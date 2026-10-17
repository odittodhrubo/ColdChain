-- Inventory (P10). batch_assignments.from_ts / to_ts are unix ms (a batch can move twice within one second).

ALTER TABLE batches RENAME COLUMN lot TO lot_number;
ALTER TABLE batches ADD COLUMN manufacturer TEXT NOT NULL DEFAULT '';
ALTER TABLE batches ADD COLUMN created_by INTEGER REFERENCES users (id);
ALTER TABLE batches ADD COLUMN acknowledged_at INTEGER;
ALTER TABLE batches ADD COLUMN deleted_at INTEGER; -- soft delete (Admin, quantity 0): history stays auditable

-- A batch sits in exactly one fridge at a time: at most one open assignment interval per batch.
CREATE UNIQUE INDEX idx_batch_assignments_open ON batch_assignments (batch_id) WHERE to_ts IS NULL;
CREATE INDEX idx_batches_expiry ON batches (expiry_date);
