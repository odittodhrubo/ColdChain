-- P7: browser Web Push subscriptions. One row per browser endpoint; a user may have several (phone, desktop).
-- No secrets of ours live here: p256dh and auth are the browser's own push keys. Pruned when the push service
-- reports the endpoint is gone (404/410).
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id),
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);
