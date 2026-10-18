// Firmware tuning (the "config" module). Committed, unlike config.h, which holds per-board secrets and overrides.
// Contract thresholds (2-8 C, hysteresis 7/3, 60 s min-off ...) live in constants.h, generated from
// contracts/constants.json; only firmware-local parameters belong here.
#pragma once
#include <stdint.h>

// Demo builds may pass -DTHERMAL_SPEED_DEFAULT=4 (3-6 is a good range) to make the compressor cycle faster.
#ifndef THERMAL_SPEED_DEFAULT
#define THERMAL_SPEED_DEFAULT 1.0f
#endif

// SSD1306 I2C clock while drawing. 800 kHz keeps a full-frame transfer near 12 ms (400 kHz takes ~23 ms and
// breaks the 20 ms loop budget). Set 400000 in config.h for modules that misbehave above spec.
#ifndef OLED_I2C_HZ
#define OLED_I2C_HZ 800000UL
#endif

namespace cfg {

// ---- thermal model (P02 section 2): dT/dt = k_leak(Tamb-T) + door*k_door(Tamb-T) - comp*cool_rate*efficiency
constexpr float T_AMBIENT_C = 30.0f;
constexpr float K_LEAK_PER_S = 0.0004f;
constexpr float K_DOOR_PER_S = 0.004f;
constexpr float COOL_RATE_C_PER_S = 0.02f;
constexpr float NOISE_SIGMA_C = 0.03f;
constexpr float T_INITIAL_C = 5.0f;
constexpr float THERMAL_SPEED = THERMAL_SPEED_DEFAULT;
constexpr float MAX_STEP_S = 1.0f;  // simulated seconds per Euler sub-step, keeps high speeds stable

// ---- sensor-fault fail-safe compressor duty (documented in docs/firmware.md)
constexpr uint32_t FAULT_DUTY_ON_S = 5 * 60;
constexpr uint32_t FAULT_DUTY_OFF_S = 10 * 60;

// ---- DS18B20 (manual mode)
constexpr uint32_t DS_CONVERSION_MS = 800;  // 12-bit conversion takes up to 750 ms
constexpr uint32_t DS_STALE_MS = 5000;      // no valid reading for this long = sensor fault

// ---- inputs, UI, console
constexpr uint32_t DEBOUNCE_MS = 30;
constexpr uint32_t OLED_REFRESH_MS = 500;  // 2 Hz, plus an immediate redraw when a discrete field changes
constexpr uint32_t RED_BLINK_HALF_MS = 500;  // 1 Hz blink on BREACH
constexpr uint32_t STATUS_LINE_MS = 5000;

}  // namespace cfg
