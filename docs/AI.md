# AI: forecast, compressor health, relocation

Three things, each with a reason a pharmacist can read:

1. **A 30-minute temperature forecast** with an 80 % range and a LOW / MEDIUM / HIGH breach warning.
2. **A compressor health score (0–100)** with Good / Weakening / Failing bands and a "service recommended" flag.
3. **Relocation plans**: when a fridge looks unsafe, which batches to move first and to which fridge. One click confirms.

The full evaluation, with every number generated from `metrics.json`, is in **[ml/reports/REPORT.md](../ml/reports/REPORT.md)**. The app also shows it on its AI Report page. Method details are in [ml.md](ml.md).

## Results at a glance

These figures come from the test split: held-out fridges plus the last 10 days.

| | Result | Baseline |
|---|---|---|
| Forecast error at +30 min (MAE) | **0.66 °C** | persistence 1.25, physics model 1.57, linear 3.49 |
| 80 % interval coverage | **80.0 %** | target 80 % |
| Breach warnings: recall / precision | **65 % / 40 %** | recall chosen over precision |
| Breaches warned before 8 °C | **91 %** (median 4 min ahead) | |
| Door left ajar (slow creep) | warned **22–27 min** ahead | test requires ≥ 10 min |
| Compressor health error (MAE) | **4.4 points** | Spearman 0.74 with true efficiency |
| Degradations flagged as Weakening | **3 of 3**, median 1 day after onset | |

## How it fits together

- **Dataset** (`ml/data/`):
  - 10 simulated fridges × 60 days, from the firmware's own physics;
  - disturbances: door openings and a door left ajar, power cuts, compressor wear and faults, ambient drift, noise, gaps;
  - the card is [ml/data/DATASET_CARD.md](../ml/data/DATASET_CARD.md).
- **Features** (`ml/features.py`):
  - one module, used for both training and serving;
  - 42 forecast features from the last 60 minutes, 15 health features from the last 24 hours;
  - tested for look-ahead, missing data and train/serve parity.
- **Models** (`ml/train.py`):
  - median plus quantile gradient boosting, conformalised to 80 %;
  - a calibrated breach classifier, chosen over the forecast rule on validation recall;
  - health: gradient boosting minus an IsolationForest anomaly signal, with a rule-based fallback.
- **Service** (`ml/app/main.py`): FastAPI `/predict`, about 80 ms per call. The models load once and only from `ml/models`.
- **Backend loop** (`backend/src/ml/`, `backend/src/modules/relocation/`):
  - runs every 30 s, with a 1 s budget per call;
  - the rule-based fallback is labelled when the service is down;
  - alerts need 2 consecutive runs, and plans follow hysteresis.
- **UI** (`frontend/src/ai/`):
  - a forecast band on the chart, the risk badge and a sentence of why;
  - the health gauge and its factors;
  - the relocation panel with one-click confirm, and the report page.

## Honesty note

- The models are trained on **synthetic data** from the same family of physics as the simulator, so the scores flatter them. A real fridge has defrost cycles, load mass and sensor placement that this data does not.
- A door flung wide open or a sudden power cut gives **minutes, not half an hour**: no forecast can warn before its cause. The slow failures (a door left ajar, a weakening compressor) are where the early warning works.
- Everything is built to **retrain on the system's own data**: `python -m data.export_live --db <backend db>` exports real readings in the training schema.
