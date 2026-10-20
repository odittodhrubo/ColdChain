// ColdChain fridge node: local control loop (P02), signed MQTT uplink (P03), heat budget, DISCARD latch and
// signed commands (P04), power failure, offline buffer + sync and door alarm (P05).
// Cooperative scheduler on millis(): every task checks its own period with unsigned subtraction, nothing blocks,
// so the compressor logic keeps running whatever else happens. No delay() anywhere in loop(). Networking runs in
// its own task (net.cpp), so a slow broker or Wi-Fi loss never stalls this loop.
#include <Arduino.h>
#include <ctype.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "buzzer.h"
#include "cmdguard.h"
#include "constants.h"
#include "control.h"
#include "display.h"
#include "heat.h"
#include "inputs.h"
#include "kv.h"
#include "leds.h"
#include "messages.h"
#include "net.h"
#include "node_config.h"
#include "pins.h"
#include "power.h"
#include "sensors.h"
#include "status.h"
#include "thermal_model.h"
#include "uplink.h"

#ifndef FRIDGE_ID
#error "FRIDGE_ID must be set via build_flags in platformio.ini"
#endif

namespace {

constexpr uint32_t SAMPLE_MS = 1000;  // temperature sampling / control decision rate
constexpr uint32_t LATCH_BEEP_MS = 1500;
constexpr uint32_t BUZZER_TEST_MS = 1000;

ThermalModel model;
CompressorControl comp;
HeatKeeper heat(nvs::store());
PowerModel power;
DoorAlarm doorAlarm;

int8_t doorOverride = -1;  // console "door open|close": -1 = follow the switch; cleared when the switch moves
float temp = NAN;
bool sensorFault = false;
FridgeState state = FridgeState::SAFE;
bool batteryRequested = false;  // power-fail button toggle (or the mains-sense level on real hardware)
bool wifiOutage = false;        // Wi-Fi outage button toggle

bool lastDoor = false;  // door state last reported, so a console override also produces an event
uint32_t lastStepAt = 0, lastSampleAt = 0, lastLineAt = 0, lastTelemetryAt = 0, loopStartAt = 0, lastHeatAt = 0;
uint32_t loopMaxMs = 0;  // worst loop iteration since the last status line

bool doorOpen() { return doorOverride >= 0 ? doorOverride == 1 : inputs::doorOpen(); }

void driveCompressor(bool on) {
  digitalWrite(pins::PIN_RELAY, (on == (RELAY_ACTIVE_HIGH != 0)) ? HIGH : LOW);
  digitalWrite(pins::PIN_LED_BLUE, on ? HIGH : LOW);  // blue LED always mirrors the relay
}

void event(const char* type, const char* data_json = nullptr) { uplink::event(type, data_json); }

// seq and ts are filled in by the uplink when the reading is sent or buffered.
Reading reading(bool doorReason) {
  return {0,           0,     sensorFault ? NAN : temp, doorOpen(),     comp.on(),            power.onBattery(),
          power.pct(), state, heat.expS(),              heat.latched(), inputs::manualMode(), doorReason,
          sensors::ambientC()};  // A3: NAN (and omitted) unless a second probe is fitted
}

// Budget exhausted or SET_LATCH: red solid, one long beep, LATCH_SET. Already persisted by HeatKeeper.
void latchSet(const char* reason) {
  leds::setLatch(true);
  buzzer::beep(LATCH_BEEP_MS);
  char data[64];
  snprintf(data, sizeof data, "{\"exp_s\":%lu,\"reason\":\"%s\"}", static_cast<unsigned long>(heat.expS()), reason);
  event("LATCH_SET", data);
}

// Verified, whitelisted commands from uplink (or the console with -DDEBUG_UNSIGNED_CMDS).
bool runDeviceCommand(CmdType type, char* detail, size_t cap) {
  switch (type) {
    case CmdType::RESET_LATCH: {
      const bool was = heat.resetLatch();  // zeroes exp_s and writes NVS
      leds::setLatch(false);
      event("LATCH_RESET");
      snprintf(detail, cap, was ? "latch cleared, exp_s reset" : "not latched, exp_s reset");
      return true;
    }
    case CmdType::SET_LATCH:
      if (heat.setLatch()) {
        latchSet("command");
        snprintf(detail, cap, "latch set");
      } else {
        snprintf(detail, cap, "already latched");
      }
      return true;
    case CmdType::BUZZER_TEST:
      buzzer::beep(BUZZER_TEST_MS);
      snprintf(detail, cap, "beeped %lu ms", static_cast<unsigned long>(BUZZER_TEST_MS));
      return true;
    case CmdType::SYNC_REQUEST:
      uplink::restartSync(detail, cap);
      return true;
    case CmdType::ROTATE_SECRET:     // handled inside the uplink (it owns the secret); never routed here
    case CmdType::SET_CALIBRATION:   // P4: handled inside the uplink too (it reads the offset from the args)
    case CmdType::UNKNOWN:
      break;
  }
  snprintf(detail, cap, "unknown command type");
  return false;
}

void applyOutage() {
  net::setOutage(wifiOutage || power.dead());  // a DEAD node has no radio either
}

// Battery at 0 %: display, LEDs, buzzer and publishing stop; the relay is already off (forced off on battery).
// The fridge keeps warming: the thermal model keeps running.
void enterDead() {
  Serial.println("[power] battery empty: node DEAD until mains returns");
  uplink::shutdown();
  applyOutage();
  display::setPower(false);
  leds::off();
  buzzer::silence();
}

void leaveDead() {
  Serial.println("[power] mains back: node revives");
  display::setPower(true);
  applyOutage();
  lastHeatAt = millis();  // the node was off: no exposure was measured while DEAD
  event("BOOT", "{\"fw\":\"1.0.0\",\"revived\":true}");  // seq continues from the persisted value
}

void updatePower(float dt_s) {
  const PowerModel::Events ev = power.update(batteryRequested, dt_s);
  if (ev.powerFail) event("POWER_FAIL");
  if (ev.revived) leaveDead();
  if (ev.powerRestore) event("POWER_RESTORE");
  if (ev.battLow) {
    char data[24];
    snprintf(data, sizeof data, "{\"batt\":%u}", power.pct());
    event("BATT_LOW", data);
  }
  if (ev.died) enterDead();
}

void printLine() {
  Serial.printf(
      "[%lus] %s %s T=%.2fC %s door=%s comp=%s%s exp=%lus (%.0f%%)%s pwr=%s %u%% buf=%lu eff=%.2f speed=x%.1f "
      "loop_max=%lums\n",
      static_cast<unsigned long>(millis() / 1000), FRIDGE_ID, inputs::manualMode() ? "MANUAL" : "MODEL", temp,
      sensorFault ? "SENSOR_FAULT" : stateName(state), doorOpen() ? "OPEN" : "CLOSED", comp.on() ? "ON" : "OFF",
      comp.waitingMinOff(millis()) ? "(min-off)" : "", static_cast<unsigned long>(heat.expS()), heat.remainingPct(),
      heat.latched() ? " DISCARD" : "", power.dead() ? "DEAD" : power.onBattery() ? "BATTERY" : "MAINS", power.pct(),
      static_cast<unsigned long>(uplink::bufferedCount()), model.efficiency(), model.speed(),
      static_cast<unsigned long>(loopMaxMs));
}

void printStatus() {
  Serial.printf("fridge     %s  fw 1.0.0\n", FRIDGE_ID);
  Serial.printf("mode       %s\n", inputs::manualMode() ? "MANUAL (DS18B20)" : "MODEL (thermal simulation)");
  Serial.printf("temp       %.2f C  model %.2f C  sensor %.2f C%s\n", temp, model.trueTemp(), sensors::tempC(),
                sensors::fault() ? " (fault)" : "");
  Serial.printf("state      %s  latch %s\n", stateName(state), heat.latched() ? "ON (DISCARD)" : "off");
  Serial.printf("budget     exp_s %lu / %lu  remaining %.1f%%%s\n", static_cast<unsigned long>(heat.expS()),
                static_cast<unsigned long>(cc::BUDGET_S), heat.remainingPct(), heat.atRisk() ? "  AT RISK" : "");
  Serial.printf("door       %s%s%s\n", doorOpen() ? "OPEN" : "CLOSED", doorOverride >= 0 ? " (console override)" : "",
                doorAlarm.active() ? "  ALARM" : "");
  Serial.printf("power      %s  battery %.1f%%  wifi outage %s\n",
                power.dead() ? "DEAD" : power.onBattery() ? "BATTERY" : "MAINS", power.pctExact(),
                wifiOutage ? "ON" : "off");
  Serial.printf("compressor %s%s  (ON >= %.1f C, OFF <= %.1f C, min off %lus)\n", comp.on() ? "ON" : "OFF",
                comp.waitingMinOff(millis()) ? " waiting min-off" : "", cc::COMP_ON_AT_C, cc::COMP_OFF_AT_C,
                static_cast<unsigned long>(cc::COMP_MIN_OFF_S));
  Serial.printf("model      efficiency %.2f  speed x%.1f\n", model.efficiency(), model.speed());
  Serial.printf("loop       max %lu ms  free heap %lu B (lowest %lu B)\n", static_cast<unsigned long>(loopMaxMs),
                static_cast<unsigned long>(ESP.getFreeHeap()), static_cast<unsigned long>(ESP.getMinFreeHeap()));
  uplink::printStatus();
}

void printHelp() {
  Serial.println("commands: status | dump | set temp X | set eff X | set speed X | door open|close|auto | help");
#ifdef DEBUG_UNSIGNED_CMDS
  Serial.println("debug:    cmd reset_latch|set_latch|buzzer_test|sync_request  (UNSIGNED, debug build only)");
#endif
}

// Why the chip last reset, for the BOOT event: a watchdog, panic or brownout reset is worth investigating.
const char* resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_EXT: return "EXT";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
  }
}

