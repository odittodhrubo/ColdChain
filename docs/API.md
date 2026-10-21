# API reference

Generated from the backend's route registry by `npm --prefix backend run docs:api`. Do not edit by hand: the
test suite fails when this file is stale.

- Base URL: the backend (`http://localhost:4000`). Requests and responses are JSON unless noted.
- Authentication: `Authorization: Bearer <JWT>` from `POST /api/auth/login` (lifetime `JWT_EXPIRES_IN`, default 1 h). Who may call a route is
  enforced on the server; the UI only mirrors it.
- Errors: `{ "error": { "code", "message", "details"? } }` with 400 (validation, unknown fields refused),
  401, 403, 404, 409 (state conflicts, e.g. `FRIDGE_FULL`, `PLAN_CHANGED`), 429 (rate limited), 503.
- Realtime (Socket.IO, same origin, `auth: {token}`): `fridge:update`, `fridge:latch`, `batch:update`,
  `alert:new`, `alert:update`, `prediction:update`, `relocation:update`, `security:event`,
  `device:status`, `device:cmdack`, `device:command`.

59 routes.

## health

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/health` | public |  |  |  |

## ready

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/ready` | public |  |  |  |

## auth

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| POST | `/api/auth/login` | public |  |  | `email`: email ≤ 254 chars<br>`password`: string ≤ 200 chars |
| POST | `/api/auth/totp/verify` | public |  |  | `mfaToken`: string ≤ 2000 chars<br>`code?`: string<br>`recoveryCode?`: string |
| GET | `/api/auth/me` | any signed-in user |  |  |  |
| POST | `/api/auth/logout` | any signed-in user |  |  |  |
| POST | `/api/auth/password` | any signed-in user |  |  | `current`: string ≤ 200 chars<br>`next`: string ≤ 72 chars |
| POST | `/api/auth/totp/setup` | any signed-in user |  |  |  |
| POST | `/api/auth/totp/confirm` | any signed-in user |  |  | `code`: string |
| POST | `/api/auth/totp/disable` | any signed-in user |  |  | `code`: string |

## users

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/users` | `user:manage` (Admin) |  |  |  |
| POST | `/api/users` | `user:manage` (Admin) |  |  | `email`: email ≤ 254 chars<br>`name`: string ≤ 100 chars<br>`role`: `ADMIN` \| `PHARMACIST` \| `INSPECTOR`<br>`password`: string ≤ 72 chars |
| PATCH | `/api/users/:id` | `user:manage` (Admin) | `id`: integer ≥ 0 (exclusive) |  | `name?`: string ≤ 100 chars<br>`role?`: `ADMIN` \| `PHARMACIST` \| `INSPECTOR`<br>`active?`: boolean<br>`password?`: string ≤ 72 chars<br>`totp_reset?`: boolean |
| DELETE | `/api/users/:id` | `user:manage` (Admin) | `id`: integer ≥ 0 (exclusive) |  |  |

## displays

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/displays` | `user:manage` (Admin) |  |  |  |
| POST | `/api/displays` | `user:manage` (Admin) |  |  | `label`: string ≤ 100 chars |
| POST | `/api/displays/:id/revoke` | `user:manage` (Admin) | `id`: integer ≥ 0 (exclusive) |  |  |

