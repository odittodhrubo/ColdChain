# Fridge node firmware

One firmware for both fridges (`pio run -e fridge-01` / `-e fridge-02`). This page covers the local control loop (P02), the signed MQTT uplink (P03), the heat budget, DISCARD latch and signed commands (P04), and power failure, offline buffering, sync and the door alarm (P05).

## Modules

| Module | Files | Pure (native-tested) | Job |
|---|---|:-:|---|
| config | `include/node_config.h` | yes | firmware tuning: thermal model, fault duty, timings. Contract thresholds come from the generated `constants.h` |
| status | `include/status.h`, `src/status.cpp` | yes | `classify(temp, door_open, on_battery, sensor_fault)` (contract §2) |
| control | `include/control.h`, `src/control.cpp` | yes | compressor hysteresis, 60 s min-off, force-off, sensor-fault duty |
| thermal_model | `include/thermal_model.h`, `src/thermal_model.cpp` | yes | simulated fridge physics for model mode |
| inputs | `include/inputs.h`, `src/inputs.cpp` | debouncer | debounced door, mode, power-fail and Wi-Fi buttons with edge events |
| sensors | `include/sensors.h`, `src/sensors.cpp` | no | DS18B20, asynchronous conversion |
| leds | `include/leds.h`, `src/leds.cpp` | pattern | green / yellow / red-blink / red-solid latch |
| display | `include/display.h`, `src/display.cpp` | no | SSD1306 status screen |
| crypto | `include/crypto.h`, `src/crypto.cpp` | yes | HMAC-SHA256 (mbedtls on the ESP32, portable SHA-256 in native tests), constant-time compare |
| messages | `include/messages.h`, `src/messages.cpp` | yes | telemetry / event bodies, signed envelope, topics, nonces |
| seqstore | `include/seqstore.h`, `src/seqstore.cpp`, `include/kv.h`, `src/nvs_kv.cpp` | yes (fake NVS) | persistent message sequence numbers |
| heat | `include/heat.h`, `src/heat.cpp` | yes (fake NVS) | weighted exposure, remaining budget, DISCARD latch, NVS persistence |
| cmdguard | `include/cmdguard.h`, `src/cmdguard.cpp` | yes | verification of signed server-to-device envelopes, nonce ring, command whitelist |
| buzzer | `include/buzzer.h`, `src/buzzer.cpp` | no | non-blocking beeps and alarm pattern |
| power | `include/power.h`, `src/power.cpp` | yes | MAINS / BATTERY, battery model, DEAD; door-alarm timer |
| ringbuf | `include/ringbuf.h`, `src/ringbuf.cpp` | yes | 720 x 16 B offline buffer for readings and events |
| syncer | `include/syncer.h`, `src/syncer.cpp` | yes | stop-and-wait sync with acks, retries and backoff; sync body |
| net | `include/net.h`, `src/net.cpp` | no | Wi-Fi, NTP, MQTT in a FreeRTOS task with backoff |
| uplink | `include/uplink.h`, `src/uplink.cpp` | no | device secret, boot HMAC self-test, signed publishing, inbox, `dump` |
| settings | `include/settings.h`, `config_check.py` | no | picks `config.h` or the `config.example.h` placeholders |
| main | `src/main.cpp` | no | cooperative `millis()` scheduler, relay + blue LED, serial console |

There is no `delay()` in `loop()`. Each task checks its own period with unsigned subtraction (`now - last >= period`), which stays correct across the 49-day `millis()` rollover. The console `status` command prints the worst loop iteration since the last 5 s line (`loop max`); the target is below 20 ms.

## Temperature source

The **mode switch** (GPIO23) selects the source:

- **OFF: thermal model (default).** `dT/dt = k_leak·(T_amb − T) + (door ? k_door·(T_amb − T) : 0) − (comp ? cool_rate·efficiency : 0)` with `T_amb = 30 °C`, `k_leak = 0.0004/s`, `k_door = 0.004/s`, `cool_rate = 0.02 °C/s`, initial 5.0 °C. It integrates real elapsed time × `THERMAL_SPEED` (default 1; demo builds add `-DTHERMAL_SPEED_DEFAULT=4` to `build_flags`, or use `set speed 4` at runtime), in Euler sub-steps of at most 1 simulated second. Readings add Gaussian measurement noise (σ 0.03 °C); the model state itself has no noise, so it never drifts as a random walk. At default parameters 3 → 7 °C takes about 400 s, so the 60 s min-off cannot push the fridge above 8 °C in normal operation.
- **ON: manual DS18B20.** In Wokwi, drag the sensor's temperature slider. The conversion is requested, then read 800 ms later; the loop never waits for it.

