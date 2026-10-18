"""P16: the feature pipeline is deterministic, never looks ahead, survives missing minutes, and gives the same
vector on the training path (stored minute rows) and the serving path (raw readings)."""

import math

import numpy as np
import pandas as pd
import pytest

from data.dataset import add_labels, build_forecast, build_health, split_for
from data.generate import PROFILES, START_TS, efficiency_at, schedule, simulate
from features import (
    FEATURES,
    HEALTH_FEATURES,
    Minutes,
    features_at,
    health_features,
    serve_features,
    to_minutes,
)

T0 = START_TS // 60


@pytest.fixture(scope="module")
def two_days():
    df, _ = simulate(PROFILES[1], 2, seed=7)  # rural-clinic: degrades, one fault
    return df


def minutes_of(df: pd.DataFrame) -> Minutes:
    return Minutes(df.assign(minute=df["ts"] // 60))


def raw_readings(n_min: int, seed: int = 1) -> pd.DataFrame:
    """5 s readings shaped like the backend's readings table."""
    rng = np.random.default_rng(seed)
    ts = START_TS + np.arange(n_min * 12) * 5
    temp = 5 + 2 * np.sin(np.arange(ts.size) / 150) + rng.normal(0, 0.05, ts.size)
    door = (rng.random(ts.size) < 0.02).astype(int)
    comp = (np.sin(np.arange(ts.size) / 150) > 0).astype(int)
    power = np.where((ts - START_TS) // 60 % 97 < 6, "BATTERY", "MAINS")
    return pd.DataFrame({"ts": ts, "temp": temp, "door": door, "comp": comp, "power": power, "batt": 90})


def test_feature_names_are_unique_and_vectors_match():
    assert len(set(FEATURES)) == len(FEATURES)
    assert len(set(HEALTH_FEATURES)) == len(HEALTH_FEATURES)


def test_deterministic(two_days):
    m = minutes_of(two_days)
    t = T0 + 1500
    np.testing.assert_array_equal(features_at(m, t), features_at(minutes_of(two_days.copy()), t))
    np.testing.assert_array_equal(health_features(m, t), health_features(m, t))
    again, _ = simulate(PROFILES[1], 2, seed=7)
    pd.testing.assert_frame_equal(two_days, again)  # the generator is seeded too


def test_no_look_ahead(two_days):
    """Altering everything after t (values, and minutes added or removed) never changes the vectors at t."""
    m = minutes_of(two_days)
    t = T0 + 1700
    before, before_h = features_at(m, t), health_features(m, t)
    future = two_days["ts"] // 60 > t
    poisoned = two_days.copy()
    poisoned.loc[future, ["temp", "door", "comp", "power", "batt"]] = [40.0, 1.0, 1.0, 1, 3]
    poisoned = poisoned[~(future & (two_days["ts"] // 60 % 3 == 0))]  # and drop some future minutes
    pm = minutes_of(poisoned)
    np.testing.assert_array_equal(before, features_at(pm, t))
    np.testing.assert_array_equal(before_h, health_features(pm, t))


def test_truth_columns_are_never_inputs(two_days):
    m = minutes_of(two_days)
    assert set(m.cols) == {"temp", "door", "comp", "power", "batt"}
    t = T0 + 900
    lied = two_days.assign(efficiency_true=0.0, ambient_true=99.0)
    np.testing.assert_array_equal(features_at(m, t), features_at(minutes_of(lied), t))


def test_missing_minutes(two_days):
    t = T0 + 1200
    gappy = two_days[~((two_days["ts"] // 60).between(t - 40, t - 5))]
    v = dict(zip(FEATURES, features_at(minutes_of(gappy), t), strict=True))
    assert v["missing_frac_60"] == pytest.approx(36 / 60)
    assert math.isfinite(v["temp_now"]) and math.isfinite(v["temp_slope_5"])
    assert math.isnan(v["temp_mean_15"]) is False  # 5 of the last 15 minutes remain
    silent = two_days[~((two_days["ts"] // 60).between(t - 70, t))]
    s = dict(zip(FEATURES, features_at(minutes_of(silent), t), strict=True))
    assert s["missing_frac_60"] == 1.0 and math.isnan(s["temp_now"]) and s["minutes_since_reading"] == 60
    assert math.isnan(s["temp_slope_15"])


def test_train_serve_parity():
    """Serving (raw 5 s readings -> to_minutes -> features) equals the training path on the stored minute
    rows."""
    raw = raw_readings(180)
    stored = to_minutes(raw)  # what the generator writes
    m = Minutes(stored)
    for t in (T0 + 70, T0 + 121, T0 + 179):
        served = serve_features(raw[raw["ts"] // 60 <= t])
        np.testing.assert_array_equal(features_at(m, t), served)
    np.testing.assert_array_equal(serve_features(raw), features_at(m, T0 + 179))


def test_to_minutes_aggregation():
    raw = raw_readings(2)
    raw.loc[raw.index[:12], "temp"] = None  # first minute: no temperature at all
    m = to_minutes(raw)
    assert list(m["minute"]) == [T0, T0 + 1]
    assert math.isnan(m["temp"].iloc[0])
    assert m["door"].between(0, 1).all() and m["comp"].between(0, 1).all()
    assert set(m["power"]) <= {0.0, 1.0}


def test_known_values():
    """A hand-made hour: steady warming, door open for the last 3 minutes, compressor off for 20."""
    minute = np.arange(T0, T0 + 60)
    temp = 3.0 + 0.05 * np.arange(60)
    door = np.r_[np.zeros(57), np.ones(3)]
    comp = np.r_[np.ones(40), np.zeros(20)]
    frame = pd.DataFrame(
        {"minute": minute, "temp": temp, "door": door, "comp": comp, "power": 0.0, "batt": 80.0}
    )
    v = dict(zip(FEATURES, features_at(Minutes(frame), T0 + 59), strict=True))
    assert v["temp_now"] == pytest.approx(5.95)
    assert v["temp_slope_15"] == pytest.approx(0.05)
    assert v["temp_accel"] == pytest.approx(0.0, abs=1e-12)
    assert v["time_to_8"] == pytest.approx((8 - 5.95) / 0.05)
    assert v["door_open_run"] == 3 and v["door_since_open"] == 0 and v["door_frac_5"] == pytest.approx(0.6)
    assert v["comp_on_now"] == 0 and v["comp_run"] == 20 and v["comp_since_off"] == 19
    assert v["comp_switches_60"] == 1 and v["comp_duty_60"] == pytest.approx(40 / 60)
    assert v["min_off_wait"] == 0 and v["batt_now"] == 80 and v["on_battery_now"] == 0


def test_labels():
    minute = np.arange(T0, T0 + 100)
    temp = np.full(100, 5.0)
    temp[70] = 8.5  # one warm minute
    df = pd.DataFrame({"ts": minute * 60, "temp": temp, "efficiency_true": 0.42})
    lab = add_labels(df)
    assert lab["y_temp_30"].iloc[10] == 5.0 and lab["y_temp_30"].iloc[40] == 8.5
    assert (
        lab["y_breach_30"].iloc[40] == 1 and lab["y_breach_30"].iloc[39] == 0
    )  # (t, t+30] reaches 70 from 40
    assert lab["y_breach_30"].iloc[70] == 0  # strictly after t
    assert math.isnan(lab["y_breach_30"].iloc[90])  # fewer than 20 future minutes
    assert lab["y_health"].iloc[0] == pytest.approx(42)


def test_splits_are_time_ordered_and_hold_out_profiles():
    minute = np.arange(T0, T0 + 60 * 1440)
    s = split_for("pharmacy", minute, minute[0], minute[-1], {"city-depot"}, 60)
    first = {name: minute[s == name].min() for name in ("train", "val", "test")}
    last = {name: minute[s == name].max() for name in ("train", "val", "test")}
    assert last["train"] < first["val"] - 30 and last["val"] < first["test"] - 30
    assert (minute[s == "test"].size) == 10 * 1440 - 60
    assert set(split_for("city-depot", minute, minute[0], minute[-1], {"city-depot"}, 60)) == {"test"}


def test_dataset_matrices(two_days):
    f = build_forecast(two_days)
    assert list(f.columns[3 : 3 + len(FEATURES)]) == list(FEATURES)
    assert (f["ts"] // 60 % 5 == 0).all()
    assert "efficiency_true" not in f.columns and "ambient_true" not in f.columns
    h = build_health(two_days)
    assert (h["coverage_hours"] >= 6).all() and h["y_health"].between(0, 100).all()


def test_scenario_counts_over_60_days():
    """The full dataset has every scenario in useful numbers (checked on the schedules, no simulation
    needed)."""
    plans = {p.name: schedule(p, 60, 2026) for p in PROFILES}
    assert sum(len(s.doors) for s in plans.values()) >= 200
    assert sum(len(s.power_failures) for s in plans.values()) >= 20
    for p in PROFILES:
        if p.degrades:
            assert len(plans[p.name].arcs) >= 3, p.name
    assert all(5 <= d <= 300 for s in plans.values() for _, d in s.doors)
    assert all(300 <= d <= 5400 for s in plans.values() for _, d in s.power_failures)
    s = plans["rural-clinic"]
    a, b, low = s.arcs[0]
    assert efficiency_at(s, a) == 1.0 and efficiency_at(s, b - 1) == pytest.approx(low, abs=1e-3)
    assert 24 <= min(p.ambient_c for p in PROFILES) and max(p.ambient_c for p in PROFILES) <= 36
    assert len(PROFILES) >= 6 and sum(not p.held_out for p in PROFILES) >= 4


def test_export_live_uses_the_training_schema(tmp_path):
    import sqlite3

    from data.export_live import COLUMNS, export

    db = tmp_path / "live.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE readings (fridge_id TEXT, ts INTEGER, temp REAL, door INTEGER, comp INTEGER, "
                "power TEXT, batt INTEGER)")  # fmt: skip
    raw = raw_readings(3)
    con.executemany(
        "INSERT INTO readings VALUES ('fridge-01', ?, ?, ?, ?, ?, ?)",
        raw[["ts", "temp", "door", "comp", "power", "batt"]].astype(object).values.tolist(),
    )
    con.commit()
    con.close()
    out = export(db)["fridge-01"]
    assert list(out.columns) == COLUMNS and len(out) == 3
    assert out["efficiency_true"].isna().all()
    np.testing.assert_allclose(out["temp"], to_minutes(raw)["temp"].round(3))