## audit

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/audit` | `audit:read` (Admin, Pharmacist, Inspector) |  | `type?`: `AUTH_LOGIN` \| `AUTH_FAIL` \| `USER_CREATED` \| `USER_UPDATED` \| `USER_DISABLED` \| `BATCH_CREATED` \| `BATCH_UPDATED` \| `BATCH_MOVED` \| `BATCH_STATUS_CHANGED` \| `LATCH_RESET` \| `DISCARD_ACK` \| `ALERT_RAISED` \| `ALERT_ACKED` \| `ALERT_RESOLVED` \| `ALERT_ESCALATED` \| `SECURITY_REJECT` \| `RELOCATION_PROPOSED` \| `RELOCATION_CONFIRMED` \| `RELOCATION_DISMISSED` \| `DEVICE_EVENT` \| `BREACH_START` \| `BREACH_END` \| `TELEMETRY_CHECKPOINT` \| `AUDIT_VERIFY` \| `READINGS_RETIRED` \| `DEVICE_SECRET_ROTATED` \| `DISPLAY_TOKEN_CREATED` \| `DISPLAY_TOKEN_REVOKED` \| `REPORT_EXPORTED` \| `DEVICE_CALIBRATED`<br>`actor?`: string ≤ 100 chars<br>`batch_id?`: integer ≥ 0 (exclusive)<br>`from?`: integer ≥ 0<br>`to?`: integer ≥ 0<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| GET | `/api/audit/verify` | `audit:verify` (Admin, Pharmacist, Inspector) |  | `from?`: integer ≥ 1<br>`stream?`: `0` \| `1` \| `true` \| `false` |  |

## security

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/security/events` | `audit:read` (Admin, Pharmacist, Inspector) |  | `reason?`: `BAD_JSON` \| `UNKNOWN_DEVICE` \| `STALE_TS` \| `BAD_SIG` \| `REPLAY` \| `BAD_BODY`<br>`device_id?`: string ≤ 64 chars<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| GET | `/api/security/summary` | `audit:read` (Admin, Pharmacist, Inspector) |  |  |  |

## devices

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| POST | `/api/devices/:id/rotate-secret` | `device:manage` (Admin) | `id`: string ≤ 64 chars |  | `reason`: string ≤ 200 chars |
| POST | `/api/devices/:id/calibrate` | `device:manage` (Admin) | `id`: string ≤ 64 chars |  | `offset_c`: number -2..2<br>`reason`: string ≤ 200 chars |

## metrics

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/metrics/ingest` | `metrics:read` (Admin, Inspector) |  |  |  |

## batches

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/batches` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) |  | `fridge_id?`: string ≤ 64 chars<br>`status?`: `SAFE` \| `AT_RISK` \| `DISCARD`<br>`expiring_within_days?`: integer 0..3650<br>`q?`: string ≤ 100 chars<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| POST | `/api/batches` | `batch:write` (Admin, Pharmacist) |  |  | `name`: string ≤ 120 chars<br>`quantity`: integer 1..1000000<br>`criticality`: integer 1..3<br>`expiry_date`: date<br>`manufacturer`: string ≤ 120 chars<br>`lot_number`: string ≤ 64 chars<br>`fridge_id`: string ≤ 64 chars |
| GET | `/api/batches/:id` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: integer ≥ 0 (exclusive) |  |  |
| PATCH | `/api/batches/:id` | `batch:write` (Admin, Pharmacist) | `id`: integer ≥ 0 (exclusive) |  | `name?`: string ≤ 120 chars<br>`quantity?`: integer 0..1000000<br>`criticality?`: integer 1..3<br>`expiry_date?`: date |
| DELETE | `/api/batches/:id` | `batch:delete` (Admin) | `id`: integer ≥ 0 (exclusive) |  | `reason`: string ≤ 500 chars |
| POST | `/api/batches/:id/move` | `batch:write` (Admin, Pharmacist) | `id`: integer ≥ 0 (exclusive) |  | `to_fridge_id`: string ≤ 64 chars |
| GET | `/api/batches/:id/qr` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: integer ≥ 0 (exclusive) | `format?`: `svg` \| `png` = "svg" |  |
| GET | `/api/batches/:id/exposure` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: integer ≥ 0 (exclusive) |  |  |

