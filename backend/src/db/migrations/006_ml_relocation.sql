-- ML predictions (P18): one row per fridge per scheduler run. `forecast` holds the whole service (or fallback)
-- answer as JSON; the columns are what lists and charts filter on.
ALTER TABLE ml_predictions ADD COLUMN level TEXT;
ALTER TABLE ml_predictions ADD COLUMN source TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model', 'fallback'));
ALTER TABLE ml_predictions ADD COLUMN model_version TEXT;

-- Relocation plans (P18). Rebuilt: the P07 placeholder had no data, no version and no no-safe-target state.
-- One active plan (PROPOSED or NO_SAFE_TARGET) per source fridge; `version` is the optimistic lock a confirm
-- must quote, so a stale or double-clicked confirm can never move batches twice.
DROP TABLE relocation_plans;
CREATE TABLE relocation_plans (
  id            TEXT PRIMARY KEY,
  from_fridge   TEXT NOT NULL REFERENCES fridges (id),
  status        TEXT NOT NULL CHECK (status IN ('PROPOSED', 'NO_SAFE_TARGET', 'CONFIRMED', 'DISMISSED', 'EXPIRED', 'CANCELLED')),
  version       INTEGER NOT NULL DEFAULT 1,
  plan          TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    INTEGER REFERENCES users (id),
  decision_note TEXT,
  result        TEXT
);
CREATE UNIQUE INDEX idx_relocation_active ON relocation_plans (from_fridge) WHERE status IN ('PROPOSED', 'NO_SAFE_TARGET');
CREATE INDEX idx_relocation_created ON relocation_plans (created_at);
