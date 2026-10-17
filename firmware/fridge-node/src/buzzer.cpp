#include "buzzer.h"

#include <Arduino.h>

#include "pins.h"

namespace {
constexpr uint32_t TONE_HZ = 2000;
constexpr uint32_t ALARM_HALF_MS = 200;

bool sounding = false;
bool alarmActive = false;
uint32_t beepStart = 0, beepMs = 0;

void sound(bool on) {
  if (on == sounding) return;  // touch the pin only on a change
  sounding = on;
#if BUZZER_IS_ACTIVE
  digitalWrite(pins::PIN_BUZZER, on ? HIGH : LOW);
#else
  if (on) {
    tone(pins::PIN_BUZZER, TONE_HZ);
  } else {
    noTone(pins::PIN_BUZZER);
  }
#endif
}
}  // namespace

namespace buzzer {

void begin() {
  pinMode(pins::PIN_BUZZER, OUTPUT);
  digitalWrite(pins::PIN_BUZZER, LOW);
}

void beep(uint32_t ms) {
  beepStart = millis();
  beepMs = ms;
}

void setAlarm(bool on) { alarmActive = on; }

void silence() {
  beepMs = 0;
  alarmActive = false;
  sound(false);
}

void update(uint32_t now_ms) {
  const bool beeping = beepMs && now_ms - beepStart < beepMs;
  if (!beeping) beepMs = 0;
  const bool alarmOn = alarmActive && (now_ms / ALARM_HALF_MS) % 2 == 0;
  sound(beeping || alarmOn);
}

}  // namespace buzzer
