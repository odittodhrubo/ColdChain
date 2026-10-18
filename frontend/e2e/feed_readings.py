"""Playwright AI flow: stand in for two fridge nodes by writing readings straight into the e2e database.

Backfills 3 hours of history (fridge-01 with a weak compressor, fridge-02 healthy) so the models have
context, then keeps both "online" with a reading every 5 s for --seconds, using the simulator's physics in real
time. No MQTT broker is needed. Backfilled rows get negative seq numbers so they never clash with live ones.

    python e2e/feed_readings.py --db <e2e db> --seconds 300
"""

import argparse
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from coldchain_tools.sim_engine import FridgeNode, run_offline  # noqa: E402

COLS = "device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, reason, received_at"
SQL = f"INSERT OR IGNORE INTO readings ({COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
WEAK = {"fridge-01": 0.4, "fridge-02": 1.0}


def row(fid: str, seq: int, r: dict, received_ms: int) -> tuple:
    return (fid, fid, seq, r["ts"], r["temp"], r["door"], r["comp"], r["power"], r["batt"], r["state"],
            r["exp_s"], r["latch"], r["mode"], r["reason"], received_ms)  # fmt: skip


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--seconds", type=int, default=300)
    args = ap.parse_args()
    db = sqlite3.connect(args.db, timeout=10)
    now = int(time.time())
    last_temp = {}
    for fid, eff in WEAK.items():
        script = [(0, "eff", eff)]
        rows = [
            row(fid, -10_000_000 + m.seq, m.reading, m.reading["ts"] * 1000)
            for m, _ in run_offline(3 * 3600 - 10, device_id=fid, seed=5, start_ts=now - 3 * 3600, scenario=script)
            if m.kind == "telemetry"
        ]
        db.executemany(SQL, rows)
        last_temp[fid] = rows[-1][4]
    db.commit()
    print("backfilled", flush=True)

    nodes = {fid: FridgeNode(fid, seed=9) for fid in WEAK}
    for fid, node in nodes.items():
        node.set_efficiency(WEAK[fid])
        node.set_temp(last_temp[fid])  # carry on from the history, no jump
    start = time.monotonic()
    t_ms = 0
    while time.monotonic() - start < args.seconds:
        ts = int(time.time())
        for fid, node in nodes.items():
            msgs = node.tick(t_ms, 1.0 if t_ms else 0.0, lambda ts=ts: ts)
            readings = [m for m in msgs if m.kind == "telemetry"]
            db.executemany(SQL, [row(fid, m.seq, m.reading, int(time.time() * 1000)) for m in readings])
        db.commit()
        t_ms += 1000
        time.sleep(1)


if __name__ == "__main__":
    main()
