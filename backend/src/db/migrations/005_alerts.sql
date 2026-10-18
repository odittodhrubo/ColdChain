-- Alerts (P12): one row per episode. `key` = type|fridge|batch; while an episode is unresolved, raising the same
-- key updates it instead of adding a row. Acknowledging does not end an episode, resolving does.
ALTER TABLE alerts RENAME COLUMN acked_at TO acknowledged_at;
ALTER TABLE alerts RENAME COLUMN acked_by TO acknowledged_by;
ALTER TABLE alerts ADD COLUMN key TEXT NOT NULL DEFAULT '';
ALTER TABLE alerts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN resolved_at INTEGER;
ALTER TABLE alerts ADD COLUMN notified_at INTEGER; -- last notification round (re-notify cooldown)
ALTER TABLE alerts ADD COLUMN notify_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE alerts ADD COLUMN delivery_status TEXT NOT NULL DEFAULT '{}'; -- per channel: status, attempts, at, error
CREATE UNIQUE INDEX idx_alerts_active_key ON alerts (key) WHERE resolved_at IS NULL;

-- Signed server -> device commands, tracked until the device's signed cmdack.
CREATE TABLE pending_commands (
  cmd_id     TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL REFERENCES devices (device_id),
  type       TEXT NOT NULL,
  args       TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACKED', 'FAILED', 'TIMEOUT')),
  attempts   INTEGER NOT NULL DEFAULT 1,
  detail     TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_pending_commands_status ON pending_commands (status, created_at);
