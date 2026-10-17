# Fridge node firmware

One firmware for both fridges (`pio run -e fridge-01` / `-e fridge-02`). This page covers the local control loop (P02), the signed MQTT uplink (P03), and the heat budget, DISCARD latch and signed commands (P04). Power, offline buffering and the door alarm (P05) build on them.

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
- Never ON until 60 s after the last OFF. At boot the timer counts as already satisfied.
- `force_off` (power failure, from P05) keeps the compressor OFF and re-arms the timer on every call, so the 60 s counts from when power returns.
- The relay (GPIO16, polarity `RELAY_ACTIVE_HIGH`) and the blue LED are always written together. The relay is driven OFF first thing in `setup()`, so it is never in an undefined state.

With a 60 s minimum off-time the temperature can overshoot above 7 °C while the compressor waits. That is correct behaviour.

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
BUDGET 100%                status line: SENSOR FAULT > DISCARD - RESET REQ > AT RISK nn% > BUDGET nn%
DOOR:CLOSED COMP:ON
PWR:MAINS BAT:100%
WIFI√ MQTT√ SEQ 1234       connectivity (x = down), or SYNCING TIME / HMAC FAIL - OFFLINE / NO SECRET - OFFLINE
```

It redraws at 2 Hz, and at once when a discrete field (state, door, compressor, power, mode, fault, Wi-Fi, MQTT, latch, budget %) changes, so a door toggle shows instantly. It never redraws every loop. The I²C clock while drawing is `OLED_I2C_HZ` (800 kHz, about 12 ms per frame; set `400000` in `config.h` for modules that misbehave above spec).

## LEDs

Exactly one of green / yellow / red is lit: green = SAFE, yellow = WARNING, red blinking at 1 Hz = BREACH. The DISCARD latch forces red solid and turns green and yellow off. Blue mirrors the compressor relay.

## Serial console (115200 baud)

| Command | Effect |
|---|---|
| `status` | full state: mode, model/sensor temperatures, door, compressor and min-off wait, efficiency, speed, loop max, free heap (and lowest), Wi-Fi / MQTT / clock, seq and send counters |
| `dump` | the last envelope built, in full, to paste into backend tests. Check it with `node tools/gen_vectors.js --verify envelope.json --secret <device secret>` |
| `set temp X` | set the model temperature (−40…60 °C) |
| `set eff X` | compressor efficiency 0…2 (1 = healthy; 0.4 cannot hold 8 °C, used for the P17 health demo) |
| `set speed X` | thermal speed multiplier 0…50 |
| `door open` / `door close` | override the door switch until the switch next moves |
| `door auto` | follow the switch again |
| `help` | list commands |
| `cmd reset_latch` / `set_latch` / `buzzer_test` / `sync_request` | **debug builds only** (`-DDEBUG_UNSIGNED_CMDS`, off by default): run a command without a signature |

Every 5 s the node prints one line, for example:

```
[125s] fridge-01 MODEL T=6.41C SAFE door=CLOSED comp=OFF eff=1.00 speed=x1.0 loop_max=13ms
```

Events (`BOOT`, `DOOR_OPEN`, `DOOR_CLOSE`, `COMP_ON`, `COMP_OFF`, `SENSOR_FAULT`, `WIFI_BACK`) and state changes print as `[event] …` and `[state] …` lines. Every publish prints a `[tx]` line with its size and the first 4 signature characters. The power-fail and Wi-Fi buttons are debounced and reported now; their behaviour arrives in P05.

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
| `SYNC_REQUEST` | restart the offline sync from the last acked seq (P05); acks `nothing buffered` until then |

`-DDEBUG_UNSIGNED_CMDS` adds the console `cmd …` shortcut, which bypasses signatures. It is off by default and must never ship.

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
- **Events:** `BOOT` goes out on the first connection with a valid clock. `WIFI_BACK` goes out after a reconnect (not the first connect). `COMP_ON`, `COMP_OFF`, `DOOR_*` and `SENSOR_FAULT` go out when they happen.
- **Envelope** exactly as contract §4: the body is serialised once, signed, then embedded as a JSON string and never re-serialised. `nonce` is 16 hex chars from two `esp_random()` words. `ts` is the send time.
- `seq` is one counter for telemetry and events. It is written to NVS every 20 increments, and on boot the stored value jumps by 20, so a crash can never make the node reuse a seq.

### Boot self-test

Before networking starts, the node signs every HMAC vector from `contracts/test_vectors.json` (embedded via the generated `include/test_vectors.h`) with mbedtls and prints `HMAC SELFTEST OK`. On a mismatch it prints `HMAC SELFTEST FAILED`, shows `HMAC FAIL - OFFLINE` and never starts networking. The control loop keeps running, because halting the whole node would also stop the compressor.

### Security notes

- The secret is never printed. Logs show only the first 4 signature characters; `dump` prints a full envelope (signature included) on request.
- PubSubClient publishes at QoS 0 only, so delivery is not guaranteed. Reliability for buffered data comes from application-level acks (P05).

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
| `test_cmdguard` | acceptance matrix: valid, no clock, ±30 s window, bad signature, tampered body, flipped sig char, replay of the exact bytes, forgeries do not burn nonces, 32-entry ring, wrong device / kind, malformed, unknown type |
