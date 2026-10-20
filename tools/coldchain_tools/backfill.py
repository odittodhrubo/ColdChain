"""Seeded history: readings from the simulator written straight into the backend database, flagged seeded=1.

Used by the demo (`make demo`: 6 h so charts and forecasts have context from the first minute) and by the
scenario tests (a fridge with hours of a weak compressor). The UI labels these rows "seeded demo history";
they never pass for device data. Negative seq numbers keep them clear of anything a node sends.

    python -m coldchain_tools.backfill --db backend/data/demo.db --hours 6 [--fridge fridge-02=0.4]
"""

from __future__ import annotations

import argparse
import sqlite3
import time
import zlib

from .sim_engine import run_offline

COLS = (
    "device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, reason, "
    "received_at, seeded"
)


def backfill(db_path: str, hours: float, fridges: dict[str, float], end_ts: int | None = None,
             seed: int = 5) -> dict[str, float]:  # fmt: skip
    """Writes `hours` of telemetry ending at end_ts (default now) for each fridge (value = compressor
    efficiency). Returns each fridge's last temperature, so a live node can carry on from it."""
    end = end_ts or int(time.time())
    start = end - int(hours * 3600)
    db = sqlite3.connect(db_path, timeout=10)
    last: dict[str, float] = {}
    try:
        for fid, eff in fridges.items():
            sql = "SELECT device_id FROM devices WHERE fridge_id = ? LIMIT 1"
            device = db.execute(sql, (fid,)).fetchone()
            if not device:
                raise SystemExit(f"no device for {fid}: seed the database first")
            rows = []
            script = [(0, "eff", eff)] if eff != 1.0 else []
            # Per-fridge seed: each fridge gets its own noise and compressor phase, so the two histories (and
            # the charts, last temps and live nodes that carry on from them) differ instead of being twins.
            fseed = seed ^ zlib.crc32(fid.encode())
            sim = run_offline(end - start - 5, device_id=fid, seed=fseed, start_ts=start, scenario=script)
            for m, _ in sim:
                if m.kind != "telemetry":
                    continue
                r = m.reading
                fields = [r[k] for k in ("ts", "temp", "door", "comp", "power", "batt", "state", "exp_s",
                                         "latch", "mode", "reason")]  # fmt: skip
                # negative and unique per run: below any live seq, never colliding with an earlier backfill
                rows.append((device[0], fid, -start * 100_000 + m.seq, *fields, r["ts"] * 1000, 1))
            db.executemany(f"INSERT OR IGNORE INTO readings ({COLS}) VALUES ({','.join('?' * 16)})", rows)
            last[fid] = rows[-1][4]
        db.commit()
    finally:
        db.close()
    return last


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True)
    ap.add_argument("--hours", type=float, default=6)
    ap.add_argument("--fridge", action="append", default=[], help="ID or ID=efficiency (default both, 1.0)")
    args = ap.parse_args(argv)
    fridges = {f.split("=")[0]: float(f.split("=")[1]) if "=" in f else 1.0 for f in args.fridge}
    last = backfill(args.db, args.hours, fridges or {"fridge-01": 1.0, "fridge-02": 1.0})
    ends = ", ".join(f"{k} ends at {v:.1f} °C" for k, v in last.items())
    print(f"seeded {args.hours} h of history: {ends}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