bool parseFloat(const char* s, float& out) {
  char* end = nullptr;
  out = strtof(s, &end);
  return end != s && *end == '\0' && isfinite(out);
}

void runCommand(char* line) {
  float v;
  if (strcmp(line, "status") == 0) {
    printStatus();
  } else if (strcmp(line, "dump") == 0) {
    uplink::dump();
  } else if (strncmp(line, "set temp ", 9) == 0 && parseFloat(line + 9, v) && v > -40 && v < 60) {
    model.setTemp(v);
    Serial.printf("model temperature set to %.2f C%s\n", v,
                  inputs::manualMode() ? " (manual mode reads the DS18B20; move the Wokwi slider instead)" : "");
  } else if (strncmp(line, "set eff ", 8) == 0 && parseFloat(line + 8, v) && v >= 0 && v <= 2) {
    model.setEfficiency(v);
    Serial.printf("compressor efficiency %.2f\n", v);
  } else if (strncmp(line, "set speed ", 10) == 0 && parseFloat(line + 10, v) && v > 0 && v <= 50) {
    model.setSpeed(v);
    Serial.printf("thermal speed x%.1f\n", v);
  } else if (strcmp(line, "door open") == 0 || strcmp(line, "door close") == 0) {
    doorOverride = strcmp(line, "door open") == 0 ? 1 : 0;
    Serial.printf("door forced %s until the switch moves (door auto to release)\n", doorOverride ? "OPEN" : "CLOSED");
  } else if (strcmp(line, "door auto") == 0) {
    doorOverride = -1;
    Serial.println("door follows the switch");
  } else if (strcmp(line, "help") == 0) {
    printHelp();
#ifdef DEBUG_UNSIGNED_CMDS
  } else if (strcmp(line, "debug hang") == 0) {
    // Watchdog test (debug builds only): the loop stops; the task watchdog resets the chip within
    // WDT_TIMEOUT_S, and the next BOOT event carries reset TASK_WDT.
    Serial.printf("[debug] hanging the loop: expect a TASK_WDT reset within %lu s\n",
                  static_cast<unsigned long>(cfg::WDT_TIMEOUT_S));
    for (;;) {
    }
  } else if (strncmp(line, "cmd ", 4) == 0) {
    // Bypasses signature checks: compiled in only with -DDEBUG_UNSIGNED_CMDS, never in a normal build.
    char upper[24] = "";
    for (size_t i = 0; line[4 + i] && i < sizeof upper - 1; i++) upper[i] = toupper(line[4 + i]);
    char detail[64];
    const CmdType type = parseCmdType(upper);
    const bool ok = runDeviceCommand(type, detail, sizeof detail);
    Serial.printf("[cmd] UNSIGNED %s %s: %s\n", upper, ok ? "ok" : "failed", detail);
#endif
  } else {
    Serial.printf("unknown or out-of-range command: '%s'\n", line);
    printHelp();
  }
}

