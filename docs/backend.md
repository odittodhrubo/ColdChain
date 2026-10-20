# Backend

Node 22 + TypeScript (strict) + Express 5 + `better-sqlite3` + `zod` + `pino`. Entry point `src/index.ts`; the app is built by `createApp(config, db)` so tests get a fresh in-memory database.

```
src/
  config.ts, env.ts     env validation (zod), fail fast
  app.ts                middleware + route registry
  db/                   openDb (WAL, foreign_keys=ON), numbered migrations, seed
  auth/                 bcrypt passwords, JWT, authenticate middleware, login/me/logout
  rbac/permissions.ts   the permission matrix (one file)
  modules/<name>/       feature modules (users, ...): routes.ts + service.ts
  shared/               errors, http (route registry, validation), logger, secretbox, constants (generated)
  scripts/seed.ts       npm run seed
```

`jobs/` runs background work: token purge, audit anchors, reject coalescing, the ingest tick and nonce purge. `mqtt/` is the device pipeline and `realtime/` the Socket.IO push; `ml/` arrives in P18.

## Requests and errors

- Middleware, in order: request id (`X-Request-Id`, echoed or generated, one log line per request), `helmet`, CORS limited to `CORS_ORIGIN`, JSON body limit 100 kB.
- Every error is `{"error":{"code","message","details?"}}`. Codes include `VALIDATION_ERROR` (400, zod issues in `details`), `BAD_REQUEST` (malformed JSON), `PAYLOAD_TOO_LARGE` (413), `UNAUTHENTICATED` / `INVALID_CREDENTIALS` / `TOKEN_EXPIRED` / `TOKEN_REVOKED` / `INVALID_TOKEN` / `ACCOUNT_DISABLED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `EMAIL_TAKEN` / `LAST_ADMIN` (409), `RATE_LIMITED` / `ACCOUNT_LOCKED` (429), `INTERNAL` (500, details only in the log).
- Logs never contain passwords, tokens or secrets (pino redaction).

## Route registry and RBAC

Routes are declared with `defineRoute({method, path, access, body?, query?, params?, handler})` in each module and mounted by `mountRoutes`:

1. route middleware (for example the login rate limiter);
2. authentication, unless `access: 'public'`;
3. permission check, when `access: {permission}`;
4. validation: body, query and params are parsed with **strict** zod schemas, so unknown fields are rejected (no mass assignment). With no schema the default is an empty strict object, and a route with `:params` must declare a params schema;
5. the handler.

`access` is mandatory: a route cannot exist without a permission decision (deny by default). The permission matrix (contract §8) lives only in `src/rbac/permissions.ts`:

| Permission | Admin | Pharmacist | Inspector |
|---|:-:|:-:|:-:|
| `dashboard:read` (dashboard, fridges, batches, alerts) | ✔ | ✔ | ✔ |
| `batch:write` (create/edit/move batches) | ✔ | ✔ | ✘ |
| `relocation:confirm` | ✔ | ✔ | ✘ |
| `alert:ack` | ✔ | ✔ | ✘ |
| `latch:reset` (red latch, discard acknowledgement) | ✔ | ✘ | ✘ |
| `user:manage` | ✔ | ✘ | ✘ |
| `audit:read` (security events, audit log) | ✔ | ✔ | ✔ |
| `audit:verify` (Verify Integrity) | ✔ | ✔ | ✔ |
| `metrics:read` (ingestion metrics, P09) | ✔ | ✘ | ✔ |
| `device:manage` (rotate a device secret, S7) | ✔ | ✘ | ✘ |

`test/rbac.test.ts` takes the routes from the live registry and calls **every route as every role and anonymously**, expecting 2xx / 403 / 401 exactly as the matrix says. A newly registered route without an example request in that test fails the suite.

## Authentication

- `POST /api/auth/login` `{email, password}`: bcrypt (cost `BCRYPT_COST`, 12) and one generic error, `Invalid email or password`, for every failure. An unknown email is compared against a dummy bcrypt hash, so the timing is the same as a wrong password and accounts cannot be enumerated. Disabled accounts fail the same way.
- **Throttling:** `LOGIN_RATE_LIMIT_PER_MIN` (default 10) attempts per minute per IP (`express-rate-limit`) on login and on the TOTP step, and a limiter of the same size on each account route. Per account (keyed by the submitted email, whether or not the account exists), after 5 consecutive failures, wrong TOTP and recovery codes included, every further attempt is refused with `ACCOUNT_LOCKED` for 1 min, doubling up to 15 min. A successful sign-in clears the counter. Behind a reverse proxy, set `TRUST_PROXY` (default `loopback`; a hop count such as `1`, or a list such as `loopback, uniquelocal`) so the limit counts the client, not the proxy.
- **JWT:** HS256 only (algorithm pinned, so `none` and key-confusion tokens fail), `expiresIn` = `JWT_EXPIRES_IN` (default `1h`; also `3600`, `15m`, `7d`; a bare number means seconds). Claims: `sub`, `role`, `name`, `jti`, `iat`, `exp`.
- **Browser sessions (S1):** the token is set as the `cc_session` cookie: `HttpOnly`, `SameSite=Strict`, `Secure` in production, `Path=/`, expiring with the token. The login body does not carry it, so no script on the page can read it. Scripts, tools and tests send `X-Auth-Mode: token` on login to get `token` in the body, then use `Authorization: Bearer`. That needs the password, so it gives an XSS nothing.
- **CSRF:** a write (anything but `GET` / `HEAD` / `OPTIONS`) authenticated by the cookie must carry an `Origin` (or, without one, a `Referer`) equal to `CORS_ORIGIN`, otherwise `403 CSRF_ORIGIN`. Bearer requests are not checked: no browser adds a Bearer header on its own.
- **Every request** verifies the token, checks `revoked_tokens`, and **re-reads role, active flag, password state and TOTP state from the database**. Demoting or disabling a user takes effect on their next request, not when the token expires. A token issued before the account's last password change (`iat < password_changed_at`) is refused with `TOKEN_REVOKED`, so a password change ends every other session.
- **Login response:** `{expiresAt, user, mustChangePassword, totpEnabled, mfaSetupRequired, token?}`. `GET /api/auth/me` returns the same flags. `POST /api/auth/logout` adds the token's `jti` to `revoked_tokens` until its `exp` and clears the cookie; expired revocations are purged every 10 minutes.

### Password changes (S2)

- `POST /api/auth/password` `{current, next}`: the new password follows the same policy as an admin-set one and must differ from the current one. A wrong current password is `400 INVALID_CURRENT_PASSWORD`, not 401, which would sign the user out. On success every other session of the account ends and this one gets a fresh session. Audited as `USER_UPDATED` `{fields:['password'], by:'self'}`.
- **Forced change:** a password generated by the seed or set by an admin (`POST /api/users`, `PATCH /api/users/:id {password}`) sets `must_change_password`. Until it is changed, every route except `me`, `logout`, `password`, `totp/setup` and `totp/confirm` answers `403 PASSWORD_CHANGE_REQUIRED`, and the web app sends the user to `/account/required`. An admin reset also ends the user's sessions.

### Two-factor sign-in (S3)

- **TOTP** (RFC 6238: HMAC-SHA1, 6 digits, 30 s steps, one step either side accepted). The secret is stored encrypted under `APP_SECRET_KEY`, like device secrets. The last used step is stored (`totp_last_step`), so a code cannot be replayed inside its window.
- **Setup:** `POST /api/auth/totp/setup` returns `{secret, otpauthUri, qrSvg}`. The QR is drawn on the server, so no third party sees the secret. `POST /api/auth/totp/confirm {code}` turns it on and returns **10 recovery codes, once**; only their SHA-256 is stored. `POST /api/auth/totp/disable {code}` turns it off (`409 MFA_REQUIRED` for an Admin while `REQUIRE_ADMIN_MFA` is on).
- **Login with TOTP:** the password step answers `{mfaRequired:true, mfaToken}`, a 5 min JWT of its own type that is never accepted as a session. `POST /api/auth/totp/verify {mfaToken, code | recoveryCode}` starts the session. The MFA token is revoked on use and a recovery code is spent. Audited as `AUTH_LOGIN` with `mfa: 'totp' | 'recovery_code'`.
- **`REQUIRE_ADMIN_MFA=true`:** an Admin without TOTP can reach only the account routes (`403 MFA_SETUP_REQUIRED` elsewhere) until it is set up. Other roles are unaffected.
- **Lost phone:** an Admin clears another user's TOTP with `PATCH /api/users/:id {totp_reset:true}`.

## Users (Admin)

`GET /api/users`, `POST /api/users` `{email, name, role, password}`, `PATCH /api/users/:id` (any of `name`, `role`, `active`, `password`), `DELETE /api/users/:id` (disables; users are never deleted, so audit and batch history keep valid references). Passwords need at least 10 characters and three of: lowercase, uppercase, digit, symbol. A password an admin sets is temporary: the user must change it at the next sign-in. `totp_reset: true` switches a user's two-factor sign-in off. Hashes and secrets are never returned; the view carries `totp_enabled`. The last active admin cannot be disabled or demoted (`409 LAST_ADMIN`); the check runs again inside the write transaction.

## Inventory and public QR check (P10)

`src/modules/batches/`. A batch has `name`, `manufacturer`, `lot_number`, `quantity`, `expiry_date` (`YYYY-MM-DD`), `criticality` (1 low to 3 high), a random `public_token`, and derived `status`, `remaining_pct`, `used_minutes`, `expired`.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/batches?fridge_id&status&expiring_within_days&q&page&pageSize` | `dashboard:read` | `q` searches name, lot and manufacturer (LIKE wildcards escaped) |
| `POST /api/batches` | `batch:write` | needs `fridge_id`; `409 FRIDGE_FULL` at capacity; expiry must be in the future |
| `GET /api/batches/:id` | `dashboard:read` | batch, assignment history, exposure summary (with `demoScale`), `public_url` for the QR check page |
| `PATCH /api/batches/:id` | `batch:write` | any of `name`, `quantity`, `criticality`, `expiry_date` |
| `DELETE /api/batches/:id` | `batch:delete` (Admin) | soft delete, only at quantity 0 (`409 QUANTITY_NOT_ZERO`); frees the fridge slot |
| `POST /api/batches/:id/move` `{to_fridge_id}` | `batch:write` | atomic; `409 BATCH_DISCARDED`, `FRIDGE_FULL`, `SAME_FRIDGE` |
| `GET /api/batches/:id/qr?format=svg\|png` | `dashboard:read` | encodes `${PUBLIC_BASE_URL}/check/<token>`; the SVG carries name and lot as a caption |
| `GET /api/public/batch/:token` | public | see below |

