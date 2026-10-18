# API reference

Generated from the backend's route registry by `npm --prefix backend run docs:api`. Do not edit by hand: the
test suite fails when this file is stale.

- Base URL: the backend (`http://localhost:4000`). Requests and responses are JSON unless noted.
- Authentication: `Authorization: Bearer <JWT>` from `POST /api/auth/login` (8 h). Who may call a route is
  enforced on the server; the UI only mirrors it.
- Errors: `{ "error": { "code", "message", "details"? } }` with 400 (validation, unknown fields refused),
  401, 403, 404, 409 (state conflicts, e.g. `FRIDGE_FULL`, `PLAN_CHANGED`), 429 (rate limited), 503.
- Realtime (Socket.IO, same origin, `auth: {token}`): `fridge:update`, `fridge:latch`, `batch:update`,
  `alert:new`, `alert:update`, `prediction:update`, `relocation:update`, `security:event`,
  `device:status`, `device:cmdack`, `device:command`.

37 routes.

## health

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/health` | public |  |  |  |

## auth

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| POST | `/api/auth/login` | public |  |  | `email`: email ≤ 254 chars<br>`password`: string ≤ 200 chars |
| GET | `/api/auth/me` | any signed-in user |  |  |  |
| POST | `/api/auth/logout` | any signed-in user |  |  |  |

## users

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/users` | `user:manage` (Admin) |  |  |  |
| POST | `/api/users` | `user:manage` (Admin) |  |  | `email`: email ≤ 254 chars<br>`name`: string ≤ 100 chars<br>`role`: `ADMIN` \| `PHARMACIST` \| `INSPECTOR`<br>`password`: string ≤ 72 chars |
| PATCH | `/api/users/:id` | `user:manage` (Admin) | `id`: integer ≥ 0 (exclusive) |  | `name?`: string ≤ 100 chars<br>`role?`: `ADMIN` \| `PHARMACIST` \| `INSPECTOR`<br>`active?`: boolean<br>`password?`: string ≤ 72 chars |
| DELETE | `/api/users/:id` | `user:manage` (Admin) | `id`: integer ≥ 0 (exclusive) |  |  |

## audit

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/audit` | `audit:read` (Admin, Pharmacist, Inspector) |  | `type?`: `AUTH_LOGIN` \| `AUTH_FAIL` \| `USER_CREATED` \| `USER_UPDATED` \| `USER_DISABLED` \| `BATCH_CREATED` \| `BATCH_UPDATED` \| `BATCH_MOVED` \| `BATCH_STATUS_CHANGED` \| `LATCH_RESET` \| `DISCARD_ACK` \| `ALERT_RAISED` \| `ALERT_ACKED` \| `ALERT_RESOLVED` \| `SECURITY_REJECT` \| `RELOCATION_PROPOSED` \| `RELOCATION_CONFIRMED` \| `RELOCATION_DISMISSED` \| `DEVICE_EVENT` \| `BREACH_START` \| `BREACH_END` \| `TELEMETRY_CHECKPOINT` \| `AUDIT_VERIFY`<br>`actor?`: string ≤ 100 chars<br>`batch_id?`: integer ≥ 0 (exclusive)<br>`from?`: integer ≥ 0<br>`to?`: integer ≥ 0<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| GET | `/api/audit/verify` | `audit:verify` (Admin, Pharmacist, Inspector) |  | `from?`: integer ≥ 1<br>`stream?`: `0` \| `1` \| `true` \| `false` |  |

## security

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/security/events` | `audit:read` (Admin, Pharmacist, Inspector) |  | `reason?`: `BAD_JSON` \| `UNKNOWN_DEVICE` \| `STALE_TS` \| `BAD_SIG` \| `REPLAY` \| `BAD_BODY`<br>`device_id?`: string ≤ 64 chars<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| GET | `/api/security/summary` | `audit:read` (Admin, Pharmacist, Inspector) |  |  |  |

