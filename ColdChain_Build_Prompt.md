# ColdChain — Vaccine & Medicine Storage Monitor
## Master Build Prompt File (FastRoboX 1.0 · IoT Hackathon · Round 1)

> **How to use this file**
> 1. Give your AI coding assistant **Parts 1–3 (Context, Necessities, Shared Contracts)** once at the start of the session, and keep them in context. Every prompt below depends on them.
> 2. Run the prompts **in order (P00 → P20)**. Each prompt has its own git branch. Finish the prompt, tick its checklist, merge to `main`, then continue.
> 3. Section 6 of every prompt ("Architect / Debugger / Tester Review") lists the traps already known for that feature. After the AI finishes, paste that section back and ask: *"Review your work against each item and fix what fails."*
> 4. The last prompt (P21) produces the 3-minute video plan. Run the **Final Checklist** before recording.

---

# PART 1 — CONTEXT & PROJECT OVERVIEW

## 1.1 The competition
- **Event:** FastRoboX 1.0 – National Robotics Competition 2026, IoT Hackathon, Round 1.
- **Deliverable:** a video presentation, **max 3 minutes**, answering **at least 3 questions** from the challenge. We will cover **all five task areas** inside one integrated system.
- **Deadline:** **5 November 2026**. Late or incomplete submissions may not be evaluated.
- **Challenge:** *ColdChain — Vaccine & Medicine Storage Monitor* (100 marks). Vaccines and insulin lose effectiveness outside **2–8 °C**. Build an IoT cold-chain system that monitors fridge conditions, tracks vaccine heat exposure, keeps temperature safe automatically, and ships with a complete web application.

## 1.2 What we are building (one paragraph)
Two simulated **ESP32 fridge nodes** (Wokwi) each read temperature and door state, run a hysteresis-controlled compressor relay, show status on an OLED, and publish **HMAC-signed MQTT** messages. A **backend** verifies every message (signature, timestamp, nonce), stores readings, tracks a **60-minute heat-exposure budget per vaccine batch**, raises alerts, and writes a **tamper-evident hash-chained audit log**. A **React web app** gives role-based access (Admin / Pharmacist / Inspector), a live dashboard, inventory with QR codes, and a **public QR check page**. An **AI service** forecasts fridge temperature 30 minutes ahead, scores compressor health 0–100, and proposes **which batches to move where**, which a pharmacist confirms with **one click**.

## 1.3 Architecture overview

```
┌──────────────────────┐   MQTT (signed JSON)    ┌────────────────────────────────────────┐
│ Wokwi ESP32 fridge-01│ ───────────────────────►│            MQTT Broker                 │
│ Wokwi ESP32 fridge-02│ ◄───────────────────────│ (HiveMQ Cloud free / Mosquitto)        │
└──────────────────────┘   cmd + ack (signed)    └───────────────┬────────────────────────┘
        ▲                                                         │
        │ (fallback / test)                                       ▼
┌───────┴──────────────┐                        ┌────────────────────────────────────────┐
│ Python virtual node  │──────MQTT──────────────►│ Backend (Node 20 + TS + Express)       │
│ + attack/tamper tools│                         │  ingestion+security · heat engine ·    │
└──────────────────────┘                         │  RBAC/JWT · inventory · alerts ·       │
                                                 │  hash-chain audit · relocation planner │
                                                 │  SQLite · Socket.IO                    │
                                                 └───────┬───────────────────┬────────────┘
                                                         │ REST/WS           │ HTTP
                                                         ▼                   ▼
                                          ┌──────────────────────┐  ┌─────────────────────────┐
                                          │ React + Vite + TS UI │  │ ML service (FastAPI,    │
                                          │ dashboard · QR · AI  │  │ scikit-learn)           │
                                          └──────────────────────┘  └─────────────────────────┘
```

## 1.4 Scope map: challenge task → prompts

| Challenge task | Covered by prompts |
|---|---|
| 1. Fridge Node | P01, P02, P03 |
| 2. Heat-Exposure Budget | P04, P11 |
| 3. Power Failure & Offline Mode | P05, P09 (sync), P12 (alerts) |
| 4. Web Application (Auth, Dashboard, Inventory, QR, Device Security, Hash-chain logs) | P07, P08, P09, P10, P13, P14, P15 |
| 5. AI Breach Prediction & Relocation | P16, P17, P18, P19 |
| Support, QA, delivery | P00, P06, P20, P21 |

---

# PART 2 — NECESSITIES (tools, accounts, versions, conventions)

## 2.1 Software to install
| Tool | Version | Purpose |
|---|---|---|
| Git | latest | branches per prompt |
| Node.js | 20 LTS | backend, frontend |
| Python | 3.11 | ML service, virtual node, tools |
| Docker + Docker Compose | latest | broker, services |
| VS Code | latest | main IDE |
| PlatformIO extension | latest | firmware build |
| **Wokwi for VS Code** extension (or wokwi.com) | latest | ESP32 simulation |
| Mosquitto clients (`mosquitto_pub/sub`) | optional | debugging |

## 2.2 Accounts / external services
- **Wokwi account** (free). Wokwi simulated Wi-Fi uses the SSID **`Wokwi-GUEST`** (open) and reaches the **public internet**, but **not** your `localhost`. A *Private Gateway* feature exists for reaching local services; at the time of writing it is a paid-tier feature, so **verify current Wokwi plan features**. Our default therefore uses a **cloud broker**.
- **MQTT broker (pick one, configurable by env):**
  - **A (default):** HiveMQ Cloud free cluster (TLS `8883`, username/password). Use a **unique topic prefix** (e.g. `coldchain/v1/<teamslug>-<random>`).
  - **B:** public `broker.hivemq.com:1883` for quick tests only. Payloads are public, so HMAC protects integrity, not confidentiality. Never use real data.
  - **C:** local Mosquitto in Docker for the virtual node and backend tests.
- **Telegram bot** (via @BotFather) for alerts: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Email via SMTP is optional. If neither is configured, alerts still appear in-app and in logs.

## 2.3 Tech stack (fixed, do not swap)
- **Firmware:** C++/Arduino on ESP32 (`esp32dev`), PlatformIO. Libraries: `PubSubClient`, `ArduinoJson`, `Adafruit SSD1306` + `Adafruit GFX`, `OneWire` + `DallasTemperature`, `mbedtls` (bundled) for HMAC-SHA256, `Preferences` (NVS), `WiFiClientSecure`.
- **Backend:** Node 20, TypeScript, Express, `better-sqlite3`, `mqtt`, `zod`, `jsonwebtoken`, `bcrypt` (cost 12), `socket.io`, `helmet`, `express-rate-limit`, `pino`, `qrcode`, tests with `vitest` + `supertest`.
- **Frontend:** React 18, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query, `socket.io-client`, Recharts, `lucide-react`, `qrcode.react`.
- **ML:** Python 3.11, FastAPI, uvicorn, scikit-learn, pandas, numpy, joblib, matplotlib, pytest.
- **Infra:** Docker Compose (broker for dev, backend, ml, frontend).

## 2.4 Environment variables (`.env.example` must contain all)
```
# backend
PORT=4000
NODE_ENV=development
JWT_SECRET=change-me-long-random
JWT_EXPIRES_IN=1h
BCRYPT_COST=12
DB_PATH=./data/coldchain.db
APP_SECRET_KEY=32-byte-hex-for-encrypting-device-secrets
PUBLIC_BASE_URL=http://localhost:5173
CORS_ORIGIN=http://localhost:5173
# mqtt
MQTT_URL=mqtts://xxxx.s1.eu.hivemq.cloud:8883
MQTT_USERNAME=
MQTT_PASSWORD=
MQTT_TOPIC_PREFIX=coldchain/v1
# device security
HMAC_WINDOW_S=30
NONCE_TTL_S=120
# demo
DEMO_TIME_SCALE=1
# alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
ALERT_EMAIL_TO=
# ml
ML_URL=http://localhost:8000
```

## 2.5 Engineering conventions
- **Branches:** one branch per prompt, named in the prompt. Merge to `main` only after the checklist passes. Conventional commits (`feat:`, `fix:`, `test:`, `docs:`).
- **Single source of truth for constants:** `contracts/constants.json` (thresholds, topic names, timings). A script generates `firmware/.../constants.h`, backend `constants.ts`, and `ml/constants.py`. Never hard-code a threshold twice.
- **Shared test vectors:** `contracts/test_vectors.json` (HMAC signing vectors, status classification vectors, exposure vectors). Firmware self-test, backend tests, and the virtual node must all pass the same vectors.
- **Secrets never committed.** `config.h` for firmware secrets is git-ignored; ship `config.example.h`.
- **No `delay()` in firmware loops.** Everything is `millis()`-based and non-blocking.
- **Everything is tested.** Each prompt ends with tests that run in one command.

---

# PART 3 — SHARED CONTRACTS (the rules every prompt must obey)

## 3.1 Constants (`contracts/constants.json`)
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

## 3.2 Status logic (identical on firmware, backend, and tests)
**Fridge status** (precedence BREACH > WARNING > SAFE):
- `BREACH`: `T > 8.0` or `T < 2.0` (or sensor fault).
- `WARNING`: `7.5 < T ≤ 8.0`, or `2.0 ≤ T < 2.5`, or door open, or running on battery.
- `SAFE`: otherwise.

**Heat exposure (per batch):** while the batch is inside a fridge, each second of time with `8.0 < T ≤ 12.0` adds **1** weighted second; each second with `T > 12.0` adds **2**. `remaining_pct = max(0, 100 × (1 − weighted_exposure_s / 3600))`.
**Batch status:** `SAFE` (remaining ≥ 20%), `AT_RISK` (0 < remaining < 20%), `DISCARD` (remaining = 0, or expired). **Discard is permanent: exposure never decreases and a discarded batch never becomes Safe again.**

**Gap handling:** a reading represents the interval until the next reading. If the gap between consecutive readings of a fridge exceeds 15 s (lost data), integrate it **conservatively** using `max(T_prev, T_next)`.

## 3.3 MQTT topics (prefix = `MQTT_TOPIC_PREFIX`)
| Topic | Direction | Content |
|---|---|---|
| `{prefix}/{device_id}/telemetry` | device → server | live reading (signed) |
| `{prefix}/{device_id}/event` | device → server | discrete event (signed) |
| `{prefix}/{device_id}/sync` | device → server | buffered readings chunk (signed) |
| `{prefix}/{device_id}/ack` | server → device | sync acknowledgement (signed) |
| `{prefix}/{device_id}/cmd` | server → device | command (signed) |
| `{prefix}/{device_id}/cmdack` | device → server | command result (signed) |
| `{prefix}/{device_id}/status` | device → server | LWT `online`/`offline`, **unsigned, informational only, never trusted for data** |

## 3.4 Signed envelope (all topics except `status`)
```json
{"v":1,"device_id":"fridge-01","kind":"telemetry","ts":1767225600,"nonce":"9f2c1a7b5d3e4f60","body":"{\"seq\":1204,...}","sig":"<64 hex chars>"}
```
- `body` is **a JSON-encoded string** embedded as a string. The server verifies the HMAC over the **raw string** before parsing it. This avoids canonical-JSON mismatches between C++ and JavaScript.
- `sig = HMAC_SHA256(secret, device_id + "|" + kind + "|" + ts + "|" + nonce + "|" + body)`, lowercase hex.
- `ts` is the **send time** (unix seconds, NTP-synced). Reading time lives inside `body.ts`.
- `nonce` is 16 hex chars from `esp_random()` (server-to-device messages use a server-generated nonce).
- **Server checks, in this order:** parse → known & active device → `|now − ts| ≤ HMAC_WINDOW_S` → HMAC valid (constant-time compare) → nonce unseen (stored for `NONCE_TTL_S`) → body schema. Any failure is **rejected and logged** with a reason code: `BAD_JSON`, `UNKNOWN_DEVICE`, `STALE_TS`, `BAD_SIG`, `REPLAY`, `BAD_BODY`. Nonces are stored **only after** the HMAC verifies, so an attacker cannot burn nonces.
- **Buffered data and replay protection are compatible:** each sync chunk is a *new* message with fresh `ts` + `nonce`; old reading times live inside the body; duplicates are removed by `UNIQUE(device_id, seq)`.

## 3.5 Message bodies
- **telemetry:** `{"seq":int,"ts":int,"temp":float,"door":0|1,"comp":0|1,"power":"MAINS"|"BATTERY","batt":int,"state":"SAFE|WARNING|BREACH","exp_s":int,"latch":0|1,"mode":"model|manual","buf":int,"rssi":int,"fw":"1.0.0","reason":"periodic|door"}`
- **event:** `{"seq":int,"ts":int,"type":"DOOR_OPEN|DOOR_CLOSE|DOOR_ALARM|POWER_FAIL|POWER_RESTORE|BATT_LOW|COMP_ON|COMP_OFF|LATCH_SET|LATCH_RESET|WIFI_LOST|WIFI_BACK|SENSOR_FAULT|BOOT","data":{}}`
- **sync:** `{"from_seq":int,"to_seq":int,"readings":[{telemetry-body without "buf","rssi","fw"}...]}` ordered oldest → newest, ≤ `SYNC_CHUNK` readings.
- **ack (server→device):** `{"seq_upto":int}` = highest contiguous seq stored.
- **cmd (server→device):** `{"cmd_id":"uuid","type":"RESET_LATCH|SET_LATCH|BUZZER_TEST|SYNC_REQUEST","args":{}}`
- **cmdack:** `{"cmd_id":"uuid","ok":true,"detail":"..."}`
- `seq` is one monotonically increasing counter per device across telemetry and events, **persisted in NVS** so it survives reboot.

## 3.6 Core data model (SQLite)
`users`, `devices` (device_id, fridge_id, secret encrypted with `APP_SECRET_KEY`, active), `fridges` (id, name, capacity, latch_state), `readings` (UNIQUE device_id+seq), `events`, `batches` (id, public_token, name, lot, quantity, expiry_date, criticality 1–3, status, weighted_exposure_s, discarded_at, acknowledged_by), `batch_assignments` (batch_id, fridge_id, from_ts, to_ts), `alerts`, `nonces`, `security_events`, `audit_log` (hash chain), `relocation_plans`, `ml_predictions`.

## 3.7 REST API surface
| Area | Endpoints |
|---|---|
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

## 3.8 Permission matrix (enforced **on the server**, UI only mirrors it)
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

## 3.9 Hardware pin map (ESP32 DevKit C, one firmware, two Wokwi projects)
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

**LED meaning:** green = SAFE, yellow = WARNING, **red blinking = BREACH**, **red solid = DISCARD latch (until admin reset)**.

---

# PART 4 — THE PROMPTS

> Every prompt below uses the same seven blocks: **1 Name · 2 Branch · 3 Role · 4 Prompt · 5 What we are building · 6 Architect / Debugger / Tester review · 7 Checklist**.

