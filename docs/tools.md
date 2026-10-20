# Developer tools: virtual node, attack and tamper scripts

Python package `coldchain_tools` (in `tools/`, Python 3.12+, `paho-mqtt`). Install it once into the repo venv:

```bash
.venv/Scripts/python -m pip install -e "tools[dev]"     # bin/ instead of Scripts/ on macOS / Linux
```

All commands below run from `tools/` with that venv's Python (`python -m coldchain_tools.<tool>`). Broker settings default to `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` and `MQTT_TOPIC_PREFIX` from the environment or the repo `.env`. Device secrets default to `DEVICE_SECRET_<ID>` (for example `DEVICE_SECRET_FRIDGE_01`), the same values the firmware `config.h` and the backend use. For the local Docker broker (`make up`): `--url mqtt://localhost:1883 --username coldchain --password coldchain-dev-only`.

| Module | Purpose |
|---|---|
| `sim_engine` | pure simulation core, a faithful port of the firmware; offline fast mode for the ML dataset (P16) |
| `virtual_node` | a second fridge node over real MQTT, scripted or interactive |
| `attack` | messages the backend must reject, each with the reason code it should log |
| `tamper` | edits a row in the SQLite audit log or readings so Verify Integrity can catch it; `--restore` undoes it |
| `verify_envelope` | checks one pasted envelope and names the failing check |
| `envelope`, `contracts` | shared signing / verification and constants, topics, `.env` settings |
| `backfill` | seeded history from the simulator straight into the database (`seeded=1`, labelled in the UI) |
| `stack` | runs the whole system locally; `stack demo` is `make demo` |
| `scenarios` | end-to-end scenarios S1–S10 and failure injection on an isolated stack (`make scenarios`) |
| `security_check` | dependency audit, secrets scan of the tree and the history, live security probes (`make security`) |
| `perf` | API latency under load: 2 devices, a flood, 24 h of history (`make perf`) |

## Simulation engine

`sim_engine` mirrors the firmware module by module: `ThermalModel` (its `params` override the firmware's ambient, leak, door, cooling and noise for the ML dataset's fridge profiles), `CompressorControl` (hysteresis, 60 s min-off, fault duty), `classify`, `HeatKeeper` (exposure and latch), `PowerModel`, `DoorAlarm`, `RingBuffer`, `Syncer`, plus `FridgeNode`, which is `main.cpp`'s loop without the uplink. It reads the contract constants from `contracts/constants.json` and **parses** the firmware's own tuning (`node_config.h`: thermal model, battery, sync timing), so the simulator cannot silently diverge from the device. Message bodies are byte-for-byte the firmware's: same field order, `temp` with two decimals.

Offline fast mode (virtual clock, no MQTT) yields every message plus the model's ground truth (true temperature, compressor efficiency):

```python
from coldchain_tools.sim_engine import run_offline
rows = [(m, truth) for m, truth in run_offline(24 * 3600, scenario="weak_compressor", seed=7)]  # ~0.3 s
```

## Virtual node

```bash
python -m coldchain_tools.virtual_node --fridge fridge-03 --scenario full_demo [--thermal-speed 4]
python -m coldchain_tools.virtual_node --fridge fridge-03 --interactive
```

It uses the same signed envelope, topics and bodies as the firmware, a retained `status` last will, the 720-entry offline buffer, and stop-and-wait sync with verified acks. It accepts verified commands (`RESET_LATCH`, `SET_LATCH`, `BUZZER_TEST`, `SYNC_REQUEST`) and replies on `cmdack`. Timestamps come from the real clock, because the server accepts only ±30 s. The seq is persisted in `tools/.state/<id>.json` (git-ignored) the way the firmware uses NVS: saved every 20, +20 on start. Use a device id the Wokwi node is not using at the same time, since both would share one seq space.

