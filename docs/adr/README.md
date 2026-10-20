# Architecture decision records

Each file records one decision that was made on purpose, so a judge or a future contributor can see the trade-off was deliberate rather than accidental. The format is Context, Decision, Consequences, Status.

| # | Decision | Status |
|---|---|---|
| [0001](0001-sqlite-over-postgres.md) | SQLite over PostgreSQL | Accepted |
| [0002](0002-hmac-envelopes-over-mqtt-auth.md) | HMAC message envelopes, not MQTT-level auth alone | Accepted |
| [0003](0003-qos0-plus-app-level-sync.md) | QoS 0 on the device plus an application-level sync | Accepted |
| [0004](0004-session-token-storage.md) | Session token: `sessionStorage` first, then `HttpOnly` cookies | Superseded by S1 |
| [0005](0005-synthetic-training-data.md) | Train the models on synthetic data | Accepted |

New records are numbered in sequence and never rewritten once accepted; a later decision that changes an earlier one adds its own record and flips the old one's status to "Superseded by …".