---

## P00 — Project Scaffold & Dev Environment

**1. Prompt name:** Monorepo scaffold, shared contracts, infra
**2. Branch name:** `feat/00-scaffold`
**3. Role:** `[You are a senior staff engineer and DevOps lead setting up a polyglot monorepo for a hackathon team that must ship fast and cleanly.]`

**4. The prompt:**
Create the monorepo `coldchain/` with this layout: `firmware/fridge-node/` (PlatformIO project), `backend/`, `frontend/`, `ml/`, `tools/`, `contracts/`, `infra/`, `docs/`.
1. **Git:** init repo, `main` + `develop`, `.gitignore` (node_modules, `.env`, `data/`, `*.db`, `config.h`, `__pycache__`, `.pio`, models cache), conventional-commit note in README.
2. **Contracts:** create `contracts/constants.json` with every value in Part 3.1 plus topic templates (Part 3.3). Write `tools/gen_constants.py` that generates `firmware/fridge-node/include/constants.h`, `backend/src/shared/constants.ts`, `ml/constants.py`, and add a CI-style check that fails if generated files are stale.
3. **Test vectors:** create `contracts/test_vectors.json` with (a) 5 HMAC vectors (secret, device_id, kind, ts, nonce, body → expected hex sig; compute them with a Node script `tools/gen_vectors.js` so the values are real), (b) 12 fridge-status vectors (temp, door, power → expected state), (c) 8 exposure vectors (list of (dt, temp) → expected weighted seconds).
4. **Infra:** `infra/docker-compose.yml` with services `mosquitto` (dev broker, config in `infra/mosquitto/mosquitto.conf`, password file), `backend`, `ml`, `frontend` (dev servers with volumes). Provide `Makefile` (or npm scripts) with `make up`, `make down`, `make test`, `make seed`, `make demo`.
5. **Env:** write `.env.example` containing every variable in Part 2.4, plus a `backend/src/config.ts` stub validating env with `zod` (fails fast with readable errors).
6. **Scaffolds:** `backend` (TS, Express, `GET /api/health`), `frontend` (Vite React TS Tailwind, blank page), `ml` (FastAPI `GET /health`), `tools/` (python package skeleton), `firmware/fridge-node/platformio.ini` (esp32dev, libraries from Part 2.3, build flags for `FRIDGE_ID`).
7. **Docs:** root `README.md` with architecture diagram (mermaid), prerequisites, quick-start, branch workflow, and the scope map from Part 1.4.
8. Lint/format (eslint, prettier, ruff) and one smoke test per service that runs under `make test`.

**5. What we are actually building:** the skeleton everything else plugs into: one repo, one source of truth for thresholds, shared cross-language test vectors, one-command infra and test entry points.

**6. Architect / Debugger / Tester review:**
- *Architect:* thresholds duplicated across firmware, backend, ML will drift. Generated constants plus a staleness check prevent it.
- *Debugger:* HMAC vectors written by hand are usually wrong. They must be produced by real code and then asserted by every implementation.
- *Debugger:* Wokwi cannot reach `localhost`. The default broker must be a cloud broker; local Mosquitto is only for the virtual node and tests.
- *Tester:* `make test` must fail loudly when any service has zero tests, so nothing silently skips.
- *Architect:* never commit real broker credentials; `.env.example` holds placeholders only.

**7. Checklist:**
- [ ] Repo layout exists exactly as specified; `main` and `develop` branches created.
- [ ] `contracts/constants.json` contains all Part 3.1 values; generator creates the three target files.
- [ ] `test_vectors.json` has 5 HMAC, 12 status, 8 exposure vectors generated by code.
- [ ] `docker compose up` starts mosquitto + backend + ml + frontend; `/api/health` and ML `/health` respond.
- [ ] `.env.example` lists every variable; backend refuses to start with invalid env.
- [ ] `make test` runs one passing smoke test per service.
- [ ] README has diagram, setup steps, branch workflow.

---

## P01 — Wokwi Hardware Design (Two Fridge Nodes)

**1. Prompt name:** Fridge node circuit in Wokwi (×2)
**2. Branch name:** `feat/01-wokwi-hardware`
**3. Role:** `[You are a senior embedded hardware engineer who designs ESP32 circuits and Wokwi simulations that are electrically correct and demo-friendly.]`

**4. The prompt:**
Create two Wokwi projects under `firmware/fridge-node/wokwi/fridge-01/` and `.../fridge-02/`, each with `diagram.json` and `wokwi.toml` (for the VS Code extension, pointing at the PlatformIO build output). Both use the **same firmware**; only `FRIDGE_ID`, secret, and Wi-Fi/MQTT config differ.
1. **Parts and wiring** exactly per the pin map in Part 3.9: ESP32 DevKit C, DS18B20 (+4.7 kΩ pull-up), slide switch (door), relay module (compressor), LEDs green/yellow/red/blue with 220 Ω resistors, buzzer, two pushbuttons (power-fail, Wi-Fi outage) wired with `INPUT_PULLUP` (to GND), slide switch (mode), SSD1306 OLED on I²C.
2. Add **part labels/attrs** in `diagram.json` so the video is readable: "DOOR", "COMPRESSOR RELAY", "POWER FAIL", "WI-FI OUTAGE", "MODE (model/manual)".
3. Provide `docs/hardware.md`: a wiring table, a bill of materials as if for real hardware (relay module, DS18B20 waterproof probe, reed switch, 3.7 V Li-ion + charger board for real battery backup, buzzer), an ASCII/mermaid schematic, and a "how to run in Wokwi (VS Code and web)" section including Wi-Fi SSID `Wokwi-GUEST`.
4. Provide a minimal **hardware smoke-test sketch** (`firmware/fridge-node/test/hw_smoke.cpp`) that blinks each LED in turn, toggles the relay, beeps, prints DS18B20 temperature, reads all inputs, and draws a test screen, so wiring can be verified before the real firmware exists.
5. Document how to add a **real-hardware path**: the same pins, only `config.h` changes (no code changes).

**5. What we are actually building:** the virtual circuit for both fridges and a smoke-test that proves every sensor/actuator is wired correctly, plus documentation that also describes the real-world equivalent.

**6. Architect / Debugger / Tester review:**
- *Debugger:* **GPIO12 is a strapping pin** (can prevent boot if driven high); it is deliberately unused. GPIO34–39 are input-only with no internal pull-ups, so no button may use them.
- *Debugger:* missing DS18B20 pull-up gives constant `-127 °C`; the smoke test must detect and print this clearly.
- *Debugger:* OLED I²C address is `0x3C` in Wokwi; wrong address gives a blank screen, not an error.
- *Tester:* buttons bounce; the smoke test should show raw transitions so the debounce time can be chosen from evidence.
- *Architect:* two identical Wokwi projects must not drift. Generate `diagram.json` from one template via a small script if possible.

**7. Checklist:**
- [ ] Both Wokwi projects load and start without errors.
- [ ] Every component in Part 3.9 is present and on the specified GPIO.
- [ ] Smoke test: all 4 LEDs, buzzer, relay, OLED, door switch, both buttons, mode switch, DS18B20 verified.
- [ ] `docs/hardware.md` includes wiring table, BOM, schematic, run instructions.
- [ ] No component uses GPIO12 or input-only pins for outputs/pull-ups.

---

## P02 — Firmware Core: Sensing, Thermal Model, Compressor Control, OLED & LEDs

**1. Prompt name:** Fridge node control loop and local UI
**2. Branch name:** `feat/02-firmware-core`
**3. Role:** `[You are a senior embedded firmware engineer specialising in real-time control on ESP32 with non-blocking architectures and testable logic.]`

**4. The prompt:**
In `firmware/fridge-node/` implement the node's local behaviour **without networking** (networking comes in P03). Structure the code in modules: `config`, `sensors`, `thermal_model`, `control`, `status`, `display`, `leds`, `inputs`, `main`. No `delay()`; use a cooperative scheduler on `millis()`.
1. **Inputs (`inputs`):** debounced door switch (HIGH = OPEN), power-fail button, Wi-Fi-outage button, mode switch. Expose edge events (`doorChanged`, etc.).
2. **Temperature (`sensors`, `thermal_model`):**
   - **Manual mode** (mode switch ON): read DS18B20 (async conversion, non-blocking) and use it directly. Treat `-127`/`85`/disconnected as **sensor fault**.
   - **Model mode** (default, switch OFF): simulate fridge physics so the compressor visibly cycles: `dT/dt = k_leak·(T_amb − T) + (door_open ? k_door·(T_amb − T) : 0) − (comp_on ? cool_rate : 0)`, with `T_amb = 30 °C`, `k_leak = 0.0004/s`, `k_door = 0.004/s`, `cool_rate = 0.02 °C/s`, plus small Gaussian noise (σ 0.03 °C). Integrate using **real elapsed time** times a `THERMAL_SPEED` multiplier (default 1; demo builds can use 3–6). Initial T = 5.0 °C. Make parameters `constexpr` in `config.h`. Compressor "weakness" must be injectable (`cool_rate` multiplied by `efficiency`, default 1.0, settable by a debug serial command and later by a signed command) so P17 can be demonstrated.
3. **Compressor control (`control`):** hysteresis: **ON when `T ≥ 7.0`**, **OFF when `T ≤ 3.0`**, and **never switch ON until at least 60 s after the last OFF** (use `uint32_t` subtraction, rollover-safe). At boot, the minimum-off timer is treated as already satisfied. A forced OFF (power failure, P05) still starts the 60 s off-timer. Drive the relay and the blue LED.
4. **Status (`status`):** implement the exact classification of Part 3.2 as a pure function `classify(temp, door_open, on_battery, sensor_fault)`, unit-testable on a PC (PlatformIO `native` env). Run it against `contracts/test_vectors.json` status vectors.
5. **Display (`display`):** 128×64 OLED layout: header `FRIDGE-01` + state word (**SAFE / WARNING / BREACH**, inverted video on BREACH); large temperature `4.6°C`; row 3: `DOOR:CLOSED COMP:ON`; row 4: `PWR:MAINS BAT:100%`; footer reserved for connectivity (`WIFI/MQTT/BUF`, filled in P03/P05). Redraw at 2 Hz or on change, never every loop (avoid flicker/I²C hogging).
6. **LEDs (`leds`):** green = SAFE, yellow = WARNING, red blinking (1 Hz) = BREACH, red solid = DISCARD latch (latch logic arrives in P04; expose `setLatch(bool)` now). Only one of green/yellow/red-pattern active at a time except latch overriding red.
7. **Serial debug console:** `status`, `set temp X` (manual override of the model), `set eff X`, `set speed X`, `door open/close`, printing a 1-line state every 5 s.
8. **Tests:** native unit tests for `classify`, hysteresis (including the 60 s rule using a fake clock), and thermal model stability (temperature stays bounded and the compressor cycles between ~3 and ~7 °C within a simulated hour at speed 1).

**5. What we are actually building:** a self-contained fridge controller: simulated physics (or a real/manual sensor), correct hysteresis with minimum off-time, a consistent three-state status, and a clean OLED + LED interface.

**6. Architect / Debugger / Tester review:**
- *Debugger:* with a 60 s minimum off-time, temperature can overshoot above 7 °C while the compressor waits; this is correct, not a bug. Make sure the model's leak rate does not push it above 8 °C in normal operation (3 → 7 °C takes about 400 s at default parameters).
- *Debugger:* `millis()` rollover after ~49 days; always use unsigned subtraction. Never compare absolute timestamps.
- *Debugger:* DS18B20 conversion takes up to 750 ms; a blocking `requestTemperatures()` stalls the loop and breaks 5 s timing.
- *Tester:* float equality at thresholds (`T == 7.0`): use `>=`/`<=` exactly as specified, and test the boundary values 3.0, 7.0, 7.5, 8.0, 2.0.
- *Architect:* keeping `classify` pure and platform-independent is what lets the backend reuse the same vectors.
- *Debugger:* sensor-fault behaviour must be defined (fail-safe: state `BREACH`, event `SENSOR_FAULT`, compressor on a cautious 5 min ON / 10 min OFF duty) and documented; never leave the relay in an undefined state.

**7. Checklist:**
- [ ] OLED shows temperature and exactly one of SAFE / WARNING / BREACH.
- [ ] Compressor turns ON at ≥ 7.0 °C and OFF at ≤ 3.0 °C.
- [ ] Compressor never restarts within 60 s of turning off (proved by native test with fake clock).
- [ ] Door switch changes door state instantly on OLED and affects the thermal model.
- [ ] Model mode and manual (DS18B20) mode both work via the mode switch.
- [ ] LED patterns correct (green/yellow/red blink/blue mirrors relay); red-solid hook exists.
- [ ] `classify` passes all status vectors from `test_vectors.json`.
- [ ] Sensor fault handled and shown on OLED.
- [ ] No `delay()` in firmware loop; loop stays responsive (< 20 ms per iteration).

---

## P03 — Firmware Networking: Wi-Fi, NTP, MQTT, Signed Messages

**1. Prompt name:** Secure MQTT telemetry from the fridge node
**2. Branch name:** `feat/03-firmware-mqtt-secure`
**3. Role:** `[You are a senior IoT firmware and security engineer who builds resilient, non-blocking MQTT clients and applies HMAC message authentication correctly.]`

**4. The prompt:**
Add networking to the firmware from P02 (new modules `net`, `crypto`, `seqstore`, `messages`).
1. **Wi-Fi:** connect to `Wokwi-GUEST` (configurable in `config.h`; real SSID/password for hardware). Fully **non-blocking** reconnect with exponential backoff (1 s → 30 s). Respect the "simulated outage" flag (P05) by refusing to connect while set.
2. **Time:** NTP (`configTime`) with `pool.ntp.org`. Until time is valid (`time() > 1_700_000_000`) **do not publish and do not verify commands**; show `SYNCING TIME` on OLED. Provide `nowUnix()`.
3. **MQTT (`PubSubClient` over `WiFiClientSecure` for port 8883):** call `setBufferSize(4096)`. For simulation `setInsecure()` is acceptable but must be behind a `#define ALLOW_INSECURE_TLS` with a comment explaining that real deployments pin the CA. Non-blocking reconnect with backoff, LWT on `{prefix}/{device_id}/status` (`offline`), publish `online` on connect. Subscribe to `ack` and `cmd` topics. Use the topic templates from Part 3.3.
4. **Sequence numbers (`seqstore`):** one monotonic `seq` per device, persisted to NVS (`Preferences`) every 20 increments and on shutdown/boot recovery (on boot add 20 to the stored value so a crash never reuses a seq).
5. **Signing (`crypto`):** implement `hmacSha256Hex(secret, msg)` with `mbedtls_md_hmac`. Build the **envelope exactly as in Part 3.4**: `msg = device_id|kind|ts|nonce|body`, `body` embedded as a JSON string, `nonce` = 16 hex chars from `esp_random()`. Implement a **boot self-test** that signs every vector in `contracts/test_vectors.json` (embedded via the generated header) and prints `HMAC SELFTEST OK` or halts with an error.
6. **Publishing (`messages`):**
   - Telemetry every **5 s** (`TELEMETRY_PERIOD_S`) with the body in Part 3.5.
   - **Immediate** telemetry (`reason:"door"`) plus a `DOOR_OPEN`/`DOOR_CLOSE` event on every door state change.
   - Events: `BOOT`, `COMP_ON`, `COMP_OFF`, `WIFI_BACK`, `SENSOR_FAULT` (others added in P04/P05).
   - Use `ArduinoJson` with preallocated documents; no heap fragmentation in the steady state (check free heap in the debug console).
