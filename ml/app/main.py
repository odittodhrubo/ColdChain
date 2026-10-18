"""ColdChain ML service (P18): forecast + breach warning + compressor health for one fridge per request.

Only the backend calls it (no CORS headers: browsers cannot). Models load once at start-up from ml/models.

    POST /predict   {fridge_id, readings: [{ts, temp, door, comp, power, batt}] (last 60 min, >= 20),
                     history_24h?: same shape (1-minute rows), health_history?: [{ts, score}]}
    GET  /health    service and model status
    GET  /report    metrics.json, REPORT.md, model card and figure names; GET /report/figures/{name}
"""

from __future__ import annotations

import json
import math
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from constants import FORECAST_HORIZON_MIN, SAFE_MAX_C
from features import FEATURES, HEALTH_FEATURES, Minutes, features_at, health_features, to_minutes
from modeling.predict import MODELS, Forecaster, HealthModel, band, load, trend_per_day, weakening

ML = Path(__file__).resolve().parents[1]
REPORTS = ML / "reports"
FIGURES = ("actual_vs_pred.png", "error_by_horizon.png", "confusion_matrix.png", "feature_importance.png",
           "health_vs_truth.png")  # fmt: skip
MIN_READINGS = 20
EXPLAIN = ("temp_now", "temp_slope_15", "temp_max_15", "door_open_run", "door_frac_15", "comp_duty_60",
           "on_battery_now", "batt_now", "time_to_8", "missing_frac_60")  # fmt: skip
HEALTH_EXPLAIN = ("cool_rate_on", "warm_rate_off", "duty_24", "cycles_per_hour", "n_cycles", "longest_on_run")

state: dict = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        state["forecaster"], state["health"] = load()
        card = json.loads((MODELS / "model_card.json").read_text(encoding="utf-8"))
        state["version"] = f"{card['trained_at']}"
        state["card"] = card
    except (FileNotFoundError, ValueError) as err:  # the service still answers /health, saying why
        state["error"] = str(err)
    yield
    state.clear()


app = FastAPI(title="ColdChain ML service", version="1.0.0", lifespan=lifespan)

Num = Annotated[float, Field(ge=-60, le=90)]


class Reading(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ts: Annotated[int, Field(gt=1_000_000_000, lt=10_000_000_000)]  # unix seconds
    temp: Num | None = None
    door: Annotated[float, Field(ge=0, le=1)] = 0
    comp: Annotated[float, Field(ge=0, le=1)] = 0
    power: Literal["MAINS", "BATTERY"] | Annotated[float, Field(ge=0, le=1)] = "MAINS"
    batt: Annotated[float, Field(ge=0, le=100)] = 100


class HealthPoint(BaseModel):
    ts: int
    score: Annotated[float, Field(ge=0, le=100)]


class PredictIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fridge_id: Annotated[str, Field(min_length=1, max_length=64)]
    readings: Annotated[list[Reading], Field(max_length=2000)]
    history_24h: Annotated[list[Reading], Field(max_length=2000)] | None = None
    health_history: Annotated[list[HealthPoint], Field(max_length=500)] | None = None


def _frame(rows: list[Reading]) -> pd.DataFrame:
    df = pd.DataFrame([r.model_dump() for r in rows])
    df["power"] = [p if isinstance(p, str) else ("BATTERY" if p >= 0.5 else "MAINS") for p in df["power"]]
    return df


def _num(v) -> float | None:
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 4)


def minutes_to_breach(now: float, pred: float, p90: float) -> float | None:
    """When the forecast path crosses 8 °C, straight line from now to +30 min (the median path, else p90)."""
    if math.isnan(now):
        return None
    if now > SAFE_MAX_C:
        return 0.0
    for end in (pred, p90):
        if end > SAFE_MAX_C:
            return round(FORECAST_HORIZON_MIN * (SAFE_MAX_C - now) / (end - now), 1)
    return None


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if "forecaster" in state else "degraded",
        "service": "ml",
        "forecast_horizon_min": FORECAST_HORIZON_MIN,
        "model_version": state.get("version"),
        **({"error": state["error"]} if "error" in state else {}),
    }


@app.post("/predict")
def predict(body: PredictIn) -> dict:
    started = time.perf_counter()
    if "forecaster" not in state:
        raise HTTPException(503, detail="models not loaded: " + state.get("error", "unknown"))
    forecaster: Forecaster = state["forecaster"]
    health_model: HealthModel = state["health"]
    with_temp = [r for r in body.readings if r.temp is not None]
    if len(with_temp) < MIN_READINGS:
        return {"status": "insufficient_data", "fridge_id": body.fridge_id, "readings": len(with_temp),
                "needed": MIN_READINGS, "model_version": state["version"]}  # fmt: skip

    raw = _frame(body.readings)
    m = Minutes(to_minutes(raw))
    t = int(m.minute[-1])
    x = features_at(m, t)
    f = forecaster.predict(x[None, :]).iloc[0]

    hist = _frame(body.history_24h) if body.history_24h else raw
    hm = Minutes(to_minutes(pd.concat([hist, raw]).drop_duplicates("ts", keep="last").sort_values("ts")))
    hx = health_features(hm, t)
    h = health_model.score(hx[None, :]).iloc[0]
    score = float(h["health"])
    history = [(p.ts, p.score) for p in body.health_history or []]
    trend = trend_per_day([p[0] for p in history] + [t * 60], [p[1] for p in history] + [score])
    temp_now = x[FEATURES.index("temp_now")]
    return {
        "status": "ok",
        "fridge_id": body.fridge_id,
        "at": t * 60,
        "pred_temp_30": _num(f["pred"]),
        "p10": _num(f["p10"]),
        "p90": _num(f["p90"]),
        "breach_level": f["level"],
        "breach_prob": _num(f["prob"]),
        "minutes_to_breach_estimate": minutes_to_breach(temp_now, f["pred"], f["p90"]),
        "health_score": _num(score),
        "health_band": band(score),
        "health_method": h["method"],
        "health_trend_per_day": _num(trend),
        "weakening": bool(weakening(score, None if math.isnan(trend) else trend)),
        "features_used": {k: _num(x[FEATURES.index(k)]) for k in EXPLAIN},
        "health_factors": {k: _num(hx[HEALTH_FEATURES.index(k)]) for k in HEALTH_EXPLAIN},
        "model_version": state["version"],
        "elapsed_ms": round(1000 * (time.perf_counter() - started), 1),
    }


@app.get("/report")
def report() -> dict:
    try:
        metrics = json.loads((REPORTS / "metrics.json").read_text(encoding="utf-8"))
        text = (REPORTS / "REPORT.md").read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise HTTPException(404, detail="no report yet: run `python -m train`") from err
    return {
        "metrics": metrics,
        "report_md": text,
        "figures": [f for f in FIGURES if (REPORTS / f).exists()],
        "model_card": state.get("card"),
    }


@app.get("/report/figures/{name}")
def figure(name: str) -> FileResponse:
    if name not in FIGURES or not (REPORTS / name).exists():  # whitelist: no path from the request is used
        raise HTTPException(404, detail="no such figure")
    return FileResponse(REPORTS / name, media_type="image/png")
