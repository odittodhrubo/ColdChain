# ML: dataset and features

Everything ML lives in `ml/` and runs with the repo venv (`.venv/Scripts/python` on Windows, `.venv/bin/python` elsewhere), from inside `ml/`.

## Dataset (P16)

```bash
cd ml && ../.venv/Scripts/python -m data.generate     # or: npm run ml:data / make data  (~2 min)
```

- `data/generate.py` simulates 8 fridge profiles × 60 days at 5 s steps with the simulator's own physics (`tools/coldchain_tools/sim_engine.py`: `ThermalModel` with per-profile parameters, `CompressorControl`, `PowerModel`). The events are door openings that follow the working day, power failures of 5–90 min, gradual compressor degradation arcs, sudden faults, a drifting ambient, sensor noise and missing segments. Everything is seeded, so the same command gives the same rows.
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
