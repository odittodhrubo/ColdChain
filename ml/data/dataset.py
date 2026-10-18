"""Labels, leakage-safe splits and model matrices, built from ml/data/raw with the shared feature pipeline.

Labels (per profile, on the stored 1-minute series):
  y_temp_h      temperature h minutes after t, h in 5/10/20/30 (NaN when that minute is missing)
  y_breach_30   max(temp over (t, t+30 min]) > 8 °C (NaN when fewer than 20 of those 30 minutes exist)
  y_health      100 x efficiency_true, clipped to [0, 100]

Splits, never shuffled: the held-out profiles are test only; on the others the last 10 days are test, the 10
before them validation, the rest training. Around each boundary rows are purged so no training label looks
into validation time and no validation window reaches back into training labels (30 + 60 min for forecasts,
24 h for health). Tree models need no scaling; anything fitted (scalers, thresholds) is fitted on train
only.

    python -m data.dataset          # raw -> ml/data/processed/{forecast,health}.csv.gz + DATASET_CARD.md
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd

from constants import FORECAST_HORIZON_MIN, SAFE_MAX_C
from features import FEATURES, HEALTH_FEATURES, HISTORY_MIN, WINDOW_MIN, Minutes, features_at, health_features

DATA = Path(__file__).resolve().parent
HORIZONS = (5, 10, 20, 30)
MIN_FUTURE_MINUTES = 20  # of the 30 needed for y_breach_30
FORECAST_STEP_MIN = 5  # one forecast row every 5 minutes
HEALTH_STEP_MIN = 60
HEALTH_MIN_COVERAGE_H = 6.0
TEST_DAYS = 10
VAL_DAYS = 10


def held_out_profiles() -> set[str]:
    from data.generate import PROFILES

    return {p.name for p in PROFILES if p.held_out}


def add_labels(df: pd.DataFrame) -> pd.DataFrame:
    """Labels for one profile's minute rows (sorted by ts). Only ever reads the future to *label*."""
    df = df.sort_values("ts").reset_index(drop=True)
    minute = (df["ts"] // 60).to_numpy()
    temp = pd.Series(df["temp"].to_numpy(), index=minute)
    full = temp.reindex(np.arange(minute[0], minute[-1] + FORECAST_HORIZON_MIN + 1))
    out = df.copy()
    for h in HORIZONS:
        out[f"y_temp_{h}"] = full.reindex(minute + h).to_numpy()
    # rolling over the next 30 minutes: reverse, roll, reverse back, then shift by one (strictly after t)
    future = full.iloc[::-1]
    fmax = future.rolling(FORECAST_HORIZON_MIN, min_periods=1).max().iloc[::-1].shift(-1)
    fcount = future.rolling(FORECAST_HORIZON_MIN, min_periods=1).count().iloc[::-1].shift(-1)
    breach = (fmax > SAFE_MAX_C).astype(float).where(fcount >= MIN_FUTURE_MINUTES)
    out["y_breach_30"] = breach.reindex(minute).to_numpy()
    out["y_health"] = np.clip(100 * df["efficiency_true"].to_numpy(), 0, 100)
    return out


def split_for(
    profile: str, minute: np.ndarray, first: int, last: int, held_out: set[str], embargo: int
) -> np.ndarray:
    """'train' / 'val' / 'test' / 'gap' for each minute of one profile spanning [first, last]."""
    if profile in held_out:
        return np.full(minute.shape, "test", dtype=object)
    test_at = last - TEST_DAYS * 1440 + 1
    val_at = test_at - VAL_DAYS * 1440
    out = np.where(minute >= test_at, "test", np.where(minute >= val_at, "val", "train")).astype(object)
    for boundary in (val_at, test_at):
        near = (minute >= boundary - FORECAST_HORIZON_MIN) & (minute < boundary + embargo)
        out[near] = "gap"
    return out


def build_forecast(raw: pd.DataFrame, step: int = FORECAST_STEP_MIN) -> pd.DataFrame:
    """One row per profile every `step` minutes that has a reading: meta, FEATURES, labels."""
    held = held_out_profiles()
    parts = []
    for profile, df in raw.groupby("fridge_profile", sort=True):
        lab = add_labels(df)
        minute = (lab["ts"] // 60).to_numpy()
        rows = lab[(minute % step == 0) & (minute - minute[0] >= WINDOW_MIN - 1)]
        m = Minutes(lab.assign(minute=minute))
        X = np.vstack([features_at(m, int(t)) for t in rows["ts"] // 60])
        part = pd.DataFrame(X, columns=list(FEATURES))
        part.insert(0, "fridge_profile", profile)
        part.insert(1, "ts", rows["ts"].to_numpy())
        rm = (rows["ts"] // 60).to_numpy()
        part.insert(2, "split", split_for(profile, rm, minute[0], minute[-1], held, WINDOW_MIN))
        for c in [*(f"y_temp_{h}" for h in HORIZONS), "y_breach_30", "y_health"]:
            part[c] = rows[c].to_numpy()
        parts.append(part)
    return pd.concat(parts, ignore_index=True)


def build_health(raw: pd.DataFrame, step: int = HEALTH_STEP_MIN) -> pd.DataFrame:
    """One row per profile every `step` minutes with at least 6 h of the last 24 h covered."""
    held = held_out_profiles()
    parts = []
    for profile, df in raw.groupby("fridge_profile", sort=True):
        lab = add_labels(df)
        minute = (lab["ts"] // 60).to_numpy()
        m = Minutes(lab.assign(minute=minute))
        rows = lab[minute % step == 0]
        X = np.vstack([health_features(m, int(t)) for t in rows["ts"] // 60])
        part = pd.DataFrame(X, columns=list(HEALTH_FEATURES))
        part.insert(0, "fridge_profile", profile)
        part.insert(1, "ts", rows["ts"].to_numpy())
        rm = (rows["ts"] // 60).to_numpy()
        part.insert(2, "split", split_for(profile, rm, minute[0], minute[-1], held, HISTORY_MIN))
        part["y_health"] = rows["y_health"].to_numpy()
        parts.append(part[part["coverage_hours"] >= HEALTH_MIN_COVERAGE_H])
    return pd.concat(parts, ignore_index=True)


def load(name: str, directory: Path = DATA / "processed") -> pd.DataFrame:
    """A processed matrix ('forecast' or 'health'); `python -m data.generate` creates them."""
    path = directory / f"{name}.csv.gz"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing: run `python -m data.generate` in ml/")
    return pd.read_csv(path)


def build(raw_dir: Path = DATA / "raw", out_dir: Path = DATA / "processed", stats: list[dict] | None = None,
          seed: int | None = None, card: Path | None = DATA / "DATASET_CARD.md") -> dict:  # fmt: skip
    from data.generate import load_raw

    raw = load_raw(raw_dir)
    forecast = build_forecast(raw)
    health = build_health(raw)
    out_dir.mkdir(parents=True, exist_ok=True)
    forecast.to_csv(out_dir / "forecast.csv.gz", index=False)
    health.to_csv(out_dir / "health.csv.gz", index=False)
    summary = summarize(raw, forecast, health, stats, seed)
    stats_text = json.dumps(summary, indent=2) + "\n"
    (DATA / "dataset_stats.json").write_text(stats_text, encoding="utf-8", newline="\n")
    if card is not None:
        from data.card import render

        card.write_text(render(summary), encoding="utf-8", newline="\n")
    print(f"forecast {len(forecast)} rows, health {len(health)} rows -> {out_dir}")
    return summary


def summarize(raw: pd.DataFrame, forecast: pd.DataFrame, health: pd.DataFrame, stats, seed) -> dict:
    by_split = {}
    for split, part in forecast.groupby("split"):
        y = part["y_breach_30"].dropna()
        by_split[split] = {
            "forecast_rows": len(part),
            "breach_rows": int(y.sum()),
            "breach_rate": round(float(y.mean()), 4) if len(y) else None,
            "health_rows": int((health["split"] == split).sum()),
        }
    return {
        "generated_at": datetime.now(UTC).strftime("%Y-%m-%d"),
        "seed": seed,
        "profiles": stats,
        "raw_rows": len(raw),
        "minutes_above_8_pct": round(100 * float((raw["temp"] > SAFE_MAX_C).mean()), 2),
        "forecast_rows": len(forecast),
        "health_rows": len(health),
        "features": len(FEATURES),
        "health_features": len(HEALTH_FEATURES),
        "by_split": by_split,
        "held_out_profiles": sorted(held_out_profiles()),
    }


if __name__ == "__main__":
    previous = DATA / "dataset_stats.json"  # keep the generator's per-profile counts when only rebuilding
    old = json.loads(previous.read_text(encoding="utf-8")) if previous.exists() else {}
    build(stats=old.get("profiles"), seed=old.get("seed"))
