# Fridge node firmware

One firmware for both fridges (`pio run -e fridge-01` / `-e fridge-02`). This page covers the local control loop (P02). Networking (P03), the heat budget and latch (P04), and power/offline/door-alarm behaviour (P05) build on it.

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
FRIDGE-01          SAFE    header; inverted video on BREACH
4.6 °C                     size-3 temperature, or SENSOR FAULT
DOOR:CLOSED COMP:ON
PWR:MAINS BAT:100%
MODE:THERMAL MODEL         footer, becomes WIFI / MQTT / BUF in P03 and P05
```

It redraws at 2 Hz, and at once when a discrete field (state, door, compressor, power, mode, fault) changes, so a door toggle shows instantly. It never redraws every loop. The I²C clock while drawing is `OLED_I2C_HZ` (800 kHz, about 12 ms per frame; set `400000` in `config.h` for modules that misbehave above spec).

## LEDs

Exactly one of green / yellow / red is lit: green = SAFE, yellow = WARNING, red blinking at 1 Hz = BREACH. `leds::setLatch(true)` (wired up in P04) forces red solid and turns green and yellow off. Blue mirrors the compressor relay.

## Serial console (115200 baud)

| Command | Effect |
|---|---|
| `status` | full state: mode, model/sensor temperatures, door, compressor and min-off wait, efficiency, speed, loop max, free heap |
| `set temp X` | set the model temperature (−40…60 °C) |
| `set eff X` | compressor efficiency 0…2 (1 = healthy; 0.4 cannot hold 8 °C, used for the P17 health demo) |
| `set speed X` | thermal speed multiplier 0…50 |
| `door open` / `door close` | override the door switch until the switch next moves |
| `door auto` | follow the switch again |
| `help` | list commands |

Every 5 s the node prints one line, for example:

```
[125s] fridge-01 MODEL T=6.41C SAFE door=CLOSED comp=OFF eff=1.00 speed=x1.0 loop_max=13ms
```

Events (`BOOT`, `DOOR_OPEN`, `DOOR_CLOSE`, `COMP_ON`, `COMP_OFF`, `SENSOR_FAULT`) and state changes print as `[event] …` and `[state] …` lines. The power-fail and Wi-Fi buttons are debounced and reported now; their behaviour arrives in P05.

All four inputs use a 30 ms debounce (`cfg::DEBOUNCE_MS`). Typical mechanical bounce is under 10 ms. On real hardware, run the `hw-smoke` sketch, read the largest burst of raw transitions, and raise the value if a burst is longer.

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
