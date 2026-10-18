-- Demo seed (P20): readings backfilled by `make demo` so charts and forecasts have context from the first minute.
-- They are flagged, never mixed up with what a device sent: the UI labels them "seeded history".
ALTER TABLE readings ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0;
