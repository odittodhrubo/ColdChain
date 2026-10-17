// Non-blocking buzzer: one-shot beeps and a repeating alarm pattern, driven from loop() by update().
#pragma once
#include <stdint.h>

namespace buzzer {
void begin();
void beep(uint32_t ms);    // one beep (LATCH_SET long beep, BUZZER_TEST); restarts if already beeping
void setAlarm(bool on);    // 200 ms on / 200 ms off until cleared (door alarm, P05)
void update(uint32_t now_ms);
}  // namespace buzzer
