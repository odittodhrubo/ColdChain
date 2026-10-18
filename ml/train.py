"""Train, evaluate and package the forecast and compressor-health models; write metrics, figures, REPORT.md.

    python -m train          # from ml/ (npm run ml:train / make train); builds the dataset first if missing

Everything is seeded. Choices (hyper-parameters, warning method and thresholds) are made on the validation
split; every number in reports/ is measured once, on the test split (held-out profiles + last 10 days).
"""

from __future__ import annotations

import json
import platform
import sys
import time
import warnings
from datetime import UTC, datetime
from pathlib import Path

import joblib
import matplotlib
import numpy as np
import pandas as pd
import sklearn
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import (
    HistGradientBoostingClassifier,
    HistGradientBoostingRegressor,
    IsolationForest,
    RandomForestRegressor,
)
from sklearn.frozen import FrozenEstimator
from sklearn.inspection import permutation_importance

from constants import SAFE_MAX_C
from data.dataset import DATA, HORIZONS, load, split_for
from data.generate import PROFILES, START_TS, load_raw, schedule
from features import FEATURES, HEALTH_FEATURES, WINDOW_MIN, Minutes, features_at
from modeling import metrics as M
from modeling.baselines import BASELINES
from modeling.predict import MODELS, Forecaster, HealthModel, rule_level, trend_per_day, weakening

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ML = Path(__file__).resolve().parent
REPORTS = ML / "reports"
SEED = 7
GRID = [{"learning_rate": 0.05, "max_leaf_nodes": leaves} for leaves in (63, 127)]
INTERVAL = 0.8  # p10-p90
HEALTHY = 95.0  # y_health at or above: "healthy" cycles for the anomaly model and the fallback baseline
ANOMALY_WEIGHT = 20.0
DOOR_COLS = [c for c in FEATURES if c.startswith("door_")]
COMP_COLS = [c for c in FEATURES if c.startswith("comp_")] + ["min_off_wait"]


def hgb(**kw) -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        max_iter=600, min_samples_leaf=40, early_stopping=False, random_state=SEED, **kw
    )


def xy(df: pd.DataFrame, label: str, cols=FEATURES) -> tuple[pd.DataFrame, np.ndarray]:
    ok = df[label].notna() & df["temp_now"].notna()
    return df.loc[ok, list(cols)], df.loc[ok, label].to_numpy(float)


# ----------------------------------------------------------------------------------------------- forecaster


