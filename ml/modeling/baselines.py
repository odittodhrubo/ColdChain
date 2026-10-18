"""Forecast baselines the models must beat: persistence, linear extrapolation and the physics model."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from coldchain_tools.sim_engine import F  # noqa: E402

from constants import COMP_MIN_OFF_S, COMP_OFF_AT_C, COMP_ON_AT_C  # noqa: E402


def persistence(X: pd.DataFrame, horizon: int) -> np.ndarray:
    """T(t + h) = T(t)."""
    return X["temp_now"].to_numpy(float)


def linear(X: pd.DataFrame, horizon: int) -> np.ndarray:
    """T(t) + h x the 15-minute slope (no slope: persistence)."""
    slope = X["temp_slope_15"].fillna(0.0).to_numpy(float)
    return X["temp_now"].to_numpy(float) + horizon * slope


def physics(X: pd.DataFrame, horizon: int) -> np.ndarray:
    """Simulate forward with the firmware's nominal model (30 °C room, nominal leak and cooling, efficiency
    1), from the current temperature and compressor state, door closed, hysteresis and minimum-off honoured,
    compressor held off while on battery. It does not know the fridge's real parameters: that is the
    point."""
    temp = X["temp_now"].to_numpy(float).copy()
    on = X["comp_on_now"].to_numpy(float) >= 0.5
    battery = X["on_battery_now"].to_numpy(float) >= 0.5
    since_off = X["comp_since_off"].to_numpy(float) * 60.0
    amb, leak, cool = F["T_AMBIENT_C"], F["K_LEAK_PER_S"], F["COOL_RATE_C_PER_S"]
    on &= ~battery
    for _ in range(horizon * 60):  # 1 s Euler steps, vectorised over rows
        temp += leak * (amb - temp) - on * cool
        since_off += 1
        stop = on & (temp <= COMP_OFF_AT_C)
        on[stop] = False
        since_off[stop] = 0
        on |= ~on & ~battery & (temp >= COMP_ON_AT_C) & (since_off >= COMP_MIN_OFF_S)
    return temp


BASELINES = {"persistence": persistence, "linear": linear, "physics": physics}
