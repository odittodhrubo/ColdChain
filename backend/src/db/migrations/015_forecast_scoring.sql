-- A1: score each 30-minute forecast against what really happened. Once the reading nearest to
-- created_at + 30 min exists, the scoring job fills these: the observed temperature and the absolute error.
-- A rising rolling error is the "model needs retraining" signal.
ALTER TABLE ml_predictions ADD COLUMN actual_temp REAL;
ALTER TABLE ml_predictions ADD COLUMN abs_error REAL;