The model keeps running in manual mode, so switching back continues from a physical temperature. Temperature is sampled and the control decision made once per second, and immediately on a door or mode change.

## Compressor control

- ON when `T ≥ 7.0 °C`, OFF when `T ≤ 3.0 °C`.
- Never ON until 60 s after the last OFF. **A reboot counts as an OFF** (`bootLock()` in `setup()`): the relay de-energises on any reset, so after a watchdog reset or brownout mid-cycle the compressor still waits 60 s and cannot short-cycle. (`CompressorControl` without `bootLock()`, as in the native tests and the ML data generator, counts the timer as already satisfied at start.)
- `force_off` (on battery or DEAD, see Power failure) keeps the compressor OFF and re-arms the timer on every call, so the 60 s counts from when power returns.
- The relay (GPIO16, polarity `RELAY_ACTIVE_HIGH`) and the blue LED are always written together. The relay is driven OFF first thing in `setup()`, so it is never in an undefined state.

With a 60 s minimum off-time the temperature can overshoot above 7 °C while the compressor waits. That is correct behaviour.

## Task watchdog

The control loop runs under the ESP32 task watchdog: `esp_task_wdt_init(WDT_TIMEOUT_S = 8, panic)` plus `enableLoopWDT()`, armed at the end of `setup()`. The Arduino core resets it after every `loop()` pass. If the loop ever stops (a stuck I²C bus, a library bug), the chip resets within 8 s. It comes back with the relay OFF, the 60 s boot lock above, its latch and `exp_s` from NVS, and a `BOOT` event whose `data.reset` names the cause (`TASK_WDT`, `PANIC`, `BROWNOUT`, `POWERON`, …). The backend writes watchdog, panic and brownout boots into the audit chain.

The network task (core 0) is deliberately not watched. A TLS handshake can block it for a long time, and a reset would drop the RAM buffer. The control loop never waits on it.

To test it, build with `-DDEBUG_UNSIGNED_CMDS` and type `debug hang`: the loop stops, and the next boot reports `[boot] reset reason TASK_WDT`.

## Sensor fault (fail-safe)

In manual mode the probe is **faulted** when it is missing, reads `-127 °C` (disconnected) or `85 °C` (power-on value, conversion not done), reads outside −55…125 °C, or has produced no valid reading for 5 s. A missing probe is searched for again every 5 s.

On a fault:

- status is **BREACH** (contract §2), and a `SENSOR_FAULT` event is raised once per episode (printed now, published from P03);
- the OLED replaces the temperature with `SENSOR FAULT`;
- the compressor runs a cautious **5 min ON / 10 min OFF** duty cycle (starting ON if it has never run), because the fridge temperature is unknown. Force-off still wins. When a valid reading returns, normal hysteresis takes over.

## OLED (128×64)

```
FRIDGE-01 SIM      SAFE    header (SIM = thermal model, MAN = DS18B20); inverted video on BREACH
4.6 °C                     size-2 temperature (--.- on a sensor fault)
BUDGET 100%                status line: SENSOR FAULT > DOOR OPEN! > DISCARD - RESET REQ > AT RISK nn% > BUDGET nn%
DOOR:CLOSED COMP:ON
PWR:MAINS BAT:100%
WIFI√ MQTT√ SEQ 1234       connectivity (x = down), or OFFLINE buf:N / SYNC buf:N / SYNCING TIME / HMAC FAIL - OFFLINE / NO SECRET - OFFLINE
```

It redraws at 2 Hz, and at once when a discrete field (state, door, compressor, power, mode, fault, Wi-Fi, MQTT, latch, budget %) changes, so a door toggle shows instantly. It never redraws every loop. The I²C clock while drawing is `OLED_I2C_HZ` (800 kHz, about 12 ms per frame; set `400000` in `config.h` for modules that misbehave above spec).

## LEDs

Exactly one of green / yellow / red is lit: green = SAFE, yellow = WARNING, red blinking at 1 Hz = BREACH. The DISCARD latch forces red solid and turns green and yellow off. Blue mirrors the compressor relay.

## Serial console (115200 baud)

