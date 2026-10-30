"""Virtual fridge node: the firmware's behaviour over real MQTT, without Wokwi.

    python -m coldchain_tools.virtual_node --fridge fridge-01 --scenario wifi_loss [--thermal-speed 4]
    python -m coldchain_tools.virtual_node --fridge fridge-03 --interactive

Same signed envelope, topics, bodies, buffer and ack-based sync as the firmware (sim_engine is a port of it).
Timestamps come from the real clock: the server accepts only +-HMAC_WINDOW_S of skew.
Use a device id the Wokwi node is not using at the same time: both would share one seq space.

Interactive keys (type, then Enter): d door, p power, w wifi, e 0.6 efficiency, t 13 temperature,
s status, q quit. Scenarios include door_ajar (slow creep past 8 °C, the forecaster's early-warning case).
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
import zlib
from collections import deque
from pathlib import Path
from urllib.parse import urlparse

from . import envelope
from .contracts import ROOT, C, device_secret, setting, topic
from .sim_engine import (
    SCENARIOS,
    FridgeNode,
    Message,
    RingBuffer,
    Syncer,
    apply_action,
    event_json,
    reading_json,
    sync_json,
)

STATE_DIR = ROOT / "tools" / ".state"  # git-ignored: persisted seq per virtual device
SEQ_SAVE_EVERY = 20


class SeqFile:
    """Like the firmware's NVS seq: saved every 20, +20 on start, so a crash never reuses a seq."""

    def __init__(self, device_id: str, directory: Path = STATE_DIR):
        self.path = directory / f"{device_id}.json"

    def start(self) -> int:
        saved = json.loads(self.path.read_text())["seq"] if self.path.exists() else 0
        start = saved + SEQ_SAVE_EVERY
        self.save(start)
        return start

    def save(self, seq: int) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"seq": seq}))