// Non-blocking line reader: consumes whatever bytes are waiting, runs a command on newline.
void pollConsole() {
  static char buf[64];
  static size_t len = 0;
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r' || c == '\n') {
      if (len == 0) continue;
      buf[len] = '\0';
      len = 0;
      runCommand(buf);
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = static_cast<char>(tolower(static_cast<unsigned char>(c)));
    }
  }
}

void sample(uint32_t now) {
  const bool manual = inputs::manualMode();
  const bool fault = manual && sensors::fault();
  if (fault && !sensorFault) event("SENSOR_FAULT");
  sensorFault = fault;
  temp = manual ? sensors::tempC() : model.read();

  // Exposure counts real elapsed time (not the thermal speed-up): a sample stands for the time since the last.
  const float dt = (now - lastHeatAt) / 1000.0f;
  lastHeatAt = now;
  if (heat.update(temp, sensorFault, dt, now)) latchSet("budget");

  const FridgeState prev = state;
  state = classify(temp, doorOpen(), power.onBattery(), sensorFault);
  if (state != prev) Serial.printf("[state] %s -> %s\n", stateName(prev), stateName(state));

  // A small battery cannot run the compressor. The forced OFF also restarts the 60 s min-off timer, so a
  // flapping power button cannot short-cycle it.
  if (comp.update(temp, sensorFault, power.onBattery(), now)) {
    driveCompressor(comp.on());
    event(comp.on() ? "COMP_ON" : "COMP_OFF");
  }
}

}  // namespace

