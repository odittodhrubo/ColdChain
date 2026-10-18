"""Export the readings the backend collected into the training schema, so the models can be refreshed on real
data.

    python -m data.export_live --db ../backend/data/coldchain.db [--fridge fridge-01] [--out data/live]

Writes <out>/<fridge>.csv.gz with the generator's columns. efficiency_true and ambient_true are empty: only
a simulator knows them, so live data refreshes the forecaster (its labels come from the readings themselves)
while the health model still needs labelled data. The database is opened read-only.
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd

from features import to_minutes

COLUMNS = ["fridge_profile", "ts", "temp", "door", "comp", "power", "batt", "efficiency_true", "ambient_true"]


def export(db: Path, fridge: str | None = None) -> dict[str, pd.DataFrame]:
    con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    try:
        sql = "SELECT fridge_id, ts, temp, door, comp, power, batt FROM readings"
        raw = pd.read_sql_query(sql + (" WHERE fridge_id = ?" if fridge else "") + " ORDER BY ts", con,
                                params=(fridge,) if fridge else None)  # fmt: skip
    finally:
        con.close()
    out = {}
    for fid, part in raw.groupby("fridge_id"):
        m = to_minutes(part)
        out[str(fid)] = pd.DataFrame(
            {
                "fridge_profile": fid,
                "ts": m["minute"] * 60,
                "temp": m["temp"].round(3),
                "door": m["door"].round(3),
                "comp": m["comp"].round(3),
                "power": m["power"].astype(int),
                "batt": m["batt"].astype(int),
                "efficiency_true": np.nan,
                "ambient_true": np.nan,
            }
        )[COLUMNS]
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, required=True)
    ap.add_argument("--fridge")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "live")
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    for fid, df in export(args.db, args.fridge).items():
        df.to_csv(args.out / f"{fid}.csv.gz", index=False)
        print(f"{fid}: {len(df)} minutes -> {args.out / f'{fid}.csv.gz'}")


if __name__ == "__main__":
    main()