def train_forecaster(fc: pd.DataFrame) -> tuple[dict, dict]:
    tr, va, te = (fc[fc["split"] == s] for s in ("train", "val", "test"))
    Xtr, ytr = xy(tr, "y_temp_30")
    Xva, yva = xy(va, "y_temp_30")
    search = []
    for params in GRID:
        mae = M.regression(yva, hgb(loss="absolute_error", **params).fit(Xtr, ytr).predict(Xva))["mae"]
        search.append({**params, "val_mae": round(mae, 4)})
    best = min(search, key=lambda r: r["val_mae"])
    params = {k: best[k] for k in ("learning_rate", "max_leaf_nodes")}
    print(f"forecaster: best {params} (val MAE {best['val_mae']:.3f})")
    p50 = hgb(loss="absolute_error", **params).fit(Xtr, ytr)  # the median: MAE's own minimiser
    p10 = hgb(loss="quantile", quantile=0.1, **params).fit(Xtr, ytr)
    p90 = hgb(loss="quantile", quantile=0.9, **params).fit(Xtr, ytr)
    # conformalised quantiles: widen (or narrow) both ends by the margin that makes validation coverage 80 %
    lo, hi = p10.predict(Xva), p90.predict(Xva)
    margin = float(np.quantile(np.maximum(lo - yva, yva - hi), INTERVAL))
    rf = RandomForestRegressor(
        n_estimators=150, min_samples_leaf=5, max_features=0.5, n_jobs=-1, random_state=SEED
    ).fit(Xtr, ytr)

    # breach warning: rule on the forecast vs a calibrated classifier, chosen on validation F2 (recall first)
    Xtr_c, ytr_c = xy(tr, "y_breach_30")
    Xva_c, yva_c = xy(va, "y_breach_30")
    clf = HistGradientBoostingClassifier(
        max_iter=300, early_stopping=False, class_weight="balanced", random_state=SEED, **params
    ).fit(Xtr_c, ytr_c)  # rebalanced in training only
    cal = CalibratedClassifierCV(FrozenEstimator(clf), method="isotonic").fit(Xva_c, yva_c)
    prob_va = cal.predict_proba(Xva_c)[:, 1]
    medium, f2 = M.best_threshold(yva_c, prob_va, beta=2.0)
    high, _ = M.best_threshold(yva_c, prob_va, beta=0.5)
    high = max(high, medium)
    bundle = {"p50": p50, "p10": p10, "p90": p90, "classifier": cal, "features": list(FEATURES),
              "interval_margin": margin}  # fmt: skip
    fz = Forecaster({**bundle, "method": "rule", "thresholds": {"medium": medium, "high": high}})
    rule_va = fz.predict(Xva_c)["level"] != "LOW"
    choice = {
        "rule": M.classification(yva_c, rule_va),
        "classifier": M.classification(yva_c, prob_va >= medium, prob_va),
    }
    method = max(choice, key=lambda k: (choice[k]["f2"], choice[k]["recall"]))
    print(f"warning method: {method} (val F2 rule {choice['rule']['f2']:.3f}, classifier {f2:.3f})")
    bundle |= {"method": method, "thresholds": {"medium": float(medium), "high": float(high)}}

    # shorter horizons only feed the error-by-horizon table: same settings, half the trees
    short = {
        "loss": "absolute_error",
        "max_iter": 300,
        "learning_rate": 0.1,
        "max_leaf_nodes": params["max_leaf_nodes"],
    }
    horizons = {
        h: HistGradientBoostingRegressor(
            min_samples_leaf=40, early_stopping=False, random_state=SEED, **short
        )
        for h in HORIZONS
        if h != 30
    }
    for h, model in horizons.items():
        model.fit(*xy(tr, f"y_temp_{h}"))
    horizons[30] = p50
    info = {
        "params": params,
        "grid": search,
        "validation_choice": {k: _round(v) for k, v in choice.items()},
        "method": method,
        "thresholds": bundle["thresholds"],
        "interval_margin": margin,
        "_rf": rf,
        "_horizons": horizons,
        "_test": te,
    }
    return bundle, info


