#include "leds.h"

#include <Arduino.h>

#include "pins.h"

namespace {
bool latched = false;
}

namespace leds {

void begin() {
  for (uint8_t pin : {pins::PIN_LED_GREEN, pins::PIN_LED_YELLOW, pins::PIN_LED_RED}) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
  }
}

void update(FridgeState s, uint32_t now_ms) {
  const LedPattern p = ledPattern(s, latched, now_ms);
  digitalWrite(pins::PIN_LED_GREEN, p.green);
  digitalWrite(pins::PIN_LED_YELLOW, p.yellow);
  digitalWrite(pins::PIN_LED_RED, p.red);
}

void setLatch(bool on) { latched = on; }
bool latch() { return latched; }

}  // namespace leds
