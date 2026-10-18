# Security

What ColdChain protects, against whom, how, and what it does not protect. The automated part of the review runs with `make security` (`python -m coldchain_tools.security_check`). The latest results are at the end.

## Assets and attackers

| Asset | Why it matters |
|---|---|
| Temperature and door data | wrong data means a spoiled vaccine is given, or a good one is thrown away |
| Batch status (Safe / At risk / Discard) and the public QR answer | what a nurse or patient trusts at the point of use |
| Audit log | the evidence of what happened and who did it |
| Accounts and roles | who may move stock, reset the red latch, manage users |
| Device secrets, JWT and app keys | forging any of the above |

Attackers considered:
- someone on the network, or on a public MQTT broker, who can read and send MQTT messages;
- a curious or malicious signed-in user with a low role;
- the public, through the QR page;
- someone who gets hold of the database file.

## Threats and controls

### Forged device data

- **Signed envelopes:** every device message is an envelope `{v, device_id, kind, ts, nonce, body, sig}`.
  - `sig` is HMAC-SHA256 over a canonical string, with a per-device 256-bit secret.
  - It is verified in constant time.
  - An unknown or inactive device is refused (`UNKNOWN_DEVICE`).
  - A wrong signature or an edited body is refused (`BAD_SIG`).
  - A schema violation is refused (`BAD_BODY`).
- **Secrets at rest:** device secrets are stored encrypted in the database (`APP_SECRET_KEY`, AES-GCM). On the device they live in a git-ignored `config.h`.
- **Commands to devices** (`RESET_LATCH`, `SET_LATCH`, `SYNC_REQUEST`, `BUZZER_TEST`) are signed the same way. The device verifies them, and acknowledges each one with a signed `cmdack`.

### Replay

- Timestamps must be within ±30 s (`STALE_TS`).
- A nonce is remembered for 120 s, more than the whole accepted window (`REPLAY`).
- `(device, seq)` is unique, so a re-sent reading can never be counted twice.
- The Security page shows each device's **clock skew**, because a drifting clock is the usual reason for `STALE_TS`.

### Flooding

- A device or address producing many rejects in a minute raises a `SECURITY_FLOOD` alert.
- Rejects are coalesced per minute into the audit chain, so a flood cannot bloat it.
- HTTP limits:
  - login: 10 attempts a minute per address;
  - public QR endpoint: 60 a minute per address;
  - relocation confirm: 20 a minute;
  - JSON bodies: at most 100 kB.

### Tampering with records

- `audit_log` is a hash chain: each row's hash covers the previous hash, its id, time, actor, type and payload.
- Database triggers make the table append-only for ordinary SQL.
- **Verify Integrity** recomputes the whole chain and names the first broken record, along with what was changed, inserted, deleted or reordered.
- The head is **anchored**: hourly and at every start it is recorded and sent off-box to the ops channel. A truncation or a full rewrite therefore no longer matches the anchor.
- Readings are covered by periodic checkpoints in the chain.
- The demo tool `coldchain_tools.tamper` shows all of this live.

### Privilege escalation

- **RBAC is enforced on the server, deny by default.** Every route declares a permission. A test fails when a route has no example request and access rule, and checks every route × role (150 cases). Scenario S9 checks it again against a live server.
- **Every request re-reads the role and the active flag from the database.** Disabling a user or changing their role takes effect at once. Logout revokes the token.
- **JWTs** are HS256 with the algorithm pinned, so `none` and algorithm swaps are refused. They expire after 8 h. The secret is at least 32 random characters, checked at start-up.
- **Input validation:**
  - every body, query and path parameter goes through a strict zod schema, and unknown fields are refused (no mass assignment of `role` or `password_hash`);
  - passwords are bcrypt (cost 12) and need 10+ characters from three classes;
  - the last active Admin cannot be disabled or demoted.
- **High-impact actions:**
  - only an Admin can reset the red latch, and must give a reason;
  - a relocation confirm quotes the plan version (optimistic lock). It is idempotent, re-validated at confirm time and transactional.

### Data leakage

- **Public QR page:**
  - a fixed whitelist of fields: name, lot, expiry, status, expired, last checked;
  - an unguessable 72-bit token, never sequential;
  - the same 404 for malformed and unknown tokens;
  - `Cache-Control: no-store` and `noindex`.
- **CORS** allows only the configured web origin. The ML service sends no CORS headers and is bound to localhost.
- **Web security headers:** helmet sets a Content-Security-Policy, HSTS, `X-Content-Type-Options`, frame denial and Referrer-Policy. `X-Powered-By` is off.
- **Untrusted text:** React escapes it. The report's markdown renders without raw HTML. A stored XSS payload is shown as text (tested).
- **Logs** carry request ids, never passwords, tokens or secrets.

### Injection

- Every SQL statement is parameterised. User input never builds SQL; `LIKE` wildcards are escaped.
- The security check sends classic payloads to every free-text query parameter and expects no 5xx, no extra rows and an intact database.

## What is not protected

- **Confidentiality on a public broker.** HMAC protects integrity and authenticity, not secrecy: on `broker.hivemq.com` anyone can read the readings. Use the TLS HiveMQ Cloud cluster or local Mosquitto with accounts for anything real.
- **A stolen device secret.** Whoever has it can sign data for that one device. To recover, rotate the secret: re-seed the device row and update `config.h`.
- **An attacker with the database file and the anchors.** The chain shows edits. A full rewrite is caught only while the off-box anchors stay out of the attacker's reach.
- **TLS for the web app** is the deployment's job: put the backend behind a reverse proxy with HTTPS. `trust proxy` is set for loopback.
- **Token theft by XSS.** The session token lives in `sessionStorage` to keep the app simple, with XSS mitigated by React escaping and the CSP. A cookie-based session would remove that class.
- **Physical tampering** with the sensor, and denial of service beyond the rate limits.
- **Readings sent while the backend is down.** The devices publish with QoS 0 (PubSubClient), so the broker does not keep them. The device buffer covers broker and Wi-Fi outages, not a backend outage. The gap is detected and its exposure is counted conservatively. See [KNOWN_ISSUES.md](KNOWN_ISSUES.md).

## Latest automated check

`make security` (`python -m coldchain_tools.security_check`) rewrites the block below on every run.

<!-- results:start -->
Run on 2026-10-18 (static checks and live probes): 14/14 PASS, 0 FAIL, 0 WARN.

| Result | Check | Detail |
|---|---|---|
| PASS | npm audit backend (production deps) | none |
| PASS | npm audit frontend (production deps) | moderate 2 |
| PASS | pip-audit ml | no known vulnerabilities |
| PASS | secrets in tracked files | none |
| PASS | secrets in git history | none |
| PASS | secrets and data are git-ignored | all |
| PASS | security headers | helmet set, no X-Powered-By |
| PASS | CORS refuses other origins | ACAO='http://localhost:5173' (not the request origin) |
| PASS | JWT tampering refused (401) | role edited to ADMIN, old signature, alg none, signed with a wrong key, expired (valid signature) |
| PASS | SQL injection probes (parameterised queries) | 20 probes, no 5xx, no extra rows, data intact |
| PASS | stored XSS payload | stored verbatim, served as JSON; the UI escapes it (src/pages/pages.test.tsx) |
| PASS | public batch endpoint leaks nothing | fields ['expired', 'expiry_date', 'last_checked', 'lot_number', 'name', 'status']; unknown and malformed both 404/404, identical body True |
| PASS | login rate limit | statuses [401, 429] |
| PASS | public QR endpoint rate limit | 429 after 57 calls |
<!-- results:end -->
