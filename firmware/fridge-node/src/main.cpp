// ColdChain fridge node: local control loop (P02) plus the signed MQTT uplink (P03).
// Cooperative scheduler on millis(): every task checks its own period with unsigned subtraction, nothing blocks,
// so the compressor logic keeps running whatever else happens. No delay() anywhere in loop(). Networking runs in
// its own task (net.cpp), so a slow broker or Wi-Fi loss never stalls this loop.
#include <Arduino.h>
#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "constants.h"
#include "control.h"
#include "display.h"
#include "inputs.h"
#include "leds.h"
#include "messages.h"
#include "net.h"
#include "node_config.h"
#include "pins.h"
#include "sensors.h"
#include "status.h"
#include "thermal_model.h"
#include "uplink.h"

#ifndef FRIDGE_ID
#error "FRIDGE_ID must be set via build_flags in platformio.ini"
#endif

namespace {

constexpr uint32_t SAMPLE_MS = 1000;  // temperature sampling / control decision rate

ThermalModel model;
CompressorControl comp;

int8_t doorOverride = -1;  // console "door open|close": -1 = follow the switch; cleared when the switch moves
float temp = NAN;
bool sensorFault = false;
FridgeState state = FridgeState::SAFE;

bool lastDoor = false;  // door state last reported, so a console override also produces an event
uint32_t lastStepAt = 0, lastSampleAt = 0, lastLineAt = 0, lastTelemetryAt = 0, loopStartAt = 0;
uint32_t loopMaxMs = 0;  // worst loop iteration since the last status line

bool doorOpen() { return doorOverride >= 0 ? doorOverride == 1 : inputs::doorOpen(); }

void driveCompressor(bool on) {
  digitalWrite(pins::PIN_RELAY, (on == (RELAY_ACTIVE_HIGH != 0)) ? HIGH : LOW);
  digitalWrite(pins::PIN_LED_BLUE, on ? HIGH : LOW);  // blue LED always mirrors the relay
}

void event(const char* type) { uplink::event(type); }

// seq and ts are filled in by the uplink when the reading is sent.
Reading reading(bool doorReason) {
  return {0, 0, sensorFault ? NAN : temp, doorOpen(), comp.on(), false, 100, state, 0, leds::latch(),
          inputs::manualMode(), doorReason};
}

void printLine() {
  Serial.printf("[%lus] %s %s T=%.2fC %s door=%s comp=%s%s eff=%.2f speed=x%.1f loop_max=%lums\n",
                static_cast<unsigned long>(millis() / 1000), FRIDGE_ID, inputs::manualMode() ? "MANUAL" : "MODEL",
                temp, sensorFault ? "SENSOR_FAULT" : stateName(state), doorOpen() ? "OPEN" : "CLOSED",
                comp.on() ? "ON" : "OFF", comp.waitingMinOff(millis()) ? "(min-off)" : "", model.efficiency(),
                model.speed(), static_cast<unsigned long>(loopMaxMs));
}

void printStatus() {
  Serial.printf("fridge     %s  fw 1.0.0\n", FRIDGE_ID);
  Serial.printf("mode       %s\n", inputs::manualMode() ? "MANUAL (DS18B20)" : "MODEL (thermal simulation)");
  Serial.printf("temp       %.2f C  model %.2f C  sensor %.2f C%s\n", temp, model.trueTemp(), sensors::tempC(),
                sensors::fault() ? " (fault)" : "");
  Serial.printf("state      %s  latch %s\n", stateName(state), leds::latch() ? "ON" : "off");
  Serial.printf("door       %s%s\n", doorOpen() ? "OPEN" : "CLOSED", doorOverride >= 0 ? " (console override)" : "");
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

  const FridgeState prev = state;
  state = classify(temp, doorOpen(), /*on_battery=*/false, sensorFault);  // battery arrives in P05
  if (state != prev) Serial.printf("[state] %s -> %s\n", stateName(prev), stateName(state));

  if (comp.update(temp, sensorFault, /*force_off=*/false, now)) {  // power-fail force-off arrives in P05
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
  pinMode(pins::PIN_BUZZER, OUTPUT);
  digitalWrite(pins::PIN_BUZZER, LOW);
  driveCompressor(false);  // defined relay state before anything else runs

  Serial.printf("\nColdChain node %s fw 1.0.0 booting\n", FRIDGE_ID);
  model = ThermalModel(esp_random());
  inputs::begin();
  leds::begin();
  sensors::begin();
  if (!display::begin(FRIDGE_ID)) Serial.printf("[oled] SSD1306 not found at 0x%02X\n", OLED_I2C_ADDR);
  uplink::begin(FRIDGE_ID);  // BOOT is sent once the clock is valid and the broker is reachable
  printHelp();

  lastStepAt = millis();
  sample(lastStepAt);
  lastSampleAt = lastStepAt;
  lastDoor = doorOpen();
}

void loop() {
  const uint32_t now = millis();
  loopStartAt = now;

  const InputEvents ev = inputs::poll(now);
  if (ev.doorChanged) doorOverride = -1;
  if (ev.modeChanged) Serial.printf("[mode] %s\n", inputs::manualMode() ? "MANUAL (DS18B20)" : "MODEL");
  if (ev.powerPressed) Serial.println("[input] power-fail button (MAINS/BATTERY simulation arrives in P05)");
  if (ev.wifiPressed) Serial.println("[input] Wi-Fi outage button (outage simulation arrives in P05)");
  pollConsole();

  // The model always runs, so switching back from manual mode continues from a physical temperature.
  model.step((now - lastStepAt) / 1000.0f, doorOpen(), comp.on());
  lastStepAt = now;
  sensors::update(now);

  const bool door = doorOpen();
  const bool doorChanged = door != lastDoor;
  if (now - lastSampleAt >= SAMPLE_MS || doorChanged || ev.modeChanged) {
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
  uplink::poll(now);

  leds::update(state, now);
  const net::Status st = net::status();
  display::update({state, temp, sensorFault, door, comp.on(), false, 100, inputs::manualMode(), st.wifi, st.mqtt,
                   uplink::lastSeq(), uplink::footerNote()},
                  now);

  if (now - lastLineAt >= cfg::STATUS_LINE_MS) {
    lastLineAt = now;
    printLine();
    loopMaxMs = 0;
  }
  const uint32_t took = millis() - loopStartAt;
  if (took > loopMaxMs) loopMaxMs = took;
}