void setup() {
  Serial.setTxBufferSize(1024);  // a multi-line "status" reply must not block the loop at 115200 baud
  Serial.begin(115200);
  pinMode(pins::PIN_RELAY, OUTPUT);
  pinMode(pins::PIN_LED_BLUE, OUTPUT);
  driveCompressor(false);  // defined relay state before anything else runs
  comp.bootLock(millis());  // a reboot counts as an OFF: the 60 s min-off holds after a reset mid-cycle
  buzzer::begin();

  Serial.printf("\nColdChain node %s fw 1.0.0 booting\n", FRIDGE_ID);
  const char* reset = resetReasonName();
  Serial.printf("[boot] reset reason %s\n", reset);
  model = ThermalModel(esp_random());
  inputs::begin();
  leds::begin();
  heat.begin();  // a latched node comes back latched after any reboot or power cut
  leds::setLatch(heat.latched());
  Serial.printf("[heat] exp_s %lu, latch %s\n", static_cast<unsigned long>(heat.expS()), heat.latched() ? "ON" : "off");
  sensors::begin();
  if (!display::begin(FRIDGE_ID)) Serial.printf("[oled] SSD1306 not found at 0x%02X\n", OLED_I2C_ADDR);
  uplink::onCommand(runDeviceCommand);
  uplink::begin(FRIDGE_ID, reset);  // BOOT is sent (or buffered) once the clock is valid
  printHelp();

  lastStepAt = millis();
  lastHeatAt = lastStepAt;
  sample(lastStepAt);
  lastSampleAt = lastStepAt;
  lastDoor = doorOpen();

  // Task watchdog on the control loop, armed last so setup()'s one-off work does not count. The core resets
  // it after every loop() pass. If the loop hangs (stuck I2C, a library bug) the chip reboots with the relay
  // OFF instead of leaving the compressor in its last state. The network task is not watched: a TLS handshake
  // may block it for a long time, and a reboot would drop the RAM buffer; the control loop never waits on it.
  esp_task_wdt_init(cfg::WDT_TIMEOUT_S, true);  // reconfigures the core's TWDT: timeout, panic -> reset
  enableLoopWDT();
  Serial.printf("[wdt] task watchdog on the control loop: %lu s\n", static_cast<unsigned long>(cfg::WDT_TIMEOUT_S));
}