| Command | Effect |
|---|---|
| `status` | full state: mode, model/sensor temperatures, budget, door and alarm, power and battery, compressor and min-off wait, efficiency, speed, loop max, free heap (and lowest), Wi-Fi / MQTT / clock, seq and send counters, buffer fill / dropped / sync state |
| `dump` | the last envelope built, in full, to paste into backend tests. Check it with `node tools/gen_vectors.js --verify envelope.json --secret <device secret>` |
| `set temp X` | set the model temperature (−40…60 °C) |
| `set eff X` | compressor efficiency 0…2 (1 = healthy; 0.4 cannot hold 8 °C, used for the P17 health demo) |
| `set speed X` | thermal speed multiplier 0…50 |
| `door open` / `door close` | override the door switch until the switch next moves |
| `door auto` | follow the switch again |
| `help` | list commands |
| `cmd reset_latch` / `set_latch` / `buzzer_test` / `sync_request` | **debug builds only** (`-DDEBUG_UNSIGNED_CMDS`, off by default): run a command without a signature |
| `debug hang` | **debug builds only**: stop the loop to test the task watchdog (reset within 8 s) |

Every 5 s the node prints one line, for example:

```
[125s] fridge-01 MODEL T=6.41C SAFE door=CLOSED comp=OFF eff=1.00 speed=x1.0 loop_max=13ms
```

Events (`BOOT`, `DOOR_OPEN`, `DOOR_CLOSE`, `COMP_ON`, `COMP_OFF`, `SENSOR_FAULT`, `WIFI_BACK`) and state changes print as `[event] …` and `[state] …` lines. Every publish prints a `[tx]` line with its size and the first 4 signature characters. The power-fail and Wi-Fi outage buttons toggle on each debounced press (see below).

All four inputs use a 30 ms debounce (`cfg::DEBOUNCE_MS`). Typical mechanical bounce is under 10 ms. On real hardware, run the `hw-smoke` sketch, read the largest burst of raw transitions, and raise the value if a burst is longer.

## Heat budget and DISCARD latch

The server tracks the 60-minute budget per vaccine batch and is the source of truth for batch status (P11). The node keeps a **fridge-level worst case**, so the safety indicators work even with no server contact.

- **Exposure:** every 1 s sample adds `dt × weight` weighted seconds, using real elapsed time (not the thermal speed-up): weight 0 up to 8.0 °C, 1 above 8.0 up to 12.0, 2 above 12.0 (contract §2). 60 s at 9 °C adds 60; 60 s at 13 °C adds 120. During a **sensor fault** the temperature is unknown, so it counts as weight 1 (fail-safe: never under-count). Telemetry carries `exp_s`; `remaining_pct = max(0, 100 × (1 − exp_s / 3600))`.
- **AT RISK:** below 20 % remaining the OLED status line shows `AT RISK nn%` (the yellow LED already shows WARNING while the fridge is warm).
- **Latch:** at `exp_s ≥ 3600` the node latches: red LED solid, one 1.5 s beep, `LATCH_SET` event (`{"exp_s":…, "reason":"budget"}`), OLED `DISCARD - RESET REQ`. The latch never clears by itself.
- **Persistence:** `latch` and `exp_s` live in NVS. `exp_s` is written at most every 30 s, plus at once when an excursion starts or ends and on latch changes, so a crash loses at most 30 s of exposure and flash wear stays low. A reboot or power cut comes back latched with the same `exp_s`.
- **Reset:** only a verified `RESET_LATCH` command clears the latch. It also zeroes `exp_s`, writes NVS and emits `LATCH_RESET`. The admin reset clears the server side too (P11).

Device and server budgets can legitimately differ: the server counts per batch (and only while the batch is in the fridge), the device counts the whole fridge. The device latches when the fridge-level budget is exhausted or when the server sends `SET_LATCH`.

## Signed commands

The node subscribes to `{prefix}/{device_id}/cmd`. A command is accepted only if, in this order:

1. the clock is valid (a command before NTP is **rejected**, never accepted against a wrong clock);
2. it is valid JSON with all envelope fields (`v`, `device_id`, `kind`, `ts`, `nonce` of 16 chars, `body`, 64-char `sig`);
3. `device_id` is this node and `kind` is `cmd`;
4. `|now − ts| ≤ 30 s`;
5. the HMAC verifies with the device secret (constant-time compare);
6. the nonce is not among the last 32 accepted (ring cache). A nonce is remembered only after its HMAC verified, so forged messages cannot evict real ones;
7. `type` is one of `RESET_LATCH`, `SET_LATCH`, `BUZZER_TEST`, `SYNC_REQUEST`.

