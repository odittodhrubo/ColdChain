# ML: dataset and features

Everything ML lives in `ml/` and runs with the repo venv (`.venv/Scripts/python` on Windows, `.venv/bin/python` elsewhere), from inside `ml/`.

## Dataset (P16)

```bash
cd ml && ../.venv/Scripts/python -m data.generate     # or: npm run ml:data / make data  (~2 min)
```

- `data/generate.py` simulates 10 fridge profiles × 60 days (including the firmware's own nominal fridge) at 5 s steps with the simulator's own physics (`tools/coldchain_tools/sim_engine.py`: `ThermalModel` with per-profile parameters, `CompressorControl`, `PowerModel`). The events are door openings that follow the working day, power failures of 5–90 min, gradual compressor degradation arcs, sudden faults, a drifting ambient, sensor noise and missing segments. Everything is seeded, so the same command gives the same rows.
- The 5 s readings become 1-minute rows through `features.to_minutes`, the function serving uses on live readings. They are stored in `data/raw/<profile>.csv.gz`, which is git-ignored and reproducible.
- `data/dataset.py` adds the labels (`y_temp_5/10/20/30`, `y_breach_30`, `y_health`), the splits and the model matrices `data/processed/{forecast,health}.csv.gz`. `python -m data.dataset` rebuilds only this step.
- [`ml/data/DATASET_CARD.md`](../ml/data/DATASET_CARD.md) and `data/dataset_stats.json` are rendered from the generated data: method, parameters, counts, class balance, limitations.
- `python -m data.export_live --db <backend db>` exports the backend's real readings in the same schema, so the models can be refreshed on live data.

## Feature pipeline

`ml/features.py` is the only feature code. Training and the serving API (P18) both call it.

| Function | Input | Output |
|---|---|---|
| `to_minutes(readings)` | raw readings (`ts, temp, door, comp, power, batt`, any rate; `power` as `MAINS`/`BATTERY` or 0/1) | one row per minute: mean temp, door and compressor fraction, battery flag, battery % |
| `features_at(Minutes, t)` / `serve_features(readings, t)` | the 60 minutes ending at minute `t` | `FEATURES` (42): temperature stats, slopes and acceleration, door, compressor, power, time to 8 °C, minimum-off wait, missing fraction, hour of day |
| `health_features(Minutes, t)` | the 24 hours ending at `t` | `HEALTH_FEATURES` (15): cooling / warming rates, ON / OFF durations, 7 → 3 °C pull-down, overshoot, cycles per hour, duty and its trend, longest run, temperature summary |

Rules the tests enforce (`ml/tests/test_features.py`):
- **No look-ahead.** The window is cut with a binary search that stops at `t`. Changing, adding or removing any minute after `t` leaves both vectors unchanged.
- **No truth as input.** `Minutes` holds only `temp, door, comp, power, batt`. `efficiency_true` and `ambient_true` cannot reach a feature.
- **Missing minutes** are NaN on the window grid. Statistics skip them, `missing_frac_60` and `minutes_since_reading` report them, and a silent hour gives NaN rather than a guess. The models handle NaN natively.
- **Train/serve parity.** Raw 5 s readings passed to `serve_features` give exactly the vector that the training path computes from the stored minute rows.
- Deterministic output, hand-checked values on a constructed hour, label spot checks, time-ordered splits, and scenario counts (≥ 200 door events, ≥ 20 power failures, ≥ 3 arcs per degrading profile).

## Splits

The splits are never shuffled:
- The held-out profiles (`mobile-unit`, `city-depot`) are test only.
- On the other profiles, the last 10 days are test, the 10 days before them are validation, and the rest is training.
- Rows within 30 min before a boundary, and within the lookback after it, are marked `gap` and not used. The lookback is 60 min for forecasts and 24 h for health.
- Anything fitted, such as scalers or thresholds, is fitted on training rows only.

## Models and report (P17)

```bash
cd ml && ../.venv/Scripts/python -m train     # or: npm run ml:train / make train  (~6 min; builds the dataset if missing)
```

Outputs: `ml/models/{forecast,health}.joblib` and `model_card.json`; `ml/reports/metrics.json`, five figures and [`ml/reports/REPORT.md`](../ml/reports/REPORT.md). The report is rendered from `metrics.json`, so no number in it is typed by hand. `python report.py` re-renders it.

- **Forecast (+30 min)**
  - Histogram gradient boosting predicting the median (absolute-error loss). The size is chosen on validation MAE.
  - p10 / p90 quantile models give the interval. The interval is conformalised on validation to reach 80 % coverage, then sorted, so `p10 ≤ pred ≤ p90` always holds.
  - Compared against random forest and three baselines: persistence, linear extrapolation, and the physics model with the nominal firmware parameters (`modeling/baselines.py`).
- **Breach warning**
  - Two candidates: the forecast rule (`HIGH` if pred > 8 or p90 > 9; `MEDIUM` if p90 > 8) and a calibrated classifier, class-weighted in training only.
  - The candidate with the better validation F2 (recall first) is chosen. Its thresholds are stored in the bundle.
- **Compressor health**
  - Gradient boosting on the 24 h cycle features, minus `20 × anomaly`. The anomaly signal is an IsolationForest fitted on healthy cycles, scaled to [0, 1].
  - Fallback with fewer than 3 cycles: `100 × (cooling rate ON + warming rate OFF) / healthy median`.
  - When no compressor data exists, the score is `insufficient` (NaN, band `UNKNOWN`).
  - Bands: 80–100 `GOOD`, 50–79 `WEAKENING`, 0–49 `FAILING`.
  - The weakening flag is set when health < 70 or the 24 h trend is below −5 points/day.
- **Serving** (`modeling/predict.py`): `load()` reads only `ml/models`. It refuses a feature list that differs from `features.py`. `Forecaster.predict(X)` and `HealthModel.score(X)` take the vectors from `features.py`.
- **Evaluation**, on the test split only:
  - forecast MAE / RMSE / R² for every model and baseline;
  - error by horizon and by condition (door open, power failure);
  - interval coverage;
  - breach precision, recall, F1, ROC-AUC, PR-AUC, confusion matrix and false alarms per fridge-day;
  - lead time, from a forecast every minute before each breach onset;
  - health MAE, Spearman correlation and degradation detection delay;
  - permutation importance and ablations.
- **Tests** (`ml/tests/test_models.py`):
  - metric functions;
  - warning levels;
  - quantile ordering;
  - health bounds, fallback and the `insufficient` case;
  - the trained models beat every baseline;
  - a **door-left-ajar replay** on a held-out fridge warns at least 10 minutes before the temperature passes 8 °C.

The trained bundles are committed (about 16 MB), so the service starts without training. Loading a bundle needs the scikit-learn version recorded in `model_card.json`.

## Prediction service (P18)

`ml/app/main.py` (FastAPI). Run it with `cd ml && ../.venv/Scripts/uvicorn app.main:app --port 8000`; in Docker it is the `ml` service. The backend is its only client. It sends no CORS headers, and compose binds it to localhost.

- **Models:** loaded once at start-up from `ml/models`. If they are missing, `/health` says `degraded` and why, and `/predict` answers 503.
- **`POST /predict`:**
  - Request: `{fridge_id, readings, history_24h?, health_history?}`. `readings` holds the last 60 min (raw or 1-minute rows: `ts, temp, door, comp, power, batt`); fewer than 20 with a temperature answers `{"status": "insufficient_data"}`. `history_24h` holds the last 24 h for compressor health. `health_history` is `[{ts, score}]` for the trend.
  - Validation is strict: unknown fields, impossible values and oversized arrays get 422.
  - Response: `{pred_temp_30, p10, p90, breach_level, breach_prob, minutes_to_breach_estimate, health_score, health_band, health_method, health_trend_per_day, weakening, features_used, health_factors, model_version, elapsed_ms}`.
  - `features_used` and `health_factors` are the inputs behind the answer, so the UI can say *why*.
  - `minutes_to_breach_estimate` is the straight-line time to 8 °C along the forecast (or p90) path.
  - The trend needs at least 6 h of scores; with less, minutes of jitter would read as a collapse.
- **`GET /report`** and **`GET /report/figures/{name}`**: `metrics.json`, `REPORT.md`, the model card and the figures, served to the backend (`/api/ml/report`). Figure names are whitelisted.
- **Speed:** about 80 ms per prediction on a laptop. The backend gives it 1 s, then falls back to its rule.

`requirements.txt` pins the versions the models were trained with. The image uses Python 3.14 like the venv.

Tests (`ml/tests/test_service.py`) run on simulator scenarios (the firmware's physics):
- a normal fridge is LOW risk and healthy;
- `weak_compressor` scores below 70 and is flagged weakening;
- an open door reaches HIGH within a minute;
- insufficient data and validation are handled;
- there are no CORS headers;
- the report endpoints work.

The dataset includes the firmware's own nominal fridge (`firmware-nominal`), so a healthy virtual node scores GOOD.
