# Backend

Node 20 + TypeScript (strict) + Express 5 + `better-sqlite3` + `zod` + `pino`. Entry point `src/index.ts`; the app is built by `createApp(config, db)` so tests get a fresh in-memory database.

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

`jobs/` runs background work (token purge, audit anchors, reject coalescing). `realtime/`, `mqtt/` and `ml/` are added by the prompts that need them (P09 onwards).

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

`test/rbac.test.ts` takes the routes from the live registry and calls **every route as every role and anonymously**, expecting 2xx / 403 / 401 exactly as the matrix says. A newly registered route without an example request in that test fails the suite.

## Authentication

- `POST /api/auth/login` `{email, password}`: bcrypt (cost `BCRYPT_COST`, 12) and one generic error, `Invalid email or password`, for every failure. An unknown email is compared against a dummy bcrypt hash, so the timing is the same as a wrong password and accounts cannot be enumerated. Disabled accounts fail the same way.
- **Throttling:** 10 attempts per minute per IP (`express-rate-limit`). Per account (keyed by the submitted email, whether or not the account exists), after 5 consecutive failures every further attempt is refused with `ACCOUNT_LOCKED` for 1 min, doubling up to 15 min. A successful login clears the counter.
- **JWT:** HS256 only (algorithm pinned, so `none` and key-confusion tokens fail), `expiresIn` = `JWT_EXPIRES_IN` (`3600`, `15m`, `1h`, `7d`; a bare number means seconds). Claims: `sub`, `role`, `name`, `jti`, `exp`.
- **Every request** verifies the token, checks `revoked_tokens`, and **re-reads role and active from the database**. Demoting or disabling a user takes effect on their next request, not when the token expires.
- `GET /api/auth/me` returns the current user. `POST /api/auth/logout` adds the token's `jti` to `revoked_tokens` until its `exp`, and expired revocations are purged every 10 minutes.

## Users (Admin)

`GET /api/users`, `POST /api/users` `{email, name, role, password}`, `PATCH /api/users/:id` (any of `name`, `role`, `active`, `password`), `DELETE /api/users/:id` (disables; users are never deleted, so audit and batch history keep valid references). Passwords need at least 10 characters and three of: lowercase, uppercase, digit, symbol. Hashes are never returned. The last active admin cannot be disabled or demoted (`409 LAST_ADMIN`); the check runs again inside the write transaction.

## Database

`openDb(DB_PATH)` sets `journal_mode=WAL`, `foreign_keys=ON` and `busy_timeout=5000`, then applies every `src/db/migrations/NNN_*.sql` not yet in `schema_migrations`, each in a transaction. Re-running is a no-op. `001_init.sql` creates the contract §6 tables (`users`, `devices`, `fridges`, `readings`, `events`, `batches`, `batch_assignments`, `alerts`, `nonces`, `security_events`, `audit_log`, `relocation_plans`, `ml_predictions`) plus `revoked_tokens` and `login_attempts`. Keys: `readings UNIQUE(device_id, seq)`, `events UNIQUE(device_id, seq)`, `nonces UNIQUE(device_id, nonce)` + `expires_at` index, `batches UNIQUE(public_token)`; indexes on `readings(fridge_id, ts)`, `events(fridge_id, ts)` and `batch_assignments(batch_id, to_ts)`.

**Device secrets** are stored encrypted with AES-256-GCM under `APP_SECRET_KEY` (`v1:<iv>:<tag>:<ciphertext>`). The GCM tag makes a modified value fail to decrypt rather than yield a wrong secret.

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

Every hour and at every start, `jobs/` stores the head (`head_id`, `head_hash`, `count`) in `audit_anchor` and sends it to Telegram (when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are set) and to the log. A deleted *last* row leaves every remaining link valid; only a head recorded earlier reveals it, and the tests cover exactly this case.

**What the chain does and does not prove.** It proves *integrity*: any change to recorded history is detected. It does not prove *who* wrote a row. An attacker with full write access to the database file could delete everything and recompute a consistent chain from scratch. The off-box anchors make that detectable, because the old head no longer matches. Without external anchoring it would not be. A documented extension is an HMAC of each row under a key kept outside the database.

### Read API

`GET /api/audit?type&actor&from&to&page&pageSize` (permission `audit:read`; `from`/`to` in unix ms, page size ≤ 200): newest first, with `hash`, `prev_hash` and the parsed `payload`, plus `total`.

## Seed

```bash
npm run seed        # or: make seed
```

Creates `admin@`, `pharmacist@` and `inspector@coldchain.local`. Passwords come from `SEED_ADMIN_PASSWORD` / `SEED_PHARMACIST_PASSWORD` / `SEED_INSPECTOR_PASSWORD`, or are random and printed once. It also creates `fridge-01` "Vaccine Fridge A" and `fridge-02` "Vaccine Fridge B" (capacity 20), and devices `fridge-01` / `fridge-02`. Device secrets come from `DEVICE_SECRET_FRIDGE_01/02` in `.env`, so they match the firmware `config.h` from `tools/init_firmware_config.js` and the virtual node; otherwise they are generated and printed once. Re-running never resets passwords or rotates secrets (an `.env` secret that differs from the stored one is applied).

## Docker

The dev image (Node 20) installs `python3 make g++`, because `better-sqlite3` has no prebuilt Linux binary for Node 20 any more and compiles from source. `make up` passes `--renew-anon-volumes`, so the container's `node_modules` volume picks up new dependencies after a rebuild.

## Tests

`npm test` (vitest + supertest):

| File | Covers |
|---|---|
| `health.test.ts` | health, request id, error format (404, malformed JSON, 413), helmet headers, CORS origin |
| `db.test.ts` | all tables, migrations idempotent, unique keys and indexes, foreign keys, AES-GCM round trip / tamper / wrong key |
| `auth.test.ts` | login, identical error + bcrypt run for unknown email, disabled account, lockout after 5 and unlock, per-IP rate limit, `$2b$12$` hashes, logout revocation, expired / tampered / wrong-key / `alg:none` tokens, demotion and disabling take effect at once |
| `rbac.test.ts` | every registered route × Admin / Pharmacist / Inspector / anonymous, plus the matrix itself |
| `audit.test.ts` | canonical JSON edge cases, genesis and links, clean / empty log, triggers, each tamper case with its reason and record id (edited payload, edited hash, changed ts, deleted row, deleted first row, row inserted in the middle, swapped rows, replaced genesis), deleted tail caught by the anchor, recomputed chain caught by the anchor, partial `?from`, 100 parallel appends and two connections → one valid chain, 100k rows < 3 s without blocking, checkpoints (late rows, edited and deleted readings), reject coalescing, bounded queue, API (logins, failures, user changes, pagination, verify, NDJSON stream) |
| `users.test.ts` | create (no hash leaked), duplicate email, weak passwords, unknown fields rejected, role change, password reset, disable, last-admin protection, seed (3 users, 2 fridges, 2 devices, encrypted secrets, idempotent) |