class Uplink:
    """Delivery layer of one node: live publish or buffer, sync with acks, verified commands, Wi-Fi events.

    transport needs .connected (bool) and .publish(topic, payload) -> bool.
    """

    def __init__(
        self, node: FridgeNode, secret: str, prefix: str, transport, seq_file: SeqFile | None = None
    ):
        self.node = node
        self.secret = secret
        self.prefix = prefix
        self.transport = transport
        self.seq_file = seq_file
        self.outage = False
        self.buffer = RingBuffer()
        self.syncer = Syncer(self.buffer)
        # R1, as the firmware: live-sent messages stay replayable (the last 720) for SYNC_REQUEST
        self.recent = RingBuffer()
        self.nonces: deque[str] = deque(maxlen=32)
        self.rejected: dict[str, int] = {}
        self.sent = 0
        self._was_up = False
        self._ever_up = False
        self._saved_seq = node.seq

    def t(self, kind: str) -> str:
        return topic(self.prefix, self.node.device_id, kind)

    @property
    def up(self) -> bool:
        return bool(self.transport.connected) and not self.outage

    def _publish(self, kind: str, body: str) -> bool:
        ok = self.up and self.transport.publish(
            self.t(kind), envelope.build(self.secret, self.node.device_id, kind, body)
        )
        self.sent += ok
        return ok

    def deliver(self, messages: list[Message]) -> None:
        for m in messages:
            if m.kind == "telemetry":
                live = {"buf": len(self.buffer), "rssi": -55, "dropped": self.buffer.dropped}
                if self._publish("telemetry", reading_json(m.reading, live)):
                    self.recent.push(dict(m.reading))
                else:
                    self.buffer.push(dict(m.reading))
            elif self._publish("event", event_json(m.seq, m.ts, m.type, m.data)):
                self.recent.push({"seq": m.seq, "ts": m.ts, "type": m.type})
            else:
                self.buffer.push({"seq": m.seq, "ts": m.ts, "type": m.type})  # data is not buffered
        if self.seq_file and self.node.seq - self._saved_seq >= SEQ_SAVE_EVERY:
            self._saved_seq = self.node.seq
            self.seq_file.save(self.node.seq)

    def pump(self, now_ms: int) -> None:
        """Wi-Fi events on uplink changes, then the next sync chunk if one is due."""
        up = self.up
        if up != self._was_up:
            self._was_up = up
            if not up:
                self.node.event("WIFI_LOST")
            elif self._ever_up:
                self.node.event("WIFI_BACK")
            self._ever_up = self._ever_up or up
            self.deliver(self.node.drain())
        if self.syncer.due(now_ms, up):
            chunk = self.syncer.chunk()
            self._publish("sync", sync_json(chunk))  # fresh ts + nonce on every (re)send
            self.syncer.sent(now_ms)

    def _reject(self, reason: str) -> None:
        self.rejected[reason] = self.rejected.get(reason, 0) + 1

    def _verify(self, payload: str, kind: str) -> dict | None:
        reason, env = envelope.verify(payload, {self.node.device_id: self.secret}, expected_kind=kind)
        if reason == "OK" and env["nonce"] in self.nonces:
            reason = "REPLAY"
        if reason != "OK":
            self._reject(reason)
            return None
        self.nonces.append(env["nonce"])  # remembered only after the HMAC verified
        return json.loads(env["body"])

    def handle(self, topic_: str, payload: str) -> None:
        if self.outage:
            return  # radio off
        if topic_ == self.t("ack"):
            body = self._verify(payload, "ack")
            if body is not None and isinstance(body.get("seq_upto"), int):
                self.syncer.on_ack(body["seq_upto"])
        elif topic_ == self.t("cmd"):
            body = self._verify(payload, "cmd")
            if body is None or not isinstance(body.get("cmd_id"), str):
                return
            type_ = body.get("type")
            if type_ == "SYNC_REQUEST":
                args = body.get("args") or {}
                lo, hi = args.get("from_seq"), args.get("to_seq")
                if not (isinstance(lo, int) and isinstance(hi, int)):
                    lo, hi = 0, 2**32 - 1  # no range named: replay everything kept
                replayed = self.recent.move_range_to(self.buffer, lo, hi)
                self.syncer.restart()
                ok, detail = True, f"resync, {len(self.buffer)} buffered, {replayed} replayed"
            elif type_ == "ROTATE_SECRET":  # S7, as the firmware: open the sealed secret, then switch to it
                args = body.get("args") or {}
                new = envelope.rotate_open(self.secret, args.get("nonce"), args.get("ct"), args.get("tag"))
                if new:
                    self.secret = new  # the cmdack below is signed with it: the server's proof of the switch
                    ok, detail = True, "secret rotated"
                else:
                    self._reject("BAD_ROTATION")
                    ok, detail = False, "sealed secret did not verify"
            elif type_ in ("RESET_LATCH", "SET_LATCH", "BUZZER_TEST"):
                ok, detail = self.node.command(type_)
            else:
                self._reject("UNKNOWN_TYPE")
                ok, detail = False, "unknown command type"
            self._publish(
                "cmdack",
                json.dumps({"cmd_id": body["cmd_id"], "ok": ok, "detail": detail}, separators=(",", ":")),
            )
            self.deliver(self.node.drain())