## public

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/public/batch/:token` | public | `token`: string ≤ 64 chars |  |  |

## fridges

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| POST | `/api/fridges/:id/reset-latch` | `latch:reset` (Admin) | `id`: string ≤ 64 chars |  | `reason`: string ≤ 500 chars |
| POST | `/api/fridges/:id/buzzer-test` | `device:test` (Admin, Pharmacist) | `id`: string ≤ 64 chars |  |  |
| GET | `/api/fridges` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) |  |  |  |
| GET | `/api/fridges/:id` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: string ≤ 64 chars |  |  |
| GET | `/api/fridges/:id/readings` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: string ≤ 64 chars | `from?`: integer ≥ 0<br>`to?`: integer ≥ 0<br>`bucket?`: integer 1..86400 |  |
| GET | `/api/fridges/:id/report` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: string ≤ 64 chars | `from`: integer ≥ 0<br>`to`: integer ≥ 0<br>`format?`: `csv` \| `html` = "csv" |  |
| POST | `/api/fridges/:id/sim` | `device:test` (Admin, Pharmacist) | `id`: string ≤ 64 chars |  |  |

## alerts

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/alerts` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) |  | `status?`: `active` \| `acknowledged` \| `resolved` \| `all` = "all"<br>`severity?`: `INFO` \| `WARNING` \| `CRITICAL`<br>`type?`: `DOOR_OPEN_LONG` \| `FRIDGE_BREACH` \| `POWER_FAILURE` \| `BATTERY_LOW` \| `FRIDGE_OFFLINE` \| `BATCH_AT_RISK` \| `BATCH_DISCARD` \| `PREDICTED_BREACH` \| `COMPRESSOR_WEAK` \| `RELOCATION_PROPOSED` \| `FORECAST_DRIFT` \| `SECURITY_FLOOD`<br>`fridge_id?`: string ≤ 64 chars<br>`page?`: integer ≥ 1 = 1<br>`pageSize?`: integer 1..200 = 50 |  |
| POST | `/api/alerts/:id/ack` | `alert:ack` (Admin, Pharmacist) | `id`: integer ≥ 0 (exclusive) |  |  |
| GET | `/api/alerts/recipients` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) |  |  |  |
| POST | `/api/alerts/recipients` | `user:manage` (Admin) |  |  | `email`: email ≤ 255 chars<br>`set_active?`: boolean |
| POST | `/api/alerts/recipients/:id/activate` | `user:manage` (Admin) | `id`: integer ≥ 0 (exclusive) |  |  |
| DELETE | `/api/alerts/recipients/:id` | `user:manage` (Admin) | `id`: integer ≥ 0 (exclusive) |  |  |
| POST | `/api/alerts/recipients/test` | `user:manage` (Admin) |  |  | `email?`: email |

## commands

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/commands/:id` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: uuid |  |  |

## relocations

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/relocations` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) |  | `status?`: `active` \| `all` = "active"<br>`limit?`: integer 1..100 = 20 |  |
| GET | `/api/relocations/:id` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `id`: uuid |  |  |
| POST | `/api/relocations/:id/confirm` | `relocation:confirm` (Admin, Pharmacist) | `id`: uuid |  | `version`: integer ≥ 0 (exclusive) |
| POST | `/api/relocations/:id/dismiss` | `relocation:confirm` (Admin, Pharmacist) | `id`: uuid |  | `reason`: string ≤ 500 chars |

## ml

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/ml/predictions/:fridgeId` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `fridgeId`: string ≤ 64 chars | `from?`: integer ≥ 0<br>`to?`: integer ≥ 0<br>`limit?`: integer 1..2000 = 500 |  |
| GET | `/api/ml/accuracy` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) |  |  |  |
| GET | `/api/ml/report` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) |  |  |  |
| GET | `/api/ml/report/figures/:name` | `dashboard:read` (Admin, Pharmacist, Inspector, Display) | `name`: string |  |  |

## push

| Method | Path | Who | Path params | Query | Body |
|---|---|---|---|---|---|
| GET | `/api/push/vapid-key` | any signed-in user |  |  |  |
| POST | `/api/push/subscribe` | any signed-in user |  |  | `endpoint`: uri ≤ 1000 chars<br>`keys`: object |
| POST | `/api/push/unsubscribe` | any signed-in user |  |  | `endpoint`: uri ≤ 1000 chars |
