// Copy to config.h (git-ignored) and edit. config.h is optional for the simulator:
// without it the defaults in pins.h match the Wokwi circuit.
// Network, broker and secret settings are added here in P03.
#pragma once

// ---- real-hardware switches: same pins, only these values change ----

// #define RELAY_ACTIVE_HIGH 0      // most blue 5 V relay boards switch on LOW
// #define DOOR_OPEN_LEVEL 1        // reed switch to GND: magnet present (door closed) = LOW
// #define MODE_MANUAL_LEVEL 0      // tie GPIO23 to GND and set 0 to always use the DS18B20 probe
// #define BUZZER_IS_ACTIVE 1       // active buzzer module instead of a passive piezo
// #define OLED_I2C_ADDR 0x3D       // some 128x64 modules ship at 0x3D
// #define OLED_I2C_HZ 400000UL     // default 800 kHz; drop to spec if the screen shows garbage

// Power-fail input. 0 = simulator push button that toggles MAINS/BATTERY (Wokwi).
// 1 = real mains-sense level on GPIO32 (HIGH = mains present), e.g. a 10k/20k divider from the 5 V adapter rail.
// Honoured by the firmware from P05.
// #define POWER_SENSE_IS_LEVEL 1