- **Where a batch is:** `batch_assignments` intervals (`from_ts`/`to_ts` in unix ms). A partial unique index allows one open interval per batch. A move closes the open interval and opens the next at the same instant, together with the `BATCH_MOVED` audit entry, in one transaction: any failure leaves the batch where it was, and exposure (P11) is attributed to exactly one fridge at every moment. The batch keeps its used budget when it moves.
- **Capacity** counts batches currently in the fridge (seed: 20 per fridge).
- **Status** comes from one function, `deriveBatchStatus(remaining_pct, expiry_date, discarded)` in `shared/status.ts`: `DISCARD` when out of budget, expired (expiry date before today in UTC) or discarded before; `AT_RISK` below 20 % remaining; else `SAFE`. Every change is persisted with a `BATCH_STATUS_CHANGED` audit entry, a `batch:update` push and the `batchStatusChanged` hook for alerts (P12). Reaching `DISCARD` sets `discarded_at`, which makes it permanent: no API can revive the batch. A job re-derives all batches every 10 minutes (and at start) because expiry moves with the calendar.
- **Public check** (`GET /api/public/batch/:token`, no login): returns exactly `{name, lot_number, expiry_date, status, expired, last_checked}` (a whitelist, never fridge ids, exposure, users or internal ids). `last_checked` is the time of the latest reading in the batch's fridge. Unknown and malformed tokens get the same generic `404`; 60 requests per minute per IP (`429 RATE_LIMITED`); `Cache-Control: no-store`. Tokens are 12 URL-safe characters (72 random bits), so the inventory cannot be enumerated.

## Heat-exposure budget (P11)

`src/modules/exposure/engine.ts` (`HeatEngine`, `ctx.heat`), following contract §2 exactly. The 60-minute budget is the challenge's simplified model of "time out of refrigeration" policies; real stability data is product specific.

