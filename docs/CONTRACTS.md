# Shared contracts

These rules bind the firmware, backend, frontend, ML service and tools. Change a contract here first, then in code.

Machine-readable sources:

- [`contracts/constants.json`](../contracts/constants.json): every threshold, timing and topic template. `tools/gen_constants.py` generates `firmware/fridge-node/include/constants.h`, `backend/src/shared/constants.ts` and `ml/constants.py`. Never hard-code these values anywhere else.
- [`contracts/test_vectors.json`](../contracts/test_vectors.json): HMAC, status and exposure vectors, computed by `tools/gen_vectors.js`, which also emits `firmware/fridge-node/include/test_vectors.h` for the firmware tests. Firmware, backend and the virtual node must all pass them.

`make check` (or `npm run check:gen`) fails when either generated output is stale. `make test` runs that check first.

## 1. Constants

| Name | Value | Meaning |
|---|---|---|
| `SAFE_MIN_C` / `SAFE_MAX_C` | 2.0 / 8.0 | Safe storage band |
| `WARN_HIGH_C` / `WARN_LOW_C` | 7.5 / 2.5 | Early-warning edges inside the band |
| `COMP_ON_AT_C` / `COMP_OFF_AT_C` | 7.0 / 3.0 | Compressor hysteresis |
| `COMP_MIN_OFF_S` | 60 | Minimum compressor off-time |
| `TELEMETRY_PERIOD_S` | 5 | Publish interval (plus on door change) |
| `BUDGET_S` | 3600 | 60-minute heat budget per batch |
| `DOUBLE_ABOVE_C` | 12.0 | Above this, exposure counts ×2 |
| `AT_RISK_PCT` | 20 | Remaining budget below this = At Risk |
| `DOOR_ALARM_S` | 60 | Door open longer than this = alarm |
| `BUFFER_CAPACITY` | 720 | Readings buffered offline (60 min; requirement is ≥ 30 min = 360) |
| `SYNC_CHUNK` | 25 | Readings per sync message |
| `HMAC_WINDOW_S` | 30 | Allowed clock skew for message timestamp |
| `NONCE_TTL_S` | 120 | Nonce memory on the server |
| `FORECAST_HORIZON_MIN` | 30 | AI forecast horizon |
| `GAP_CONSERVATIVE_S` | 15 | Reading gap above which exposure is integrated conservatively |
| `ENVELOPE_VERSION` | 1 | `v` field of the signed envelope |

`HMAC_WINDOW_S` and `NONCE_TTL_S` can be overridden by env on the backend. The backend refuses to start if `NONCE_TTL_S < 2 × HMAC_WINDOW_S`, because a nonce must be remembered for the whole accepted timestamp range.

## 2. Status logic

Identical on firmware, backend and tests.

**Fridge status** (precedence BREACH > WARNING > SAFE):

- `BREACH`: `T > 8.0`, or `T < 2.0`, or sensor fault.
- `WARNING`: `7.5 < T ≤ 8.0`, or `2.0 ≤ T < 2.5`, or door open, or running on battery.
- `SAFE`: otherwise.

Boundaries: 7.5 and 2.5 are SAFE; 8.0 and 2.0 are WARNING.

**Heat exposure (per batch):** while the batch is inside a fridge, each second with `8.0 < T ≤ 12.0` adds **1** weighted second; each second with `T > 12.0` adds **2**. Exactly 8.0 adds nothing; exactly 12.0 adds 1.

`remaining_pct = max(0, 100 × (1 − weighted_exposure_s / 3600))`

**Batch status:** `SAFE` (remaining ≥ 20%), `AT_RISK` (0 < remaining < 20%), `DISCARD` (remaining = 0, or expired). Discard is permanent: exposure never decreases, and a discarded batch never becomes Safe again.

**Gap handling:** a reading represents the interval until the next reading. If the gap between consecutive readings of a fridge exceeds `GAP_CONSERVATIVE_S` (15 s, lost data), integrate it conservatively using `max(T_prev, T_next)`.

## 3. MQTT topics

Prefix = `MQTT_TOPIC_PREFIX` (env). Use a unique prefix on shared brokers, e.g. `coldchain/v1/<teamslug>-<random>`.

