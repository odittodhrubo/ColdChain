"""The one feature pipeline, shared by training (ml/data/dataset.py) and serving (the ML API, P18).

Input is what the backend can supply live: readings (any rate, 5 s on the devices) turned into 1-minute rows
by `to_minutes`. Forecast features look only at the 60 minutes ending at the current minute `t`; health
features at the 24 hours ending at `t`. Nothing after `t` is ever read (tests/test_features.py alters the
future and checks the vectors do not move), and simulator truth (efficiency, ambient) is never an input.

Minute rows: minute (unix s // 60), temp (mean °C, NaN when no reading), door (fraction of the minute open),
comp (fraction of the minute the compressor ran), power (1 = on battery at the end of the minute), batt (%).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from constants import COMP_MIN_OFF_S, COMP_OFF_AT_C, COMP_ON_AT_C, SAFE_MAX_C

WINDOW_MIN = 60
HISTORY_MIN = 24 * 60
CAP_MIN = 60.0  # "time since" features saturate at the window length
TTB_CAP_MIN = 120.0  # time-to-8 °C extrapolation cap

MINUTE_COLUMNS = ("minute", "temp", "door", "comp", "power", "batt")


def to_minutes(readings: pd.DataFrame) -> pd.DataFrame:
    """Raw readings (ts unix s, temp, door, comp, power, batt) -> one row per minute that has readings.

    `power` may be "MAINS"/"BATTERY" (backend) or 0/1. Minutes without readings are absent, not invented."""
    df = readings
    power = df["power"]
    if not pd.api.types.is_numeric_dtype(power):
        power = (power == "BATTERY").astype(float)
    frame = pd.DataFrame(
        {
            "minute": (df["ts"].to_numpy() // 60).astype(np.int64),
            "temp": pd.to_numeric(df["temp"], errors="coerce").to_numpy(dtype=float),
            "door": df["door"].to_numpy(dtype=float),
            "comp": df["comp"].to_numpy(dtype=float),
            "power": power.to_numpy(dtype=float),
            "batt": df["batt"].to_numpy(dtype=float),
        }
    )
    g = frame.groupby("minute", sort=True)
    out = pd.DataFrame(
        {
            "temp": g["temp"].mean(),  # NaN only when every reading in the minute had no temperature
            "door": g["door"].mean(),
            "comp": g["comp"].mean(),
            "power": g["power"].last(),
            "batt": g["batt"].last(),
        }
    ).reset_index()
    return out[list(MINUTE_COLUMNS)]


class Minutes:
    """Minute rows as sorted numpy arrays, so a window is two binary searches (training slices ~10^5 of
    them)."""

    def __init__(self, frame: pd.DataFrame):
        frame = frame.sort_values("minute")
        self.minute = frame["minute"].to_numpy(dtype=np.int64)
        self.cols = {c: frame[c].to_numpy(dtype=float) for c in MINUTE_COLUMNS[1:]}

    def grid(self, t: int, length: int) -> dict[str, np.ndarray]:
        """Columns on the full grid of `length` minutes ending at t (inclusive); missing minutes are NaN."""
        lo, hi = np.searchsorted(self.minute, [t - length + 1, t + 1])  # hi excludes everything after t
        pos = self.minute[lo:hi] - (t - length + 1)
        out = {}
        for c, values in self.cols.items():
            g = np.full(length, np.nan)
            g[pos] = values[lo:hi]
            out[c] = g
        return out


# ----------------------------------------------------------------------------- small helpers (NaN-aware)


def _stat(fn, x: np.ndarray) -> float:
    x = x[~np.isnan(x)]
    return float(fn(x)) if x.size else math.nan


def _slope(y: np.ndarray) -> float:
    """Least-squares slope per minute over the non-missing points (needs 2)."""
    x = np.arange(y.size, dtype=float)
    ok = ~np.isnan(y)
    if ok.sum() < 2:
        return math.nan
    x, y = x[ok], y[ok]
    xm = x - x.mean()
    return float((xm * (y - y.mean())).sum() / (xm * xm).sum())


def _since(mask: np.ndarray) -> float:
    """Minutes since the last True (0 = now), capped at the window length when never."""
    idx = np.flatnonzero(mask)
    return float(mask.size - 1 - idx[-1]) if idx.size else CAP_MIN


def _trailing_run(mask: np.ndarray) -> int:
    """Length of the run of True ending at the last minute."""
    if not mask.size or not mask[-1]:
        return 0
    idx = np.flatnonzero(~mask)
    return int(mask.size - 1 - idx[-1]) if idx.size else int(mask.size)


def _on(comp: np.ndarray) -> np.ndarray:
    """Compressor ON per minute (ran at least half of it); missing minutes count as OFF."""
    return np.nan_to_num(comp, nan=0.0) >= 0.5


# ------------------------------------------------------------------------ forecast features (last 60 min)

FEATURES: tuple[str, ...] = (
    "temp_now", "minutes_since_reading",
    *(f"temp_{s}_{w}" for w in (5, 15, 30, 60) for s in ("mean", "std", "min", "max")),
    "temp_slope_5", "temp_slope_15", "temp_slope_30", "temp_accel",
    "door_frac_5", "door_frac_15", "door_frac_60", "door_since_open", "door_open_run",
    "comp_on_now", "comp_duty_15", "comp_duty_60", "comp_since_on", "comp_since_off", "comp_run",
    "comp_switches_60",
    "on_battery_now", "battery_minutes_60", "batt_now",
    "time_to_8", "min_off_wait", "missing_frac_60", "hour_sin", "hour_cos",
)  # fmt: skip


def window_features(g: dict[str, np.ndarray], t: int) -> np.ndarray:
    """Feature vector (FEATURES order) from the 60-minute grid ending at minute t."""
    temp, door, comp, power, batt = g["temp"], g["door"], g["comp"], g["power"], g["batt"]
    n = temp.size
    seen = np.flatnonzero(~np.isnan(temp))
    temp_now = float(temp[seen[-1]]) if seen.size else math.nan
    f: dict[str, float] = {
        "temp_now": temp_now,
        "minutes_since_reading": float(n - 1 - seen[-1]) if seen.size else CAP_MIN,
    }
    for w in (5, 15, 30, 60):
        tail = temp[-w:]
        f[f"temp_mean_{w}"] = _stat(np.mean, tail)
        f[f"temp_std_{w}"] = _stat(np.std, tail)
        f[f"temp_min_{w}"] = _stat(np.min, tail)
        f[f"temp_max_{w}"] = _stat(np.max, tail)
    for w in (5, 15, 30):
        f[f"temp_slope_{w}"] = _slope(temp[-w:])
    f["temp_accel"] = (f["temp_slope_5"] - _slope(temp[-10:-5])) / 5.0  # change of slope, °C/min²

    door0 = np.nan_to_num(door, nan=0.0)
    for w in (5, 15, 60):
        f[f"door_frac_{w}"] = float(door0[-w:].mean())
    is_open = door0 > 0
    f["door_since_open"] = _since(is_open)
    run = _trailing_run(is_open)
    f["door_open_run"] = (
        float(door0[n - run :].sum()) if run else 0.0
    )  # minutes open, partial minutes counted

    on = _on(comp)
    comp0 = np.nan_to_num(comp, nan=0.0)
    f["comp_on_now"] = float(on[-1])
    f["comp_duty_15"] = float(comp0[-15:].mean())
    f["comp_duty_60"] = float(comp0.mean())
    starts = np.r_[False, on[1:] & ~on[:-1]]
    stops = np.r_[False, ~on[1:] & on[:-1]]
    f["comp_since_on"] = _since(starts)
    f["comp_since_off"] = _since(stops)
    f["comp_run"] = float(_trailing_run(on) if on[-1] else _trailing_run(~on))
    f["comp_switches_60"] = float(starts.sum() + stops.sum())

    p = np.nan_to_num(power, nan=0.0)
    f["on_battery_now"] = float(p[-1] >= 0.5)
    f["battery_minutes_60"] = float(p.sum())
    b = batt[~np.isnan(batt)]
    f["batt_now"] = float(b[-1]) if b.size else math.nan

    slope = f["temp_slope_15"] if not math.isnan(f["temp_slope_15"]) else f["temp_slope_5"]
    if math.isnan(temp_now):
        f["time_to_8"] = math.nan
    elif temp_now >= SAFE_MAX_C:
        f["time_to_8"] = 0.0
    elif not math.isnan(slope) and slope > 0:
        f["time_to_8"] = min(TTB_CAP_MIN, (SAFE_MAX_C - temp_now) / slope)
    else:
        f["time_to_8"] = TTB_CAP_MIN
    min_off = COMP_MIN_OFF_S / 60.0
    f["min_off_wait"] = max(0.0, min_off - f["comp_since_off"]) if not on[-1] else 0.0
    f["missing_frac_60"] = float(1.0 - seen.size / n)
    hour = ((t % 1440) / 60.0) * 2 * math.pi / 24  # UTC hour of day: door use follows the working day
    f["hour_sin"], f["hour_cos"] = math.sin(hour), math.cos(hour)
    return np.array([f[k] for k in FEATURES], dtype=float)


def features_at(minutes: Minutes, t: int) -> np.ndarray:
    """Training path: the forecast vector at minute t from a whole stored series."""
    return window_features(minutes.grid(t, WINDOW_MIN), t)


def serve_features(readings: pd.DataFrame, t: int | None = None) -> np.ndarray:
    """Serving path: raw readings as the backend stores them -> the forecast vector at minute t (default: the
    minute of the last reading)."""
    m = Minutes(to_minutes(readings))
    return features_at(m, int(m.minute[-1]) if t is None else t)


# ----------------------------------------------------------------------------- compressor health (last 24 h)

HEALTH_FEATURES: tuple[str, ...] = (
    "cool_rate_on", "warm_rate_off", "on_duration_mean", "off_duration_mean", "pulldown_7_3",
    "overshoot_7", "cycles_per_hour", "n_cycles", "duty_24", "duty_trend", "longest_on_run",
    "temp_mean_24", "temp_max_24", "frac_above_8", "coverage_hours",
)  # fmt: skip


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of each run of True."""
    edges = np.flatnonzero(np.diff(np.r_[0, mask.astype(np.int8), 0]))
    return list(zip(edges[::2], edges[1::2], strict=True))


