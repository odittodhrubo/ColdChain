"""Security demo: messages the backend must reject, each with the reason code it should log (contract §4).

    python -m coldchain_tools.attack replay          # capture a live node message, resend the same bytes
    python -m coldchain_tools.attack replay --own    # sign a fresh valid message, send it twice
    python -m coldchain_tools.attack badsig | stale | unknown-device | tamper-body | flood  [--fridge ID]
    python -m coldchain_tools.attack <name> --dry-run   # print the messages, publish nothing

Only targets topics under the configured MQTT_TOPIC_PREFIX, and refuses to run when NODE_ENV=production.
"""

from __future__ import annotations

import argparse
import json
import queue
import sys
import time

from . import envelope
from .contracts import device_secret, refuse_in_production, setting, topic
from .sim_engine import FridgeNode, reading_json

ATTACKS = ("replay", "badsig", "stale", "unknown-device", "tamper-body", "flood")
FLOOD_RATE = 50  # invalid messages per second
FLOOD_SECONDS = 5


def own_body(device_id: str, ts: int) -> str:
    """A realistic telemetry body. Nodes never use seq 0, so an accepted copy cannot shadow real data."""
    r = FridgeNode(device_id).reading(False)
    r["seq"], r["ts"] = 0, ts
    return reading_json(r, {"buf": 0, "rssi": -60})


def flip_hex(sig: str) -> str:
    return ("1" if sig[0] == "0" else "0") + sig[1:]


def craft(attack: str, device_id: str, secret: str, now: int) -> list[tuple[str, str, str, str]]:
    """[(device_id, kind, payload, expected_reason)] in send order."""
    body = own_body(device_id, now)
    valid = envelope.build(secret, device_id, "telemetry", body, ts=now)
    if attack == "replay":
        return [(device_id, "telemetry", valid, "OK"), (device_id, "telemetry", valid, "REPLAY")]
    if attack == "badsig":
        env = json.loads(valid)
        env["sig"] = flip_hex(env["sig"])
        return [(device_id, "telemetry", json.dumps(env, separators=(",", ":")), "BAD_SIG")]
    if attack == "stale":  # correctly signed, but 10 minutes old
        old = now - 600
        stale = envelope.build(secret, device_id, "telemetry", own_body(device_id, old), ts=old)
        return [(device_id, "telemetry", stale, "STALE_TS")]
    if attack == "unknown-device":
        ghost = "fridge-99"
        forged = envelope.build("not-a-registered-secret", ghost, "telemetry", own_body(ghost, now), ts=now)
        return [(ghost, "telemetry", forged, "UNKNOWN_DEVICE")]
    if attack == "tamper-body":  # change the temperature after signing
        env = json.loads(valid)
        b = json.loads(env["body"])
        b["temp"] = 4.0 if b["temp"] != 4.0 else 5.0
        env["body"] = json.dumps(b, separators=(",", ":"))
        return [(device_id, "telemetry", json.dumps(env, separators=(",", ":")), "BAD_SIG")]
    if attack == "flood":
        out = []
        for _ in range(FLOOD_RATE * FLOOD_SECONDS):
            env = json.loads(envelope.build(secret, device_id, "telemetry", body, ts=now))
            env["sig"] = flip_hex(env["sig"])
            out.append((device_id, "telemetry", json.dumps(env, separators=(",", ":")), "BAD_SIG"))
        return out  # fresh nonce each time: every one fails on the signature, never as a replay
    raise ValueError(f"unknown attack {attack!r}")


def check_prefix(prefix: str) -> None:
    if not prefix or any(c in prefix for c in "#+") or prefix.endswith("/"):
        raise SystemExit(f"refusing to run: MQTT_TOPIC_PREFIX {prefix!r} must be a plain topic path")


def _capture(client, telemetry_topic: str, timeout_s: float) -> str:
    got: queue.Queue[str] = queue.Queue()
    client.on_message = lambda _c, _u, msg: got.put(msg.payload.decode())
    client.subscribe(telemetry_topic, qos=0)
    try:
        return got.get(timeout=timeout_s)
    finally:
        client.unsubscribe(telemetry_topic)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("attack", choices=ATTACKS)
    ap.add_argument("--fridge", default="fridge-01")
    ap.add_argument("--secret", help="device secret for messages that must be validly signed")
    ap.add_argument(
        "--own", action="store_true", help="replay: sign a fresh message instead of capturing one"
    )
    ap.add_argument("--capture-timeout", type=float, default=30.0)
    ap.add_argument("--dry-run", action="store_true", help="print the messages, publish nothing")
    ap.add_argument("--url", default=setting("MQTT_URL", "mqtt://localhost:1883"))
    ap.add_argument("--username", default=setting("MQTT_USERNAME"))
    ap.add_argument("--password", default=setting("MQTT_PASSWORD"))
    ap.add_argument("--prefix", default=setting("MQTT_TOPIC_PREFIX", "coldchain/v1"))
    args = ap.parse_args(argv)

    refuse_in_production()
    check_prefix(args.prefix)
    secret = args.secret or device_secret(args.fridge)
    plan = craft(args.attack, args.fridge, secret, int(time.time()))

    if args.dry_run:
        for dev, kind, payload, expect in plan[:5]:
            print(f"{topic(args.prefix, dev, kind)}  expect {expect}\n  {payload}")
        if len(plan) > 5:
            print(f"... {len(plan) - 5} more (expect {plan[-1][3]})")
        return 0

    from urllib.parse import urlparse

    import paho.mqtt.client as mqtt

    u = urlparse(args.url)
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"coldchain-attack-{int(time.time())}")
    if args.username:
        client.username_pw_set(args.username, args.password or None)
    if u.scheme in ("mqtts", "ssl"):
        client.tls_set()
    client.connect(u.hostname, u.port or (8883 if u.scheme in ("mqtts", "ssl") else 1883), keepalive=15)
    client.loop_start()
    try:
        if args.attack == "replay" and not args.own:
            t = topic(args.prefix, args.fridge, "telemetry")
            print(f"waiting up to {args.capture_timeout:.0f}s for a live message on {t} ...")
            captured = _capture(client, t, args.capture_timeout)
            print("captured; the node's original was accepted. Resending the exact same bytes in 2 s.")
            time.sleep(2)
            plan = [(args.fridge, "telemetry", captured, "REPLAY")]
        delay = 1.0 / FLOOD_RATE if args.attack == "flood" else 2.0
        for i, (dev, kind, payload, expect) in enumerate(plan):
            client.publish(topic(args.prefix, dev, kind), payload, qos=0)
            if args.attack != "flood" or i % FLOOD_RATE == 0:
                print(f"sent #{i + 1} to {topic(args.prefix, dev, kind)}: server should answer {expect}")
            if i + 1 < len(plan):
                time.sleep(delay)
        if args.attack == "flood":
            print(
                f"flood done: {len(plan)} BAD_SIG messages in {FLOOD_SECONDS}s; "
                "the security log should coalesce them"
            )
    finally:
        client.loop_stop()
        client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