7. **OLED footer:** `WIFI✔/✘  MQTT✔/✘  SEQ nnnn`.
8. **Config:** `config.example.h` (Wi-Fi, broker host/port/user/pass, `FRIDGE_ID`, `DEVICE_SECRET`, topic prefix). `config.h` is git-ignored.
9. A debug command `dump` prints the last published envelope so it can be pasted into backend tests.

**5. What we are actually building:** the fridge node's secure uplink: correct time, resilient MQTT, signed envelopes, persistent sequence numbers, and per-5-second plus event-driven publishing.

**6. Architect / Debugger / Tester review:**
- *Debugger:* `PubSubClient` default buffer is 256 bytes; larger messages are **silently dropped**. Setting 4096 is mandatory (sync chunks are ~2 KB).
- *Debugger:* a blocking `client.connect()` or `WiFi.begin()` loop freezes the control loop and the compressor logic. Network failure must never stop the compressor.
- *Debugger:* signing before NTP is valid produces timestamps near 1970, and the server will (correctly) reject them as `STALE_TS`.
- *Security:* `PubSubClient` publishes at QoS 0 only; delivery is not guaranteed, so reliability must come from application-level acks (P05).
- *Security:* never log the secret over serial; only print the first 4 characters of a signature.
- *Tester:* signature mismatch is usually caused by `body` being re-serialised after signing. Sign the exact string that is transmitted.

**7. Checklist:**
- [ ] Boot self-test prints `HMAC SELFTEST OK` against shared vectors.
- [ ] Node connects to the broker; OLED shows WIFI/MQTT status.
- [ ] Telemetry appears on `…/telemetry` every 5 s (observed with `mosquitto_sub` or HiveMQ web client).
- [ ] Door toggle produces an immediate telemetry + event within 1 s.
- [ ] Every message contains `v, device_id, kind, ts, nonce, body, sig` and verifies independently with `tools/gen_vectors.js`.
- [ ] Sequence numbers increase and survive reboot (no reuse).
- [ ] Control loop continues (compressor cycling) while Wi-Fi/MQTT is down.
- [ ] No secrets in git; `config.example.h` provided.

---

## P04 — Firmware: Heat-Exposure Tracking, Red Latch, Signed Commands

**1. Prompt name:** On-device heat budget, discard latch, command channel
**2. Branch name:** `feat/04-firmware-heat-latch-commands`
**3. Role:** `[You are a senior embedded engineer for safety-critical medical-storage devices, focused on fail-safe behaviour and authenticated remote commands.]`

**4. The prompt:**
Extend the firmware with the **device-side half of Task 2**. The server owns per-batch budgets (P11); the device keeps a **fridge-level worst-case budget** so safety indicators work even when offline.
1. **Local exposure counter (`heat`):** every loop tick accumulates weighted seconds exactly per Part 3.2 (`8 < T ≤ 12` → ×1, `T > 12` → ×2), using elapsed real time. Expose `exp_s`, `remaining_pct`. Telemetry already carries `exp_s` and `latch`.
2. **Latch:** when `exp_s ≥ BUDGET_S` set `latch = true`: **red LED solid ON**, a one-time long buzzer beep, event `LATCH_SET`, OLED shows `DISCARD`. The latch **persists in NVS** (and `exp_s` is saved every 30 s and on state change) so a reboot or power cut never clears it. Only a verified `RESET_LATCH` command clears it (see 4), which also zeroes `exp_s`, writes NVS, emits `LATCH_RESET`.
3. **At-risk indication:** when `remaining_pct < 20` show `AT RISK nn%` on the OLED status line (yellow LED already shows WARNING).
4. **Command channel:** subscribe to `{prefix}/{device_id}/cmd`. A command is accepted **only if**: time is valid; envelope fields present; `|now − ts| ≤ 30 s`; HMAC verifies with the device secret; `nonce` not in a small ring cache of the last 32 nonces; `type` is in the whitelist `RESET_LATCH | SET_LATCH | BUZZER_TEST | SYNC_REQUEST`. Anything else is dropped and counted (`rejected_cmds` shown in the debug console). Reply on `cmdack` (signed) with `ok` and `detail`. `SET_LATCH` sets the latch exactly as if the local budget had run out (red solid, `LATCH_SET` event, persisted); `BUZZER_TEST` beeps for 1 s; `SYNC_REQUEST` restarts sync from the last acked seq.
5. Debug-only simulated commands over serial may bypass signatures **only when compiled with `-DDEBUG_UNSIGNED_CMDS`** (off by default).
6. **Tests (native):** exposure integration against the exposure vectors; latch persistence logic with a fake NVS; command acceptance matrix (valid, stale, bad sig, replayed nonce, unknown type).

**5. What we are actually building:** a fail-safe local budget and latch that keep the red LED on even without server contact, and an authenticated command path so only an admin-originated, signed command can clear it.

**6. Architect / Debugger / Tester review:**
- *Architect:* device and server budgets can legitimately differ (the server tracks per batch; the device tracks the fridge). The contract is: the device latches **when the fridge-level budget is exhausted** or when told to by the server; the server is the source of truth for batch status. The admin reset clears both sides (P11).
- *Debugger:* writing NVS every second wears flash; throttle to 30 s plus on state change.
- *Debugger:* if a command arrives before NTP is valid, it must be **rejected**, not accepted with a wrong clock.
- *Security:* a latched node that reboots must come back latched. Test by power-cycling in Wokwi.
- *Tester:* simulate temperatures through the serial override (`set temp 13`) and verify ×2 accrual: 30 s above 12 °C adds 60 weighted seconds.

**7. Checklist:**
- [ ] 60 s at 9 °C adds 60 weighted s; 60 s at 13 °C adds 120 weighted s.
- [ ] At 3600 weighted s: red solid LED, long beep, `LATCH_SET` event, OLED `DISCARD`.
- [ ] Reboot keeps latch and `exp_s`.
- [ ] `RESET_LATCH` with valid signature clears latch and emits `LATCH_RESET`; replayed/stale/bad-sig commands are rejected.
- [ ] `AT RISK` shown below 20% remaining.
- [ ] Native tests pass.

---

## P05 — Firmware: Power Failure, Offline Buffer, Sync, Door Alarm

**1. Prompt name:** Power-failure simulation, 30-minute offline buffer, ordered duplicate-free sync, door alarm
**2. Branch name:** `feat/05-firmware-power-offline-door`
**3. Role:** `[You are a senior IoT reliability engineer who designs store-and-forward systems that never lose or duplicate data.]`

