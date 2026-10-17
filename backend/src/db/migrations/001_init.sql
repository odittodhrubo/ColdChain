-- Core data model (contract: docs/CONTRACTS.md section 6). Times: *_at in unix ms; reading/event ts in unix s.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('ADMIN', 'PHARMACIST', 'INSPECTOR')),
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Logout: revoked JWT ids until they would have expired anyway (exp in unix s).
CREATE TABLE revoked_tokens (
  jti TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
CREATE INDEX idx_revoked_tokens_exp ON revoked_tokens (exp);

-- Failed-login backoff, keyed by the submitted email whether or not the account exists (no enumeration).
CREATE TABLE login_attempts (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  failures     INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE fridges (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  capacity    INTEGER NOT NULL CHECK (capacity > 0),
  latch_state INTEGER NOT NULL DEFAULT 0 CHECK (latch_state IN (0, 1)),
  created_at  INTEGER NOT NULL
);

-- secret_enc: AES-256-GCM with APP_SECRET_KEY ("v1:<iv>:<tag>:<ciphertext>", hex). Never stored in plaintext.
CREATE TABLE devices (
  device_id    TEXT PRIMARY KEY,
  fridge_id    TEXT NOT NULL REFERENCES fridges (id),
  secret_enc   TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE readings (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices (device_id),
  fridge_id   TEXT NOT NULL REFERENCES fridges (id),
  seq         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  temp        REAL,
  door        INTEGER NOT NULL,
  comp        INTEGER NOT NULL,
  power       TEXT NOT NULL,
  batt        INTEGER NOT NULL,
  state       TEXT NOT NULL,
  exp_s       INTEGER NOT NULL,
  latch       INTEGER NOT NULL,
  mode        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  late        INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  UNIQUE (device_id, seq)
);
CREATE INDEX idx_readings_fridge_ts ON readings (fridge_id, ts);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices (device_id),
  fridge_id   TEXT NOT NULL REFERENCES fridges (id),
  seq         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  late        INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  UNIQUE (device_id, seq)
);
CREATE INDEX idx_events_fridge_ts ON events (fridge_id, ts);

CREATE TABLE batches (
  id                  INTEGER PRIMARY KEY,
  public_token        TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  lot                 TEXT NOT NULL,
  quantity            INTEGER NOT NULL CHECK (quantity >= 0),
  expiry_date         TEXT NOT NULL,
  criticality         INTEGER NOT NULL CHECK (criticality BETWEEN 1 AND 3),
  status              TEXT NOT NULL DEFAULT 'SAFE' CHECK (status IN ('SAFE', 'AT_RISK', 'DISCARD')),
  weighted_exposure_s REAL NOT NULL DEFAULT 0,
  discarded_at        INTEGER,
  acknowledged_by     INTEGER REFERENCES users (id),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE batch_assignments (
  id        INTEGER PRIMARY KEY,
  batch_id  INTEGER NOT NULL REFERENCES batches (id),
  fridge_id TEXT NOT NULL REFERENCES fridges (id),
  from_ts   INTEGER NOT NULL,
  to_ts     INTEGER
);
CREATE INDEX idx_batch_assignments_batch_to ON batch_assignments (batch_id, to_ts);
CREATE INDEX idx_batch_assignments_fridge ON batch_assignments (fridge_id, to_ts);

CREATE TABLE alerts (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  fridge_id  TEXT REFERENCES fridges (id),
  batch_id   INTEGER REFERENCES batches (id),
  message    TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  acked_at   INTEGER,
  acked_by   INTEGER REFERENCES users (id)
);
CREATE INDEX idx_alerts_created ON alerts (created_at);

-- Stored only after the HMAC verified; expires_at in unix s.
CREATE TABLE nonces (
  id         INTEGER PRIMARY KEY,
  device_id  TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (device_id, nonce)
);
CREATE INDEX idx_nonces_expires ON nonces (expires_at);

CREATE TABLE security_events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  device_id   TEXT,
  reason      TEXT NOT NULL,
  topic       TEXT,
  size        INTEGER,
  sample_hash TEXT,
  detail      TEXT
);
CREATE INDEX idx_security_events_ts ON security_events (ts);

-- Hash chain (P08): hash = SHA256(prev_hash|id|ts|actor|event_type|payload); genesis prev_hash = 64 zeros.
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload    TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);

CREATE TABLE relocation_plans (
  id           INTEGER PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'CONFIRMED', 'DISMISSED', 'EXPIRED')),
  reason       TEXT NOT NULL,
  plan         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   INTEGER REFERENCES users (id)
);

CREATE TABLE ml_predictions (
  id           INTEGER PRIMARY KEY,
  fridge_id    TEXT NOT NULL REFERENCES fridges (id),
  created_at   INTEGER NOT NULL,
  horizon_min  INTEGER NOT NULL,
  forecast     TEXT NOT NULL,
  breach_prob  REAL,
  health_score REAL
);
CREATE INDEX idx_ml_predictions_fridge ON ml_predictions (fridge_id, created_at);
