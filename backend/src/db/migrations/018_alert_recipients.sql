-- Alert email recipients for notifications (DOOR_OPEN_LONG, BREACH, POWER_FAILURE)
CREATE TABLE IF NOT EXISTS alert_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_alert_recipients_active ON alert_recipients (is_active);