| Topic | Direction | Content |
|---|---|---|
| `{prefix}/{device_id}/telemetry` | device → server | live reading (signed) |
| `{prefix}/{device_id}/event` | device → server | discrete event (signed) |
| `{prefix}/{device_id}/sync` | device → server | buffered readings chunk (signed) |
| `{prefix}/{device_id}/ack` | server → device | sync acknowledgement (signed) |
| `{prefix}/{device_id}/cmd` | server → device | command (signed) |
| `{prefix}/{device_id}/cmdack` | device → server | command result (signed) |
| `{prefix}/{device_id}/status` | device → server | LWT `online` / `offline`. Unsigned, informational only, never trusted for data |

## 4. Signed envelope

All topics except `status`:

```json
{"v":1,"device_id":"fridge-01","kind":"telemetry","ts":1767225600,"nonce":"9f2c1a7b5d3e4f60","body":"{\"seq\":1204,...}","sig":"<64 hex chars>"}
```

- `body` is a JSON-encoded **string**. The server verifies the HMAC over the raw string before parsing it. This avoids canonical-JSON mismatches between C++ and JavaScript. Sign the exact string you transmit; never re-serialise after signing.
- `sig = HMAC_SHA256(secret, device_id + "|" + kind + "|" + ts + "|" + nonce + "|" + body)`, lowercase hex.
- **HMAC key:** the UTF-8 bytes of the device secret string exactly as stored and configured (the 64-character hex text). It is not hex-decoded first. The test vectors encode this decision.
- `ts` is the send time (unix seconds, NTP-synced). Reading time lives inside `body.ts`.
- `nonce` is 16 hex chars from `esp_random()`. Server-to-device messages use a server-generated nonce.
- **Server checks, in this order:** parse → known and active device → `|now − ts| ≤ HMAC_WINDOW_S` → HMAC valid (constant-time compare) → nonce unseen (stored for `NONCE_TTL_S`) → body schema. Any failure is rejected and logged with a reason code: `BAD_JSON`, `UNKNOWN_DEVICE`, `STALE_TS`, `BAD_SIG`, `REPLAY`, `BAD_BODY`.
- Nonces are stored **only after** the HMAC verifies, so an attacker cannot burn nonces.
- Buffered data and replay protection are compatible: each sync chunk is a new message with a fresh `ts` and `nonce`; old reading times live inside the body; duplicates are removed by `UNIQUE(device_id, seq)`.

## 5. Message bodies

- **telemetry:** `{"seq":int,"ts":int,"temp":float,"door":0|1,"comp":0|1,"power":"MAINS"|"BATTERY","batt":int,"state":"SAFE|WARNING|BREACH","exp_s":int,"latch":0|1,"mode":"model|manual","buf":int,"rssi":int,"fw":"1.0.0","reason":"periodic|door"}`
- **event:** `{"seq":int,"ts":int,"type":"DOOR_OPEN|DOOR_CLOSE|DOOR_ALARM|POWER_FAIL|POWER_RESTORE|BATT_LOW|COMP_ON|COMP_OFF|LATCH_SET|LATCH_RESET|WIFI_LOST|WIFI_BACK|SENSOR_FAULT|BOOT","data":{}}`
- **telemetry** may also carry `"dropped":int` (readings lost to an offline-buffer overflow). It is present only when > 0.
- **sync:** `{"from_seq":int,"to_seq":int,"readings":[<telemetry body without "buf","rssi","fw">...]}`, ordered oldest → newest, at most `SYNC_CHUNK` items. Events raised while offline share the same seq counter, so they travel in the same array as event bodies (`{"seq","ts","type","data":{}}`, recognised by the `type` key; buffered events keep type, seq and ts, not `data`). `from_seq`/`to_seq` are the first and last item's seq.
- **ack** (server → device): `{"seq_upto":int}` = highest contiguous seq stored. After storing every item of a chunk (duplicates ignored via `UNIQUE(device_id, seq)`), the server acks at least that chunk's `to_seq`, idempotently: a resent chunk gets the same ack again, never an error. The device frees buffered items with `seq <= seq_upto`, never earlier, and ignores an ack below its oldest buffered seq. Acks are signed with the device secret and verified like commands (timestamp window, HMAC, nonce).
- **cmd** (server → device): `{"cmd_id":"uuid","type":"RESET_LATCH|SET_LATCH|BUZZER_TEST|SYNC_REQUEST","args":{}}`
- **cmdack:** `{"cmd_id":"uuid","ok":true,"detail":"..."}`
- `seq` is one monotonically increasing counter per device across telemetry and events, persisted in NVS so it survives reboot.

