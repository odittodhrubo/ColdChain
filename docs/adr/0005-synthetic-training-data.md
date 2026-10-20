# 0005 — Train the models on synthetic data

## Status

Accepted, with an explicit path to real data.

## Context

The AI features — the 30-minute temperature forecast, the compressor-health score and the relocation planner — need training data: long runs of fridge readings across normal operation, door events, power cuts and failing compressors. No such labelled dataset from real pharmacy fridges was available during the build, and collecting months of real failures was not possible on the timeline. The models still had to be trained, evaluated and shown to work end to end.

## Decision

Generate a synthetic dataset from the same thermal and compressor model the firmware and the virtual node use (`ml/data/generate.py`), with a documented dataset card (`ml/data/DATASET_CARD.md`). Train and evaluate on it, and say so plainly: the AI report carries a "synthetic data" badge, and the evaluation report keeps an honesty note that synthetic data flatters the scores. Ship an exporter (`ml/data/export_live.py`) that writes real readings in the same training schema, so a retrain on real data is a data swap, not a rewrite.

## Consequences

- The AI pipeline is complete and testable now: no-look-ahead feature tests, model tests, an evaluation report, and the service wired into the backend and UI.
- The reported accuracy is optimistic because the physics that generated the data is the physics the model learns; this is disclosed, not hidden (see the report's honesty note).
- Chasing another fraction of a degree of MAE on synthetic fridges proves nothing (see "What not to do"). The work that matters is live forecast-error tracking (A1) against the offline MAE, and a retrain on exported real data (A2) with versioned models.
- Because the generator, firmware and virtual node share one thermal model, the synthetic data is at least self-consistent with the system being monitored, which keeps the demo honest even before real data exists.
