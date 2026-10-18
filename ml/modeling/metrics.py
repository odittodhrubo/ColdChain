"""Metric functions used by training, the report and the tests. Plain numpy / scikit-learn, no state."""

from __future__ import annotations

import math

import numpy as np
from scipy.stats import spearmanr
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    mean_absolute_error,
    mean_squared_error,
    r2_score,
    roc_auc_score,
)


def regression(y, pred) -> dict:
    y, pred = np.asarray(y, float), np.asarray(pred, float)
    return {
        "mae": float(mean_absolute_error(y, pred)),
        "rmse": float(math.sqrt(mean_squared_error(y, pred))),
        "r2": float(r2_score(y, pred)),
        "n": int(y.size),
    }


def coverage(y, lo, hi) -> float:
    """Share of outcomes inside [lo, hi] (target 0.8 for a 10-90 % interval)."""
    y = np.asarray(y, float)
    return float(((y >= lo) & (y <= hi)).mean())


def f_beta(precision: float, recall: float, beta: float = 2.0) -> float:
    """F2 by default: recall counts twice, because a missed breach is worse than a false alarm."""
    if precision + recall == 0:
        return 0.0
    b2 = beta * beta
    return (1 + b2) * precision * recall / (b2 * precision + recall)


def classification(y, warn, score=None) -> dict:
    """Binary warning quality. `score` (higher = more likely) adds ROC-AUC and PR-AUC."""
    y, warn = np.asarray(y).astype(bool), np.asarray(warn).astype(bool)
    tn, fp, fn, tp = confusion_matrix(y, warn, labels=[False, True]).ravel()
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    out = {
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f_beta(precision, recall, 1.0)),
        "f2": float(f_beta(precision, recall, 2.0)),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
        "positives": int(y.sum()),
        "n": int(y.size),
    }
    if score is not None and 0 < y.sum() < y.size:
        score = np.nan_to_num(np.asarray(score, float), nan=-np.inf)
        out["roc_auc"] = float(roc_auc_score(y, score))
        out["pr_auc"] = float(average_precision_score(y, score))
    return out


def best_threshold(y, score, beta: float = 2.0) -> tuple[float, float]:
    """Threshold on `score` that maximises F-beta; returns (threshold, F-beta)."""
    y = np.asarray(y).astype(bool)
    score = np.asarray(score, float)
    best = (0.5, -1.0)
    for thr in np.unique(np.quantile(score, np.linspace(0.5, 0.999, 200))):
        warn = score >= thr
        tp = (warn & y).sum()
        p = tp / warn.sum() if warn.sum() else 0.0
        r = tp / y.sum() if y.sum() else 0.0
        f = f_beta(p, r, beta)
        if f > best[1]:
            best = (float(thr), float(f))
    return best


def episodes(flags: np.ndarray, max_gap: int = 0) -> list[tuple[int, int]]:
    """[start, end) index ranges of True runs, merging runs separated by at most `max_gap` False."""
    idx = np.flatnonzero(np.asarray(flags, bool))
    if not idx.size:
        return []
    out, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev > max_gap + 1:
            out.append((int(start), int(prev) + 1))
            start = i
        prev = i
    out.append((int(start), int(prev) + 1))
    return out


def lead_time(warn_before: np.ndarray) -> int:
    """Minutes of warning before a breach onset. `warn_before[i]` = warning at onset - len + i; the run that
    is still active one or two minutes before the onset counts (gaps up to 2 min allowed); 0 = missed."""
    w = np.asarray(warn_before, bool)
    if not w[-2:].any():
        return 0
    runs = episodes(w, max_gap=2)
    return int(w.size - runs[-1][0])


def spearman(a, b) -> float:
    return float(spearmanr(a, b).statistic)


def percentile(values, q: float) -> float | None:
    v = np.asarray(values, float)
    return float(np.percentile(v, q)) if v.size else None
