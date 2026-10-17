"""Virtual fridge node: the firmware's behaviour over real MQTT, without Wokwi.

    python -m coldchain_tools.virtual_node --fridge fridge-01 --scenario wifi_loss [--thermal-speed 4]
    python -m coldchain_tools.virtual_node --fridge fridge-03 --interactive

Same signed envelope, topics, bodies, buffer and ack-based sync as the firmware (sim_engine is a port of it).
Timestamps come from the real clock: the server accepts only +-HMAC_WINDOW_S of skew.
Use a device id the Wokwi node is not using at the same time: both would share one seq space.

Interactive keys (type, then Enter): d door, p power, w wifi, e 0.6 efficiency, t 13 temperature,
s status, q quit.
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import threading
import time
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
                if not self._publish("telemetry", reading_json(m.reading, live)):
                    self.buffer.push(dict(m.reading))
            elif not self._publish("event", event_json(m.seq, m.ts, m.type, m.data)):
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
                self.syncer.restart()
                ok, detail = True, f"resync, {len(self.buffer)} buffered"
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
        # An explicit disconnect() ends paho's network thread, so restoring needs a fresh connect + loop.
        if on:
            self.client.disconnect()
            self.client.loop_stop()
        else:
            self.client.connect_async(self._host, self._port, keepalive=15)
            self.client.loop_start()

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
    seq_file = SeqFile(args.fridge)
    node = FridgeNode(
        args.fridge, seed=int(time.time()), start_seq=seq_file.start(), thermal_speed=args.thermal_speed
    )
    transport = MqttTransport(
        args.url,
        args.username,
        args.password,
        f"{args.fridge}-virtual-{int(time.time()) % 100000}",
        topic(args.prefix, args.fridge, "status"),
        [topic(args.prefix, args.fridge, "ack"), topic(args.prefix, args.fridge, "cmd")],
    )
    uplink = Uplink(node, secret, args.prefix, transport, seq_file)
    script = sorted(SCENARIOS[args.scenario], key=lambda a: a[0])
    duration = args.duration
    if duration is None and script:
        duration = script[-1][0] + 60
    keys: queue.Queue[str] = queue.Queue()
    if args.interactive:
        threading.Thread(target=_stdin_lines, args=(keys,), daemon=True).start()
    print(
        f"virtual node {args.fridge} -> {args.url} prefix {args.prefix}, "
        f"scenario {args.scenario}, seq from {node.seq}"
    )

    start = time.monotonic()
    last = start
    next_status = 0.0
    step = 0
    try:
        while duration is None or time.monotonic() - start < duration:
            now = time.monotonic()
            elapsed = now - start
            while step < len(script) and script[step][0] <= elapsed:
                _, action, arg = script[step]
                print(f"[scenario] t={elapsed:.0f}s {action} {'' if arg is None else arg}")
                if action == "wifi":
                    uplink.outage = bool(arg)
                    transport.set_outage(bool(arg))
                else:
                    apply_action(node, action, arg)
                step += 1
            while not keys.empty():
                cmd = keys.get().split()
                if not cmd:
                    continue
                if cmd[0] == "q":
                    return 0
                if cmd[0] == "d":
                    node.set_door(not node.door_open)
                elif cmd[0] == "p":
                    node.toggle_power()
                elif cmd[0] == "w":
                    uplink.outage = not uplink.outage
                    transport.set_outage(uplink.outage)
                elif cmd[0] == "e" and len(cmd) == 2:
                    node.set_efficiency(float(cmd[1]))
                elif cmd[0] == "t" and len(cmd) == 2:
                    node.set_temp(float(cmd[1]))
                print(_status(node, uplink))
            now_ms = int(elapsed * 1000)
            uplink.deliver(node.tick(now_ms, now - last, lambda: int(time.time())))
            last = now
            while not transport.inbox.empty():
                uplink.handle(*transport.inbox.get())
            uplink.pump(now_ms)
            if elapsed >= next_status:
                next_status = elapsed + C["TELEMETRY_PERIOD_S"]
                print(_status(node, uplink))
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        seq_file.save(node.seq)
        transport.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