Anything else is dropped and counted (`rejected_cmds` in `status`) with its reason (`NO_TIME`, `BAD_JSON`, `BAD_FIELDS`, `WRONG_DEVICE`, `WRONG_KIND`, `STALE_TS`, `BAD_SIG`, `REPLAY`). Only authenticated commands get a reply: a signed `cmdack` `{"cmd_id","ok","detail"}`. An authenticated but unknown type gets `ok:false`; a forgery gets nothing, so it learns nothing.

| Command | Effect |
|---|---|
| `RESET_LATCH` | clear the latch, zero `exp_s`, persist, `LATCH_RESET` |
| `SET_LATCH` | latch exactly as if the budget ran out (red solid, beep, `LATCH_SET` with `reason:"command"`, persisted) |
| `BUZZER_TEST` | beep for 1 s |
| `SYNC_REQUEST` | move the live-sent entries in `args.from_seq..to_seq` (all of them without a range) from the replay window into the offline buffer, then restart the sync from the oldest unacked entry; the cmdack says from which seq, how many were replayed, or `nothing buffered` |

`-DDEBUG_UNSIGNED_CMDS` adds the console `cmd …` shortcut, which bypasses signatures. It is off by default and must never ship.

## Power failure

The **POWER FAIL** button (GPIO32) toggles MAINS ↔ BATTERY. On real hardware, `#define POWER_SENSE_IS_LEVEL 1` in `config.h` makes GPIO32 a mains-sense input instead (HIGH = mains present, e.g. a 10 k / 20 k divider from the 5 V adapter rail).

- **On BATTERY:** the compressor is forced OFF (a small battery cannot run it), status is at least WARNING, the OLED shows `PWR:BATTERY BAT:nn%`, and `POWER_FAIL` / `POWER_RESTORE` events are sent. The forced OFF keeps re-arming the 60 s min-off timer, so after power returns the compressor waits at least 60 s and a flapping button cannot short-cycle it.
- **Battery model:** starts at 100 %, drains `BATT_DRAIN_PCT_PER_MIN` (default 2; demo builds pass `-DBATT_DRAIN_PCT_PER_MIN=6`) on battery, and recharges 5 %/min on mains. At ≤ 20 % `BATT_LOW` is sent once per discharge.
- **DEAD at 0 %:** OLED off, LEDs and buzzer off, radio off, nothing published, relay off; the exact seq is saved to NVS. The thermal model keeps running (the fridge physically warms). No exposure is counted while DEAD, because an unpowered node cannot measure; the server integrates the gap conservatively (contract §2). When mains returns the node revives: `BOOT` (`"revived":true`), seq continues from the persisted value, and the temperature is *not* reset.
- Telemetry carries `power` and `batt` in every reading.

## Offline buffer and sync

The **WI-FI OUTAGE** button (GPIO33) toggles a simulated outage: Wi-Fi disconnects and refuses to reconnect. A real outage (broker unreachable, Wi-Fi gone) behaves identically, because both are just "uplink down". Uplink means MQTT connected with a valid clock.

- **Events:** `WIFI_LOST` (buffered, since the link is down) and `WIFI_BACK` on recovery.
- **Buffer:** while the uplink is down, or when a publish fails, every reading and event goes into a ring buffer of `BUFFER_CAPACITY = 720` entries (60 min at 5 s; the requirement is ≥ 30 min = 360). Each entry is 16 bytes of binary (seq, ts, temp × 100, exp_s, batt, state or event type, flags), ~11.5 kB in total, and is serialised to JSON only when sent. When full, the oldest entry is overwritten and counted; the next live telemetry reports `"dropped":N`. Readings created before the clock was ever valid have no timestamp and are dropped (counted as `no clock`); once NTP has synced, the clock keeps running through outages.
- **Sync on reconnect:** stop-and-wait, oldest first. The node sends one `sync` chunk of at most 25 items (`from_seq` / `to_seq`, fresh `ts` and `nonce`), then waits for the server's signed ack `{"seq_upto":N}`. The ack is verified like a command (window, HMAC, nonce). Then entries ≤ N are freed and the next chunk goes. With no ack within 5 s the same chunk is resent; after 5 retries the sender backs off for 60 s. **Entries are never freed before an ack.** A late duplicate ack (below the oldest buffered seq) is ignored. Events buffered offline travel in the same array as event bodies (contract §5).
- **Live telemetry continues during sync** with higher seqs; the server orders by seq, so nothing overtakes the buffered data.
- **Retain until acknowledged (R1).** A successful live publish only means the message reached the socket. If the backend was down, the broker dropped it (QoS 0, PubSubClient has no QoS 1 publish). So every live-sent reading and event is also kept in a second ring, `recent` (720 entries, the last 60 min, another 11.5 kB of RAM).
  - The server finds the hole in the seq numbers and sends `SYNC_REQUEST {from_seq, to_seq}`.
  - The node moves exactly those entries into the offline buffer, in seq order, and they sync like any buffered data.
  - An ack frees only entries that went out in a sync chunk (`bufflag::SENT`). An older entry replayed in while a chunk was in flight survives that chunk's ack.
  - The offline buffer, its `buf:N` and `dropped` counters are unchanged: `recent` is not counted in them.