- **Rate:** each second in `8 < T ≤ 12 °C` adds 1 weighted second, above 12 °C it adds 2. Exactly 8.0 adds nothing, 12.0 counts ×1. An unknown temperature (sensor fault) counts ×2. `remaining_pct = max(0, 100 × (1 − weighted / 3600))`; below 20 % → `AT_RISK`, 0 → `DISCARD`.
- **Integration:** a reading stands for the time until the next reading of its fridge, at most 5 telemetry periods (25 s). Over a gap of more than 15 s (lost data) it uses the hotter of the two neighbouring readings. Intervals are clipped to the batch's assignment intervals, so a batch only accrues while it is in a fridge, and a moved batch carries its used budget.
- **Source of truth = recomputation:** `computeExposure(batchId)` is a pure function of `readings` and `batch_assignments`. The live path (`applyLive`) only adds the one interval a fresh, newest reading closes, and only when no device seq is missing in between. Data that may still arrive by sync is never estimated: a seq hole marks the fridge pending, the recompute triggered by each sync chunk fills it, and `tick()` (every 10 s) gives a hole up after 5 minutes without progress and counts it with the gap rule (lost data, reboot seq jumps). So the stored total only grows and ends equal to the full recompute, whatever order data arrives in (property test with 25 random late/out-of-order deliveries).
- **Storage:** integer weighted milliseconds (`batches.exposure_ms`, migration `004_exposure.sql`); APIs show `weighted_exposure_s`. It never decreases.
- **`DEMO_TIME_SCALE`** multiplies accrual (scale 30 turns 2 real minutes at 9 °C into the full budget). Every batch response carries `demoScale` (as does `/api/health`), so the UI can show the DEMO MODE banner; it is never applied silently.
- **Transitions** go through the batch module's `refreshStatus`, which acts only when the persisted status changes: `BATCH_STATUS_CHANGED` audit, `batch:update`, alert hook, once per transition. Running out of budget also sets `fridges.latch_state = 1` and emits `fridge:latch`. If the device still reports `latch=0` more than 10 s after a discard in its fridge, the server sends the signed `SET_LATCH` command (at most every 30 s).
- **Admin reset** `POST /api/fridges/:id/reset-latch {reason}` (`latch:reset`, Admin): marks every unacknowledged `DISCARD` batch in the fridge `acknowledged_by/at` with a `DISCARD_ACK` audit entry, then sends the signed `RESET_LATCH` and waits for **both** the device's `cmdack` and its `LATCH_RESET` event (15 s per attempt, 3 attempts with a fresh command each). On success `latch_state = 0`, a `LATCH_RESET` audit entry and `fridge:latch`; otherwise `504 DEVICE_TIMEOUT` and the latch stays on. A discarded batch stays `DISCARD` forever (the public QR page keeps showing Discard); no API can un-discard it. An unlatched fridge with nothing to acknowledge answers at once with `changed: false`.
- **Timeline** `GET /api/batches/:id/exposure` (`dashboard:read`): cumulative weighted seconds over time (≤ 500 points) plus remaining budget, used minutes and `demoScale`.

## Alerts and device commands (P12)

`src/modules/alerts/` (`AlertEngine`, `ctx.alerts`) and `src/mqtt/commands.ts` (`CommandTracker`, `ctx.commands`).

| Type | Raised by | Severity | Resolved by |
|---|---|---|---|
| `DOOR_OPEN_LONG` | `DOOR_ALARM` event (door open > 60 s) | WARNING, CRITICAL after 5 min | `DOOR_CLOSE`, or telemetry `door=0` |
| `FRIDGE_BREACH` | 2 consecutive accepted readings outside 2–8 °C (sensor fault counts) | CRITICAL | a reading back in range (audit `BREACH_START` / `BREACH_END`) |
| `POWER_FAILURE` / `BATTERY_LOW` | `POWER_FAIL` / `BATT_LOW` events | WARNING / CRITICAL | `POWER_RESTORE`, or telemetry `power=MAINS` |
| `FRIDGE_OFFLINE` | ingest watchdog (60 s without an accepted message) | WARNING | the next accepted message |
| `BATCH_AT_RISK` / `BATCH_DISCARD` | batch status changes (P10/P11), and the device's `LATCH_SET` | WARNING / CRITICAL | a discard supersedes the at-risk alert |
| `SECURITY_FLOOD` | more than 20 rejected messages in a minute from one source | WARNING | a quiet minute |
| `PREDICTED_BREACH`, `COMPRESSOR_WEAK`, `RELOCATION_PROPOSED` | AI service (P18) | | |

- **Episodes and dedupe:** `key` = type|fridge|batch (batch alerts key on the batch, so they follow it across moves). While an episode is unresolved, raising the same key updates it and can only escalate it. Acknowledging does not end an episode; resolving does, and the next occurrence is a new alert, so an ack never hides a new breach. A partial unique index enforces one active row per key.
- **Re-notification** every 10 minutes (CRITICAL every 5) until acknowledged or resolved; door alarms escalate to CRITICAL after 5 minutes (`tick()` every 5 s).
- **Channels** (`notifier.ts`): in-app (`alert:new` / `alert:update` over Socket.IO) is the primary channel and always on. Telegram (`sendMessage`, Markdown with escaped user data, fridge name, temperature, duration and a deep link to the dashboard) and SMTP email (`nodemailer`) are optional: unconfigured channels are skipped and the alert is logged as a console fallback, so the app runs fully without external accounts. Each channel has a 10 s timeout and 3 tries with backoff, runs in the background (ingestion never waits), and its outcome is stored per alert in `delivery_status`. Notification text never contains secrets or payloads.
- **Door alarm:** an accepted `DOOR_ALARM` is notified at once (well within 5 s). One that arrives late through sync is still sent, titled `Delayed (offline) – occurred at <time>`, and resolved right away when the door has closed since.
- **API:** `GET /api/alerts?status=active|acknowledged|resolved|all&severity&type&fridge_id&page&pageSize` (`dashboard:read`), `POST /api/alerts/:id/ack` (`alert:ack`: Admin, Pharmacist; `409 ALREADY_ACKNOWLEDGED`). Raise, ack and resolve are audited (`ALERT_RAISED`, `ALERT_ACKED`, `ALERT_RESOLVED`).
- **Commands:** every signed command the server publishes (`RESET_LATCH`, `SET_LATCH`, `SYNC_REQUEST`, `BUZZER_TEST`) is recorded in `pending_commands` and closed by the device's signed `cmdack` (`ACKED` / `FAILED`). Commands sent through `commands.send()` are retried every 5 s with the same `cmd_id` and a fresh nonce and timestamp, 3 attempts, then `TIMEOUT`; others time out after 60 s. Status changes are pushed as `device:command`. `POST /api/fridges/:id/buzzer-test` (`device:test`: Admin, Pharmacist) returns `202` with the command; `GET /api/commands/:id` (`dashboard:read`) reads its status.

