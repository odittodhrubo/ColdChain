#include "heat.h"

#include <math.h>

#include "constants.h"

namespace {
constexpr const char* KEY_EXP = "exp_s";
constexpr const char* KEY_LATCH = "latch";
}  // namespace

uint8_t exposureWeight(float temp) {
  if (temp > cc::DOUBLE_ABOVE_C) return 2;
  if (temp > cc::SAFE_MAX_C) return 1;
  return 0;
}

void HeatKeeper::begin() {
  weighted_ = kv_.getU32(KEY_EXP, 0);
  latched_ = kv_.getU32(KEY_LATCH, 0) != 0;
  savedExp_ = expS();
}

void HeatKeeper::save(uint32_t now_ms) {
  savedAt_ = now_ms;
  if (expS() == savedExp_) return;
  savedExp_ = expS();
  kv_.putU32(KEY_EXP, savedExp_);
}

bool HeatKeeper::update(float temp, bool sensor_fault, float dt_s, uint32_t now_ms) {
  const uint8_t w = (sensor_fault || isnan(temp)) ? 1 : exposureWeight(temp);
  if (dt_s > 0) weighted_ += w * static_cast<double>(dt_s);

  const bool accruing = w > 0;
  const bool edge = accruing != accruing_;  // an excursion started or ended: save at once
  accruing_ = accruing;
  if (edge || now_ms - savedAt_ >= SAVE_EVERY_MS) save(now_ms);

  if (!latched_ && expS() >= cc::BUDGET_S) {
    latched_ = true;
    kv_.putU32(KEY_LATCH, 1);
    save(now_ms);
    return true;
  }
  return false;
}

bool HeatKeeper::setLatch() {
  if (latched_) return false;
  latched_ = true;
  kv_.putU32(KEY_LATCH, 1);
  return true;
}

bool HeatKeeper::resetLatch() {
  const bool was = latched_;
  latched_ = false;
  weighted_ = 0;
  savedExp_ = 0;
  kv_.putU32(KEY_LATCH, 0);
  kv_.putU32(KEY_EXP, 0);
  return was;
}

float HeatKeeper::remainingPct() const {
  const double pct = 100.0 * (1.0 - weighted_ / cc::BUDGET_S);
  return pct > 0 ? static_cast<float>(pct) : 0.0f;
}

bool HeatKeeper::atRisk() const { return !latched_ && remainingPct() < cc::AT_RISK_PCT; }