def evaluate_forecaster(bundle: dict, info: dict, raw: pd.DataFrame) -> dict:
    te = info["_test"]
    model = Forecaster(bundle)
    X, y = xy(te, "y_temp_30")
    out = model.predict(X)
    models = {
        "hgb": out["pred"].to_numpy(),
        "random_forest": info["_rf"].predict(X),
        **{name: fn(X, 30) for name, fn in BASELINES.items()},
    }
    res = {"models": {k: M.regression(y, p) for k, p in models.items()}}
    res["interval"] = {
        "coverage": M.coverage(y, out["p10"], out["p90"]),
        "mean_width": float((out["p90"] - out["p10"]).mean()),
        "raw_quantile_coverage": M.coverage(y, bundle["p10"].predict(X), bundle["p90"].predict(X)),
        "crossed_before_sorting": int((bundle["p10"].predict(X) > bundle["p90"].predict(X)).sum()),
    }
    by_h = {}
    for h in HORIZONS:
        Xh, yh = xy(te, f"y_temp_{h}")
        by_h[h] = {
            "hgb": M.regression(yh, info["_horizons"][h].predict(Xh))["mae"],
            **{name: M.regression(yh, fn(Xh, h))["mae"] for name, fn in BASELINES.items()},
        }
    res["mae_by_horizon"] = by_h
    context = np.where(
        X["battery_minutes_60"] > 0, "power_fail", np.where(X["door_frac_15"] > 0, "door_open", "normal")
    )
    res["mae_by_context"] = {
        c: {
            "hgb": M.regression(y[context == c], models["hgb"][context == c])["mae"],
            "persistence": M.regression(y[context == c], models["persistence"][context == c])["mae"],
            "n": int((context == c).sum()),
        }
        for c in ("normal", "door_open", "power_fail")
    }

    Xc, yc = xy(te, "y_breach_30")
    pc = model.predict(Xc)
    warn = (pc["level"] != "LOW").to_numpy()
    score = pc["prob"] if bundle["method"] == "classifier" else pc["p90"]
    res["breach"] = M.classification(yc, warn, score)
    res["breach_by_method"] = {
        "rule": M.classification(yc, rule_level(pc["pred"], pc["p90"]) >= 1, pc["p90"]),
        "classifier": M.classification(yc, pc["prob"] >= bundle["thresholds"]["medium"], pc["prob"]),
    }
    meta = te.loc[Xc.index, ["fridge_profile", "ts"]]
    false_eps = 0
    for _, g in meta.assign(fa=warn & (yc == 0)).groupby("fridge_profile"):
        false_eps += len(M.episodes(g.sort_values("ts")["fa"].to_numpy()))
    fridge_days = len(te) * 5 / 1440
    res["breach"]["false_alarms_per_fridge_day"] = false_eps / fridge_days
    res["breach"]["fridge_days"] = fridge_days
    res["lead_time"] = lead_times(model, raw)
    res["_pred"] = (X, y, out)
    res["_confusion_warn"] = (yc, warn)
    return res


