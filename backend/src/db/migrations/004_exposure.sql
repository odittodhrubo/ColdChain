-- Heat budget (P11): exposure is integer weighted milliseconds, so repeated accrual never drifts like a float.
ALTER TABLE batches DROP COLUMN weighted_exposure_s;
ALTER TABLE batches ADD COLUMN exposure_ms INTEGER NOT NULL DEFAULT 0;