def history_features(g: dict[str, np.ndarray]) -> np.ndarray:
    """Cycle features (HEALTH_FEATURES order) from a 24-hour minute grid. Minutes with the door open or on
    battery are left out of the rates: those changes are not the compressor's doing."""
    temp, door, comp, power = g["temp"], g["door"], g["comp"], g["power"]
    on = _on(comp)
    clean = ~np.isnan(temp) & (np.nan_to_num(door, nan=1.0) == 0) & (np.nan_to_num(power, nan=1.0) < 0.5)
    d = np.diff(temp)
    both = clean[1:] & clean[:-1]
    on_pair = both & on[1:] & on[:-1]
    off_pair = both & ~on[1:] & ~on[:-1]
    f: dict[str, float] = {
        "cool_rate_on": float(-d[on_pair].mean())
        if on_pair.any()
        else math.nan,  # °C/min, positive = cooling
        "warm_rate_off": float(d[off_pair].mean()) if off_pair.any() else math.nan,
    }
    present = ~np.isnan(comp)
    on_runs = [(a, b) for a, b in _runs(on) if a > 0 and b < on.size and present[a - 1] and present[b]]
    off_runs = [(a, b) for a, b in _runs(~on & present) if a > 0 and b < on.size and on[a - 1] and on[b]]
    f["on_duration_mean"] = float(np.mean([b - a for a, b in on_runs])) if on_runs else math.nan
    f["off_duration_mean"] = float(np.mean([b - a for a, b in off_runs])) if off_runs else math.nan
    pulls, overs = [], []
    for a, b in on_runs:
        before = temp[max(0, a - 2) : a + 1]
        if np.nanmax(before, initial=-np.inf) >= COMP_ON_AT_C - 0.5 and np.nanmin(
            temp[a:b], initial=np.inf
        ) <= (COMP_OFF_AT_C + 0.5):
            pulls.append(b - a)
        head = temp[a : min(b, a + 4)]
        if (~np.isnan(head)).any():
            overs.append(max(0.0, float(np.nanmax(head)) - COMP_ON_AT_C))
    f["pulldown_7_3"] = float(np.mean(pulls)) if pulls else math.nan
    f["overshoot_7"] = float(np.mean(overs)) if overs else math.nan
    coverage = float(present.sum()) / 60.0
    f["coverage_hours"] = coverage
    f["n_cycles"] = float(len(on_runs))
    f["cycles_per_hour"] = len(on_runs) / coverage if coverage > 0 else math.nan
    comp0 = np.where(present, comp, np.nan)
    f["duty_24"] = _stat(np.mean, comp0)
    hourly = np.array([_stat(np.mean, comp0[i : i + 60]) for i in range(0, comp0.size, 60)])
    f["duty_trend"] = _slope(hourly)  # duty fraction per hour; rising duty = the compressor struggles
    f["longest_on_run"] = float(max((b - a for a, b in _runs(on)), default=0))
    f["temp_mean_24"] = _stat(np.mean, temp)
    f["temp_max_24"] = _stat(np.max, temp)
    seen = temp[~np.isnan(temp)]
    f["frac_above_8"] = float((seen > SAFE_MAX_C).mean()) if seen.size else math.nan
    return np.array([f[k] for k in HEALTH_FEATURES], dtype=float)


def health_features(minutes: Minutes, t: int) -> np.ndarray:
    """Training and serving: health vector at minute t from the 24 hours ending at t."""
    return history_features(minutes.grid(t, HISTORY_MIN))