## metrics

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/metrics/ingest` | `metrics:read` (Admin, Inspector) |  |  |  |

## batches

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/batches` | `dashboard:read` (Admin, Pharmacist, Inspector) |  | `fridge_id?`: string ≤ 64 chars<br>`status?`: `SAFE` \| `AT_RISK` \| `DISCARD`<br>`expiring_within_days?`: integer 0..3650<br>`q?`: string ≤ 100 chars<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| POST | `/api/batches` | `batch:write` (Admin, Pharmacist) |  |  | `name`: string ≤ 120 chars<br>`quantity`: integer 1..1000000<br>`criticality`: integer 1..3<br>`expiry_date`: date<br>`manufacturer`: string ≤ 120 chars<br>`lot_number`: string ≤ 64 chars<br>`fridge_id`: string ≤ 64 chars |
| GET | `/api/batches/:id` | `dashboard:read` (Admin, Pharmacist, Inspector) | `id`: integer ≥ 0 (exclusive) |  |  |
| PATCH | `/api/batches/:id` | `batch:write` (Admin, Pharmacist) | `id`: integer ≥ 0 (exclusive) |  | `name?`: string ≤ 120 chars<br>`quantity?`: integer 0..1000000<br>`criticality?`: integer 1..3<br>`expiry_date?`: date |
| DELETE | `/api/batches/:id` | `batch:delete` (Admin) | `id`: integer ≥ 0 (exclusive) |  |  |
| POST | `/api/batches/:id/move` | `batch:write` (Admin, Pharmacist) | `id`: integer ≥ 0 (exclusive) |  | `to_fridge_id`: string ≤ 64 chars |
| GET | `/api/batches/:id/qr` | `dashboard:read` (Admin, Pharmacist, Inspector) | `id`: integer ≥ 0 (exclusive) | `format?`: `svg` \| `png` = "svg" |  |
| GET | `/api/batches/:id/exposure` | `dashboard:read` (Admin, Pharmacist, Inspector) | `id`: integer ≥ 0 (exclusive) |  |  |

## public

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/public/batch/:token` | public | `token`: string ≤ 64 chars |  |  |

## fridges

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| POST | `/api/fridges/:id/reset-latch` | `latch:reset` (Admin) | `id`: string ≤ 64 chars |  | `reason`: string ≤ 500 chars |
| POST | `/api/fridges/:id/buzzer-test` | `device:test` (Admin, Pharmacist) | `id`: string ≤ 64 chars |  |  |
| GET | `/api/fridges` | `dashboard:read` (Admin, Pharmacist, Inspector) |  |  |  |
| GET | `/api/fridges/:id` | `dashboard:read` (Admin, Pharmacist, Inspector) | `id`: string ≤ 64 chars |  |  |
| GET | `/api/fridges/:id/readings` | `dashboard:read` (Admin, Pharmacist, Inspector) | `id`: string ≤ 64 chars | `from?`: integer ≥ 0<br>`to?`: integer ≥ 0<br>`bucket?`: integer 1..86400 |  |

## alerts

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/alerts` | `dashboard:read` (Admin, Pharmacist, Inspector) |  | `status?`: `active` \| `acknowledged` \| `resolved` \| `all` = "all"<br>`severity?`: `INFO` \| `WARNING` \| `CRITICAL`<br>`type?`: `DOOR_OPEN_LONG` \| `FRIDGE_BREACH` \| `POWER_FAILURE` \| `BATTERY_LOW` \| `FRIDGE_OFFLINE` \| `BATCH_AT_RISK` \| `BATCH_DISCARD` \| `PREDICTED_BREACH` \| `COMPRESSOR_WEAK` \| `RELOCATION_PROPOSED` \| `SECURITY_FLOOD`<br>`fridge_id?`: string ≤ 64 chars<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| POST | `/api/alerts/:id/ack` | `alert:ack` (Admin, Pharmacist) | `id`: integer ≥ 0 (exclusive) |  |  |

## commands

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/commands/:id` | `dashboard:read` (Admin, Pharmacist, Inspector) | `id`: uuid |  |  |

## relocations

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/relocations` | `dashboard:read` (Admin, Pharmacist, Inspector) |  | `status?`: `active` \| `all` = "active"<br>`limit?`: integer 1..100 = 20 |  |
| GET | `/api/relocations/:id` | `dashboard:read` (Admin, Pharmacist, Inspector) | `id`: uuid |  |  |
| POST | `/api/relocations/:id/confirm` | `relocation:confirm` (Admin, Pharmacist) | `id`: uuid |  | `version`: integer ≥ 0 (exclusive) |
| POST | `/api/relocations/:id/dismiss` | `relocation:confirm` (Admin, Pharmacist) | `id`: uuid |  | `reason`: string ≤ 500 chars |

## ml

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/ml/predictions/:fridgeId` | `dashboard:read` (Admin, Pharmacist, Inspector) | `fridgeId`: string ≤ 64 chars | `from?`: integer ≥ 0<br>`to?`: integer ≥ 0<br>`limit?`: integer 1..2000 = 500 |  |
| GET | `/api/ml/report` | `dashboard:read` (Admin, Pharmacist, Inspector) |  |  |  |
| GET | `/api/ml/report/figures/:name` | `dashboard:read` (Admin, Pharmacist, Inspector) | `name`: string |  |  |
