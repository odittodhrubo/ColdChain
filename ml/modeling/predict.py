"""Serving side of the models: load the trained bundles and turn feature vectors into a forecast with a
warning level, and a 0-100 compressor health score with band and weakening flag. Used by the API (P18) and
the tests.

Models are loaded only from ml/models (a trusted path inside the service); nothing user-supplied is unpickled.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from constants import SAFE_MAX_C
from features import FEATURES, HEALTH_FEATURES

MODELS = Path(__file__).resolve().parents[1] / "models"
LEVELS = ("LOW", "MEDIUM", "HIGH")
WEAK_BELOW = 70.0
WEAK_TREND_PER_DAY = -5.0
MIN_CYCLES = 3


# ------------------------------------------------------------------------------------- forecast and warning


def order_quantiles(p10, pred, p90) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Quantile models can cross; sorting the three per row restores p10 <= pred <= p90."""
    s = np.sort(np.column_stack([p10, pred, p90]).astype(float), axis=1)
    return s[:, 0], s[:, 1], s[:, 2]


def rule_level(pred, p90) -> np.ndarray:
    """HIGH if pred > 8 or p90 > 9; MEDIUM if p90 > 8; LOW otherwise (index into LEVELS)."""
    pred, p90 = np.asarray(pred, float), np.asarray(p90, float)
    return np.where((pred > SAFE_MAX_C) | (p90 > SAFE_MAX_C + 1), 2, np.where(p90 > SAFE_MAX_C, 1, 0))


def prob_level(prob, medium: float, high: float) -> np.ndarray:
    prob = np.asarray(prob, float)
    return np.where(prob >= high, 2, np.where(prob >= medium, 1, 0))


@dataclass
class Forecaster:
    bundle: dict

    def predict(self, X: np.ndarray) -> pd.DataFrame:
        """X: rows of FEATURES. Returns pred / p10 / p90 (°C at +30 min), breach probability and level."""
        X = pd.DataFrame(np.atleast_2d(np.asarray(X, float)), columns=FEATURES)
        b = self.bundle
        m = b.get("interval_margin", 0.0)  # conformal adjustment fitted on validation (80 % coverage)
        p10, pred, p90 = order_quantiles(
            b["p10"].predict(X) - m, b["p50"].predict(X), b["p90"].predict(X) + m
        )
        prob = b["classifier"].predict_proba(X)[:, 1]
        if b["method"] == "classifier":
            level = prob_level(prob, b["thresholds"]["medium"], b["thresholds"]["high"])
        else:
            level = rule_level(pred, p90)
        return pd.DataFrame(
            {"pred": pred, "p10": p10, "p90": p90, "prob": prob, "level": [LEVELS[i] for i in level]}
        )


# ------------------------------------------------------------------------------------- compressor health


def band(score: float) -> str:
    if math.isnan(score):
        return "UNKNOWN"
    return "GOOD" if score >= 80 else "WEAKENING" if score >= 50 else "FAILING"


def weakening(score: float, trend_per_day: float | None) -> bool:
    """Weak when below 70, or falling faster than 5 points a day over the last 24 h."""
    return (not math.isnan(score) and score < WEAK_BELOW) or (
        trend_per_day is not None and not math.isnan(trend_per_day) and trend_per_day < WEAK_TREND_PER_DAY
    )


MIN_TREND_SPAN_S = 6 * 3600


def trend_per_day(ts_s, scores, min_span_s: float = MIN_TREND_SPAN_S) -> float:
    """Least-squares slope of recent scores, in points per day. NaN with fewer than 3 points or less than 6 h
    between the first and the last: minutes of jitter extrapolated to a day would read as a collapse."""
    ts, y = np.asarray(ts_s, float), np.asarray(scores, float)
    ok = ~np.isnan(y)
    if ok.sum() < 3 or np.ptp(ts[ok]) < min_span_s:
        return math.nan
    ts, y = ts[ok] / 86400.0, y[ok]
    tm = ts - ts.mean()
    return float((tm * (y - y.mean())).sum() / (tm * tm).sum())


@dataclass
class HealthModel:
    bundle: dict

    def anomaly(self, X: np.ndarray) -> np.ndarray:
        """0 = like healthy training cycles, 1 = far outside them (IsolationForest, scaled on healthy
        train)."""
        b = self.bundle
        filled = np.where(np.isnan(X), b["medians"], X)
        s = -b["iforest"].score_samples(filled)
        a = b["anomaly"]
        return np.clip((s - a["q95"]) / (4 * (a["q95"] - a["q50"])), 0.0, 1.0)

    def fallback(self, X: np.ndarray) -> np.ndarray:
        """Rule when fewer than 3 cycles: cooling capacity (cooling rate ON + warming rate OFF, i.e. the
        compressor's own pull) against the healthy training median, as a percentage."""
        f = self.bundle["fallback"]
        i_cool, i_warm = HEALTH_FEATURES.index("cool_rate_on"), HEALTH_FEATURES.index("warm_rate_off")
        warm = np.where(np.isnan(X[:, i_warm]), f["warm_median"], X[:, i_warm])
        pull = X[:, i_cool] + warm
        return np.clip(100 * pull / f["pull_median"], 0, 100)

    def score(self, X: np.ndarray) -> pd.DataFrame:
        """X: rows of HEALTH_FEATURES. health = clip(model - 20 x anomaly, 0, 100); the rule-based fallback
        when the window holds fewer than 3 cycles; NaN ("insufficient") when not even that can be measured."""
        X = np.atleast_2d(np.asarray(X, float))
        b = self.bundle
        model = np.clip(b["regressor"].predict(pd.DataFrame(X, columns=HEALTH_FEATURES)), 0, 100)
        anomaly = self.anomaly(X)
        blended = np.clip(model - b["anomaly_weight"] * anomaly, 0, 100)
        few = np.nan_to_num(X[:, HEALTH_FEATURES.index("n_cycles")], nan=0) < MIN_CYCLES
        fb = self.fallback(X)
        health = np.where(few, fb, blended)
        method = np.where(few, np.where(np.isnan(fb), "insufficient", "fallback"), "model")
        return pd.DataFrame(
            {
                "health": health,  # NaN only with method "insufficient": no compressor data to judge
                "model": model,
                "anomaly": anomaly,
                "method": method,
                "band": [band(h) for h in health],
            }
        )


def load(directory: Path = MODELS) -> tuple[Forecaster, HealthModel]:
    """The trained bundles from ml/models. Refuses anything outside that directory."""
    directory = directory.resolve()
    if directory != MODELS.resolve():
        raise ValueError("models are only loaded from ml/models")
    forecast = joblib.load(directory / "forecast.joblib")
    health = joblib.load(directory / "health.joblib")
    if list(forecast["features"]) != list(FEATURES) or list(health["features"]) != list(HEALTH_FEATURES):
        raise ValueError("model was trained on a different feature list: retrain (npm run ml:train)")
    return Forecaster(forecast), HealthModel(health)
