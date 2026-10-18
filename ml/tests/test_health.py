from fastapi.testclient import TestClient

from app.main import app


def test_health_ok():
    with TestClient(app) as client:  # the context runs start-up, which loads the models
        res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["service"] == "ml" and body["forecast_horizon_min"] == 30
    assert body["status"] in {"ok", "degraded"}
