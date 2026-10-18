// Status LEDs: green = SAFE, yellow = WARNING, red blinking 1 Hz = BREACH, red solid = DISCARD latch.
// Exactly one of green / yellow / red is lit; the latch overrides the state (P04 sets it).
// The blue compressor LED is driven together with the relay in main.cpp so it always mirrors it.
#pragma once
#include <stdint.h>

#include "node_config.h"
#include "status.h"

struct LedPattern {
  bool green, yellow, red;
};

inline LedPattern ledPattern(FridgeState s, bool latch, uint32_t now_ms) {
  if (latch) return {false, false, true};
  const bool blinkOn = (now_ms / cfg::RED_BLINK_HALF_MS) % 2 == 0;
  return {s == FridgeState::SAFE, s == FridgeState::WARNING, s == FridgeState::BREACH && blinkOn};
}

namespace leds {
void begin();
void update(FridgeState s, uint32_t now_ms);
void setLatch(bool on);
bool latch();
}  // namespace leds
