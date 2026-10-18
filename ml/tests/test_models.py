"""P17: metric functions, warning levels, interval ordering, health score bounds, and the trained models
(beat the baselines; warn early on a door-left-ajar replay)."""

import json
import math
from pathlib import Path

import numpy as np
import pytest

from data.generate import PROFILES, START_TS, Schedule, simulate
from features import FEATURES, HEALTH_FEATURES, Minutes, features_at
from modeling import metrics as M
from modeling.predict import (
    MODELS,
    HealthModel,
    band,
    load,
    order_quantiles,
    prob_level,
    rule_level,
    trend_per_day,
    weakening,
)

ML = Path(__file__).resolve().parents[1]
TRAINED = (MODELS / "forecast.joblib").exists() and (MODELS / "health.joblib").exists()
needs_models = pytest.mark.skipif(not TRAINED, reason="no trained models: run `python -m train`")


def test_regression_and_coverage():
    r = M.regression([1, 2, 3], [1, 2, 5])
    assert r["mae"] == pytest.approx(2 / 3) and r["rmse"] == pytest.approx(math.sqrt(4 / 3))
    assert M.coverage([1, 2, 3, 4], [0, 0, 0, 5], [2, 2, 2, 6]) == 0.5


def test_classification_and_thresholds():
    c = M.classification([1, 1, 0, 0, 1], [1, 0, 0, 1, 1], [0.9, 0.2, 0.1, 0.6, 0.8])
    assert c["confusion"] == {"tn": 1, "fp": 1, "fn": 1, "tp": 2}
    assert c["precision"] == pytest.approx(2 / 3) and c["recall"] == pytest.approx(2 / 3)
    assert 0 <= c["roc_auc"] <= 1 and 0 <= c["pr_auc"] <= 1
    assert M.f_beta(0.5, 1.0, 2) > M.f_beta(1.0, 0.5, 2)  # F2 favours recall
    y = np.r_[np.zeros(900), np.ones(100)]
    score = np.r_[np.linspace(0, 0.5, 900), np.linspace(0.4, 1, 100)]
    thr, f2 = M.best_threshold(y, score)
    assert 0.3 < thr <= 0.5 and f2 > 0.8


def test_episodes_and_lead_time():
    assert M.episodes([0, 1, 1, 0, 0, 1, 0, 1]) == [(1, 3), (5, 6), (7, 8)]
    assert M.episodes([0, 1, 1, 0, 1], max_gap=1) == [(1, 5)]
    assert M.lead_time([0] * 20 + [1] * 10) == 10
    assert M.lead_time([0] * 20 + [1, 1, 0, 1, 1, 1, 1, 0, 1, 1]) == 10  # short gaps do not restart the run
    assert M.lead_time([1] * 5 + [0] * 25) == 0  # warned, then quiet: missed
    assert M.lead_time([0] * 30) == 0


def test_warning_levels():
    assert list(rule_level([7.0, 8.2, 7.5, 7.5], [8.5, 8.6, 9.2, 7.9])) == [1, 2, 2, 0]
    assert list(prob_level([0.05, 0.2, 0.8], 0.1, 0.7)) == [0, 1, 2]


def test_quantiles_never_cross():
    rng = np.random.default_rng(0)
    p10, pred, p90 = (rng.normal(5, 2, 1000) for _ in range(3))
    lo, mid, hi = order_quantiles(p10, pred, p90)
    assert (lo <= mid).all() and (mid <= hi).all()


def test_health_band_weakening_trend():
    assert [band(s) for s in (100, 80, 79.9, 50, 49, math.nan)] == [
        "GOOD", "GOOD", "WEAKENING", "WEAKENING", "FAILING", "UNKNOWN"]  # fmt: skip
    assert weakening(69, 0) and not weakening(85, -1) and weakening(85, -6) and not weakening(85, None)
    ts = np.arange(25) * 3600
    assert trend_per_day(ts, 90 - ts / 86400 * 7) == pytest.approx(-7)
    assert math.isnan(trend_per_day(ts[:2], [1, 2]))


class _Const:
    def __init__(self, v):
        self.v = v

    def predict(self, X):
        return np.full(len(X), self.v)

    def score_samples(self, X):
        return np.zeros(len(X))