void loop() {
  const uint32_t now = millis();
  loopStartAt = now;
  const float dt = (now - lastStepAt) / 1000.0f;

  const InputEvents ev = inputs::poll(now);
  if (ev.doorChanged) doorOverride = -1;
  if (ev.modeChanged) Serial.printf("[mode] %s\n", inputs::manualMode() ? "MANUAL (DS18B20)" : "MODEL");
#if POWER_SENSE_IS_LEVEL
  batteryRequested = inputs::powerPinLow();  // real hardware: mains-sense divider on GPIO32
#else
  if (ev.powerPressed) batteryRequested = !batteryRequested;
#endif
  if (ev.wifiPressed) {
    wifiOutage = !wifiOutage;
    Serial.printf("[wifi] simulated outage %s\n", wifiOutage ? "ON" : "OFF");
    applyOutage();
  }
  pollConsole();
  updatePower(dt);

  // The model always runs, even when the node is DEAD: the fridge keeps warming without the compressor.
  model.step(dt, doorOpen(), comp.on());
  lastStepAt = now;

  if (power.dead()) {
    // Unpowered node: nothing measured, shown or sent. Keep forcing the compressor off so the 60 s min-off
    // counts from the moment power returns.
    if (now - lastSampleAt >= SAMPLE_MS) {
      lastSampleAt = now;
      comp.update(temp, false, true, now);
    }
    lastDoor = doorOpen();
    return;
  }

  sensors::update(now);
  const bool door = doorOpen();
  const bool doorChanged = door != lastDoor;
  if (now - lastSampleAt >= SAMPLE_MS || doorChanged || ev.modeChanged || ev.powerPressed) {
    lastSampleAt = now;
    sample(now);
  }

  // Door change: event plus immediate telemetry (reason "door"); otherwise telemetry every TELEMETRY_PERIOD_S.
  if (doorChanged) {
    lastDoor = door;
    event(door ? "DOOR_OPEN" : "DOOR_CLOSE");
    uplink::telemetry(reading(true));
    lastTelemetryAt = now;
  } else if (now - lastTelemetryAt >= cc::TELEMETRY_PERIOD_S * 1000u) {
    uplink::telemetry(reading(false));
    lastTelemetryAt = now;
  }
  if (doorAlarm.update(door, now)) event("DOOR_ALARM");  // once per episode; the server sends the alert (P12)
  buzzer::setAlarm(doorAlarm.active());                  // 200 ms on / off until the door closes
  uplink::poll(now);

  leds::update(state, now);
  buzzer::update(now);
  const net::Status st = net::status();
  display::update({state, temp, sensorFault, door, comp.on(), power.onBattery(), power.pct(), inputs::manualMode(),
                   st.wifi, st.mqtt, uplink::lastSeq(), uplink::footerNote(), heat.latched(), heat.atRisk(),
                   static_cast<uint8_t>(heat.remainingPct()), doorAlarm.active()},
                  now);

  if (now - lastLineAt >= cfg::STATUS_LINE_MS) {
    lastLineAt = now;
    printLine();
    loopMaxMs = 0;
  }
  const uint32_t took = millis() - loopStartAt;
  if (took > loopMaxMs) loopMaxMs = took;
}
