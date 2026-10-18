#include "inputs.h"

#include <Arduino.h>

#include "pins.h"

namespace {
Debouncer door, mode, powerBtn, wifiBtn;

// Buttons are wired to GND with INPUT_PULLUP: pressed = LOW. Returns true on a debounced press.
bool pressed(Debouncer& d, uint8_t pin, uint32_t now_ms) {
  return d.update(digitalRead(pin) == LOW, now_ms) && d.level();
}
}  // namespace

namespace inputs {

void begin() {
  for (uint8_t pin : {pins::PIN_DOOR, pins::PIN_MODE, pins::PIN_BTN_POWER, pins::PIN_BTN_WIFI}) pinMode(pin, INPUT_PULLUP);
  door.reset(digitalRead(pins::PIN_DOOR) == DOOR_OPEN_LEVEL);
  mode.reset(digitalRead(pins::PIN_MODE) == MODE_MANUAL_LEVEL);
  powerBtn.reset(digitalRead(pins::PIN_BTN_POWER) == LOW);
  wifiBtn.reset(digitalRead(pins::PIN_BTN_WIFI) == LOW);
}

InputEvents poll(uint32_t now_ms) {
  InputEvents ev;
  ev.doorChanged = door.update(digitalRead(pins::PIN_DOOR) == DOOR_OPEN_LEVEL, now_ms);
  ev.modeChanged = mode.update(digitalRead(pins::PIN_MODE) == MODE_MANUAL_LEVEL, now_ms);
  ev.powerPressed = pressed(powerBtn, pins::PIN_BTN_POWER, now_ms);
  ev.wifiPressed = pressed(wifiBtn, pins::PIN_BTN_WIFI, now_ms);
  return ev;
}

bool doorOpen() { return door.level(); }
bool manualMode() { return mode.level(); }

}  // namespace inputs