def test_health_score_bounds_and_fallback():
    bundle = {
        "regressor": _Const(140.0),  # out of range on purpose
        "iforest": _Const(0.0),
        "medians": np.zeros(len(HEALTH_FEATURES)),
        "anomaly": {"q50": -0.6, "q95": -0.5},  # score 0 -> (0.5 / 0.4) clipped to 1: fully anomalous
        "anomaly_weight": 20.0,
        "fallback": {"pull_median": 0.8, "warm_median": 0.3},
    }
    X = np.full((2, len(HEALTH_FEATURES)), np.nan)
    X[0, HEALTH_FEATURES.index("n_cycles")] = 6
    X[1, HEALTH_FEATURES.index("n_cycles")] = 1
    X[1, HEALTH_FEATURES.index("cool_rate_on")] = 0.1  # pull 0.1 + 0.3 = half the healthy median
    s = HealthModel(bundle).score(X)
    assert s["health"].between(0, 100).all()
    assert s["health"][0] == pytest.approx(80) and s["method"][0] == "model"  # 100 - 20 x 1
    assert s["health"][1] == pytest.approx(50) and s["method"][1] == "fallback"


@needs_models
def test_trained_models_outputs_are_ordered_and_bounded():
    forecaster, health = load()
    rng = np.random.default_rng(1)
    X = rng.normal(5, 3, (200, len(FEATURES)))
    X[::7] = np.nan  # whole rows missing: still an answer, never a crash
    out = forecaster.predict(X)
    assert (out["p10"] <= out["pred"]).all() and (out["pred"] <= out["p90"]).all()
    assert out["prob"].between(0, 1).all() and set(out["level"]) <= {"LOW", "MEDIUM", "HIGH"}
    H = rng.normal(0, 1, (100, len(HEALTH_FEATURES)))
    H[::5] = np.nan
    s = health.score(H)
    known = s["method"] != "insufficient"
    assert s["health"][known].between(0, 100).all() and s["health"][~known].isna().all()
    assert set(s.loc[~known, "band"]) <= {"UNKNOWN"}
    with pytest.raises(ValueError):
        load(ML / "tests")  # models only from ml/models


@needs_models
def test_chosen_model_beats_baselines():
    metrics = ML / "reports" / "metrics.json"
    r = json.loads(metrics.read_text(encoding="utf-8"))
    models = r["forecast"]["models"]
    for baseline in ("persistence", "linear", "physics"):
        assert models["hgb"]["mae"] < models[baseline]["mae"], baseline
        assert models["hgb"]["rmse"] < models[baseline]["rmse"], baseline
    assert 0.7 <= r["forecast"]["interval"]["coverage"] <= 0.9
    assert r["forecast"]["breach"]["recall"] > 0.5


@needs_models
def test_door_left_ajar_replay_warns_at_least_10_minutes_ahead():
    """Held-out fridge, quiet night, door left ajar at 03:00: the temperature creeps past 8 °C; the warning
    must come at least 10 minutes before it does (forecast every minute, as the service runs)."""
    forecaster, _ = load()
    p = next(p for p in PROFILES if p.name == "city-depot")
    k = p.cool_rate * 1.2 / (p.ambient_c - 7.0) - p.leak
    start = 180
    df, _ = simulate(p, 1, seed=11, plan=Schedule(ajar=[(start * 60, 90 * 60, k)]))
    temps = df.set_index(df["ts"] // 60)["temp"]
    t0 = START_TS // 60 + start
    cross = next(t for t in range(t0, t0 + 90) if temps.get(t, 0) > 8)
    assert cross - t0 >= 15  # a slow creep, not a door flung open
    m = Minutes(df.assign(minute=df["ts"] // 60))
    minutes = range(t0 - 10, cross)
    levels = forecaster.predict(np.vstack([features_at(m, w) for w in minutes]))["level"].to_numpy()
    assert (levels[:10] == "LOW").all()  # quiet before the door was left open
    lead = M.lead_time(levels != "LOW")
    assert lead >= 10, f"warning only {lead} min before the breach"
