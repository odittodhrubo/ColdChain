from fastapi import FastAPI

from constants import FORECAST_HORIZON_MIN

app = FastAPI(title="ColdChain ML service", version="0.1.0")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "ml", "forecast_horizon_min": FORECAST_HORIZON_MIN}