## 6. Core data model (SQLite)

`users`, `devices` (device_id, fridge_id, secret encrypted with `APP_SECRET_KEY`, active), `fridges` (id, name, capacity, latch_state), `readings` (UNIQUE device_id + seq), `events`, `batches` (id, public_token, name, lot, quantity, expiry_date, criticality 1–3, status, weighted_exposure_s, discarded_at, acknowledged_by), `batch_assignments` (batch_id, fridge_id, from_ts, to_ts), `alerts`, `nonces`, `security_events`, `audit_log` (hash chain), `relocation_plans`, `ml_predictions`.

## 7. REST API surface

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` (no auth) |
| Auth | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` |
| Users (Admin) | `GET/POST /api/users`, `PATCH/DELETE /api/users/:id` |
| Fridges | `GET /api/fridges`, `GET /api/fridges/:id`, `GET /api/fridges/:id/readings?from&to&bucket`, `POST /api/fridges/:id/reset-latch` (Admin) |
| Batches | `GET/POST /api/batches`, `GET/PATCH /api/batches/:id`, `POST /api/batches/:id/move`, `GET /api/batches/:id/qr` |
| Public | `GET /api/public/batch/:token` (no auth) |
| Alerts | `GET /api/alerts`, `POST /api/alerts/:id/ack` |
| Security | `GET /api/security/events` |
| Audit | `GET /api/audit`, `GET /api/audit/verify` |
| AI | `GET /api/ml/predictions/:fridgeId`, `GET /api/ml/report` |
| Relocation | `GET /api/relocations`, `POST /api/relocations/:id/confirm`, `POST /api/relocations/:id/dismiss` |
| Realtime | Socket.IO events: `fridge:update`, `batch:update`, `alert:new`, `prediction:update`, `relocation:update` |

ML service: `GET /health` (port 8000).

## 8. Permission matrix

Enforced **on the server**; the UI only mirrors it.

| Capability | Admin | Pharmacist | Inspector |
|---|:-:|:-:|:-:|
| View dashboard, fridges, batches, alerts | ✔ | ✔ | ✔ |
| Create/edit batches, move between fridges | ✔ | ✔ | ✘ |
| Confirm relocation (one click) | ✔ | ✔ | ✘ |
| Acknowledge alerts | ✔ | ✔ | ✘ |
| Reset red latch / discard acknowledgement | ✔ | ✘ | ✘ |
| Manage users | ✔ | ✘ | ✘ |
| View security events and audit log | ✔ | ✔ (read) | ✔ (read) |
| Run **Verify Integrity** | ✔ | ✔ | ✔ |
| Public QR check | no login needed | | |

## 9. Hardware pin map

ESP32 DevKit C, one firmware, two Wokwi projects.

| Function | GPIO | Notes |
|---|---|---|
| DS18B20 data | 4 | 4.7 kΩ pull-up to 3V3 |
| Door switch (slide) | 15 | `INPUT_PULLUP`; LOW = CLOSED, HIGH = OPEN |
| Compressor relay IN | 16 | active HIGH |
| LED green / yellow / red | 25 / 26 / 27 | SAFE / WARNING / red |
| LED blue (compressor indicator) | 19 | mirrors relay |
| Buzzer | 18 | |
| Power-fail button | 32 | toggles mains/battery |
| Wi-Fi outage button | 33 | toggles simulated outage |
| Mode slide switch | 23 | OFF = thermal model, ON = manual DS18B20 |
| OLED SSD1306 I²C | SDA 21 / SCL 22 | address `0x3C`, 128×64 |

**LED meaning:** green = SAFE, yellow = WARNING, red blinking = BREACH, red solid = DISCARD latch (until admin reset).