## Fridges read API (P14)

`src/modules/fridges/` (`dashboard:read` for all three):

- `GET /api/fridges` → `{fridges, server_time, demoScale}`. Each fridge: `id`, `name`, `capacity`, `latch`, `device_id`, `load`, `batch_counts {SAFE, AT_RISK, DISCARD}`, `status` (the server's `classify()` of the latest reading, `OFFLINE` when the node is silent for 20 s) and `live`: the ingestor's live state, or the newest stored reading after a restart. `live` carries `door_open_at`, `battery_since` and `comp_off_at` (unix s, from the device's own `DOOR_OPEN` / `POWER_FAIL` / `COMP_OFF` events), so "open for mm:ss", "on battery since" and the compressor's minimum off-time countdown come from device time, not from when the browser received an update. `server_time` lets the browser correct its clock.
- `GET /api/fridges/:id` → the fridge, its last 50 events and last 25 readings (each with `late` when it arrived through sync).
- `GET /api/fridges/:id/readings?from&to&bucket` (unix s; default the last hour): history averaged into buckets on the server, the bucket raised as needed so any range is at most 600 points (24 h at 5 s = 17 280 readings → 144 s buckets). Each point has `temp` (avg), `min`, `max` and flags for door opened, compressor running, on battery and late data; events in the range come with it for the chart markers.

## AI loop: predictions, alerts, relocation (P18)

**Scheduler** (`src/ml/engine.ts`): every 30 s (`ml-tick` job), for each fridge with a reading in the last 3 min:
- **Input:** the last 60 minutes as 1-minute buckets (door / compressor as the fraction of the minute, gaps up to 3 min forward-filled), plus the last 24 h of buckets and recent health scores.
- **Call:** `POST {ML_URL}/predict` with a 1 s timeout. Runs never overlap, and ingestion never waits on them.
- **Output:** the answer is stored in `ml_predictions` (`forecast` JSON plus `level`, `source`, `model_version`) and pushed as `prediction:update`.
- **ML service down:** a deterministic rule answers instead, stored with `source: "fallback"` and `stale: true`. The rule is linear extrapolation of the last 30 min, capped while the compressor is visibly cycling, plus a cycle-rate health score against the node's nominal cooling pull. The UI must label it.
- **Alerts** (through the P12 engine):
  - `PREDICTED_BREACH` after 2 consecutive runs at MEDIUM or above; CRITICAL when HIGH. Resolved after 2 calm runs.
  - `COMPRESSOR_WEAK` after 2 weakening runs; CRITICAL below 50. Resolved after 3 healthy runs.

**Planner** (`src/modules/relocation/planner.ts`, pure, unit-tested):
- **A fridge is at risk** when its forecast is HIGH, MEDIUM with the door open or on battery, its health is below 40, or it is on battery below 30 % with the temperature rising.
- **Candidate batches:** every non-discarded batch in it, ordered by lowest remaining budget, then higher criticality, then earliest expiry. Discarded batches are listed as "dispose, cannot be saved".
- **A target must be:** online, `SAFE`, door shut, on mains, forecast `LOW`, health ≥ 60, p90 ≤ 7.5 °C, with free room.
- **Target ranking:** margin under 8 °C first, then health, then room.
- **Room runs out:** the highest-priority batches move first; the rest are reported as `shortfall`.
- **No target at all:** the plan is `NO_SAFE_TARGET`, with each refused fridge and its reason, advice to use a portable cooler, and a CRITICAL alert.

**Plans** (`src/modules/relocation/service.ts`, table `relocation_plans`):
- **Lifecycle:** proposed after 2 consecutive at-risk runs; withdrawn (`CANCELLED`) after 3 safe runs. One active plan per fridge.
- **Changes:** a plan is refreshed with a new `version` only when its moves would change. It expires after 15 min.
- **Audit:** `RELOCATION_PROPOSED`, `RELOCATION_CONFIRMED`, `RELOCATION_DISMISSED`. `RELOCATION_PROPOSED` is also an alert.
- **Nothing moves without a person.**

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/relocations?status=active\|all&limit` | `dashboard:read` | newest first |
| `GET /api/relocations/:id` | `dashboard:read` | |
| `POST /api/relocations/:id/confirm` `{version}` | `relocation:confirm` (Admin, Pharmacist) | rate limited |
| `POST /api/relocations/:id/dismiss` `{reason}` | `relocation:confirm` | records the reason; no new plan for that fridge for 15 min |
| `GET /api/ml/predictions/:fridgeId?from&to&limit` | `dashboard:read` | history (unix ms, default the last 6 h) + `latest` |
| `GET /api/ml/report` | `dashboard:read` | proxied from the ML service: `metrics`, `report_md`, `model_card`, figure URLs; `503 ML_UNAVAILABLE` when it is down |
| `GET /api/ml/report/figures/:name` | `dashboard:read` | the PNG, proxied (whitelisted names) |

**What confirm does:**
1. It re-checks everything at confirm time: the batches are still in the source fridge and not discarded, each target is still eligible, and there is room.
2. It moves all batches in **one transaction**, reusing the P10 move. Each `BATCH_MOVED` carries `plan_id` and the AI rationale, under the confirming user. One `RELOCATION_CONFIRMED` entry is added.
3. Once committed, it emits `batch:update` and `relocation:update`.

**How confirm refuses or repeats:**
- A wrong `version`, an expired plan or changed conditions answer `409` with the refreshed plan in `error.details.plan`, and changed conditions also list `problems`. Nothing moves.
- A `NO_SAFE_TARGET` plan answers `409 NO_SAFE_TARGET`.
- A second confirm of a confirmed plan returns it with `already: true` (double-click safe).

## Database

`openDb(DB_PATH)` sets `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`, then applies every `src/db/migrations/NNN_*.sql` not yet in `schema_migrations`, each in a transaction. Re-running is a no-op. `003_inventory.sql` adds the P10 batch columns, `004_exposure.sql` stores exposure as integer milliseconds, `005_alerts.sql` adds alert episodes and `pending_commands`. `001_init.sql` creates the contract §6 tables (`users`, `devices`, `fridges`, `readings`, `events`, `batches`, `batch_assignments`, `alerts`, `nonces`, `security_events`, `audit_log`, `relocation_plans`, `ml_predictions`) plus `revoked_tokens` and `login_attempts`. Keys: `readings UNIQUE(device_id, seq)`, `events UNIQUE(device_id, seq)`, `nonces UNIQUE(device_id, nonce)` + `expires_at` index, `batches UNIQUE(public_token)`; indexes on `readings(fridge_id, ts)`, `events(fridge_id, ts)` and `batch_assignments(batch_id, to_ts)`.

**Device secrets** are stored encrypted with AES-256-GCM under `APP_SECRET_KEY` (`v1:<iv>:<tag>:<ciphertext>`). The GCM tag makes a modified value fail to decrypt rather than yield a wrong secret.

### Backups

Every `BACKUP_EVERY_MS` (default 6 h), `backupDb` (`src/db/backup.ts`) writes an online copy with SQLite's backup API to `BACKUP_DIR` (default `./data/backups`, git-ignored). The copy is consistent while the app keeps writing, and queued audit entries are flushed into it first. It then deletes the oldest copies beyond `BACKUP_KEEP` (default 28 = 7 days), and only files it named itself.

**Restore:**
1. Stop the backend.
2. Copy `data/backups/coldchain-<time>.db` over `DB_PATH` and delete any `-wal` / `-shm` next to it.
3. Start the backend.
4. Run **Verify Integrity**. The chain must be valid, and the restart writes a new audit anchor.

**Off-box copies** (another disk, object storage) are the deployment's job, e.g. a nightly `rclone copy data/backups remote:coldchain`. A backup on the same disk does not survive a disk failure.

### Readings retention (R8)

At 5 s, each fridge writes about 17 280 readings a day. Two jobs keep the database bounded without losing the record:

- **Rollup** (`rollupReadings`, every 10 min): every finished hour goes into `readings_hourly`, with readings count, readings with a temperature, min / max / average, readings above 8 °C, door open, compressor on, on battery, and seeded. The last 48 h are re-aggregated on each run, so readings synced late are folded in.
- **Retention** (`retireReadings`, hourly): raw readings older than `READINGS_RETENTION_DAYS` (default 90, at least 32) are deleted. A block is deleted only if it is older than the cutoff and every hour it spans is already rolled up.
  - Deletion goes one **telemetry checkpoint block** (100 readings) at a time, oldest first, each in one transaction with a `READINGS_RETIRED` audit entry. That entry quotes the block's id range and its checkpoint `sha256`.
  - **Verify Integrity** accepts a block whose readings are all gone only when such an entry is in the chain with the same hash (`retired` in the result). A row in `readings_retired` alone proves nothing, and neither does a partly deleted block: both are still `READINGS_TAMPERED`.
- **Charts:** for a range that reaches back past the oldest raw reading, `GET /api/fridges/:id/readings` uses the hourly rollups (points with `rollup: 1`) up to the end of the hour that holds the oldest raw reading, and raw readings after it, so no hour is counted twice. Until anything is retired, nothing changes.
- **Exposure** totals are stored per batch and only ever grow, so deleting old readings never lowers them.

## Tamper-evident audit log

`src/modules/audit`. Table `audit_log`: `id` (autoincrement), `ts` (unix ms), `actor` (`user:<id>`, `device:<id>` or `system`), `event_type`, `payload` (canonical JSON text), `prev_hash`, `hash`.

- **Hash rule:** `hash = SHA256(prev_hash | id | ts | actor | event_type | payload)`, and the genesis `prev_hash` is 64 zeros. Every row commits to the one before it.
- **Canonical JSON** (`canonical.ts`), used for both writing and verifying: keys sorted recursively, no whitespace, numbers in their shortest round-trip form (`5.0` → `5`, `-0` → `0`), `undefined` members dropped, non-finite numbers and non-plain objects refused.
- **Append:** `appendEntries` runs in one `BEGIN IMMEDIATE` transaction. It takes the write lock *before* reading the head, so two writers, even in different processes, can never extend the same head and fork the chain. `AuditLog.enqueue` is a bounded async queue (1000; overflow is counted and logged) written in one transaction per tick for high-rate callers.
- **Event types:** `AUTH_LOGIN`, `AUTH_FAIL`, `USER_CREATED/UPDATED/DISABLED`, `BATCH_CREATED/UPDATED/MOVED`, `BATCH_STATUS_CHANGED`, `LATCH_RESET`, `DISCARD_ACK`, `ALERT_RAISED/ACKED`, `SECURITY_REJECT`, `RELOCATION_PROPOSED/CONFIRMED/DISMISSED`, `DEVICE_EVENT`, `BREACH_START/END`, `TELEMETRY_CHECKPOINT`, `AUDIT_VERIFY`. Logins, login failures (email, reason, IP; never the password) and user changes (changed field names; never the password) are logged now; the others are written by the modules that own them.
- **SECURITY_REJECT coalescing:** `AuditLog.securityReject(device, reason)` keeps one window per device + reason. Each minute it writes **one** entry `{device_id, reason, count, first_ts, last_ts}`, so a flood of forged messages cannot bloat the chain. The per-message detail goes to `security_events` (P09).
- **Telemetry checkpoints:** `checkpointReadings(db, fridgeId)` writes a `TELEMETRY_CHECKPOINT` for every full block of 100 readings of a fridge: `{fridge_id, from_id, to_id, from_seq, to_seq, count, sha256}`, where `sha256` covers the canonical JSON of those `readings` rows in id order. Blocks are ranges of reading **row ids**, not seqs: synced (late) readings always get new ids, so they never fall inside an already-checkpointed range and cannot cause false alarms. Editing or deleting a covered reading breaks verification.
- **Immutability:** `BEFORE UPDATE` / `BEFORE DELETE` triggers on `audit_log` raise `audit_log is append-only`. The P06 `tamper` tool drops and recreates them to demonstrate detection. That is defence in depth: the triggers stop accidents and ordinary SQL, and the chain catches someone who bypasses them.

### Verify Integrity

`GET /api/audit/verify[?from=<id>][&stream=1]` (permission `audit:verify`) recomputes the chain in chunks of 5000 rows and yields to the event loop between chunks, so 100 000 rows take well under 3 s and the API stays responsive. Each row is checked in this order:

| Reason | Meaning |
|---|---|
| `ID_GAP` | a row is missing (deleted); `firstBrokenId` is the first row after the gap |
| `GENESIS_INVALID` | row 1 does not start from 64 zeros |
| `PREV_LINK_BROKEN` | `prev_hash` is not the previous row's hash (inserted or reordered rows) |
| `HASH_MISMATCH` | the row's content or hash was changed (payload, ts, actor, ...) |
| `ANCHOR_MISMATCH` | a recorded anchor head is missing or different (deleted tail, or a fully recomputed chain) |
| `READINGS_TAMPERED` | a `TELEMETRY_CHECKPOINT` no longer matches the stored readings |

The response is `{valid, checked, headId, headHash, checkpoints, anchors, firstBrokenId?, reason?, expected?, actual?}`. `?from=id` verifies from that row, trusting the row before it. `?stream=1` returns NDJSON: `{"progress":{checked,total}}` lines, then `{"result":…}`. The call itself is logged as `AUDIT_VERIFY` *after* the check, so recording a verification never changes its own result.

### Anchoring

Every hour and at every start, `jobs/` stores the head (`head_id`, `head_hash`, `count`) in `audit_anchor` and sends it to Telegram (when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are set) and to the log.

**RFC 3161 timestamp (S8, optional):** with `ANCHOR_TSA_URL` set (https only, for example `https://freetsa.org/tsr`), each anchor is also sent to that Time-Stamp Authority. Only `SHA-256("coldchain-anchor|<head_id>|<head_hash>|<count>")` leaves the server, never audit content. A granted reply is stored in `audit_anchor.tsa_reply` with `tsa_url` and `tsa_at`. A failure is logged and the next anchor tries again; it never blocks the chain. Verify Integrity reports the newest stamped anchor as `externalAnchor`, and the stored reply can be checked offline with `openssl ts -verify` (docs/SECURITY.md). A deleted *last* row leaves every remaining link valid; only a head recorded earlier reveals it, and the tests cover exactly this case.

**What the chain does and does not prove.** It proves *integrity*: any change to recorded history is detected. It does not prove *who* wrote a row. An attacker with full write access to the database file could delete everything and recompute a consistent chain from scratch. The off-box anchors make that detectable, because the old head no longer matches. Without external anchoring it would not be. A documented extension is an HMAC of each row under a key kept outside the database.

### Read API

`GET /api/audit?type&actor&batch_id&from&to&page&pageSize` (permission `audit:read`; `batch_id` matches `payload.batch_id`; `from`/`to` in unix ms, page size ≤ 200): newest first, with `hash`, `prev_hash` and the parsed `payload`, plus `total`.

## Device ingestion (MQTT)

`src/mqtt/`: `client.ts` (broker connection), `ingest.ts` (pipeline), `envelope.ts`, `schemas.ts`, `devices.ts`, `commands.ts`.

**Broker:** `mqtt` with TLS for `mqtts://`, and reconnect backoff from 1 s doubling to 30 s. It subscribes to `{prefix}/+/telemetry`, `+/event`, `+/sync`, `+/cmdack` and `+/status` (QoS 1). The `device_id` comes from the **topic** and must equal the envelope's.

**Verification, in this order** (the first failure wins):

| Step | Reject reason |
|---|---|
| topic shape, size ≤ 16 kB, JSON, envelope fields (`v`, 16-hex nonce, ...), envelope `kind` = topic kind | `BAD_JSON` |
| device in the topic exists, is active, equals the envelope's `device_id` (secrets decrypted once, cached 10 s) | `UNKNOWN_DEVICE` |
| \|now − ts\| ≤ `HMAC_WINDOW_S` on the **send** time (reading times inside a sync are never checked) | `STALE_TS` (the skew is recorded) |
| HMAC over `device_id\|kind\|ts\|nonce\|body`, compared with `crypto.timingSafeEqual` after a length/format check | `BAD_SIG` |
| insert into `nonces` (`UNIQUE(device_id, nonce)`, `expires_at = now + NONCE_TTL_S`), **only now that the HMAC passed**, so unauthenticated senders cannot fill the table | `REPLAY` |
| zod schema of the body per kind (strict) | `BAD_BODY` |

`NONCE_TTL_S` (120) is at least 2 × the window (30), so a captured message cannot be replayed even when its timestamp would be fresh again. Expired nonces are purged every minute.

**Rejects** go to `security_events` (`ts, device_id, reason, topic, size, sample_hash` = SHA-256 of the payload, `detail` such as `{skew_s}`), to the audit chain as a coalesced `SECURITY_REJECT` (one per device + reason per minute, with a count), to Socket.IO `security:event`, and to the log. The payload and the secret are never stored or logged.

**Accepted messages:**

- **telemetry:** `INSERT … ON CONFLICT(device_id, seq) DO NOTHING`. The server recomputes the status with the shared `classify()` (a mismatch with the device's `state` is logged at debug level as `STATE_MISMATCH`), updates the live state, emits `fridge:update`, calls `hooks.onReadingsInserted(fridgeId, rows, {late:false})` (heat engine, P11), and writes a `TELEMETRY_CHECKPOINT` per 100 readings.
- **event:** stored once. `DOOR_ALARM`, `POWER_FAIL`, `POWER_RESTORE`, `LATCH_SET`, `LATCH_RESET` and `SENSOR_FAULT` are audited as `DEVICE_EVENT`. `LATCH_SET` / `LATCH_RESET` update `fridges.latch_state` (the reset confirms an admin reset). Every event goes to `hooks.onDeviceEvent` (alerts, P12). `WIFI_BACK` with an open seq gap sends `SYNC_REQUEST` at once.
- **sync:** at most `SYNC_CHUNK` items, `from_seq` / `to_seq` matching the items. Readings and buffered events are inserted sorted by seq in one transaction, marked `late=1`, and passed to `onReadingsInserted(…, {late:true})` so exposure is recomputed. Then a **signed ack** `{seq_upto}` (fresh server nonce, current ts, HMAC with the device secret) goes to `…/ack`. `seq_upto` is the highest contiguous seq counted from the chunk's `from_seq` (contract §5): it never covers anything the device still holds that the server lacks, and reboot seq jumps or a lost live message cannot stall the sync. A resent chunk is stored once and re-acked with the same value.
- **cmdack:** forwarded to `hooks.onCommandAck` and Socket.IO `device:cmdack`.
- **status** (LWT `online` / `offline`): unsigned, so it is only a hint (`device:status` with `hint:true`). It is never stored and never decides the online state.

**Gaps and offline:** if a device's seq jumps past `last + 1` and no sync arrives within 30 s, a signed `SYNC_REQUEST {from_seq, to_seq}` naming the gap is sent (once per gap), and the node replays that range from its live-sent window (R1). After a restart, `last` starts from the highest seq already stored for the device, so a hole from while the backend was down is a gap too. A device with no accepted message for 20 s is marked `online:false` (`fridge:update`), and after 60 s `hooks.onDeviceOffline` fires once (alert, P12).

**Secret rotation (S7):** `POST /api/devices/:id/rotate-secret {reason}` (`device:manage`, Admin) generates a new 32-byte secret, stores it encrypted as `pending_secret_enc`, and sends a signed `ROTATE_SECRET` command. Its args carry the new secret sealed under the **old** one: an XOR pad and a tag, both HMAC-SHA256 with their own labels (contract §4). The answer is `202 {device_id, cmd_id, status:'PENDING'}`.

- The node checks the tag, stores the new secret in NVS, switches to it, and signs its `cmdack` with it.
- The first message that verifies only under the pending secret promotes it in one `UPDATE` (`secret_rotated_at`). From then on the old secret gets `BAD_SIG`.
- The request and the switch are both audited as `DEVICE_SECRET_ROTATED`.
- A second request while one is pending is `409 ROTATION_PENDING`: replacing the pending secret could lock out a node that already switched.
- A node that never got the command keeps working on the old secret. Re-seeding its secret clears the pending one.
- `GET /api/security/summary` shows `rotation_pending` and `secret_rotated_at` per device.

**Run one ingesting backend per broker prefix.** Two instances on the same database would both process every message, and the second correctly rejects each one as `REPLAY`.

**Endpoints:** `GET /api/security/events?reason&device_id&page&pageSize` (`audit:read`), `GET /api/security/summary` (`audit:read`: last-hour accepted and rejected counts, rejects by reason, per device active / last accepted / open sequence gap), `GET /api/metrics/ingest` (`metrics:read`: Admin and Inspector) with accepted counts by kind, rejected counts by reason, late readings, sync requests, and per device last seen / online / LWT hint / max seq / acked up to / open gap.

## Realtime

Socket.IO on the same HTTP server, with the same session as the REST API: the browser's `cc_session` cookie (`withCredentials`), or `io(url, {auth: {token: <JWT>}})` from scripts. The token is verified and checked against revocations and the last password change, and the user must be active. A cookie handshake must come from `CORS_ORIGIN`, the same CSRF rule as REST. Events: `fridge:update` (live state, including `online`), `security:event`, `device:status`, `device:cmdack`; `batch:update`, `alert:new`, `alert:update`, `prediction:update` (each stored prediction) and `relocation:update` (each plan change).

## Seed

```bash
npm run seed        # or: make seed
```

Creates `admin@`, `pharmacist@` and `inspector@coldchain.local`. Passwords come from `SEED_ADMIN_PASSWORD` / `SEED_PHARMACIST_PASSWORD` / `SEED_INSPECTOR_PASSWORD`, or are random and printed once. It also creates `fridge-01` "Vaccine Fridge A" and `fridge-02` "Vaccine Fridge B" (capacity 20), and devices `fridge-01` / `fridge-02`. Device secrets come from `DEVICE_SECRET_FRIDGE_01/02` in `.env`, so they match the firmware `config.h` from `tools/init_firmware_config.js` and the virtual node; otherwise they are generated and printed once. Re-running never resets passwords or rotates secrets (an `.env` secret that differs from the stored one is applied).

## Metrics (D3)

With `METRICS_PORT` set, a second HTTP server answers `GET /metrics` in the Prometheus text format. It binds to `METRICS_HOST` (default `127.0.0.1`; `0.0.0.0` inside a container, with the port left unpublished). The public API port never serves it (`/metrics` there is 404). It has no login, so keep it off the internet.

| Metric | Type | Labels |
|---|---|---|
| `coldchain_readings_total` | counter: readings stored, live and synced | `fridge` |
| `coldchain_rejects_total` | counter: device messages refused | `reason` |
| `coldchain_last_reading_age_seconds` | gauge: time since the last accepted message | `fridge` |
| `coldchain_fridge_temp_c` | gauge: latest temperature | `fridge` |
| `coldchain_batch_remaining_ratio` | gauge: heat budget left (0..1), batches in stock only | `batch` |
| `coldchain_ml_tick_seconds` | histogram: one AI scheduler run | |
| `coldchain_http_request_seconds` | histogram: API latency | `route` (the pattern, never a raw path), `method`, `status` |
| `coldchain_process_*` | Node defaults: CPU, memory, event-loop lag, GC | |

Example alert rule: `coldchain_last_reading_age_seconds > 300` (no reading from a fridge for 5 minutes).

## Error tracking (D4)

Off unless `ERROR_DSN` is set to a Sentry or self-hosted GlitchTip DSN. `src/shared/errorReport.ts` speaks the Sentry envelope protocol directly (no SDK). It reports unexpected 500s from `errorHandler` (tags: request id, route pattern, method), uncaught exceptions and unhandled rejections; expected 4xx errors are never sent. At most 30 events a minute go out, each a single 5 s POST that never blocks or fails a request. **Scrubbing (beforeSend):** JWTs, `Bearer` values, the `cc_session` cookie, emails and 64-hex secrets are replaced before sending. Request bodies and headers are never attached.

## Docker

The dev image (Node 22) installs `python3 make g++`, so the native addons (`better-sqlite3`, `bcrypt`) can compile from source whenever no prebuilt binary matches the Node version. `make up` passes `--renew-anon-volumes`, so the container's `node_modules` volume picks up new dependencies after a rebuild.

### Production with Docker

`infra/docker-compose.prod.yml` runs built images with no source mounts and keeps data on named volumes. The backend and ML images run as unprivileged users, and Mosquitto drops to its own user; Caddy runs as the image's default user to bind 80/443. Every service restarts on its own; broker, backend and ML have healthchecks. It publishes only 80/443 (web app and API through Caddy, HTTPS) and 8883 (devices, MQTT over TLS).

- `backend/Dockerfile.prod`: two stages. The first compiles TypeScript and the native addons; the second copies `dist` and the production `node_modules` into a slim Node 22 image that runs as `node`. Its healthcheck is `GET /api/ready`.
- `frontend/Dockerfile.prod` builds the app and serves it with Caddy (`frontend/Caddyfile`), which proxies `/api` and `/socket.io` to the backend and gets the certificate for `SITE_ADDRESS`.
- The backend waits for a healthy broker and ML service. Prometheus can scrape `backend:9464/metrics` on the private network.

**Before the first start:**

1. `.env` at the repo root with real secrets (`npm run env:init`), `NODE_ENV=production`, `PUBLIC_BASE_URL` and `CORS_ORIGIN` = `https://<SITE_ADDRESS>`, `MQTT_USERNAME=backend` and its `MQTT_PASSWORD`, plus `SITE_ADDRESS` and `HEALTHCHECK_PASSWORD` (both are read by Compose itself).
2. `infra/mosquitto/passwd.prod` with accounts `backend`, `healthcheck` and one per device, for example `mosquitto_passwd -c infra/mosquitto/passwd.prod backend`, then `mosquitto_passwd infra/mosquitto/passwd.prod fridge-01` (no `-c` after the first). It is git-ignored.
3. `infra/mosquitto/certs/server.crt` and `server.key` for the device listener (git-ignored).
4. Start: `docker compose --env-file .env -f infra/docker-compose.prod.yml up -d --build` from the repo root. `--env-file` matters: without it Compose looks for `infra/.env`.

## Tests

`npm test` (vitest + supertest):

| File | Covers |
|---|---|
| `health.test.ts` | health, request id, error format (404, malformed JSON, 413), helmet headers, CORS origin |
| `db.test.ts` | all tables, migrations idempotent, unique keys and indexes, foreign keys, AES-GCM round trip / tamper / wrong key |
| `auth.test.ts` | login, identical error + bcrypt run for unknown email, disabled account, lockout after 5 and unlock, per-IP rate limit, `$2b$12$` hashes, logout revocation, expired / tampered / wrong-key / `alg:none` tokens, demotion and disabling take effect at once |
| `rbac.test.ts` | every registered route × Admin / Pharmacist / Inspector / anonymous, plus the matrix itself |
| `audit.test.ts` | canonical JSON edge cases, genesis and links, clean / empty log, triggers, each tamper case with its reason and record id (edited payload, edited hash, changed ts, deleted row, deleted first row, row inserted in the middle, swapped rows, replaced genesis), deleted tail caught by the anchor, recomputed chain caught by the anchor, partial `?from`, 100 parallel appends and two connections → one valid chain, 100k rows < 3 s without blocking, checkpoints (late rows, edited and deleted readings), reject coalescing, bounded queue, API (logins, failures, user changes, pagination, verify, NDJSON stream) |
| `ingest.test.ts` | the shared HMAC vectors (and the vector envelope accepted end to end), server `classify()` on the status vectors, accepted telemetry (stored once, live state, server status, push), checkpoint every 100, **each reject reason** (12 cases including topic / device and kind mismatch, oversized, future ts, tampered body, unknown field) logged in `security_events` + audit + realtime, recorded skew, replay of identical bytes, the nonce table cannot be filled by forgers, disabled device, flood (p95 < 20 ms, coalesced to one audit row), events (audit, latch state, alert hook), **sync of 360 readings in 15 chunks with a duplicate and shuffled order → exactly 360 ordered rows, acks signed and monotonic, final ack 360**, lost ack, lost live message / seq jump, ack extension only through stored seqs, old reading ts accepted, oversized / inconsistent chunk, late hook, gap → `SYNC_REQUEST` after 30 s, `WIFI_BACK`, offline watchdog 20 s / 60 s, LWT hint, nonce purge, cmdack, metrics and security-events API |
| `realtime.test.ts` | Socket.IO pushes to a valid JWT; missing, invalid and revoked tokens refused; the session cookie works from the app origin only |
| `account.test.ts` | S1 cookie sessions (HttpOnly, SameSite, Secure in production, CSRF origin check, logout), S2 password change (current password, policy, older sessions end, forced change, admin reset, seed), S3 TOTP (RFC 6238 vectors, setup, confirm, two-step login, no code reuse, one-time recovery codes, disable, `REQUIRE_ADMIN_MFA`, admin reset) |
| `config.test.ts` | env validation and defaults, `.env.example` loads on the local broker, placeholders refused, `TRUST_PROXY` forms |
| `backup.test.ts` | a consistent online copy whose audit chain verifies; only the newest `BACKUP_KEEP` kept |
| `retention.test.ts` | hourly rollup equals the raw aggregate, only old rolled-up blocks retired and audited, Verify Integrity stays green, unaudited or partial deletes are still tampering, charts use rollups where raw readings are gone |
| `tsa.test.ts` | RFC 3161 request DER, reply status (long-form lengths too), stamp stored on the anchor, a failing TSA never fails the anchor, nothing sent when unset |
| `broker-acl.test.ts` | dev broker ACL: devices own topics only, backend, injection account without commands, wildcards and unknown accounts refused |
| `errorReport.test.ts` | scrubbing, DSN to envelope URL, envelope shape and frames, off without a DSN, 30 a minute cap, a 500 is reported and a 4xx is not |
| `metrics.test.ts` | counters move with ingest, gauges read at scrape time, route-pattern labels, no `/metrics` on the API port |
| `users.test.ts` | create (no hash leaked), duplicate email, weak passwords, unknown fields rejected, role change, password reset, disable, last-admin protection, seed (3 users, 2 fridges, 2 devices, encrypted secrets, idempotent) |