def lead_times(model: Forecaster, raw: pd.DataFrame) -> dict:
    """Per breach episode in the test period: minutes of warning before the temperature first exceeds 8 °C,
    from a forecast made every minute (as the service does) over the 30 minutes before the onset."""
    held = {p.name for p in PROFILES if p.held_out}
    leads, per_profile = [], {}
    for profile, df in raw.groupby("fridge_profile", sort=True):
        minute = (df["ts"] // 60).to_numpy()
        split = split_for(profile, minute, minute[0], minute[-1], held, WINDOW_MIN)
        temp = pd.Series(df["temp"].to_numpy(), index=minute)
        m = Minutes(df.assign(minute=minute))
        test_min = set(minute[split == "test"])
        onsets = []
        for t in minute[split == "test"]:
            prev = temp.get(t - 1)
            if temp[t] > SAFE_MAX_C and prev is not None and prev <= SAFE_MAX_C:
                window = temp.reindex(range(t - 30, t))
                if (
                    (window.dropna() <= SAFE_MAX_C).all()
                    and (t - 30) in test_min
                    and t - 30 - minute[0] >= 59
                ):
                    onsets.append(int(t))
        if not onsets:
            continue
        X = np.vstack([features_at(m, w) for t in onsets for w in range(t - 30, t)])
        warn = (model.predict(X)["level"] != "LOW").to_numpy().reshape(len(onsets), 30)
        lp = [M.lead_time(row) for row in warn]
        per_profile[profile] = {"episodes": len(lp), "warned": int(np.count_nonzero(lp))}
        leads += lp
    leads_arr = np.array(leads)
    warned = leads_arr[leads_arr > 0]
    return {
        "episodes": int(leads_arr.size),
        "warned_share": float((leads_arr > 0).mean()) if leads_arr.size else None,
        "median_min": M.percentile(warned, 50),
        "p10_min": M.percentile(warned, 10),
        "median_including_missed_min": M.percentile(leads_arr, 50),
        "share_at_least_10_min": float((leads_arr >= 10).mean()) if leads_arr.size else None,
        "per_profile": per_profile,
    }


# ----------------------------------------------------------------------------------------------- health


def train_health(hl: pd.DataFrame) -> tuple[dict, dict]:
    tr, va = hl[hl["split"] == "train"], hl[hl["split"] == "val"]
    cols = list(HEALTH_FEATURES)
    search = []
    for params in GRID:
        model = hgb(**params).fit(tr[cols], tr["y_health"])
        search.append(
            {**params, "val_mae": round(M.regression(va["y_health"], model.predict(va[cols]))["mae"], 3)}
        )
    best = min(search, key=lambda r: r["val_mae"])
    params = {k: best[k] for k in ("learning_rate", "max_leaf_nodes")}
    reg = hgb(**params).fit(tr[cols], tr["y_health"])
    healthy = tr[tr["y_health"] >= HEALTHY]
    medians = tr[cols].median().to_numpy()
    filled = np.where(np.isnan(healthy[cols].to_numpy()), medians, healthy[cols].to_numpy())
    iforest = IsolationForest(n_estimators=200, random_state=SEED).fit(filled)
    s = -iforest.score_samples(filled)
    cyc = healthy[
        (healthy["n_cycles"] >= 3) & healthy["cool_rate_on"].notna() & healthy["warm_rate_off"].notna()
    ]
    bundle = {
        "regressor": reg,
        "iforest": iforest,
        "medians": medians,
        "anomaly": {"q50": float(np.percentile(s, 50)), "q95": float(np.percentile(s, 95))},
        "anomaly_weight": ANOMALY_WEIGHT,
        "fallback": {
            "pull_median": float((cyc["cool_rate_on"] + cyc["warm_rate_off"]).median()),
            "warm_median": float(cyc["warm_rate_off"].median()),
        },
        "features": cols,
    }
    print(f"health: best {params} (val MAE {best['val_mae']:.2f})")
    return bundle, {"params": params, "grid": search, "healthy_rows": len(healthy)}


def evaluate_health(bundle: dict, hl: pd.DataFrame, seed: int, days: int) -> dict:
    te = hl[hl["split"] == "test"].sort_values(["fridge_profile", "ts"])
    model = HealthModel(bundle)
    sc = model.score(te[list(HEALTH_FEATURES)].to_numpy())
    y = te["y_health"].to_numpy()
    res = {
        "final": M.regression(y, sc["health"]),
        "model_only": M.regression(y, sc["model"]),
        "blended_no_fallback": M.regression(y, np.clip(sc["model"] - ANOMALY_WEIGHT * sc["anomaly"], 0, 100)),
        "spearman": M.spearman(sc["health"], y),
        "fallback_share": float((sc["method"] == "fallback").mean()),
        "fallback_mae": (
            M.regression(y[sc["method"] == "fallback"], sc["health"][sc["method"] == "fallback"])["mae"]
            if (sc["method"] == "fallback").any()
            else None
        ),
    }
    te = te.assign(score=sc["health"].to_numpy())
    flags, delays = [], []
    for profile, g in te.groupby("fridge_profile"):
        ts, scores = g["ts"].to_numpy(), g["score"].to_numpy()
        trend = [
            trend_per_day(ts[max(0, i - 23) : i + 1], scores[max(0, i - 23) : i + 1]) for i in range(len(g))
        ]
        flag = np.array([weakening(s, t) for s, t in zip(scores, trend, strict=True)])
        flags.append(pd.DataFrame({"flag": flag, "y": g["y_health"].to_numpy()}))
        p = next(p for p in PROFILES if p.name == profile)
        for a, _b, _low in schedule(p, days, seed).arcs:
            onset = START_TS + a
            if not (ts.min() <= onset <= ts.max()):
                continue
            hit = np.flatnonzero((ts >= onset) & flag)
            delays.append(round((ts[hit[0]] - onset) / 86400, 2) if hit.size else None)
    f = pd.concat(flags)
    res["weakening"] = {
        "arcs_in_test": len(delays),
        "detected": sum(d is not None for d in delays),
        "detection_delay_days": delays,
        "median_delay_days": M.percentile([d for d in delays if d is not None], 50),
        "false_flag_rate_healthy": float(f.loc[f["y"] >= HEALTHY, "flag"].mean()),
        "flag_rate_below_70": float(f.loc[f["y"] < 70, "flag"].mean()) if (f["y"] < 70).any() else None,
    }
    res["_scores"] = (te, sc)
    return res


# ----------------------------------------------------------------------------------------------- extras


def importance(bundle: dict, hbundle: dict, fc: pd.DataFrame, hl: pd.DataFrame) -> dict:
    te = fc[fc["split"] == "test"]
    X, y = xy(te, "y_temp_30")
    idx = np.random.default_rng(SEED).choice(len(X), size=min(4000, len(X)), replace=False)
    pf = permutation_importance(bundle["p50"], X.iloc[idx], y[idx], n_repeats=5, random_state=SEED,
                                scoring="neg_mean_absolute_error")  # fmt: skip
    ht = hl[hl["split"] == "test"]
    ph = permutation_importance(hbundle["regressor"], ht[list(HEALTH_FEATURES)], ht["y_health"], n_repeats=5,
                                random_state=SEED, scoring="neg_mean_absolute_error")  # fmt: skip
    top = lambda names, r: sorted(  # noqa: E731
        ({"feature": n, "mae_increase": float(v)} for n, v in zip(names, r.importances_mean, strict=True)),
        key=lambda d: -d["mae_increase"],
    )
    return {"forecast": top(FEATURES, pf)[:12], "health": top(HEALTH_FEATURES, ph)[:10]}


def ablation(fc: pd.DataFrame, params: dict, p50) -> dict:
    tr, te = fc[fc["split"] == "train"], fc[fc["split"] == "test"]
    out = {}
    for name, drop in (("all_features", []), ("no_door", DOOR_COLS), ("no_compressor", COMP_COLS)):
        cols = [c for c in FEATURES if c not in drop]
        model = p50 if not drop else hgb(loss="absolute_error", **params).fit(*xy(tr, "y_temp_30", cols))
        Xt, yt = xy(te, "y_temp_30", cols)
        pred = model.predict(Xt)
        _, yb = xy(te, "y_breach_30", cols)
        ok = te["y_temp_30"].notna() & te["y_breach_30"].notna() & te["temp_now"].notna()
        warn = model.predict(te.loc[ok, cols]) > SAFE_MAX_C
        out[name] = {**M.regression(yt, pred), "breach_recall_pred_gt_8": M.classification(
            te.loc[ok, "y_breach_30"], warn)["recall"]}  # fmt: skip
    return out


def _round(d):
    if isinstance(d, dict):
        return {k: _round(v) for k, v in d.items() if not str(k).startswith("_")}
    if isinstance(d, list):
        return [_round(v) for v in d]
    if isinstance(d, float):
        return round(d, 4)
    return d


# ----------------------------------------------------------------------------------------------- figures


def figures(fres: dict, hres: dict, imp: dict) -> None:
    REPORTS.mkdir(parents=True, exist_ok=True)
    X, y, out = fres["_pred"]
    rng = np.random.default_rng(SEED)
    idx = rng.choice(len(y), size=min(6000, len(y)), replace=False)
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    ax[0].scatter(y[idx], out["pred"].to_numpy()[idx], s=3, alpha=0.3, color="#0f766e")
    lim = [min(y.min(), 0), max(y.max(), 14)]
    ax[0].plot(lim, lim, color="#334155", lw=1)
    ax[0].axhline(8, color="#b91c1c", lw=0.8, ls="--")
    ax[0].axvline(8, color="#b91c1c", lw=0.8, ls="--")
    ax[0].set(xlabel="actual °C at +30 min", ylabel="forecast °C", title="Forecast vs actual (test)")
    meta = fres["_meta"]
    first = meta[meta["fridge_profile"] == meta["fridge_profile"].iloc[0]].sort_values("ts")
    hot = np.flatnonzero(first["y"].to_numpy() > SAFE_MAX_C)
    at = max(0, hot[0] - 36) if hot.size else 0  # 6 hours around the first breach the forecast had to see
    one = first.iloc[at : at + 72]
    t = (one["ts"] - one["ts"].iloc[0]) / 3600
    ax[1].fill_between(t, one["p10"], one["p90"], color="#99f6e4", label="p10–p90")
    ax[1].plot(t, one["pred"], color="#0f766e", lw=1.2, label="forecast")
    ax[1].plot(t, one["y"], color="#0f172a", lw=1, label="actual")
    ax[1].axhline(8, color="#b91c1c", lw=0.8, ls="--")
    ax[1].set(xlabel="hours", ylabel="°C at +30 min", title=f"6 hours, {meta['fridge_profile'].iloc[0]}")
    ax[1].legend(fontsize=8, loc="upper right")
    fig.tight_layout()
    fig.savefig(REPORTS / "actual_vs_pred.png", dpi=130)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(6, 4))
    hs = list(HORIZONS)
    for name, color in (
        ("persistence", "#94a3b8"),
        ("linear", "#f59e0b"),
        ("physics", "#6366f1"),
        ("hgb", "#0f766e"),
    ):
        ax.plot(hs, [fres["mae_by_horizon"][h][name] for h in hs], marker="o", label=name, color=color)
    ax.set(xlabel="horizon (min)", ylabel="MAE (°C)", title="Error by horizon (test)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(REPORTS / "error_by_horizon.png", dpi=130)
    plt.close(fig)

    c = fres["breach"]["confusion"]
    fig, ax = plt.subplots(figsize=(4.2, 3.8))
    mat = np.array([[c["tn"], c["fp"]], [c["fn"], c["tp"]]])
    ax.imshow(mat, cmap="Greens")
    for i in range(2):
        for j in range(2):
            ax.text(j, i, f"{mat[i, j]:,}", ha="center", va="center", fontsize=11)
    ax.set_xticks([0, 1], ["no warning", "warning"])
    ax.set_yticks([0, 1], ["no breach", "breach in 30 min"])
    ax.set_title("Breach warnings (test)")
    fig.tight_layout()
    fig.savefig(REPORTS / "confusion_matrix.png", dpi=130)
    plt.close(fig)

    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    for a, key, title in ((ax[0], "forecast", "Forecaster"), (ax[1], "health", "Health model")):
        items = imp[key][::-1]
        a.barh([d["feature"] for d in items], [d["mae_increase"] for d in items], color="#0f766e")
        a.set(xlabel="MAE increase when shuffled", title=f"{title}: permutation importance")
    fig.tight_layout()
    fig.savefig(REPORTS / "feature_importance.png", dpi=130)
    plt.close(fig)

    te, sc = hres["_scores"]
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    ax[0].scatter(te["y_health"], sc["health"], s=4, alpha=0.3, color="#0f766e")
    ax[0].plot([0, 100], [0, 100], color="#334155", lw=1)
    ax[0].set(
        xlabel="true health (100 × efficiency)", ylabel="health score", title="Health score vs truth (test)"
    )
    held = next(p.name for p in PROFILES if p.held_out and p.degrades)
    g = te.assign(score=sc["health"].to_numpy())
    g = g[g["fridge_profile"] == held]
    d = (g["ts"] - g["ts"].min()) / 86400
    ax[1].plot(d, g["y_health"], color="#0f172a", lw=1, label="truth")
    ax[1].plot(d, g["score"], color="#0f766e", lw=1, label="score")
    ax[1].axhline(70, color="#d97706", lw=0.8, ls="--", label="weakening < 70")
    ax[1].set(xlabel="days", ylabel="health", title=f"{held} (held out)")
    ax[1].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(REPORTS / "health_vs_truth.png", dpi=130)
    plt.close(fig)


# ----------------------------------------------------------------------------------------------- main


def main() -> None:
    t0 = time.perf_counter()
    warnings.filterwarnings("ignore", category=UserWarning)
    try:
        fc, hl = load("forecast"), load("health")
    except FileNotFoundError:
        from data.generate import main as generate

        generate([])
        fc, hl = load("forecast"), load("health")
    dstats = json.loads((DATA / "dataset_stats.json").read_text(encoding="utf-8"))
    days = dstats["profiles"][0]["days"]
    raw = load_raw()

    fbundle, finfo = train_forecaster(fc)
    fres = evaluate_forecaster(fbundle, finfo, raw)
    X, y, out = fres["_pred"]
    fres["_meta"] = (
        finfo["_test"]
        .loc[X.index, ["fridge_profile", "ts"]]
        .assign(y=y, pred=out["pred"].to_numpy(), p10=out["p10"].to_numpy(), p90=out["p90"].to_numpy())
    )
    hbundle, hinfo = train_health(hl)
    hres = evaluate_health(hbundle, hl, dstats["seed"], days)
    imp = importance(fbundle, hbundle, fc, hl)
    abl = ablation(fc, finfo["params"], fbundle["p50"])
    figures(fres, hres, imp)

    mods = fres["models"]
    beats = {
        b: mods["hgb"]["mae"] < mods[b]["mae"] and mods["hgb"]["rmse"] < mods[b]["rmse"] for b in BASELINES
    }
    if not all(beats.values()):
        print(f"WARNING: the forecaster does not beat every baseline on the test set: {beats}")

    MODELS.mkdir(exist_ok=True)
    joblib.dump(fbundle, MODELS / "forecast.joblib", compress=3)
    joblib.dump(hbundle, MODELS / "health.joblib", compress=3)
    trained_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    card = {
        "trained_at": trained_at,
        "seed": SEED,
        "versions": {
            "python": platform.python_version(),
            "scikit-learn": sklearn.__version__,
            "numpy": np.__version__,
            "pandas": pd.__version__,
        },
        "dataset": {
            k: dstats[k] for k in ("seed", "generated_at", "raw_rows", "forecast_rows", "health_rows")
        },
        "forecast": {
            "model": "HistGradientBoostingRegressor: median (absolute error) + quantile p10/p90 "
            "conformalised on validation, horizon 30 min",
            "interval_margin": fbundle["interval_margin"],
            "features": list(FEATURES),
            "params": finfo["params"],
            "warning_method": fbundle["method"],
            "thresholds": fbundle["thresholds"],
            "rule": "HIGH if pred > 8 or p90 > 9; MEDIUM if p90 > 8; LOW otherwise",
        },
        "health": {
            "model": "HistGradientBoostingRegressor on 24 h cycle features "
            "+ IsolationForest on healthy cycles",
            "features": list(HEALTH_FEATURES),
            "params": hinfo["params"],
            "formula": f"health = clip(model - {ANOMALY_WEIGHT:g} x anomaly, 0, 100); anomaly in [0, 1]",
            "fallback": "fewer than 3 cycles: 100 x (cooling rate ON + warming rate OFF) / healthy median",
            "bands": {"GOOD": "80-100", "WEAKENING": "50-79", "FAILING": "0-49"},
            "weakening": "health < 70 or 24 h trend < -5 points/day",
        },
    }
    (MODELS / "model_card.json").write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8", newline="\n")
    report = {
        "trained_at": trained_at,
        "dataset": dstats,
        "forecast": _round({**fres, "selection": {k: v for k, v in finfo.items() if not k.startswith("_")}}),
        "beats_baselines": beats,
        "ablation": _round(abl),
        "importance": _round(imp),
        "health": _round({**hres, "selection": hinfo}),
        "seconds": round(time.perf_counter() - t0),
    }
    (REPORTS / "metrics.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    from report import render

    (REPORTS / "REPORT.md").write_text(render(report), encoding="utf-8", newline="\n")
    print(f"done in {report['seconds']} s: models -> {MODELS}, report -> {REPORTS / 'REPORT.md'}")


if __name__ == "__main__":
    sys.exit(main())
