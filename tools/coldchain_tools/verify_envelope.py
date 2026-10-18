"""Verify a pasted envelope against a device secret and say which check fails.

    python -m coldchain_tools.verify_envelope envelope.json [--secret S] [--no-time] [--now 1767225600]
    python -m coldchain_tools.verify_envelope -  < envelope.json

Runs the server's checks in the server's order (contract section 4): parse, known device, timestamp window,
HMAC, body JSON. Replays need the server's nonce store and cannot be judged from one message.
The secret defaults to DEVICE_SECRET_<DEVICE_ID> from the environment or .env.
"""

from __future__ import annotations

import argparse
import json
import sys
import time

from . import envelope
from .contracts import C, secret_var, setting


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="file with the envelope JSON, or - for stdin")
    ap.add_argument("--secret")
    ap.add_argument("--now", type=int, help="unix time to check ts against (default: now)")
    ap.add_argument("--no-time", action="store_true", help="skip the timestamp window (old captures)")
    args = ap.parse_args(argv)

    text = sys.stdin.read() if args.source == "-" else open(args.source, encoding="utf-8").read()
    try:
        device = json.loads(text).get("device_id", "")
    except (ValueError, AttributeError):
        device = ""
    secret = args.secret or (setting(secret_var(device)) if device else "")
    secrets = {device: secret} if secret else {}
    now = args.now if args.now is not None else int(time.time())
    window = 2**31 if args.no_time else C["HMAC_WINDOW_S"]

    reason, env = envelope.verify(text, secrets, now=now, window_s=window)
    order = ["BAD_JSON", "UNKNOWN_DEVICE", "STALE_TS", "BAD_SIG", "BAD_BODY"]
    labels = [
        "parse + fields",
        "known device (secret)",
        f"|now - ts| <= {C['HMAC_WINDOW_S']} s",
        "HMAC",
        "body JSON",
    ]
    failed_at = order.index(reason) if reason in order else len(order)
    for i, label in enumerate(labels):
        mark = "ok" if i < failed_at else "FAIL" if i == failed_at else "--"
        if i == 2 and args.no_time and i < failed_at:
            mark = "skipped"
        print(f"  {mark:<7} {label}")
    if reason == "STALE_TS" and env:
        print(f"  ts {env['ts']} is {now - env['ts']:+d} s from now")
    if reason == "UNKNOWN_DEVICE":
        var = secret_var(device) if device else "DEVICE_SECRET_<ID>"
        print(f"  no secret for {device!r}: pass --secret or set {var}")
    print(reason if reason != "OK" else f"OK {env['kind']} from {env['device_id']} (replay not checked)")
    return 0 if reason == "OK" else 1


if __name__ == "__main__":
    sys.exit(main())
