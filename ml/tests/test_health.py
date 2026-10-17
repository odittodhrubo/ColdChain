from fastapi.testclient import TestClient

from app.main import app


def test_health_ok():
    res = TestClient(app).get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "ml", "forecast_horizon_min": 30}