**4. The prompt:**
Implement the device half of **Task 3**.
1. **Power failure simulation:** the power-fail button (GPIO32, debounced) toggles `MAINS ↔ BATTERY`. On `BATTERY`: compressor forced **OFF** (small battery cannot run it), OLED `PWR:BATTERY BAT:nn%`, status gains WARNING, events `POWER_FAIL`/`POWER_RESTORE`. **Battery model:** starts 100%, drains `BATT_DRAIN_PCT_PER_MIN` (default 2, demo 6) on battery, recharges 5%/min on mains; at ≤ 20% emit `BATT_LOW` once; at 0% the node enters **DEAD** (OLED off, no publishing, relay off) until power is restored. Report `power` and `batt` in every telemetry.
2. **Wi-Fi outage simulation:** the Wi-Fi button toggles a flag that disconnects Wi-Fi and prevents reconnection (event `WIFI_LOST` recorded locally, `WIFI_BACK` on recovery). Real outages (broker unreachable) behave identically.
3. **Offline ring buffer (`buffer`):** when the uplink is down, every periodic reading (and door/power events) is stored in a **ring buffer of `BUFFER_CAPACITY = 720` entries** (≥ 2× the required 30 minutes). Entry = `{seq, ts, temp×100 int16, door, comp, power, batt, state, exp_s, latch}` (≈ 16 bytes). Oldest entries are overwritten only when full, with a counter of dropped readings. The OLED footer shows `OFFLINE buf:N`. Optional: persist to LittleFS (not required).
4. **Sync protocol on reconnect:**
   - Send `sync` messages oldest → newest, **≤ 25 readings per message**, each with a fresh `ts` and `nonce` and `from_seq/to_seq`.
   - **Stop-and-wait with app-level ack:** send one chunk, wait for `{"seq_upto":N}` on `…/ack` (verify the server's HMAC), then free entries ≤ N and send the next chunk. Retry the same chunk after 5 s without an ack (max 5 retries, then back off). **Never delete entries before acked.**
   - Live telemetry continues during sync, but it never overtakes data in the order the server stores it (server orders by `seq`; the device simply keeps `seq` monotonic).
   - On `SYNC_REQUEST` from the server, restart sync from the last acked seq.
   - Duplicates are impossible because entries are removed only after ack and the server dedupes by `(device_id, seq)`.
5. **Door alarm:** if the door stays open for **> 60 s** (`DOOR_ALARM_S`): buzzer pattern (200 ms on/200 ms off) until the door closes, event `DOOR_ALARM` once per episode (also buffered if offline; flagged late by the server), OLED `DOOR OPEN!`. The server sends the SMS/Telegram/email alert (P12). Door close silences the buzzer and emits `DOOR_CLOSE`.
6. **Interplay rules:** during `BATTERY` + door open, thermal model uses both effects; during DEAD, thermal model keeps running (the fridge physically warms) but nothing is displayed/published; on revival the node publishes a `BOOT` event and **continues from persisted seq**. The temperature is *not* reset on revival.
7. **Tests (native):** ring buffer overflow/ordering; ack/retry state machine with a simulated lossy link (random drops 30%); battery model; door-alarm timer. Add a **Wokwi scenario script** (`firmware/fridge-node/wokwi/scenarios/offline.md`) listing the exact button sequence for the video: press the Wi-Fi outage button, wait until the OLED footer shows a clearly visible `buf:` count (e.g. 40+ readings, about 3–4 minutes), release the button, and show the readings arriving in order on the dashboard. Document in that file that 360 buffered readings = 30 minutes at 5 s, and prove the full 30-minute capacity with the native test (not by waiting 30 real minutes).

**5. What we are actually building:** a store-and-forward node: it survives power and Wi-Fi loss, never loses data inside its 60-minute buffer, delivers it in order without duplicates using acks, and sounds a local alarm for an open door.

**6. Architect / Debugger / Tester review:**
- *Architect:* ack-before-delete is the only way to guarantee no loss with QoS 0 publishing. "Exactly once" is achieved as **at-least-once + server dedupe**.
- *Debugger:* if the ack is lost (not the data), the device resends the same chunk; the server must re-ack idempotently with the current `seq_upto` rather than error.
- *Debugger:* the nonce must be fresh for every retry; otherwise the retry is correctly rejected as `REPLAY`.
- *Debugger:* a 720-entry buffer at 16 B is ~11.5 KB RAM, acceptable; at 100 B per entry (JSON) it would exhaust heap. Store binary, serialise at send time.
- *Tester:* verify **order** by sending out-of-phase events (door toggled during outage) and checking the stored seq sequence has no gaps and no repeats.
- *Tester:* test buffer overflow (outage > 60 min equivalent) and confirm the dropped counter is reported in the next telemetry.
- *Debugger:* the compressor must remain OFF for 60 s after power returns (min-off rule), so a flapping power button cannot short-cycle it.

**7. Checklist:**
- [ ] Button toggles MAINS/BATTERY; compressor OFF on battery; battery % drains/recharges; `BATT_LOW` once; DEAD at 0%.
- [ ] Power status + battery appear in telemetry, OLED, and events.
- [ ] Wi-Fi outage button stops uplink; OLED shows `OFFLINE buf:N` increasing every 5 s.
- [ ] Buffer holds ≥ 360 readings (30 min); capacity 720 confirmed by test.
- [ ] After reconnect all buffered readings arrive in order, no gaps, no duplicates (verified in DB by P09).
- [ ] Ack lost / data lost / ack late: all recover without loss or duplicates (native lossy-link test).
- [ ] Door open > 60 s: buzzer + `DOOR_ALARM` event once per episode; closes silence.
- [ ] Min-off rule respected after power restore.
- [ ] Scenario script for the video exists.

---

## P06 — Virtual Node Simulator, Attack & Tamper Tools

**1. Prompt name:** Python virtual fridge node + security demo tools
**2. Branch name:** `feat/06-virtual-node-tools`
**3. Role:** `[You are a senior test-automation and security engineer who builds faithful device simulators and reproducible attack scripts.]`

**4. The prompt:**
Build `tools/` (Python 3.11, package `coldchain_tools`) so the backend and ML can be developed and demonstrated **independently of Wokwi**, and so security features can be shown on demand.
1. **`virtual_node.py`**: a faithful port of the firmware behaviour using the same constants: thermal model, hysteresis with 60 s min-off, status classification, local exposure/latch, power-fail, Wi-Fi outage with a ring buffer and ack-based sync, door alarm. Same signed envelope and topics as Part 3.3–3.5 (`paho-mqtt`). CLI: `python -m coldchain_tools.virtual_node --fridge fridge-01 --scenario normal|door_open|power_fail|wifi_loss|heat_spike|weak_compressor|full_demo [--thermal-speed N]`. Scenarios are timed scripts (e.g. `wifi_loss`: run 2 min → drop uplink 2 min → restore). Interactive mode: keyboard commands (`d` door, `p` power, `w` wifi, `e 0.6` set efficiency).
2. **`sim_engine.py`**: the pure simulation core with an **offline fast mode** (no MQTT, virtual clock) used by the ML dataset generator in P16 (so the dataset and the live simulator share one physics model).
3. **`attack.py`** with sub-commands that use a real captured/own message to demonstrate rejection: `replay` (resend an identical valid message), `badsig` (flip one hex char), `stale` (valid signature, `ts` 10 minutes old), `unknown-device` (valid format, wrong device id), `tamper-body` (change temp after signing), `flood` (50 invalid msgs/s for 5 s to test log coalescing).
4. **`tamper.py`**: directly edits a row in the SQLite audit log and a reading (`--audit-id N --field payload`) to demonstrate **Verify Integrity** detection (and `--restore` to undo).
5. **`gen_vectors.js`/`verify_envelope.py`** utilities: verify any pasted envelope against a secret, print which check fails.
6. Unit tests: simulator vs firmware-derived vectors (same HMAC/status/exposure vectors from `contracts`).

**5. What we are actually building:** a second, scriptable "fridge node" that behaves like the Wokwi one, plus the attack and tamper scripts we will run live in the video to prove device security and integrity checking.

**6. Architect / Debugger / Tester review:**
- *Architect:* the simulator must reuse constants and vectors, otherwise it silently diverges from the firmware and the demo lies.
- *Debugger:* simulator `ts` must come from the real clock in live mode (the server window is 30 s); a virtual clock is allowed only in offline mode.
- *Tester:* the `replay` attack must be the **exact same bytes** as an accepted message sent earlier; confirm the server accepts the first and rejects the second.
- *Security:* attack scripts must only target the configured broker prefix and refuse to run if `NODE_ENV=production`.

**7. Checklist:**
- [ ] `virtual_node` publishes valid signed telemetry accepted by the backend (after P09).
- [ ] All six scenarios run and produce the expected events.
- [ ] Offline fast mode generates 24 h of data in seconds (for P16).
- [ ] `attack.py replay|badsig|stale|unknown-device|tamper-body|flood` each runs and prints what rejection is expected.
- [ ] `tamper.py` edits a log row and can restore it.
- [ ] Shared vectors pass in simulator tests.

---

## P07 — Backend Foundation: Database, Auth (JWT + bcrypt), Roles (RBAC)

**1. Prompt name:** Backend core, schema, authentication, server-side permissions
**2. Branch name:** `feat/07-backend-auth-rbac`
**3. Role:** `[You are a senior backend engineer and application-security reviewer who builds Node/TypeScript APIs with strict validation and server-side authorization.]`

**4. The prompt:**
In `backend/` build the foundation (TypeScript strict mode, Express, `better-sqlite3`, `zod`, `pino`).
1. **Structure:** `src/{config,db,auth,rbac,modules/*,shared,realtime,mqtt,ml,jobs}`; centralised error handler returning `{error:{code,message,details?}}`; request-id logging; `helmet`; CORS limited to `CORS_ORIGIN`; JSON body limit 100 kb.
2. **Database:** migration system (numbered SQL files, applied at start, tracked in `schema_migrations`). Create all tables from Part 3.6 with sensible indexes: `readings(device_id, seq) UNIQUE`, `readings(fridge_id, ts)`, `events(fridge_id, ts)`, `nonces(device_id, nonce) UNIQUE` + `expires_at`, `batches(public_token) UNIQUE`, `batch_assignments(batch_id, to_ts)`. Enable WAL, `foreign_keys=ON`. Device secrets are stored **encrypted (AES-256-GCM) with `APP_SECRET_KEY`**.
3. **Auth:** `POST /api/auth/login` (email + password, **bcrypt cost 12**, constant-time failure path, generic error message), returns a signed **JWT** (`HS256`, `JWT_EXPIRES_IN`, claims `sub`, `role`, `name`). `GET /api/auth/me`. `POST /api/auth/logout` (client discards the token; keep a server-side revocation list `revoked_tokens(jti, exp)` checked on each request). Rate-limit login (e.g. 10/min/IP and lockout/backoff after 5 failures per account).
4. **RBAC:** roles `ADMIN`, `PHARMACIST`, `INSPECTOR`. Implement `requireAuth` and `requirePermission('batch:write')` middleware using the permission matrix in Part 3.8 (permission strings in one file). **Authorization is always re-checked on the server from the DB role, not only from the token claim**, so demoting a user takes effect immediately.
5. **Users module (Admin only):** list/create/update/disable users, change role, reset password (min length 10, complexity check), cannot delete/demote the last active admin.
6. **Validation:** every route has a `zod` schema for body/query/params; unknown fields rejected.
7. **Seed script** (`npm run seed`): 3 users — `admin@coldchain.local`, `pharmacist@coldchain.local`, `inspector@coldchain.local` (password printed once, from env or random) — 2 fridges (`fridge-01` "Vaccine Fridge A", `fridge-02` "Vaccine Fridge B", capacity 20 each), 2 devices with randomly generated 32-byte hex secrets (printed once for `config.h`).
8. **Tests (vitest + supertest):** login success/failure, expired and tampered JWT, role matrix test that iterates **every protected route × every role** and asserts 200/403/401 exactly as the matrix says, last-admin protection, password hashing is bcrypt (`$2b$12$`).

**5. What we are actually building:** the secure spine of the web app: schema, login with bcrypt + JWT, and a permission system enforced on the server for the three roles.

**6. Architect / Debugger / Tester review:**
- *Security:* trusting only the JWT `role` claim leaves a window after demotion. Re-read role from DB (cheap with SQLite).
- *Security:* user-enumeration via different error messages or timing on login. Always run a bcrypt compare (against a dummy hash if the user doesn't exist).
- *Security:* mass-assignment: `PATCH /users` must not accept `role` from non-admins; zod strict schemas prevent it.
- *Debugger:* `better-sqlite3` is synchronous; keep DB calls short and never inside tight per-message loops without transactions (see P09).
- *Tester:* generate the role×route test from the route registry so a newly added route without a permission fails the suite ("deny by default").

**7. Checklist:**
- [ ] All Part 3.6 tables created by migrations; re-running migrations is a no-op.
- [ ] Login works; passwords stored as bcrypt hashes; JWT verifies; logout revokes the token.
- [ ] Admin / Pharmacist / Inspector permissions match Part 3.8 on every route (automated test).
- [ ] Unauthenticated request → 401, wrong role → 403, never 200.
- [ ] Rate limit and lockout work.
- [ ] Seed creates 3 users, 2 fridges, 2 devices; device secrets encrypted at rest.
- [ ] Last active admin cannot be removed.

---

## P08 — Tamper-Evident Audit Log (Hash Chain) + Verify Integrity

**1. Prompt name:** Hash-chained audit log
**2. Branch name:** `feat/08-hash-chain-audit`
**3. Role:** `[You are a senior security engineer who designs append-only, tamper-evident audit trails and writes the verification logic that proves them.]`

**4. The prompt:**
Implement the tamper-evident logging module `backend/src/modules/audit`.
1. **Table `audit_log`:** `id INTEGER PK AUTOINCREMENT`, `ts` (unix ms), `actor` (user id / `device:<id>` / `system`), `event_type`, `payload` (canonical JSON text), `prev_hash` (64 hex), `hash` (64 hex). **Genesis** `prev_hash` = 64 zeros.
2. **Hash rule:** `hash = SHA256( prev_hash + "|" + id + "|" + ts + "|" + actor + "|" + event_type + "|" + payload )`, with `payload` produced by a **canonical JSON** function (keys sorted recursively, no whitespace, numbers normalised) so verification is deterministic.
3. **Append API:** `appendAudit(actor, type, payload)` runs in a **single better-sqlite3 transaction** that reads the last row's hash, inserts the next row, and returns it (serialising writers so the chain never forks). Provide a bounded async queue for high-rate callers (security rejects).
4. **What gets logged (event types):** `AUTH_LOGIN`, `AUTH_FAIL`, `USER_CREATED/UPDATED/DISABLED`, `BATCH_CREATED/UPDATED/MOVED`, `BATCH_STATUS_CHANGED`, `LATCH_RESET`, `DISCARD_ACK`, `ALERT_RAISED/ACKED`, `SECURITY_REJECT` (coalesced: one entry per device+reason per minute with a `count`), `RELOCATION_PROPOSED/CONFIRMED/DISMISSED`, `DEVICE_EVENT` (door alarm, power fail/restore, latch set), `BREACH_START/END`, `TELEMETRY_CHECKPOINT` (every 100 accepted readings per fridge: `{from_seq,to_seq,sha256 of the concatenated reading rows}`, so tampering with stored readings is detectable too), `AUDIT_VERIFY`.
5. **Verify Integrity:** `GET /api/audit/verify` recomputes the entire chain and returns `{valid, checked, headHash, firstBrokenId?, reason?: "HASH_MISMATCH"|"PREV_LINK_BROKEN"|"ID_GAP"|"GENESIS_INVALID", expected?, actual?}`. Also verifies each `TELEMETRY_CHECKPOINT` against the current `readings` rows (reason `READINGS_TAMPERED`). Logging an `AUDIT_VERIFY` event for the call itself must not break the verification result. Support `?from=id` partial verification and stream progress for large logs.
6. **Anchoring (documented hardening):** store the latest `headHash` + count in `audit_anchor` every hour and send it to Telegram/console. Document that without external anchoring, an attacker with full DB write access could recompute the whole chain; the anchor makes that detectable.
7. **Read API:** `GET /api/audit?type&actor&from&to&page` paginated, newest first, includes `hash` and `prev_hash`.
8. **Immutability at the DB level:** SQLite triggers `BEFORE UPDATE` and `BEFORE DELETE` on `audit_log` that `RAISE(ABORT, 'audit_log is append-only')`. The tamper script in P06 will have to bypass them (drop trigger) to demonstrate detection, which is intentional: it shows defence in depth.
9. **Tests:** chain builds correctly; editing a payload, editing a hash, deleting a row, inserting a row in the middle, reordering rows, changing ts: each detected with the correct reason and record id; concurrent appends (100 in parallel) produce a valid chain.

**5. What we are actually building:** an append-only journal where every record's hash depends on the previous one, so any edit, deletion, or insertion is detectable by one button ("Verify Integrity"), and tampering with stored readings is caught through periodic checkpoints.

**6. Architect / Debugger / Tester review:**
- *Debugger:* non-canonical JSON (key order, floats like `5.0` vs `5`) makes verification fail on clean data. Use one canonicalisation function for both write and verify, and test it with tricky payloads.
- *Debugger:* a deleted **last** row is invisible to chain-linking checks; the stored `audit_anchor` count/head hash catches it. Test this case explicitly.
- *Security:* a flood of rejected messages can bloat the log; coalescing per device/reason/minute keeps the chain meaningful.
- *Architect:* a hash chain proves *integrity*, not *authenticity of the author*. State this honestly in the docs; optional HMAC of each row with a key outside the DB is a documented extension.
- *Tester:* verify performance with 100k rows (< 3 s) and make sure the UI endpoint doesn't block the event loop (chunked verification).

**7. Checklist:**
- [ ] Every row's hash covers the previous hash; genesis is zeros.
- [ ] `GET /api/audit/verify` returns valid for a clean log.
- [ ] Edit / delete / insert / reorder / timestamp change are each detected with the broken record id.
- [ ] Deleted tail detected via anchor.
- [ ] Triggers block ordinary UPDATE/DELETE.
- [ ] Telemetry checkpoints verify against `readings`; altering a stored reading breaks verification.
- [ ] Concurrent appends keep a single valid chain.
- [x] Audit read API is paginated and role-protected as per matrix.

---

## P09 — Secure MQTT Ingestion: HMAC + Timestamp + Nonce, Dedupe, Sync

**1. Prompt name:** Device message pipeline and device security
**2. Branch name:** `feat/09-secure-ingestion`
**3. Role:** `[You are a senior backend security engineer who builds authenticated device-ingestion pipelines that reject forged, stale, and replayed messages.]`

**4. The prompt:**
Implement `backend/src/mqtt/ingest` following Parts 3.3–3.5 exactly.
1. **Broker client:** connect with `mqtt` (TLS if `mqtts://`), reconnect/backoff, subscribe `{prefix}/+/telemetry`, `+/event`, `+/sync`, `+/cmdack`, `+/status`. The `device_id` is taken from the **topic** and must equal `device_id` in the envelope (mismatch → reject `UNKNOWN_DEVICE`).
2. **Verification pipeline (in this order):** parse JSON → device exists and active (load/cached decrypted secret) → `|now − ts| ≤ HMAC_WINDOW_S` else `STALE_TS` → recompute HMAC over `device_id|kind|ts|nonce|body` and compare with `crypto.timingSafeEqual` else `BAD_SIG` → insert `nonce` into `nonces` (`UNIQUE(device_id, nonce)`, `expires_at = now + NONCE_TTL_S`); constraint violation → `REPLAY` → validate body with `zod` per `kind` else `BAD_BODY`. Purge expired nonces every minute. Because the nonce lives for `NONCE_TTL_S` (≥ 2 × window) a captured message cannot be replayed even after its timestamp would otherwise be valid again.
3. **Reject handling:** insert into `security_events` (`ts, device_id, reason, topic, size, sample_hash`) and write the (coalesced) `SECURITY_REJECT` audit entry; emit Socket.IO `security:event`. Never echo the secret or the full payload in logs.
4. **Accepted telemetry:** in a transaction: insert reading (`INSERT … ON CONFLICT(device_id, seq) DO NOTHING`), update the fridge's live-state cache, compute server-side status via the shared `classify` (compare to device-reported `state`, log `STATE_MISMATCH` at debug level), call the heat engine hook `onReadingsInserted(fridgeId, readings[])` (P11), emit `fridge:update`, count toward the `TELEMETRY_CHECKPOINT`.
5. **Events:** store in `events`; side effects: `DOOR_ALARM`, `POWER_FAIL`, `BATT_LOW`, `LATCH_SET` → alert hook (P12); `LATCH_RESET` confirms a pending reset; `WIFI_BACK` triggers a `SYNC_REQUEST` if the server detects a seq gap.
6. **Sync:** for `kind=sync`, validate chunk size ≤ `SYNC_CHUNK`, insert readings **sorted by seq** with `ON CONFLICT DO NOTHING` in one transaction (marked `late=1`), compute `seq_upto` = highest **contiguous** stored seq for the device, publish a **signed `ack`** (server-generated nonce, current `ts`, HMAC with the device secret) to `…/ack`. Re-acking a duplicate chunk is idempotent. After insert call `onReadingsInserted` with `late=true` so exposure is **recomputed** (P11).
7. **Gap detection and offline detection:** if telemetry `seq` jumps beyond `last+1` and no sync arrives in 30 s, publish a signed `SYNC_REQUEST` command. A watchdog marks a fridge `OFFLINE` if no accepted message for 20 s (the LWT `status` message is only a hint) and raises an alert after 60 s.
8. **Metrics endpoint** (Admin/Inspector): counters accepted/rejected by reason, last seen per device, seq gaps.
9. **Tests:** run the **shared HMAC vectors**; accept a valid message; reject each of the six reasons (including topic/device mismatch); replay identical bytes → `REPLAY`; stale but correctly signed → `STALE_TS`; sync of 360 readings in 15 chunks with a duplicated chunk and shuffled chunk order → DB has exactly 360 rows, ordered, ack = last seq; attacker with random nonces cannot fill the nonce table (nonces stored only after HMAC passes).

**5. What we are actually building:** the gatekeeper for all device data: every message is authenticated and replay-protected; valid readings are stored once, in order; rejections are logged and visible; buffered data is synced and acknowledged safely.

**6. Architect / Debugger / Tester review:**
- *Security:* verifying HMAC **before** storing the nonce prevents nonce-exhaustion by unauthenticated senders.
- *Debugger:* comparing signatures with `===` leaks timing; use `timingSafeEqual` with equal-length buffers (check length first).
- *Debugger:* NTP drift on a device causes false `STALE_TS`. Log the observed skew in the reject record so the cause is obvious in the demo.
- *Debugger:* in a sync chunk the **envelope `ts`** is fresh but **reading `ts`** is old; the code must never apply the freshness window to reading timestamps.
- *Architect:* `seq_upto` must be the *contiguous* maximum; acking the max seq with holes would make the device delete data that never arrived.
- *Tester:* run the pipeline under 2 devices × 5 s plus a 50 msg/s flood; the event loop must stay responsive (p95 handling < 20 ms).

**7. Checklist:**
- [ ] Valid signed telemetry is stored and shown live.
- [ ] Each reject reason (`BAD_JSON, UNKNOWN_DEVICE, STALE_TS, BAD_SIG, REPLAY, BAD_BODY`) works and is logged in `security_events` + audit chain.
- [ ] Identical replayed message is rejected; first copy accepted.
- [ ] Sync stores readings in order with no duplicates; acks are signed and contiguous.
- [ ] Lost ack / duplicate chunk handled idempotently.
- [ ] Gap detection triggers `SYNC_REQUEST`; offline watchdog works.
- [ ] Metrics endpoint shows accepted/rejected counts.
- [ ] Shared HMAC vectors pass; flood test passes.

---

## P10 — Inventory, Batch Assignment & Public QR Check

**1. Prompt name:** Vaccine batch inventory and public QR status page API
**2. Branch name:** `feat/10-inventory-qr`
**3. Role:** `[You are a senior full-stack engineer building a pharmacy inventory module with strict audit trails and a safe public endpoint.]`

**4. The prompt:**
Implement `backend/src/modules/batches`.
1. **Batch fields:** `name` (e.g. "COVID-19 mRNA"), `manufacturer`, `lot_number`, `quantity`, `expiry_date`, `criticality` (1 low – 3 high), `public_token` (random 12-char URL-safe, **not** sequential), `status` (derived), `weighted_exposure_s`, `remaining_pct`, `discarded_at`, `acknowledged_by`, `created_by`.
2. **CRUD:** create (requires `fridge_id`; checks capacity and that expiry is in the future), list with filters (fridge, status, expiring within N days, search), detail (includes assignment history and exposure timeline summary), update (name, quantity, criticality, expiry), soft-delete only by Admin when quantity 0.
3. **Assign / move:** `POST /api/batches/:id/move {to_fridge_id}`: closes the current `batch_assignments` interval (`to_ts = now`), opens a new one, enforces capacity, rejects moving `DISCARD` batches (409), is atomic, writes `BATCH_MOVED` to the audit chain, emits `batch:update`. Exposure continues to accumulate **per batch across fridges**: the moving batch carries its used budget.
4. **QR:** `GET /api/batches/:id/qr?format=svg|png` returns a QR encoding `${PUBLIC_BASE_URL}/check/${public_token}` (use `qrcode`), with the batch name/lot as caption in the SVG.
5. **Public check endpoint** (`GET /api/public/batch/:token`, **no auth**): returns only `{name, lot_number, expiry_date, status: "SAFE"|"AT_RISK"|"DISCARD", expired: boolean, last_checked}`. Never return fridge ids, user names, exposure seconds, or internal ids. `DISCARD` also when `expiry_date < today`. Per-IP rate limit (60/min), constant response shape for unknown tokens (404 with generic body), `Cache-Control: no-store`.
6. **Status derivation:** one function `deriveBatchStatus(remaining_pct, expiry, discarded)` per Part 3.2, used everywhere.
7. **Events:** any status change emits `batch:update`, writes `BATCH_STATUS_CHANGED` to audit and calls the alert hook.
8. **Tests:** capacity enforcement, move atomicity (simulate failure mid-move), discarded batch cannot be moved, public endpoint leak test (response key whitelist), token unguessability (≥ 70 bits), RBAC (Inspector read-only).

**5. What we are actually building:** the pharmacist's inventory: batches that live in fridges, move between fridges with audit trail, and a public, privacy-safe QR check endpoint that anyone can scan to see Safe / At Risk / Discard and expiry.

**6. Architect / Debugger / Tester review:**
- *Security:* sequential batch IDs in the public URL allow enumeration of the whole inventory; random tokens fix that.
- *Security:* the public endpoint is the only unauthenticated data route besides login; whitelist output keys, don't blacklist.
- *Debugger:* moving a batch must close one interval and open another in the same transaction, or exposure double-counts/under-counts.
- *Architect:* "expired" is derived from date, not stored; timezone-safe comparison (use UTC date).
- *Tester:* QR content must be tested by decoding the generated PNG and comparing the URL.

**7. Checklist:**
- [ ] Create / edit / list / filter batches works with role rules.
- [ ] Move batch between fridges is atomic, capacity-checked, audited.
- [ ] Discarded batch cannot be moved.
- [ ] QR image decodes to the public URL.
- [ ] Public endpoint works without login and exposes only whitelisted fields.
- [ ] Public status = Safe / At Risk / Discard (expired → Discard).
- [ ] Rate limiting and generic 404 on public endpoint.

---

## P11 — Heat-Exposure Budget Engine (Server)

**1. Prompt name:** Per-batch 60-minute heat budget, At Risk, Discard, admin reset
**2. Branch name:** `feat/11-heat-budget-engine`
**3. Role:** `[You are a senior backend engineer for safety-critical cold-chain software who builds deterministic, recomputable calculations with full traceability.]`

**4. The prompt:**
Implement `backend/src/modules/exposure` implementing Part 3.2 exactly.
1. **Model:** each batch has a 60-minute (`BUDGET_S = 3600`) weighted budget above 8 °C. Per second in `8 < T ≤ 12` adds 1; `T > 12` adds 2. `remaining_pct = max(0, 100·(1 − weighted/3600))`; `<20` → `AT_RISK`; `=0` → `DISCARD`.
2. **Source of truth = recomputation:** exposure for a batch is a pure function of `readings` and `batch_assignments` intervals: `Σ over its assignment intervals, over that fridge's readings in the interval`. Implement `computeExposure(batchId)` (full recompute, used on late sync, moves, and tests) and `applyLive(fridgeId, newReadings)` (incremental fast path for in-order readings). Both must give identical results (property test).
3. **Integration rule:** a reading applies from its `ts` until the next reading's `ts`; dt capped at 5×period; if the gap > 15 s use the **conservative** rule from Part 3.2 (`max` of the two neighbouring temperatures). Intervals are clipped at assignment boundaries.
4. **`DEMO_TIME_SCALE`:** multiply accrued weighted seconds by this factor (default 1). When ≠ 1, every API response with exposure includes `demoScale` and the UI shows a **DEMO MODE** banner. Never apply it silently.
5. **Transitions:** on crossing 20% remaining → `AT_RISK` (audit + alert + socket). At 0 → `DISCARD`: set `discarded_at`, **latch the fridge**: send signed `LATCH_SET`-equivalent state (the device sets latch itself at its own budget; the server additionally ensures the fridge `latch_state=true` and sends a signed `cmd` only if the device reports `latch=0` more than 10 s after a batch in that fridge discards — use the `SET_LATCH` command type, which is already whitelisted in P04), alert, audit.
6. **Admin reset:** `POST /api/fridges/:id/reset-latch` (Admin only): requires a reason string; marks every `DISCARD` batch in that fridge `acknowledged_by=admin, acknowledged_at`; sends the signed `RESET_LATCH` command; waits for `cmdack` + `LATCH_RESET` event (timeout 15 s, retry ×3); sets `fridges.latch_state=false`; writes `LATCH_RESET` and `DISCARD_ACK` to the audit chain. **A discarded batch stays `DISCARD` forever** (public QR still shows Discard); the reset only acknowledges disposal and turns off the red LED. A batch cannot be un-discarded by any API.
7. **API:** `GET /api/batches/:id/exposure` (timeline of cumulative weighted seconds over time, for charts), included summary in batch detail.
8. **Tests:** run the 8 shared exposure vectors; boundary cases (exactly 8.0 → no accrual; 12.0 → ×1; 12.01 → ×2); incremental vs full recompute equality (random sequences incl. gaps and out-of-order sync); batch moved mid-exposure carries budget; 20% and 0% transitions fire exactly once; discard permanence; reset flow with a mocked device (success, timeout, retry).

**5. What we are actually building:** the heat-budget brain: for every batch it tracks used and remaining exposure time correctly, even when data arrives late or batches move, flags At Risk and Discard, turns on the red latch, and lets only an admin acknowledge and clear it.

**6. Architect / Debugger / Tester review:**
- *Architect:* incremental accumulation alone breaks as soon as buffered data arrives late. The recompute-from-readings design makes the result independent of arrival order.
- *Debugger:* double counting at the sync boundary (a reading both live-applied and later in a sync chunk) is prevented by `UNIQUE(device_id, seq)` and by only applying inserted rows (`changes()`).
- *Debugger:* float drift: store weighted exposure as integer **milliseconds** (or integer seconds ×1000).
- *Debugger:* transitions must be idempotent; a recompute that re-crosses 20% must not spam alerts. Store `last_status` and only act on change.
- *Tester:* demo scale must be tested: scale 30 turns 2 real minutes into 60 weighted minutes.
- *Architect:* be explicit in docs that the 60-min budget is a simplified model of "time out of refrigeration" policies, which is what the challenge specifies.

**7. Checklist:**
- [ ] 9 °C accrues ×1, 13 °C accrues ×2; boundaries correct.
- [ ] Remaining budget and used minutes visible per batch via API.
- [ ] `< 20%` → At Risk; `0` → Discard; each fires once with alert + audit.
- [ ] Late/buffered data produces the same totals as live data (property test).
- [ ] Moving a batch keeps its used budget.
- [ ] Discard sets red latch; only Admin reset clears it, via signed command with ack.
- [ ] Discarded batch remains Discard on public QR after reset.
- [ ] `DEMO_TIME_SCALE` works and is disclosed in API/UI.
- [ ] All shared exposure vectors pass.

---

## P12 — Alerts (Door, Power, Breach, Budget) & Device Command Publisher

**1. Prompt name:** Notification engine: Telegram / Email / In-app, and signed command sender
**2. Branch name:** `feat/12-alerts-commands`
**3. Role:** `[You are a senior backend engineer who builds reliable alerting pipelines with deduplication, escalation, and delivery tracking.]`

**4. The prompt:**
Implement `backend/src/modules/alerts` and `backend/src/mqtt/commands`.
1. **Alert types and severity:** `DOOR_OPEN_LONG` (> 60 s, WARNING→CRITICAL after 5 min), `FRIDGE_BREACH` (T outside 2–8 °C for ≥ 2 consecutive accepted readings), `POWER_FAILURE`, `BATTERY_LOW`, `FRIDGE_OFFLINE`, `BATCH_AT_RISK`, `BATCH_DISCARD`, `PREDICTED_BREACH` (P18), `COMPRESSOR_WEAK` (P18), `RELOCATION_PROPOSED`, `SECURITY_FLOOD` (> 20 rejects/min from one source).
2. **Table `alerts`:** `id, key, type, severity, fridge_id, batch_id, message, created_at, acknowledged_by, acknowledged_at, resolved_at, delivery_status JSON`.
3. **De-duplication:** `key` = type+fridge(+batch); an active alert with the same key is updated, not duplicated; re-notify at most every 10 min (CRITICAL every 5 min) until acknowledged or resolved. Auto-resolve when the condition ends (door closed, temperature back in range, power restored).
4. **Channels (`notifier`):** Telegram Bot API (`sendMessage`, Markdown, includes fridge name, temperature, duration, deep link to the dashboard), optional SMTP email (nodemailer), always in-app (Socket.IO `alert:new`). Each channel has timeout, 3 retries with backoff, and its outcome stored in `delivery_status`. If no credentials are configured the channel is skipped and the alert still appears in-app and in logs (the app must run fully without any external accounts).
5. **Door alarm requirement:** when a `DOOR_ALARM` event is accepted (device-side buzzer already on), send the alert via Telegram/email **within 5 s**. If the event arrives late via sync, still send it, labelled "delayed (offline) – occurred at <time>".
6. **Command publisher:** `sendCommand(deviceId, type, args)`: builds the signed envelope (server nonce, current `ts`, `cmd_id` uuid), publishes on `…/cmd`, tracks `pending_commands` with retries (3 × 5 s) until `cmdack`, exposes status. Used by P11 (reset latch / set latch), P09 (`SYNC_REQUEST`), and a Pharmacist/Admin **"Test buzzer"** button (`BUZZER_TEST`).
7. **API:** `GET /api/alerts?status&severity&fridge`, `POST /api/alerts/:id/ack` (Admin, Pharmacist). Every raise/ack/resolve is audited.
8. **Tests:** dedupe and re-notify timing (fake timers), auto-resolve, channel failure retry, Telegram payload formatting with a mocked HTTP client, late door alarm labelling, command retry and ack tracking, RBAC.

**5. What we are actually building:** the alerting layer that tells humans when something is wrong (door left open, power cut, breach, vaccines at risk) via Telegram/email and in the app, without spamming them, plus the secure way for the server to send commands back to the devices.

**6. Architect / Debugger / Tester review:**
- *Debugger:* alert storms (flapping door) must not spam; dedupe + cooldown + auto-resolve are mandatory.
- *Debugger:* Telegram rate limits and outages must never block ingestion; notify asynchronously via a queue.
- *Security:* never include secrets, tokens, or full payloads in notification text; the Telegram token must come only from env.
- *Tester:* verify that acknowledging an alert does not hide a *new* breach later (a new episode creates a new alert).
- *Architect:* in-app alerts are the **primary** channel; Telegram/email are best-effort add-ons, so graders without keys still see everything.

**7. Checklist:**
- [ ] Door open > 60 s produces an in-app alert and a Telegram/email message within 5 s (or console fallback if not configured).
- [ ] Breach, power failure, battery low, offline, At Risk, Discard alerts all fire.
- [ ] No duplicate alerts for the same ongoing condition; auto-resolve works.
- [ ] Alert acknowledgement is role-restricted and audited.
- [ ] Commands are signed, retried, and tracked until `cmdack`.
- [ ] Notification failure never blocks data ingestion.

---

## P13 — Frontend Foundation: Design System, Auth, Layout, Realtime

**1. Prompt name:** React app shell with a professional medical-grade UI
**2. Branch name:** `feat/13-frontend-foundation`
**3. Role:** `[You are a senior frontend engineer and product designer who ships polished, accessible, responsive dashboards for healthcare operations.]`

**4. The prompt:**
In `frontend/` (React 18 + Vite + TS + Tailwind + React Router + TanStack Query).
1. **Design system:** clean clinical look (white/slate surfaces, teal primary), **status colours used consistently everywhere**: SAFE green, WARNING amber, BREACH red, AT RISK orange, DISCARD deep red/black with a strike pattern, OFFLINE grey, DEMO banner violet. Light and dark mode (system default + toggle). Typography scale, spacing, card, badge/chip, table, modal, toast, skeleton, empty-state, and error components in `src/ui/`. Icons via `lucide-react`. All colours also carry an **icon or text label** (not colour alone).
2. **Layout:** responsive app shell: left sidebar (collapses to a bottom bar on mobile) with role-aware items (Dashboard, Fridges, Inventory, Alerts, Relocations, AI Report, Security, Audit Log, Users[Admin]); top bar with a global status pill (all fridges safe / n alerts), connection indicator (realtime connected / polling), user menu, theme toggle.
3. **Auth:** login page (clear errors, show/hide password, loading state), token stored in memory + `sessionStorage` (never `localStorage`), auto-logout on 401 / expiry, route guards by role (UI mirrors but **never replaces** server enforcement; 403 responses show a friendly "no permission" page).
4. **API client:** typed fetch wrapper with TanStack Query, error normalisation, retry policy, request cancellation.
5. **Realtime:** one Socket.IO connection authenticated with the JWT; a store that merges `fridge:update`, `batch:update`, `alert:new`, `prediction:update`, `relocation:update` into the query cache; automatic polling fallback every 5 s when the socket is down, with a visible indicator.
6. **DEMO banner:** if the API reports `demoScale ≠ 1`, show a persistent banner "DEMO MODE — heat exposure accelerated ×N".
7. **Quality:** keyboard accessible, focus rings, `aria` labels, `prefers-reduced-motion` respected, contrast ≥ 4.5:1, no layout shift; Vitest + Testing Library tests for auth guard, role-based nav, socket merge.

**5. What we are actually building:** the polished shell of the application: consistent visual language for statuses, secure login flow, role-aware navigation, and a realtime data layer every page will reuse.

**6. Architect / Debugger / Tester review:**
- *Security:* tokens in `localStorage` are exposed to any XSS; use memory/`sessionStorage` and never render unsanitised server strings with `dangerouslySetInnerHTML`.
- *Debugger:* socket reconnect storms and duplicate listeners on route change cause double updates; centralise subscription in one provider.
- *Debugger:* socket auth must be re-done after token expiry; otherwise the UI looks live but is stale.
- *Architect:* hiding a button is not authorisation; every action must still handle a 403.
- *Tester:* run Lighthouse accessibility ≥ 90 on login and shell; check 360 px and 1440 px widths.

**7. Checklist:**
- [ ] Login works with all 3 roles; logout clears session; expired token redirects.
- [ ] Nav shows only permitted items per role; forbidden routes show a no-permission page.
- [ ] Light/dark mode both look right; statuses use the shared palette + icons.
- [ ] Realtime connection indicator; polling fallback works when the socket is blocked.
- [ ] DEMO banner appears when scale ≠ 1.
- [ ] Responsive at 360 px, 768 px, 1440 px.
- [ ] Component and guard tests pass.

---

## P14 — Frontend: Live Dashboard & Fridge Detail

**1. Prompt name:** Live monitoring dashboard (temperature, door, power, compressor, heat budget)
**2. Branch name:** `feat/14-frontend-dashboard`
**3. Role:** `[You are a senior frontend engineer and data-visualisation designer who builds glanceable operational dashboards that surface danger within one second.]`

**4. The prompt:**
Build the **Dashboard** and **Fridge detail** pages (well-designed UI is an explicit grading point).
1. **Summary strip:** counts: fridges Safe/Warning/Breach, batches Safe/At Risk/Discard, active alerts, devices offline; a "last updated n s ago" ticker.
2. **Fridge cards (one per fridge):** name and status chip; large temperature with an animated gauge/bar showing the **2–8 °C band**, the 7 °C/3 °C compressor thresholds, and the live needle; **door** (open/closed + "open for mm:ss", turns red after 60 s with a pulsing alarm icon); **power** (Mains / Battery with battery % bar and "on battery since"); **compressor** (ON/OFF, cooling animation, "off-timer 42 s until restart allowed"); **connectivity** (online / offline, last seen, `buffered n readings syncing…`); **latch banner** "DISCARD LATCH – admin reset required" (red) with Admin-only "Reset" button (reason modal); mini sparkline of the last 30 minutes.
3. **Heat budget panel (per fridge, per batch):** row per batch with name/lot, a **progress bar of remaining budget** (green → amber → orange below 20% → red at 0), minutes used / remaining, exposure state (`accruing ×1`, `accruing ×2`, `not accruing`), status chip. Sort by lowest remaining first. Clicking opens the batch drawer with the cumulative exposure chart.
4. **Alerts feed:** latest alerts with severity, time, ack button (permission-aware), link to the fridge.
5. **Fridge detail page:** Recharts line chart (ranges 15 min / 1 h / 6 h / 24 h, auto-downsampling server-side `bucket` param) with the safe band shaded, 8 °C and 12 °C reference lines, compressor ON periods as shaded strips, door-open and power-failure markers, tooltip with exact values; event timeline (door, power, alarm, latch, sync); table of recent readings flagged `late` when they arrived via sync; space reserved for forecast overlay and health gauge (wired in P19).
6. **Realtime feel:** values animate smoothly; a short flash on change; a stale-data indicator turns the card grey with "No data for n s" after 20 s.
7. **Empty/loading/error states** for every widget; skeletons not spinners.
8. **Tests:** component tests for status → colour/label mapping (using the shared status vectors), door timer, budget bar thresholds; one Playwright smoke test (login → dashboard shows two fridge cards).

**5. What we are actually building:** the control-room view: at a glance, for each fridge, the temperature, door, power, compressor, connectivity and the heat budget of every batch, with a detail page showing history and events.

**6. Architect / Debugger / Tester review:**
- *Debugger:* rendering a chart point on every 5 s update for 24 h = 17k points; downsample on the server and cap at ~600 points client-side.
- *Debugger:* timers like "open for mm:ss" must derive from server timestamps, not from when the browser received the update.
- *Architect:* the status shown must come from the **server-derived** status, not recomputed differently in the UI; share the same vectors in tests.
- *Tester:* simulate a socket drop; the dashboard must flag staleness rather than keep showing old numbers as live.
- *Tester:* check colour-blind safety (icons + labels on every state).

**7. Checklist:**
- [ ] Both fridges visible with live temperature, status, door, power/battery, compressor.
- [ ] Heat budget bar per batch with remaining % and At Risk/Discard colours.
- [ ] Door-open timer turns to alarm after 60 s.
- [ ] Latch banner shows and Admin reset flow works end to end.
- [ ] Detail page: chart with band, 8/12 °C lines, compressor strips, event timeline, late-sync marker.
- [ ] Offline/stale state is visible; buffered/sync indicator works.
- [ ] Good looking at 360 px and 1440 px; loading/empty/error states present.

---

## P15 — Frontend: Inventory, QR, Public Check Page, Security, Audit, Users

**1. Prompt name:** Inventory management UI, public QR page, security & audit UI, user admin
**2. Branch name:** `feat/15-frontend-inventory-security`
**3. Role:** `[You are a senior frontend engineer building operational back-office screens and a mobile-first public verification page.]`

**4. The prompt:**
1. **Inventory page:** table with search, filters (fridge, status, expiring ≤ 30 days), sortable columns (name, lot, qty, expiry, fridge, remaining %, status); row actions by permission: **Add batch** (modal, validation), **Edit**, **Move to fridge** (shows target capacity and current safety, warns if target is Warning/Breach), **QR** (modal with the QR, a **Print label** view with name/lot/expiry, and "Copy public link"), **Details** drawer (assignment history, exposure chart, audit entries for that batch). Discarded batches visibly struck-through with "Disposal required"; Admin sees "Acknowledge disposal" via the fridge reset flow.
2. **Public QR check page** (`/check/:token`, no login, no app chrome): mobile-first single card with a giant status (✔ SAFE / ⚠ AT RISK / ✖ DISCARD), batch name, lot, **expiry date** (with "Expired" if past), "Last checked", short guidance text per status ("Safe to use", "Use only per pharmacist instruction / verify", "Do not use. Report to pharmacist"), and no internal info. Works at 320 px, loads in < 1 s, handles unknown token with a friendly "Batch not found". Adds `<meta name="robots" content="noindex">`.
3. **Security page:** device-security feed (time, device, **reason** `BAD_SIG/STALE_TS/REPLAY/…`, count), filter by reason/device, summary tiles (accepted vs rejected last hour, last seen per device, seq gaps), live updates via `security:event`. Highlights replay/bad-signature bursts.
4. **Audit Log page:** paginated hash-chain viewer (id, time, actor, event, short payload, `prev_hash…`, `hash…` with copy), filters, **"Verify Integrity" button** (all three roles). Result panel: ✔ "Chain intact — N records verified, head hash …" in green, or ✖ red "Tampering detected at record #ID (reason, expected vs actual)" with the first broken row highlighted in the table. Show progress for large logs.
5. **Users page (Admin):** list/create/disable users, change role, reset password, protections for the last admin.
6. **Alerts page:** full alert history with filter, ack/resolve state and delivery status per channel.
7. **Tests:** Playwright flows: Pharmacist adds batch → moves it → opens QR → public page shows Safe; Inspector cannot see add/move buttons and gets 403 when calling the API directly; Verify Integrity green, then after `tamper.py` red with the right record.

**5. What we are actually building:** the day-to-day operational screens: managing batches and their QR labels, the public scan page for anyone, the security feed proving device authentication works, the integrity checker for the audit log, and user administration.

**6. Architect / Debugger / Tester review:**
- *Security:* the public page must not call authenticated endpoints or leak internal data in the HTML/JS payload; test it logged out in a private window.
- *Debugger:* printing QR labels: SVG scaling/quiet-zone issues make codes unscannable; test with a phone camera.
- *Debugger:* long audit logs: virtualise rows, never render thousands of DOM nodes.
- *Tester:* Inspector/Pharmacist/Admin screenshots for each page to confirm role differences.
- *UX:* "AT RISK" on the public page needs plain guidance, not just a colour; staff and the public read it very differently.

**7. Checklist:**
- [ ] Add/edit/move batch works; capacity and permission rules reflected.
- [ ] QR modal and printable label; scan opens the public page.
- [ ] Public page shows Safe/At Risk/Discard + expiry without login; unknown token handled.
- [ ] Security page lists rejected messages with reasons in real time.
- [ ] Verify Integrity shows green on clean data and red with exact record after tampering.
- [ ] Users page works for Admin only.
- [ ] Alerts history page shows delivery status.

---

## P16 — AI Part 1: Dataset Generator & Feature Pipeline

**1. Prompt name:** Training data and features for forecasting and compressor health
**2. Branch name:** `feat/16-ml-dataset-features`
**3. Role:** `[You are a senior machine-learning engineer who builds honest, leakage-free datasets and a single feature pipeline shared by training and serving.]`

**4. The prompt:**
In `ml/` create the data layer.
1. **Dataset generator (`ml/data/generate.py`)** using the **same physics as the firmware/virtual node** (`tools/coldchain_tools/sim_engine.py`, offline fast mode). Simulate **≥ 60 days per fridge**, ≥ 6 fridge "profiles" (different ambient temperature 24–36 °C, leak rate, compressor capacity, noise), 5 s sampling downsampled to 1 min for storage. Include realistic events: random door openings (duration 5 s – 5 min, frequency varying by hour of day), power failures (5–90 min), **gradual compressor degradation** (efficiency drifting 1.0 → 0.3 over weeks in some profiles), sudden compressor faults, sensor noise, and rare missing segments. Save `ml/data/raw/*.parquet` (or CSV) with columns: `fridge_profile, ts, temp, door, comp, power, batt, efficiency_true, ambient_true`. `efficiency_true` and `ambient_true` are **labels only**, never features.
2. **Labels:** `y_temp_30` = temperature 30 min after `t`; `y_breach_30` = whether `max(temp over (t, t+30 min]) > 8`; `y_health` = `100 × efficiency_true` clipped to [0, 100] (per day/window).
3. **Feature pipeline (`ml/features.py`)**, one function used by both training and the serving API, operating on the **last 60 minutes of 1-min readings** only (what the backend can supply live):
   - Temperature: current, mean/std/min/max over 5, 15, 30, 60 min; slope (linear regression) over 5, 15, 30 min; second difference (acceleration).
   - Door: fraction open in the last 5/15/60 min, time since last open, current open duration.
   - Compressor: duty cycle over 15/60 min, time since last ON/OFF, current run length, number of switches in 60 min.
   - Power: on battery now, minutes on battery in last 60, battery %.
   - Derived physics-style features: time-to-8 °C extrapolation (capped), minutes until the minimum-off timer allows restart.
   - **Cycle features for compressor health** (computed from detected ON→OFF cycles in the last 6–24 h of history): mean cooling rate during ON (°C/min), mean ON duration, 7 → 3 °C pull-down time, overshoot above 7 °C after ON command, cycles/hour, duty cycle trend. A separate function `health_features(history_24h)`.
4. **Splitting:** **time-based and profile-based** splits: train on early days of most profiles, validate on later days, test on **held-out profiles and the last 10 days** (prevents leakage and shows generalisation). Never random-shuffle time series. Fit scalers only on train.
5. **Dataset card (`ml/data/DATASET_CARD.md`):** generation method, parameters, number of rows/events, class balance of `y_breach_30`, known limitations ("synthetic, produced by the same family of physics as the simulator; real fridges will differ; the pipeline is built to retrain on live data collected by the system").
6. **Optional live-data export:** `GET`-style script that exports real readings collected by the backend to the same schema, so models can be refreshed.
7. **Tests:** feature function is deterministic, has no look-ahead (assert it never reads beyond `t`), handles missing minutes, and train/serve parity (running it on the same window in both code paths gives identical vectors).

**5. What we are actually building:** a credible dataset and one reusable feature pipeline that turns the last hour of readings (and recent compressor cycles) into model inputs without leaking the future.

**6. Architect / Debugger / Tester review:**
- *Debugger:* **label leakage** is the #1 risk (e.g. using `efficiency_true` or future temperature in features). Add an automated test that features at time `t` do not change if data after `t` is altered.
- *Architect:* a model trained on its own simulator will look unrealistically good; the report must say so plainly and the dataset must include disturbances (noise, unmodelled drift) that the forecaster has to handle.
- *Debugger:* class imbalance: breaches are rare; keep the natural ratio for evaluation, and handle imbalance only in training.
- *Tester:* check that the dataset contains each scenario type with sufficient counts (≥ 200 door events, ≥ 20 power failures, ≥ 3 degradation arcs per degraded profile).

**7. Checklist:**
- [ ] ≥ 60 days × ≥ 6 profiles generated reproducibly (seeded).
- [ ] Labels `y_temp_30`, `y_breach_30`, `y_health` correct (spot-checked).
- [ ] `features.py` shared by training and serving; parity test passes.
- [ ] No look-ahead leakage (test passes); true efficiency/ambient never used as features.
- [ ] Time/profile-based splits; held-out test set defined.
- [ ] `DATASET_CARD.md` written including limitations.

---

## P17 — AI Part 2: Forecast Model, Compressor Health Model, Evaluation Report

**1. Prompt name:** 30-minute temperature forecast, 0–100 compressor health score, results report
**2. Branch name:** `feat/17-ml-models-report`
**3. Role:** `[You are a senior ML engineer who trains, calibrates, and honestly evaluates small tabular models and writes clear technical reports.]`

**4. The prompt:**
In `ml/` build, evaluate, and package the models.
1. **Temperature forecaster (30 min ahead):**
   - Baselines: **persistence** (`T(t+30) = T(t)`), **linear extrapolation** of the last 15-min slope, and a **physics baseline** (simulate forward with the known model, assuming current compressor state).
   - Models: `HistGradientBoostingRegressor` (primary), `RandomForestRegressor` (comparison). Add **prediction intervals** via quantile regression (`loss="quantile"`, q = 0.1 and 0.9) so the API can output `pred`, `p10`, `p90`.
   - Hyper-parameter search on the validation split only (small grid), fixed random seeds.
2. **Breach warning logic (from the forecast):** `level = HIGH` if `pred > 8.0` or `p90 > 9.0`; `MEDIUM` if `p90 > 8.0`; `LOW` otherwise. Also train a direct classifier for `y_breach_30` (`HistGradientBoostingClassifier`, calibrated) and compare it with the regressor-derived rule; choose the better one on validation F1/recall, with **recall prioritised** (missing a breach is worse than a false alarm).
3. **Compressor health (0–100):**
   - Train a regressor on `health_features` → `y_health` (e.g. `GradientBoostingRegressor`), clip to [0, 100].
   - Add an **unsupervised anomaly signal** (IsolationForest on healthy-only cycles) to flag unseen failure modes.
   - **Health score** = model output blended with the anomaly signal (document the formula). **Weakening flag** when `health < 70` or when the 24 h trend (slope per day) is below −5 points/day. Bands: 80–100 Good, 50–79 Weakening, 0–49 Failing.
   - Provide a **rule-based fallback** (ratio of recent cooling rate to the healthy baseline) used when fewer than 3 cycles are available.
4. **Evaluation (on the held-out test set):**
   - Forecast: MAE, RMSE, R² for each model and baseline; error vs horizon (5/10/20/30 min); error during door-open/power-fail vs normal; interval coverage (target ≈ 80%).
   - Breach detection: precision, recall, F1, ROC-AUC, PR-AUC, confusion matrix, and **lead time** (how many minutes before the actual breach the first HIGH/MEDIUM warning appears; median/10th percentile), false alarms per fridge-day.
   - Health: MAE, Spearman correlation with true efficiency, detection delay for gradual degradation (days from onset to "Weakening").
   - Feature importance (permutation importance) for forecaster and health models; ablation (no door features / no compressor features).
5. **Artifacts:** `ml/models/*.joblib` + `model_card.json` (versions, feature list, training date, seeds), `ml/reports/metrics.json`, figures (`actual_vs_pred.png`, `error_by_horizon.png`, `confusion_matrix.png`, `feature_importance.png`, `health_vs_truth.png`) and **`ml/reports/REPORT.md`** — a short report (≤ 2 pages) with sections: **Dataset**, **Features**, **Models**, **Results (tables + figures)**, **Limitations & honesty note**, **How to retrain**. Numbers in the report must be generated from `metrics.json`, never typed by hand.
6. `make train` runs everything reproducibly in a few minutes; `pytest` covers metric functions, interval ordering (`p10 ≤ pred ≤ p90`), score bounds [0, 100], and that the chosen model beats the baselines on the test set (otherwise the build prints a warning).

**5. What we are actually building:** the intelligence: a model that predicts temperature half an hour ahead and warns early, a compressor health score between 0 and 100 with a weakening flag, and a short, honest evaluation report with the dataset, features and results.

**6. Architect / Debugger / Tester review:**
- *Debugger:* a forecaster that merely copies the current temperature has low MAE; persistence **must** be shown as the baseline to beat, especially in the ±0.5 °C hysteresis regime.
- *Architect:* optimising only MAE ignores the real objective (don't miss a breach). Report breach recall and lead time and choose thresholds accordingly.
- *Debugger:* quantile models can cross (`p10 > p90`); enforce monotonic ordering after prediction.
- *Tester:* verify on a **replay of a door-left-open scenario** that the warning appears at least 10 minutes before T crosses 8 °C; if not, retune features/thresholds.
- *Architect:* write the limitation plainly: synthetic training data; the service is built so it can retrain on the system's own collected data.
- *Security:* load models only from trusted local paths; no pickle from user input.

**7. Checklist:**
- [ ] Forecaster beats persistence and linear-extrapolation baselines on the held-out test set (MAE/RMSE table in report).
- [ ] 80% prediction intervals with measured coverage.
- [ ] Breach warning metrics (precision/recall/F1/lead time) reported; recall prioritised.
- [ ] Health score 0–100 with weakening flag and bands; rule-based fallback implemented.
- [ ] Figures + `metrics.json` + `REPORT.md` generated by `make train`.
- [ ] Report contains dataset, features, results, and limitations sections.
- [ ] Models + model card saved; tests pass.

---

## P18 — AI Part 3: ML Service API, Backend Integration, Relocation Planner, One-Click Confirm

**1. Prompt name:** Prediction service, scheduled inference, relocation suggestions with one-click confirmation
**2. Branch name:** `feat/18-ml-service-relocation`
**3. Role:** `[You are a senior backend/ML-platform engineer who integrates models into production services and designs safe, explainable decision-support with a human in the loop.]`

**4. The prompt:**
1. **ML service (`ml/service`, FastAPI):** `GET /health`; `POST /predict` taking `{fridge_id, readings:[{ts,temp,door,comp,power,batt}], history_24h_cycles?}` and returning `{pred_temp_30, p10, p90, breach_level, breach_prob, minutes_to_breach_estimate, health_score, health_band, health_trend_per_day, weakening, features_used, model_version}`; input validation (≥ 20 readings or return `insufficient_data`), 1 s timeout budget, CORS closed (backend only), model loaded once at start.
2. **Backend scheduler (`backend/src/ml/`):** every 30 s per fridge: take the last 60 min of readings (1-min buckets, forward-filled up to 3 min) and the last 24 h of compressor-cycle statistics, call `/predict`, store in `ml_predictions`, emit `prediction:update`, and raise `PREDICTED_BREACH` (when `level` ≥ MEDIUM for 2 consecutive runs) and `COMPRESSOR_WEAK` alerts via P12. If the ML service is down, mark predictions `stale`, **fall back to a deterministic rule** (linear extrapolation + cycle-rate health) and say so in the UI; never block ingestion.
3. **Relocation planner (`backend/src/modules/relocation/planner.ts`, pure and unit-tested):**
   - **Trigger:** a fridge is "at risk" if `breach_level = HIGH`, or `MEDIUM` with the door open/on battery, or `health_score < 40`, or on battery with `batt < 30%` and rising temperature.
   - **Candidate batches:** all non-`DISCARD` batches in that fridge, **ordered by**: lowest remaining budget, then higher criticality, then earliest expiry. Discarded batches are excluded and listed as "dispose, cannot be saved".
   - **Target eligibility:** another fridge that is online, `SAFE`, door closed, on mains, `breach_level = LOW`, `health_score ≥ 60`, **has free capacity**, and whose predicted `p90 ≤ 7.5`. Score targets by margin to 8 °C + health + free capacity.
   - **Output:** a plan `{plan_id, from_fridge, created_at, expires_at (15 min), moves:[{batch_id, batch_name, to_fridge, reason, urgency}], unsaveable:[...], rationale: "Fridge A forecast 8.9 °C in 30 min (compressor health 41). Moving 3 batches to Fridge B (forecast 5.1 °C, 7 free slots)."}`. If **no safe target** exists: plan status `NO_SAFE_TARGET`, `CRITICAL` alert, and a message advising manual action (e.g. portable cooler). Capacity shortfalls split the list: highest priority batches move first, the rest are reported.
   - De-duplicate: one active plan per source fridge; refresh when conditions change; auto-expire/cancel when risk resolves.
4. **One-click confirm:** `POST /api/relocations/:id/confirm` (**Admin & Pharmacist only**): re-validates preconditions at confirm time (target still eligible, batches still in source, capacity); executes all moves in **one transaction** (reusing the P10 move logic and assignment history); audit entries `RELOCATION_CONFIRMED` + each `BATCH_MOVED` (actor = confirming user, includes plan id and AI rationale); emits socket updates; returns the new state. If preconditions changed → `409` with a refreshed plan instead of moving blindly. `POST /api/relocations/:id/dismiss` records the dismissal reason.
5. **Predictions API:** `GET /api/ml/predictions/:fridgeId?from&to` (history for charts) and `GET /api/ml/report` (serves `metrics.json` + `REPORT.md` + figure URLs).
6. **Tests:** planner unit tests (single fridge at risk with free target, no safe target, capacity shortage, discarded batches excluded, priority order, expired plan); confirm race (state changes between propose and confirm → 409); RBAC (Inspector cannot confirm); ML-down fallback; end-to-end with the virtual node `weak_compressor` and `door_open` scenarios.

**5. What we are actually building:** the live AI loop: every 30 s each fridge gets a forecast and health score; when a fridge looks unsafe the system proposes exactly which batches to move and where, explains why, and lets a pharmacist execute the plan with a single click, safely and audibly.

**6. Architect / Debugger / Tester review:**
- *Architect:* AI **suggests**, humans **confirm**; the planner must never move anything on its own.
- *Debugger:* relocation proposal flapping (suggest → cancel → suggest every 30 s) is annoying and unsafe; add hysteresis (risk must persist 2 runs to propose, 3 safe runs to cancel).
- *Debugger:* moving batches into a fridge that is itself about to fail; the `p90 ≤ 7.5` and health checks prevent a bad destination.
- *Security:* the confirm endpoint is high-impact; enforce role server-side, rate-limit, and require the plan id + current version (optimistic lock) to prevent double-click duplicates.
- *Tester:* double-click on confirm must be idempotent (second call returns the already-executed plan).
- *Architect:* with only two fridges, "no safe target" is a realistic outcome. The UI/alert for that case is part of the feature, not an edge case.

**7. Checklist:**
- [ ] `/predict` returns forecast, p10/p90, breach level, health score + band + weakening flag.
- [ ] Scheduler stores predictions every 30 s and emits socket updates.
- [ ] Predicted breach and weak compressor alerts raised; ML-down fallback works and is labelled.
- [ ] Planner produces plans naming **which batches** and **which destination**, with rationale and urgency.
- [ ] No-safe-target and capacity-shortage cases handled.
- [ ] One-click confirm (Admin/Pharmacist) executes transactionally, audited; Inspector gets 403.
- [ ] Stale-plan and double-click cases handled (409 / idempotent).
- [ ] Predictions history and report endpoints work.

---

## P19 — Frontend: AI Forecast, Health Score, Relocation & AI Report

**1. Prompt name:** AI features in the UI
**2. Branch name:** `feat/19-frontend-ai`
**3. Role:** `[You are a senior frontend engineer who makes AI output understandable, trustworthy, and actionable for non-technical pharmacy staff.]`

**4. The prompt:**
1. **Forecast overlay (Fridge detail + dashboard cards):** dashed forecast line to "+30 min" with the p10–p90 band, a marker at the predicted value, and a risk badge (LOW / MEDIUM / HIGH) with text like "Forecast 8.9 °C in 30 min – may exceed 8 °C in ~18 min". On the card: a compact "Next 30 min" chip. Show `stale` / "rule-based fallback" labels when the ML service is down.
2. **Compressor health gauge (0–100):** semicircular gauge with bands (Good / Weakening / Failing), the numeric score, 7-day trend sparkline, "Weakening compressor – service recommended" banner, tooltip explaining the contributing factors (cooling rate, duty cycle) in plain language.
3. **Relocation panel (Dashboard + dedicated page):** appears when a plan exists. Shows the reason ("Fridge A may become unsafe because …"), a clear table of **moves: batch → destination fridge** with urgency chips and remaining budget, unsaveable batches separately, destination safety summary, plan expiry countdown, and a prominent **"Confirm relocation"** button (single click, visible only for Admin/Pharmacist; Inspector sees the plan read-only). After click: optimistic progress state, success toast with a link to the audit entry, and updated inventory. Handle 409 (plan changed) by showing the refreshed plan and an explanation. **No-safe-target** state with strong warning styling.
4. **AI Report page:** renders `REPORT.md`, KPI cards (forecast MAE/RMSE vs baselines, breach recall/precision/lead time, health MAE), the figures, the dataset summary and the feature list with importances; "model version / trained on / data is synthetic" badge.
5. **Realtime:** subscribe to `prediction:update` and `relocation:update`; animate changes.
6. **Tests:** component tests with mocked predictions (each level), relocation confirm happy path/409/permission, snapshot for no-safe-target; Playwright: run `weak_compressor` scenario → health drops → plan appears → Pharmacist confirms → inventory shows moved batches.

**5. What we are actually building:** the visible AI: forecasts on the charts, a health score you can read at a glance, plain-language relocation proposals with a one-click confirmation, and an in-app evaluation report.

**6. Architect / Debugger / Tester review:**
- *UX:* an unexplained AI number is not trusted. Every score and recommendation needs a one-line "why".
- *Debugger:* a stale prediction presented as live is dangerous; always show the prediction age.
- *Debugger:* the confirm button must be disabled while the request is in flight (double-click safety) and must re-fetch the plan on failure.
- *Tester:* verify Inspector sees no actionable button and the server also refuses.
- *Architect:* don't over-claim: the report badge must say the training data is synthetic.

**7. Checklist:**
- [ ] Forecast line + band + risk badge visible and updating.
- [ ] Health gauge 0–100 with bands, trend, weakening banner.
- [ ] Relocation panel lists batches and destinations with reasons; one-click confirm works for Pharmacist/Admin only.
- [ ] 409, no-safe-target and stale-prediction states handled.
- [ ] AI Report page shows dataset, features, results.
- [ ] Playwright AI flow passes.

---

## P20 — Integration, End-to-End Tests, Hardening, Docs, Demo Seed

**1. Prompt name:** System integration, QA, security review, one-command demo
**2. Branch name:** `feat/20-integration-hardening`
**3. Role:** `[You are a senior QA architect and security reviewer who breaks the system on purpose, fixes what breaks, and makes the final product reproducible by a stranger in ten minutes.]`

**4. The prompt:**
1. **End-to-end scenario tests** (scripted with the virtual node + API + Playwright), each asserting through the real stack:
   - **S1 Normal operation:** two fridges publish for 10 min; compressor cycles between 3–7 °C; status SAFE; no alerts.
   - **S2 Hysteresis & min-off:** ON at ≥ 7.0, OFF at ≤ 3.0, never restart < 60 s after OFF.
   - **S3 Door open:** door open > 60 s → buzzer event, alert delivered (Telegram or fallback) within 5 s; temperature rises; WARNING → BREACH.
   - **S4 Heat budget:** temperature held at 9 °C (×1) and 13 °C (×2) — verify rates; At Risk at < 20%; Discard at 0 with red latch; reset only by Admin; QR shows Discard forever.
   - **S5 Power failure:** button → battery mode, compressor off, battery drains, alert, restore, min-off honoured.
   - **S6 Offline buffer:** Wi-Fi outage 5+ min → buffer grows → reconnect → all readings present, ordered, no duplicates, exposure recomputed consistently with live.
   - **S7 Device security:** replay, bad sig, stale, unknown device, tampered body, flood → all rejected, listed in Security page and audit chain.
   - **S8 Tamper evidence:** edit audit row via `tamper.py` → Verify Integrity red at that record → `--restore` → green.
   - **S9 RBAC:** every action × role matrix against the live server (not only unit tests).
   - **S10 AI:** `weak_compressor` → health falls below 70 → "Weakening"; `door_open` → forecast warns ≥ 10 min before 8 °C; relocation plan proposed → Pharmacist confirms → batches moved → audit entries.
2. **Failure injection:** kill the ML service, the broker, and the backend mid-run; verify graceful degradation and recovery with no data loss (device buffer + sync).
3. **Security review checklist:** run `npm audit`/`pip-audit`; secrets scan; confirm no secret in git history; headers; rate limits; SQL injection attempts on every query param (all queries parameterised); XSS on batch name/lot fields; JWT tampering; CORS; public endpoint leak test; verify `config.h` and `.env` ignored.
4. **Performance:** 2 devices × 5 s + flood → API p95 < 200 ms; dashboard stays smooth with 24 h of data.
5. **Docs:** final `README.md` (10-minute quick-start, architecture diagram, how to flash/run Wokwi nodes, env setup, demo credentials, troubleshooting table: "OLED blank", "no MQTT messages", "STALE_TS", "signature mismatch", "buffer not syncing"), `docs/API.md` (from the route registry), `docs/SECURITY.md` (threat model: forgery, replay, tampering, privilege escalation, data leakage; what is and isn't protected), `docs/ARCHITECTURE.md`, `docs/AI.md` (summary + link to `REPORT.md`).
6. **Demo seed (`make demo`):** resets DB, creates users, 2 fridges, ~8 batches with varied states (several Safe, one at ~25% remaining, one at ~12% At Risk, one Discard), loads trained models, backfills **clearly labelled seeded history** (≥ 6 hours of readings so charts and forecasts have context, marked `seeded=1`), prints credentials and the QR URLs, and starts the virtual nodes if Wokwi is not running.
7. **Bug-bash:** run through all prompts' checklists; log failures in `docs/KNOWN_ISSUES.md` with workarounds.

**5. What we are actually building:** confidence: proof that the whole chain works under normal and abnormal conditions, a security pass, complete documentation, and a one-command demo environment for recording the video.

**6. Architect / Debugger / Tester review:**
- *Tester:* run scenarios from a **clean database** and a **clean browser profile**; most demo failures are stale state.
- *Debugger:* NTP and clock skew between your laptop, Wokwi and the broker is the top cause of `STALE_TS` on demo day; add a "clock skew" line on the Security page and in the README.
- *Architect:* every demo-only shortcut (`DEMO_TIME_SCALE`, seeded history, `THERMAL_SPEED`) must be disclosed in the UI/README; judges reward honesty and punish surprises.
- *Security:* run the attack scripts against the **deployed demo configuration**, not only the test config.
- *Tester:* rehearse the full demo three times with a stopwatch (see P21).

**7. Checklist:**
- [ ] S1–S10 scenarios pass end to end.
- [ ] Failure-injection recovers with no data loss.
- [ ] Security checklist complete; no secrets in repo.
- [ ] README quick-start works from scratch in ≤ 10 minutes on another machine.
- [ ] `make demo` produces the expected state every time.
- [ ] All prompt checklists P00–P19 re-verified; known issues documented.

---

## P21 — FINAL PROMPT: Video Presentation Instructions (≤ 3 minutes)

**1. Prompt name:** Video script, shot list, recording plan, submission
**2. Branch name:** `docs/21-video-plan`
**3. Role:** `[You are a senior technical presenter, video producer, and hackathon judge-coach. You know judges watch dozens of videos, decide in the first 20 seconds, and reward working demos with clear evidence over slides and promises.]`

**4. The prompt:**
Produce `docs/VIDEO_PLAN.md` and supporting files so the team can record and submit the Round 1 video.
**Hard constraints:** total length **≤ 3:00 (target 2:50)**; covers **at least 3 challenge questions** (we cover all five task areas); the system shown must be **running live**, not mocked; any accelerated or seeded element must be **disclosed on screen or in narration**. Submission deadline: **5 November 2026**, so plan to finish recording by **1 November** to leave buffer.

**A. Deliverables to generate**
1. **Timed script** (word-for-word narration, ~140 words/min, ≈ 380 words max) aligned to the run-of-show below, plus on-screen text/captions for each segment.
2. **Shot list**: for every segment, which window is on screen, what is clicked, expected result, and fallback if it fails.
3. **Screen layout plan**: left half Wokwi (both fridge nodes visible with OLED readable), right half browser (dashboard); a second browser window ready for Security/Audit; phone (or a second window sized as a phone) for the public QR page. 1920×1080, 30 fps, browser zoom 110–125%, hide bookmarks/notifications, dark mode off for contrast (or consistent), cursor highlight enabled.
4. **Pre-recording checklist** (`make demo` reset, both Wokwi sims running, broker connected, Telegram on a visible phone/desktop window, tabs pre-opened and logged in as Pharmacist, Admin and Inspector, attack scripts staged in a terminal with large font, `DEMO_TIME_SCALE` set and the DEMO banner visible, clock check).
5. **Recording tips:** record in **segments** (one per scene), then edit; use OBS or the built-in recorder; record narration after the screen takes if needed; add captions (many judges watch muted); export MP4 H.264 ≤ 3:00, check audio levels, check the file plays on another machine.
6. **Backup plan:** if Wokwi lags, switch to the virtual node for that scene; keep a 30-second pre-recorded clip of each scene as a fallback.
7. **Submission checklist:** length verified with the file properties, filename `TeamName_ColdChain_Round1.mp4`, upload per the organisers' instructions, submission confirmation saved, repo link/README ready if requested, submitted at least 24 h before the deadline.

**B. Run of show to refine (judge-optimised; adjust timing but keep the order)**

| Time | Scene | What is on screen | What to say / prove |
|---|---|---|---|
| 0:00–0:15 | **Hook & problem** | Title card then live dashboard | "Vaccines spoil outside 2–8 °C. ColdChain monitors, protects, predicts and proves it." Name the team. Show the 5-part architecture strip for 3 s. |
| 0:15–0:45 | **Task 1: Fridge nodes** | Wokwi: OLED with temperature + SAFE; compressor relay LED toggling | Two ESP32 nodes. Point at OLED state. Show compressor ON at 7 °C and OFF at 3 °C, with the 60 s minimum off-time. MQTT every 5 s, plus instant on door change: toggle the door and show the dashboard updating immediately. |
| 0:45–1:10 | **Task 2: Heat budget** | Dashboard heat-budget bars; temperature pushed above 8 °C then above 12 °C | 60-minute budget per batch; ×2 above 12 °C. Show remaining % dropping, **At Risk below 20%**, then **Discard at 0 with red LED ON** (Wokwi). Mention it stays red until an **admin reset**, show reset button. State "demo mode accelerates exposure ×N" (banner visible). |
| 1:10–1:40 | **Task 3: Power & offline** | Press power-fail button; then Wi-Fi outage button; terminal with attack scripts not yet | Battery status on OLED + dashboard, compressor stops. Outage: OLED `OFFLINE buf:N`. Restore: readings arrive in order, no duplicates. Hold the door open > 60 s: buzzer + Telegram message appears. |
| 1:40–2:10 | **Task 4: Web app & security** | Role login switch (Admin/Pharmacist/Inspector), inventory, **QR scan on phone**, terminal attack | Show roles enforced server-side (Inspector can't move a batch). Scan the QR: public page Safe/At Risk/Discard + expiry. Run replay attack: **rejected & logged** in Security page. Run `tamper.py`, click **Verify Integrity**: red, record # shown. |
| 2:10–2:45 | **Task 5: AI** | Fridge detail with forecast; health gauge; relocation panel | Forecast 30 min ahead warns it may exceed 8 °C. Compressor health 0–100 dropping (weak compressor scenario). System proposes **which batches to move and where**; Pharmacist clicks **Confirm** once; inventory updates. Flash the AI report: dataset, features, results (MAE vs baseline, breach recall). Say that training data is simulated. |
| 2:45–2:58 | **Close** | Dashboard overview + repo/README | One-line recap: "Monitor, protect, predict, prove." Thank judges. |

**C. Rules the script must follow**
- Show **evidence, not claims**: every claim is followed by the screen proving it within 3 seconds.
- Speak to the challenge wording: use the exact terms **Safe / Warning / Breach**, **At Risk / Discard**, **HMAC-SHA256 + timestamp + nonce**, **hash chain / Verify Integrity**, **one click**.
- No dead air; no reading code; no login typing on camera (pre-logged-in tabs); cut waiting time (jump cuts are fine for accelerated demo, say so).
- Mention honestly: simulation in Wokwi (hardware path documented), accelerated demo timings, synthetic training data with retraining pipeline.
- End with the strongest visual, the relocation confirmation or the integrity check, not a blank slide.

**5. What we are actually building:** the 3-minute story that turns the whole project into marks: a rehearsed, evidence-driven demo that touches every task and proves each requirement on screen.

**6. Architect / Debugger / Tester review:**
- *Judge-coach:* the most common failures are a video over 3:00, a demo that "almost works", waiting on timers, and unreadable small text. Rehearse with a stopwatch and enlarge fonts.
- *Debugger:* live state surprises: stale tabs, expired JWT, a latched fridge left from rehearsal, or a skewed clock. Reset with `make demo` right before each take.
- *Tester:* watch the final export **muted** and on a phone: can the story still be followed? Is the OLED readable? Are Safe/At Risk/Discard obvious?
- *Architect:* if you must cut, cut explanation, never proof. Every task needs at least one visible proof moment.

**7. Checklist:**
- [ ] Video ≤ 3:00, plays on another device, audio clear, captions on.
- [ ] Task 1: OLED states, compressor 7/3 °C, 5 s MQTT + door-change message shown.
- [ ] Task 2: budget bars, ×2 above 12 °C mentioned, At Risk, Discard + red LED + admin reset shown.
- [ ] Task 3: power-fail status, offline buffer then ordered sync, door > 60 s buzzer + Telegram/email alert shown.
- [ ] Task 4: roles enforced, QR public page, replay attack rejected, Verify Integrity detects tampering.
- [ ] Task 5: 30-min forecast warning, health score, relocation suggestion, one-click confirm, report shown.
- [ ] Demo-mode acceleration, simulation, and synthetic-data disclosures stated.
- [ ] Submitted at least 24 h before **5 November 2026**; confirmation saved.

---

# PART 5 — FINAL CHECKLIST (verify the whole project)

> Tick every line **on the running system** (not from memory). Each line maps to a challenge requirement.

## Task 1 — Fridge Node
- [ ] ESP32 for two fridges, each with temperature sensor, door switch, compressor relay, LED (P01).
- [ ] OLED shows temperature and **Safe / Warning / Breach** (P02).
- [ ] MQTT data every **5 s** and **immediately on door-state change** (P03).
- [ ] Compressor **ON at 7 °C, OFF at 3 °C**, **60 s minimum off-time** (P02, proven by test).

## Task 2 — Heat-Exposure Budget
- [ ] Each batch has a **60-minute budget above 8 °C**; exposure and remaining budget tracked (P11).
- [ ] **Above 12 °C counts double** (P04 device, P11 server, vectors pass).
- [ ] **Below 20% → At Risk**; **0% → Discard**; **red LED ON until admin reset** (P04, P11, P14).
- [ ] Discarded batch never becomes Safe again, including on the public QR page (P10, P11).

## Task 3 — Power Failure & Offline Mode
- [ ] Power failure simulated with a button; **battery/power status** reported on OLED, MQTT, dashboard (P05, P14).
- [ ] **≥ 30 minutes** of readings buffered during Wi-Fi loss and synced **in order, without duplicates** (P05, P09).
- [ ] Door open **> 60 s → buzzer + SMS/Telegram/email** alert (P05, P12).

## Task 4 — Web Application
- [ ] **JWT + bcrypt**, Admin / Pharmacist / Inspector, **permissions enforced on the server** (P07, S9).
- [ ] **Live dashboard**: temperature, door, power, compressor, heat-budget status, well-designed UI (P13, P14).
- [x] **Inventory**: manage batches; assign/move between fridges (P10, P15).
- [x] **Public QR check**: Safe / At Risk / Discard + expiry, **no login** (P10, P15).
- [ ] **Device security**: HMAC-SHA256 + timestamp + nonce; invalid and replayed messages **rejected and logged** (P09).
- [ ] **Tamper-evident logs**: hash chain + **Verify Integrity** detects edited records (P08, P15).

## Task 5 — AI Breach Prediction & Relocation
- [ ] Predict fridge temperature **30 minutes ahead** and warn if it may exceed 8 °C (P17, P18, P19).
- [ ] **Compressor weakening** detection with a **0–100 health score** (P17, P19).
- [ ] Suggests **which batches to move and where** when a fridge may become unsafe (P18).
- [ ] Pharmacist confirms the relocation with **one click** (P18, P19).
- [x] Short report with **dataset, features, results** (P16, P17, `REPORT.md`, AI Report page).

## Quality gates
- [ ] `make test` passes in every service; shared vectors pass in firmware, backend, simulator.
- [ ] `make demo` brings the system to the demo state from scratch.
- [ ] No secrets in the repository; `.env` and `config.h` ignored.
- [ ] README lets a new person run the project in ≤ 10 minutes.
- [ ] Known issues documented honestly.

## Submission gates
- [ ] Video ≤ 3:00, covers ≥ 3 questions (all five covered), disclosures stated.
- [ ] Uploaded and confirmed before **5 November 2026**.
