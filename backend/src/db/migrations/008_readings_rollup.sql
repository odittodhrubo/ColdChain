-- Readings retention (R8). Raw readings older than READINGS_RETENTION_DAYS are deleted, one telemetry checkpoint
-- block at a time, but only after their hours are rolled up here. Each deletion is a READINGS_RETIRED audit entry
-- that quotes the block's checkpoint hash, so Verify Integrity can tell a retired range from a tampered one.

-- One row per fridge and finished hour. Counts are of readings (one every 5 s while online).
CREATE TABLE readings_hourly (
  fridge_id   TEXT NOT NULL REFERENCES fridges (id),
  hour        INTEGER NOT NULL, -- unix seconds, start of the hour
  n           INTEGER NOT NULL,
  n_temp      INTEGER NOT NULL, -- readings with a temperature (a sensor fault reads NULL): t_avg's weight
  t_min       REAL,
  t_max       REAL,
  t_avg       REAL,
  n_above_8   INTEGER NOT NULL, -- readings above 8 °C (excursions)
  n_door_open INTEGER NOT NULL,
  n_comp_on   INTEGER NOT NULL,
  n_battery   INTEGER NOT NULL,
  n_seeded    INTEGER NOT NULL, -- demo backfill (P20), never device data
  PRIMARY KEY (fridge_id, hour)
);

-- Which checkpoint blocks are gone (the audit chain holds the authoritative READINGS_RETIRED entries).
CREATE TABLE readings_retired (
  fridge_id  TEXT NOT NULL REFERENCES fridges (id),
  from_id    INTEGER NOT NULL,
  to_id      INTEGER NOT NULL,
  retired_at INTEGER NOT NULL, -- unix ms
  PRIMARY KEY (fridge_id, from_id)
);