class MqttTransport:
    """paho-mqtt client with LWT, auto-reconnect 1-30 s and an inbox queue for the main thread."""

    def __init__(
        self, url: str, username: str, password: str, client_id: str, status_topic: str, subscribe: list[str]
    ):
        import paho.mqtt.client as mqtt  # imported here so the pure parts and tests do not need a broker

        self._mqtt = mqtt
        u = urlparse(url)
        self.inbox: queue.Queue[tuple[str, str]] = queue.Queue()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        if username:
            self.client.username_pw_set(username, password or None)
        if u.scheme in ("mqtts", "ssl"):
            self.client.tls_set()
        self.client.will_set(status_topic, "offline", qos=1, retain=True)
        self.client.reconnect_delay_set(1, 30)

        self.status_topic = status_topic

        def on_connect(client, _userdata, _flags, reason_code, _props):
            if reason_code == 0:
                client.publish(status_topic, "online", qos=1, retain=True)
                for t in subscribe:
                    client.subscribe(t, qos=1)
            else:
                print(f"[mqtt] connect refused: {reason_code}")

        self.client.on_connect = on_connect
        self.client.on_message = lambda _c, _u, msg: self.inbox.put(
            (msg.topic, msg.payload.decode(errors="replace"))
        )
        self._host = u.hostname
        self._port = u.port or (8883 if u.scheme in ("mqtts", "ssl") else 1883)
        self.client.connect_async(self._host, self._port, keepalive=15)
        self.client.loop_start()

    @property
    def connected(self) -> bool:
        return self.client.is_connected()

    def publish(self, topic_: str, payload: str) -> bool:
        return self.client.publish(topic_, payload, qos=0).rc == self._mqtt.MQTT_ERR_SUCCESS

    def set_outage(self, on: bool) -> None:
        # Publish offline/online status to the broker so backend/UI track link status immediately.
        # We keep the MQTT client connected so the virtual node can receive the demo 'restore'
        # command over its subscribed sim topic. Uplink layer simulates the outage by buffering
        # telemetry/events into RingBuffer and triggering WIFI_LOST / WIFI_BACK.
        status = "offline" if on else "online"
        self.client.publish(self.status_topic, status, qos=1, retain=True)

    def close(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()


def _stdin_lines(q: queue.Queue[str]) -> None:
    for line in sys.stdin:
        q.put(line.strip())


def _status(node: FridgeNode, up: Uplink) -> str:
    door = "OPEN" if node.door_open else "CLOSED"
    comp = "ON" if node.comp.on else "OFF"
    latch = " DISCARD" if node.heat.latched else ""
    power = "DEAD" if node.power.dead else "BATTERY" if node.power.on_battery else "MAINS"
    return (
        f"[{node.device_id}] T={node.temp:.2f}C {node.state} door={door} comp={comp} "
        f"exp={node.heat.exp_s}s{latch} "
        f"pwr={power} {node.power.pct}% eff={node.model.efficiency:.2f} uplink={'up' if up.up else 'DOWN'} "
        f"buf={len(up.buffer)} seq={node.seq} sent={up.sent} rejected={sum(up.rejected.values())}"
    )


class NodeRunner:
    """One virtual node: the node, its uplink and its MQTT transport, advanced by step() (the CLI loop) or by
    a background thread (start(): scenario tests, the demo). Actions are safe to call from another thread."""

    def __init__(self, device_id: str, secret: str, url: str, username: str, password: str, prefix: str,
                 thermal_speed: float = 1.0, seq_file: SeqFile | None = None,
                 boot_lock: bool = True):  # fmt: skip
        # Mix the device id into the seed so two nodes started in the same second get different thermal noise
        # and compressor phase: the fridges then read differently at any instant, not in lockstep.
        seed = int(time.time()) ^ zlib.crc32(device_id.encode())
        self.node = FridgeNode(
            device_id, seed=seed, start_seq=seq_file.start() if seq_file else 0,
            thermal_speed=thermal_speed, boot_lock=boot_lock,
        )  # fmt: skip
        # demo controls from the web app (SIM_CONTROLS): unsigned, demo-only, not one of the contract TOPICS
        self.sim_topic = f"{prefix}/{device_id}/sim"
        self.transport = MqttTransport(
            url, username, password, f"{device_id}-virtual-{int(time.time() * 1000) % 1_000_000}",
            topic(prefix, device_id, "status"),
            [topic(prefix, device_id, "ack"), topic(prefix, device_id, "cmd"), self.sim_topic],
        )  # fmt: skip
        self.uplink = Uplink(self.node, secret, prefix, self.transport, seq_file)
        self.seq_file = seq_file
        self.lock = threading.Lock()
        self._start = time.monotonic()
        self._last = self._start
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    def step(self) -> None:
        with self.lock:
            now = time.monotonic()
            now_ms = int((now - self._start) * 1000)
            self.uplink.deliver(self.node.tick(now_ms, now - self._last, lambda: int(time.time())))
            self._last = now
            while not self.transport.inbox.empty():
                t, payload = self.transport.inbox.get()
                if t == self.sim_topic:
                    self._apply_sim(payload)  # under self.lock already; call the node directly, not act()
                else:
                    self.uplink.handle(t, payload)
            self.uplink.pump(now_ms)

    def _apply_sim(self, payload: str) -> None:
        """A demo control from the web app: {"action": door|temp|power|wifi|eff|ajar, "arg": ...}."""
        try:
            msg = json.loads(payload)
            action, arg = msg["action"], msg.get("arg")
        except (ValueError, KeyError, TypeError):
            return
        if action == "wifi":
            self.uplink.outage = bool(arg)
            self.transport.set_outage(bool(arg))
        else:
            apply_action(self.node, action, arg)
            if action in ("temp", "hold", "eff"):
                self.node._last_telemetry_ms = 0

    def act(self, action: str, arg=None) -> None:
        """A scenario action: door, power (toggle), wifi (outage on/off), eff, temp, ajar."""
        with self.lock:
            if action == "wifi":
                self.uplink.outage = bool(arg)
                self.transport.set_outage(bool(arg))
            else:
                apply_action(self.node, action, arg)
                if action in ("temp", "hold", "eff"):
                    self.node._last_telemetry_ms = 0

    def status(self) -> str:
        with self.lock:
            return _status(self.node, self.uplink)

    def start(self) -> NodeRunner:
        def loop():
            while not self._stop.is_set():
                self.step()
                time.sleep(0.1)

        self._thread = threading.Thread(target=loop, daemon=True, name=f"node-{self.node.device_id}")
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self.seq_file:
            self.seq_file.save(self.node.seq)
        self.transport.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fridge", default="fridge-01", help="device id (default fridge-01)")
    ap.add_argument("--scenario", default="normal", choices=sorted(SCENARIOS))
    ap.add_argument("--thermal-speed", type=float, default=1.0)
    ap.add_argument(
        "--duration", type=float, help="seconds; default: end of the scenario + 60 s (normal: forever)"
    )
    ap.add_argument("--interactive", action="store_true", help="keyboard commands on stdin")
    ap.add_argument("--secret", help="device secret (default DEVICE_SECRET_<ID> from the environment / .env)")
    ap.add_argument("--url", default=setting("MQTT_URL", "mqtt://localhost:1883"))
    ap.add_argument("--username", default=setting("MQTT_USERNAME"))
    ap.add_argument("--password", default=setting("MQTT_PASSWORD"))
    ap.add_argument("--prefix", default=setting("MQTT_TOPIC_PREFIX", "coldchain/v1"))
    args = ap.parse_args(argv)

    secret = args.secret or device_secret(args.fridge)
    runner = NodeRunner(args.fridge, secret, args.url, args.username, args.password, args.prefix,
                        args.thermal_speed, SeqFile(args.fridge))  # fmt: skip
    script = sorted(SCENARIOS[args.scenario], key=lambda a: a[0])
    duration = args.duration
    if duration is None and script:
        duration = script[-1][0] + 60
    keys: queue.Queue[str] = queue.Queue()
    if args.interactive:
        threading.Thread(target=_stdin_lines, args=(keys,), daemon=True).start()
    print(
        f"virtual node {args.fridge} -> {args.url} prefix {args.prefix}, "
        f"scenario {args.scenario}, seq from {runner.node.seq}"
    )

    start = time.monotonic()
    next_status = 0.0
    step = 0
    keymap = {"d": ("door", None), "p": ("power", None), "w": ("wifi", None)}
    try:
        while duration is None or time.monotonic() - start < duration:
            elapsed = time.monotonic() - start
            while step < len(script) and script[step][0] <= elapsed:
                _, action, arg = script[step]
                print(f"[scenario] t={elapsed:.0f}s {action} {'' if arg is None else arg}")
                runner.act(action, arg)
                step += 1
            while not keys.empty():
                cmd = keys.get().split()
                if not cmd:
                    continue
                if cmd[0] == "q":
                    return 0
                if cmd[0] in keymap:
                    action, _ = keymap[cmd[0]]
                    arg = {"door": not runner.node.door_open, "wifi": not runner.uplink.outage}.get(action)
                    runner.act(action, arg)
                elif cmd[0] == "e" and len(cmd) == 2:
                    runner.act("eff", float(cmd[1]))
                elif cmd[0] == "t" and len(cmd) == 2:
                    runner.act("temp", float(cmd[1]))
                print(runner.status())
            runner.step()
            if elapsed >= next_status:
                next_status = elapsed + C["TELEMETRY_PERIOD_S"]
                print(runner.status())
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
