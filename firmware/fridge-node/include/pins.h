// Pin map and board polarity (contract: docs/CONTRACTS.md §9, docs/hardware.md).
// tools/gen_wokwi.py reads the PIN_ constants below to wire the Wokwi diagrams, so edit pins only here.
// Real hardware uses the same pins; polarity differences go in config.h (see config.example.h), never in code.
#pragma once
#include <stdint.h>

#include "settings.h"

namespace pins {
constexpr uint8_t PIN_DS18B20 = 4;     // 1-Wire data, 4.7k pull-up to 3V3
constexpr uint8_t PIN_DOOR = 15;       // slide switch / reed switch to GND, INPUT_PULLUP
constexpr uint8_t PIN_RELAY = 16;      // compressor relay IN
constexpr uint8_t PIN_LED_GREEN = 25;  // SAFE
constexpr uint8_t PIN_LED_YELLOW = 26; // WARNING
constexpr uint8_t PIN_LED_RED = 27;    // BREACH blink / DISCARD latch solid
constexpr uint8_t PIN_LED_BLUE = 19;   // mirrors compressor relay
constexpr uint8_t PIN_BUZZER = 18;
constexpr uint8_t PIN_BTN_POWER = 32;  // power-fail button to GND, INPUT_PULLUP
constexpr uint8_t PIN_BTN_WIFI = 33;   // Wi-Fi outage button to GND, INPUT_PULLUP
constexpr uint8_t PIN_MODE = 23;       // mode slide switch to GND, INPUT_PULLUP
constexpr uint8_t PIN_I2C_SDA = 21;    // SSD1306 OLED
constexpr uint8_t PIN_I2C_SCL = 22;
}  // namespace pins

// ---- polarity / board options (override in config.h) ----

// 1 = relay energises on HIGH (Wokwi relay module, most optocoupler boards with jumper on H). 0 = active-LOW boards.
#ifndef RELAY_ACTIVE_HIGH
#define RELAY_ACTIVE_HIGH 1
#endif

// Door input level that means OPEN. Slide switch or reed switch to GND with INPUT_PULLUP: closed = LOW, open = HIGH.
#ifndef DOOR_OPEN_LEVEL
#define DOOR_OPEN_LEVEL 1
#endif

// Mode input level that means MANUAL (DS18B20). Switch to GND = LOW = thermal model (default).
#ifndef MODE_MANUAL_LEVEL
#define MODE_MANUAL_LEVEL 1
#endif

// 0 = passive piezo driven with tone() (Wokwi buzzer). 1 = active buzzer module driven with a plain HIGH.
#ifndef BUZZER_IS_ACTIVE
#define BUZZER_IS_ACTIVE 0
#endif

#ifndef OLED_I2C_ADDR
#define OLED_I2C_ADDR 0x3C
#endif
