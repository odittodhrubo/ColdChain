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

`realtime/`, `mqtt/`, `ml/` and `jobs/` are added by the prompts that need them (P09 onwards).

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
| `users.test.ts` | create (no hash leaked), duplicate email, weak passwords, unknown fields rejected, role change, password reset, disable, last-admin protection, seed (3 users, 2 fridges, 2 devices, encrypted secrets, idempotent) |