- `SYNC_REQUEST` restarts the sync from the oldest unacked entry.
- Exactly-once is at-least-once delivery from the node plus dedupe on `(device_id, seq)` at the server.

The OLED footer shows `OFFLINE buf:N` while down and `SYNC buf:N` while draining. The video walkthrough is in [`wokwi/scenarios/offline.md`](../firmware/fridge-node/wokwi/scenarios/offline.md).

## Door alarm

If the door stays open for more than `DOOR_ALARM_S` (60 s): the buzzer beeps 200 ms on / 200 ms off until the door closes, the OLED status line shows `DOOR OPEN!`, and one `DOOR_ALARM` event is sent per episode (buffered if offline, and flagged late by the server). The server sends the SMS / Telegram / email alert (P12). Closing the door silences the buzzer and sends `DOOR_CLOSE`. On battery with the door open, the thermal model applies both effects.

## Networking

### Configuration

`include/config.h` is git-ignored and holds the real settings. Generate it from `.env` with `node tools/init_firmware_config.js`. That also creates `DEVICE_SECRET_FRIDGE_01/02` in `.env` if they are missing, so the backend and the virtual node use the same secrets. Or copy `include/config.example.h` by hand.

| Setting | Meaning |
|---|---|
| `WIFI_SSID`, `WIFI_PASS` | `Wokwi-GUEST` with an empty password in the simulator |
| `NTP_SERVER` | `pool.ntp.org` |
| `MQTT_HOST`, `MQTT_PORT`, `MQTT_TLS` | `MQTT_TLS 1` uses `WiFiClientSecure` (port 8883), `0` plain TCP |
| `MQTT_USER`, `MQTT_PASS` | broker credentials (empty = anonymous) |
| `MQTT_TOPIC_PREFIX` | topic prefix; use a unique one on shared brokers |
| `ALLOW_INSECURE_TLS` | simulation only: accept any server certificate. Real deployments remove it and set `MQTT_CA_CERT` to the broker's root CA PEM. The build fails if TLS is on and neither is defined |
| `DEVICE_SECRETS` | `{{"fridge-01", "<64 hex>"}, {"fridge-02", "<64 hex>"}}`; the node picks the entry for its `FRIDGE_ID` |

Without `config.h` the firmware builds with the placeholders and a compiler warning. `config_check.py` (a PlatformIO pre-script) decides this, because `__has_include("config.h")` also finds other libraries' `config.h`. With the all-zero placeholder secret the node connects, but the server rejects every message as `BAD_SIG`.

### Network task

`PubSubClient::connect()` and the TLS handshake block for seconds. So Wi-Fi, NTP and MQTT run in their own FreeRTOS task (`net`, core 0), and the control loop runs in the Arduino loop task on core 1. The loop never waits on the network:

- `net::publish()` try-locks the client for at most 5 ms and fails at once while the link is down or connecting;
- received messages (`cmd`, `ack`) are copied into a 4-deep queue that the loop drains with `net::receive()`.

Wi-Fi and MQTT reconnect with exponential backoff, 1 s doubling to 30 s; Wi-Fi auto-reconnect is off so the backoff is ours. On connect the node sets a retained last will `offline` on `{prefix}/{device_id}/status`, publishes `online`, and subscribes to `cmd` and `ack`. The MQTT buffer is 8192 bytes: a full sync chunk of 25 readings is about 4.5 kB once its body is escaped into the envelope, and PubSubClient silently drops anything larger than its buffer.

### Time

