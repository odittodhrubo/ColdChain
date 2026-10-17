// Thermal model + compressor control run together for simulated hours, the way main.cpp runs them:
// model stepped every 100 ms of real time, noisy temperature sampled and fed to the controller every 1 s.
#include <math.h>
#include <unity.h>

#include "constants.h"
#include "control.h"
#include "node_config.h"
#include "thermal_model.h"

void setUp() {}
void tearDown() {}

struct Run {
  float minT = 1e9f, maxT = -1e9f;
  int compOnEdges = 0;
};

Run simulate(ThermalModel& m, uint32_t real_s, bool door_open = false) {
  CompressorControl c;
  Run r;
  for (uint32_t ms = 0; ms < real_s * 1000u; ms += 100) {
    m.step(0.1f, door_open, c.on());
    if (ms % 1000 == 0) {
      if (c.update(m.read(), false, false, ms) && c.on()) r.compOnEdges++;
      if (ms >= 600000) {  // ignore the first 10 min while it settles from the initial 5.0 C
        r.minT = fminf(r.minT, m.trueTemp());
        r.maxT = fmaxf(r.maxT, m.trueTemp());
      }
    }
  }
  return r;
}

void test_cycles_between_3_and_7_for_an_hour_at_speed_1() {
  ThermalModel m(42);
  const Run r = simulate(m, 3600);
  TEST_ASSERT_GREATER_OR_EQUAL(3, r.compOnEdges);  // one cycle is ~800 s at default parameters
  TEST_ASSERT_FLOAT_WITHIN(0.3f, cc::COMP_OFF_AT_C, r.minT);
  TEST_ASSERT_FLOAT_WITHIN(0.3f, cc::COMP_ON_AT_C, r.maxT);
  TEST_ASSERT_TRUE(r.minT > cc::WARN_LOW_C);   // normal operation never reaches WARNING ...
  TEST_ASSERT_TRUE(r.maxT < cc::WARN_HIGH_C);  // ... and never BREACH
}

void test_speed_multiplier_compresses_time() {
  ThermalModel m(7);
  m.setSpeed(6.0f);
  const Run r = simulate(m, 600 + 600);  // 10 min settle + 10 real min = 60 simulated min of cycling
  TEST_ASSERT_GREATER_OR_EQUAL(4, r.compOnEdges);
  TEST_ASSERT_TRUE(r.minT > cc::WARN_LOW_C);
  TEST_ASSERT_TRUE(r.maxT < cc::WARN_HIGH_C);
}

void test_rise_from_3_to_7_takes_about_400s() {
  ThermalModel m(1);
  m.setTemp(3.0f);
  int s = 0;
  while (m.trueTemp() < 7.0f && s < 2000) {
    m.step(1.0f, false, false);
    s++;
  }
  TEST_ASSERT_INT_WITHIN(60, 400, s);  // so the 60 s min-off can never push it above 8 C
}

void test_open_door_breaches_even_with_compressor() {
  ThermalModel m(3);
  for (int s = 0; s < 120; s++) m.step(1.0f, true, true);
  TEST_ASSERT_TRUE(m.trueTemp() > cc::SAFE_MAX_C);
}

void test_weak_compressor_cannot_hold_temperature() {
  ThermalModel m(5);
  m.setEfficiency(0.4f);  // P17 demo: cooling below the leak at 7 C
  const Run r = simulate(m, 3600);
  TEST_ASSERT_TRUE(r.maxT > cc::SAFE_MAX_C);
}

void test_bounded_by_ambient() {
  ThermalModel m(9);
  m.setSpeed(50.0f);
  m.setEfficiency(0.0f);
  for (int s = 0; s < 3600; s++) m.step(1.0f, true, true);
  TEST_ASSERT_TRUE(m.trueTemp() <= cfg::T_AMBIENT_C);
  TEST_ASSERT_FLOAT_WITHIN(0.5f, cfg::T_AMBIENT_C, m.trueTemp());
}

void test_noise_is_small_and_centred() {
  ThermalModel m(11);
  float sum = 0, sumSq = 0;
  const int n = 5000;
  for (int i = 0; i < n; i++) {
    const float e = m.read() - m.trueTemp();
    sum += e;
    sumSq += e * e;
  }
  TEST_ASSERT_FLOAT_WITHIN(0.005f, 0.0f, sum / n);
  TEST_ASSERT_FLOAT_WITHIN(0.005f, cfg::NOISE_SIGMA_C, sqrtf(sumSq / n));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_cycles_between_3_and_7_for_an_hour_at_speed_1);
  RUN_TEST(test_speed_multiplier_compresses_time);
  RUN_TEST(test_rise_from_3_to_7_takes_about_400s);
  RUN_TEST(test_open_door_breaches_even_with_compressor);
  RUN_TEST(test_weak_compressor_cannot_hold_temperature);
  RUN_TEST(test_bounded_by_ambient);
  RUN_TEST(test_noise_is_small_and_centred);
  return UNITY_END();
}
