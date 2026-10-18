// Simulated fridge physics for model mode (mode switch OFF):
//   dT/dt = k_leak*(T_amb - T) + (door_open ? k_door*(T_amb - T) : 0) - (comp_on ? cool_rate*efficiency : 0)
// integrated over real elapsed time times a speed multiplier. Pure C++, so the native tests run a simulated hour.
#pragma once
#include <stdint.h>

class ThermalModel {
 public:
  explicit ThermalModel(uint32_t seed = 0x12345678u);

  // Advance by real_dt_s seconds of wall-clock time (simulated time = real_dt_s * speed).
  void step(float real_dt_s, bool door_open, bool comp_on);

  // Model temperature plus Gaussian measurement noise (sigma 0.03 C). The state itself stays noise-free,
  // so noise never accumulates into a random walk.
  float read();
  float trueTemp() const { return temp_; }

  void setTemp(float t) { temp_ = t; }
  // Compressor weakness for the P17 health demo: cool_rate is multiplied by this (1.0 = healthy, 0 = dead).
  void setEfficiency(float e) { efficiency_ = e < 0 ? 0 : e; }
  float efficiency() const { return efficiency_; }
  void setSpeed(float s) { speed_ = s < 0 ? 0 : s; }
  float speed() const { return speed_; }

 private:
  float gaussian();

  float temp_;
  float efficiency_ = 1.0f;
  float speed_;
  uint32_t rng_;
};