`configTime(0, 0, NTP_SERVER)` starts SNTP when Wi-Fi first comes up. Until `time() > 1 700 000 000` the node does not publish, because a 1970 timestamp would be rejected as `STALE_TS`; the OLED footer shows `SYNCING TIME`. `net::nowUnix()` returns 0 until then.

### Messages

- **Telemetry** every `TELEMETRY_PERIOD_S` (5 s), plus immediately with `reason:"door"` and a `DOOR_OPEN` / `DOOR_CLOSE` event on every door change, including a console override. Bodies follow contract §5 exactly. `temp` has two decimals and is `null` on a sensor fault; `exp_s` and `latch` come from the heat budget.
- **Events:** `BOOT` (`{"fw":"1.0.0","reset":"<reason>"}`) is created as soon as the clock is valid (sent, or buffered if the broker is not reachable yet). `WIFI_LOST` / `WIFI_BACK` follow the uplink going down and coming back (not the first connect). `COMP_ON`, `COMP_OFF`, `DOOR_*` and `SENSOR_FAULT` go out when they happen.
- **Envelope** exactly as contract §4: the body is serialised once, signed, then embedded as a JSON string and never re-serialised. `nonce` is 16 hex chars from two `esp_random()` words. `ts` is the send time.
- `seq` is one counter for telemetry and events. It is written to NVS every 20 increments, and on boot the stored value jumps by 20, so a crash can never make the node reuse a seq.

### Boot self-test

Before networking starts, the node signs every HMAC vector from `contracts/test_vectors.json` (embedded via the generated `include/test_vectors.h`) with mbedtls and prints `HMAC SELFTEST OK`. On a mismatch it prints `HMAC SELFTEST FAILED`, shows `HMAC FAIL - OFFLINE` and never starts networking. The control loop keeps running, because halting the whole node would also stop the compressor.

### Security notes

- The secret is never printed. Logs show only the first 4 signature characters; `dump` prints a full envelope (signature included) on request.
- PubSubClient publishes at QoS 0 only, so delivery is not guaranteed. Reliability for buffered data comes from the application-level acks above. A failed live publish falls back to the buffer.

## Tests

```bash
cd firmware/fridge-node
pio test -e native
```

| Suite | Covers |
|---|---|
| `test_status` | `classify` against all 12 shared status vectors (`include/test_vectors.h`, generated by `tools/gen_vectors.js`), boundaries 2.0 / 2.5 / 3.0 / 7.0 / 7.5 / 8.0, NaN = fault |
| `test_control` | thresholds 3.0 / 7.0, boot min-off, no restart within 60 s (fake clock), `millis()` rollover, force-off, sensor-fault duty |
| `test_thermal` | one simulated hour at speed 1 cycles between ~3 and ~7 °C and never leaves 2.5–7.5 °C; speed ×6; 3 → 7 °C ≈ 400 s; open door breaches; weak compressor breaches; bounded by ambient; noise σ |
| `test_ui` | LED pattern per state, 1 Hz blink, latch override, debounce |
| `test_crypto` | RFC 4231 HMAC case, all 5 shared HMAC vectors, envelope round-trip keeps the exact body, buffer too small, constant-time compare, telemetry body byte-identical to the shared vector, sync-reading shape with `null` temp, event body, topics, nonce |
| `test_seqstore` | monotonic seq, NVS written every 20 increments, crash + reboot never reuses a seq, flush |
| `test_heat` | all 8 shared exposure vectors, 60 s at 9 °C = 60 and at 13 °C = 120, weights at 8.0 / 12.0, fault counts ×1, AT RISK then a single LATCH_SET, latch and `exp_s` survive reboot, at most 30 s lost on a crash, NVS writes throttled, reset, SET_LATCH persists |
| `test_offline` | 16-byte entry round trip, 360 readings kept and capacity 720, overflow drops oldest and counts, free only up to the ack, events in sync chunks, a worst-case 25-item chunk fits the 6 kB body and 8 kB MQTT buffers, sync over a link losing 30 % of chunks and acks (20 seeds, 4-minute outage) and a full 30-minute outage with every seq delivered once and in order, retry cadence and backoff, stale ack ignored, SYNC_REQUEST, battery drain / BATT_LOW once / DEAD / revive / recharge, door alarm after > 60 s once per episode |
| `test_cmdguard` | acceptance matrix: valid, no clock, ±30 s window, bad signature, tampered body, flipped sig char, replay of the exact bytes, forgeries do not burn nonces, 32-entry ring, wrong device / kind, malformed, unknown type |
