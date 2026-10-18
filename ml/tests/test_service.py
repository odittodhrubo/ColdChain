"""P18: the prediction service on simulator scenarios (the firmware's own physics, offline fast mode)."""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app, minutes_to_breach
from modeling.predict import MODELS

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from coldchain_tools.sim_engine import run_offline  # noqa: E402

pytestmark = pytest.mark.skipif(not (MODELS / "forecast.joblib").exists(), reason="no trained models")


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def readings(scenario, seconds: int, seed: int = 3) -> list[dict]:
    out = []
    for msg, _truth in run_offline(seconds, scenario=scenario, seed=seed):
        if msg.kind == "telemetry":
            r = msg.reading
            out.append({k: r[k] for k in ("ts", "temp", "door", "comp", "power", "batt")})
    return out


def minute_rows(rows: list[dict]) -> list[dict]:
    """What the backend sends as history: 1-minute buckets."""
    buckets: dict[int, list[dict]] = {}
    for r in rows:
        buckets.setdefault(r["ts"] // 60, []).append(r)
    return [
        {
            "ts": m * 60,
            "temp": sum(r["temp"] for r in rs) / len(rs),
            "door": sum(r["door"] for r in rs) / len(rs),
            "comp": sum(r["comp"] for r in rs) / len(rs),
            "power": rs[-1]["power"],
            "batt": rs[-1]["batt"],
        }
        for m, rs in sorted(buckets.items())
    ]


def test_normal_fridge_is_low_risk_and_healthy(client):
    rows = readings("normal", 3 * 3600)
    body = {"fridge_id": "fridge-01", "readings": rows[-720:], "history_24h": minute_rows(rows)}
    res = client.post("/predict", json=body)
    assert res.status_code == 200
    p = res.json()
    assert p["status"] == "ok" and p["breach_level"] == "LOW"
    assert p["p10"] <= p["pred_temp_30"] <= p["p90"]
    assert p["pred_temp_30"] < 8 and p["minutes_to_breach_estimate"] is None
    assert p["health_score"] >= 70 and not p["weakening"] and p["health_band"] in {"GOOD", "WEAKENING"}
    assert set(p["features_used"]) >= {"temp_now", "door_open_run", "comp_duty_60"}
    assert p["model_version"] and p["elapsed_ms"] < 1000


def test_weak_compressor_scores_low_and_flags_weakening(client):
    rows = readings("weak_compressor", 4 * 3600)
    body = {"fridge_id": "fridge-02", "readings": rows[-720:], "history_24h": minute_rows(rows)}
    p = client.post("/predict", json=body).json()
    assert p["health_score"] < 70 and p["weakening"] is True
    assert p["health_band"] in {"WEAKENING", "FAILING"}


def test_door_open_raises_the_warning(client):
    """The firmware's demo door is drastic (about 6 °C a minute): after half a minute open the forecast may
    still expect recovery, after a full minute it must be HIGH."""
    script = [(3600, "door", True)]
    early = client.post("/predict", json={"fridge_id": "f", "readings": readings(script, 3600 + 30)[-720:]})
    late = client.post("/predict", json={"fridge_id": "f", "readings": readings(script, 3600 + 60)[-720:]})
    assert early.json()["status"] == "ok"
    p = late.json()
    assert p["breach_level"] == "HIGH" and p["minutes_to_breach_estimate"] is not None, p


def test_insufficient_data_and_validation(client):
    rows = readings("normal", 60)
    res = client.post("/predict", json={"fridge_id": "fridge-01", "readings": rows[:10]})
    assert res.status_code == 200 and res.json()["status"] == "insufficient_data"
    tiny = {"fridge_id": "x", "readings": [{"ts": 1, "temp": 5}]}  # ts before 2001: refused
    assert client.post("/predict", json=tiny).status_code == 422
    bad = {"fridge_id": "x", "readings": rows, "extra": True}
    assert client.post("/predict", json=bad).status_code == 422  # unknown fields refused
    hot = [{**r, "temp": 500} for r in rows]
    assert client.post("/predict", json={"fridge_id": "x", "readings": hot}).status_code == 422


def test_no_cors_headers(client):
    preflight = {"Origin": "http://evil.example", "Access-Control-Request-Method": "POST"}
    res = client.options("/predict", headers=preflight)
    assert "access-control-allow-origin" not in res.headers


def test_report_and_figures(client):
    r = client.get("/report").json()
    assert "forecast" in r["metrics"] and r["report_md"].startswith("# ColdChain AI")
    assert "actual_vs_pred.png" in r["figures"]
    assert client.get("/report/figures/actual_vs_pred.png").headers["content-type"] == "image/png"
    assert client.get("/report/figures/..%2Fmodels%2Fforecast.joblib").status_code == 404


def test_minutes_to_breach():
    assert minutes_to_breach(9.0, 10, 11) == 0
    assert minutes_to_breach(6.0, 10.0, 11.0) == 15.0
    assert minutes_to_breach(6.0, 7.0, 10.0) == 15.0  # the p90 path
    assert minutes_to_breach(5.0, 6.0, 7.0) is None
