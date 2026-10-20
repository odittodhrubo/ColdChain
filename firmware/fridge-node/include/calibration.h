// Per-device sensor calibration offset (P4). Real DS18B20 probes differ by about ±0.5 °C; a pharmacy calibrates
// against a reference thermometer. The offset is persisted in NVS and applied to the DS18B20 reading before the
// fridge is classified, so the whole chain (classify, heat budget, telemetry) sees the corrected temperature.
#pragma once
#include <stdint.h>

#include "kv.h"

class Calibration {
 public:
  explicit Calibration(Kv& kv) : kv_(kv) {}
  void begin();  // load the persisted offset (0 if never set)
  // Clamp to ±CALIBRATION_MAX_C, persist, and adopt it. Returns the stored (clamped) value.
  float set(float offset_c);
  float offsetC() const { return offset_; }
  float apply(float raw_c) const;  // raw + offset; a NaN (sensor fault) stays NaN
  static float clampOffset(float offset_c);

 private:
  Kv& kv_;
  float offset_ = 0.0f;
};