| Scenario | Script (seconds from start) |
|---|---|
| `normal` | runs until stopped (or `--duration`) |
| `door_open` | door open at 60 s for 90 s, so `DOOR_ALARM` fires after 60 s |
| `power_fail` | battery from 60 s to 240 s (compressor forced off, `POWER_FAIL` / `POWER_RESTORE`) |
| `wifi_loss` | 2 min up, 2 min outage (buffering), then restore and sync |
| `heat_spike` | temperature set to 13 °C and door open for 3 min (×2 exposure) |
| `weak_compressor` | efficiency 0.4 at 60 s: slow breach for the health model (P17) |
| `door_ajar` | door left ajar at 60 s: the switch reads open but the gap is small, so the temperature creeps past 8 °C over a quarter of an hour (the forecaster's early-warning case) |
| `full_demo` | all of the above, one after another |

Interactive keys (type, then Enter): `d` door, `p` power, `w` Wi-Fi outage, `e 0.6` efficiency, `t 13` temperature, `s` status, `q` quit.

## Attack demo

```bash
python -m coldchain_tools.attack replay              # capture a live message from the node, resend the same bytes
python -m coldchain_tools.attack replay --own        # or sign a fresh valid one and send it twice
python -m coldchain_tools.attack badsig              # one signature hex char flipped
python -m coldchain_tools.attack stale               # valid signature, ts 10 minutes old
python -m coldchain_tools.attack unknown-device      # well-formed, device fridge-99
python -m coldchain_tools.attack tamper-body         # temperature changed after signing
python -m coldchain_tools.attack flood               # 50 invalid messages/s for 5 s (log coalescing)
python -m coldchain_tools.attack <name> --dry-run    # print the messages and expected reasons, publish nothing
```

| Attack | Server must answer |
|---|---|
| `replay` | first copy accepted, second `REPLAY` |
| `badsig`, `tamper-body`, `flood` | `BAD_SIG` |
| `stale` | `STALE_TS` |
| `unknown-device` | `UNKNOWN_DEVICE` |

The attack tool publishes only under the configured `MQTT_TOPIC_PREFIX` (it refuses wildcard or empty prefixes) and refuses to run when `NODE_ENV=production`. `replay --own` uses seq 0, which no node ever sends, so an accepted copy cannot shadow real data.

## Tamper demo

```bash
python -m coldchain_tools.tamper --audit-id 5 --field payload          # then run Verify Integrity in the UI
python -m coldchain_tools.tamper --reading-id 120 --field temp --value 4.0
python -m coldchain_tools.tamper --restore                              # undo all edits, newest first
```

The database defaults to the backend's `DB_PATH`. The originals are kept in `<db>.tamper.json`. Column names are checked against the table's real columns (`id` cannot be edited), and the tool refuses to run when `NODE_ENV=production`. `audit_log` is append-only at the database level: like an attacker with direct file access, the tool drops the two triggers for its edit and recreates them, and Verify Integrity still reports the change (`HASH_MISMATCH` at that id; `READINGS_TAMPERED` for a reading covered by a checkpoint).

## Verify an envelope

```bash
python -m coldchain_tools.verify_envelope envelope.json [--secret S] [--no-time]
node tools/gen_vectors.js --verify envelope.json --secret S          # the JavaScript reference signer
```

It prints each server check in order (parse + fields, known device, timestamp window, HMAC, body JSON) and stops at the first failure. Replays need the server's nonce store and cannot be judged from one message.

## Tests

`python -m pytest -q` in `tools/` (also part of `make test`): the shared HMAC / status / exposure vectors, firmware-identical bodies, hysteresis and min-off with a fake clock, the thermal cycle, buffer capacity and a sync over a lossy link, the battery model and door alarm, fast mode running 24 h in seconds, every scenario, the virtual node against a fake broker (live, outage, ordered sync without gaps, resend with a fresh nonce, verified commands, rejected replay / bad signature / stale), seq persistence, every attack's rejection reason, the production and prefix guards, tamper and restore on a temporary database, and `verify_envelope`.

## Demo stack, scenarios and checks (P20)

`coldchain_tools.stack` starts what a full run needs and stops it all on Ctrl-C:
- a local MQTT broker (`npm run broker`, aedes) when the configured one is local and not running;
- the ML service, the backend and the web app;
- a `NodeRunner` per fridge whose Wokwi node is not online. A `NodeRunner` is the virtual node's node, uplink and transport, driven by a thread.

`stack demo` (`make demo`):
- resets `DB_PATH` and runs `backend/src/scripts/demo-seed.ts` (users, fridges, ten batches, five per fridge, in varied states; the Discard batch latches fridge-02, and its node gets `SET_LATCH` once it connects);
- backfills 6 h of seeded history (`--hours`);
- `--weak fridge-02=0.4` simulates a weak compressor in the history and in the virtual node, as scenario S10 does: health ≈ 36 and a relocation plan within about 2 minutes (at `DEMO_TIME_SCALE=1`);
- prints the credentials and QR URLs.

`coldchain_tools.preflight` (`make preflight`, about 10 s) is the demo-day check before each take:
- `.env` present;
- clock skew against an internet `Date` header: PASS ≤ 3 s, WARN ≤ 10 s, FAIL beyond;
- the broker with the backend's credentials, and both nodes' retained `online` status;
- backend `/api/ready`, the ML service and its model files;
- `DEMO_TIME_SCALE` (`--expect-scale 20`);
- the fresh-demo state: only fridge-02 latched; 8 batches incl. one At Risk and one Discard.

`--prove-rbac` signs in as the Inspector and tries to move a batch: the server answers 403 (video shot 11).

`coldchain_tools.scenarios` (`make scenarios`, about 15 min; `--full` uses the spec's durations and adds the door-ajar lead time, about 45 min):
- It brings up its own stack on spare ports with a throwaway database and `DEMO_TIME_SCALE=60`, and drives virtual nodes.
- It checks every outcome through the REST API, plus the database for ordering and duplicates.

| | Checks |
|---|---|
| S1 | two fridges publish; temperatures stay within 2–8 °C; complete compressor cycles; no fridge alerts |
| S2 | every `COMP_ON` at ≥ 7.0 °C and ≥ 60 s after the last `COMP_OFF`; every `COMP_OFF` at ≤ 3.0 °C |
| S3 | door open: `DOOR_ALARM`, `DOOR_OPEN_LONG` alert within 5 s and delivered in-app, status WARNING → BREACH |
| S4 | held at 9 °C / 13 °C: exposure ×1 / ×2; At risk, Discard at 0 % with the latch; reset refused for Inspector / Pharmacist, done by Admin; the QR still says Discard |
| S5 | power cut: battery, compressor off, battery drains, alert; restore: alert resolved, restart honours the minimum off-time |
| S6 | Wi-Fi outage: buffer grows, fridge shown OFFLINE; on reconnect every message arrives, seq contiguous, no duplicates, marked late, in order |
| S7 | replay, bad signature, stale, unknown device, tampered body, flood: each rejected with its reason, listed, `SECURITY_FLOOD` raised, in the audit chain |
| S8 | `tamper` an audit row: Verify Integrity red at that record; `--restore`: green |
| S9 | every capability × every role (and anonymous) against the live server |
| FI | ML down → fallback labelled stale, then the model again; broker down → nodes buffer, nothing lost after restart; backend down → it recovers and ingests again |
| S10 | weak compressor: health < 70 and Weakening, `COMPRESSOR_WEAK`; plan proposed; Inspector refused; Pharmacist confirms; batches moved and audited. `--full` adds: door left ajar warns ≥ 10 min before 8 °C |
