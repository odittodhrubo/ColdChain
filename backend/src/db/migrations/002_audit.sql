-- P08: the audit log is append-only at the database level, plus external-anchor and checkpoint bookkeeping.

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- Hourly snapshot of the chain head, also sent off-box (console / Telegram). A deleted tail keeps every
-- remaining link valid; only a head recorded elsewhere reveals it.
CREATE TABLE audit_anchor (
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  head_id   INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  count     INTEGER NOT NULL
);

-- Last reading id covered by a TELEMETRY_CHECKPOINT, per fridge.
CREATE TABLE telemetry_checkpoint_state (
  fridge_id  TEXT PRIMARY KEY REFERENCES fridges (id),
  last_to_id INTEGER NOT NULL
);
