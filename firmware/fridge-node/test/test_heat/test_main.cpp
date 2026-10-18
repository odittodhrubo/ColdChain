// Fridge-level exposure budget and DISCARD latch, with a fake NVS.
#include <math.h>
#include <stdio.h>
#include <unity.h>

#include "constants.h"
#include "heat.h"
#include "kv.h"
#include "test_vectors.h"

void setUp() {}
void tearDown() {}

// Feeds a sample as main.cpp does: 1 s steps of real time.
void feed(HeatKeeper& h, float temp, float seconds, uint32_t& now_ms, bool fault = false) {
  for (float t = 0; t < seconds; t += 1.0f) {
    now_ms += 1000;
    h.update(temp, fault, 1.0f, now_ms);
  }
}

void test_shared_exposure_vectors() {
  TEST_ASSERT_EQUAL(8, vectors::EXPOSURE_COUNT);
  for (const auto& v : vectors::EXPOSURE) {
    MemKv kv;
    HeatKeeper h(kv);
    h.begin();
    uint32_t now = 0;
    for (size_t i = 0; i < v.count; i++) feed(h, v.samples[i].temp, v.samples[i].dt_s, now);
    TEST_ASSERT_EQUAL_UINT32_MESSAGE(static_cast<uint32_t>(v.expected_weighted_s), h.expS(), v.name);
    TEST_ASSERT_FLOAT_WITHIN_MESSAGE(0.001f, v.expected_remaining_pct, h.remainingPct(), v.name);
  }
}

void test_checklist_rates() {
  MemKv kv;
  HeatKeeper h(kv);
  h.begin();
  uint32_t now = 0;
  feed(h, 9.0f, 60, now);
  TEST_ASSERT_EQUAL_UINT32(60, h.expS());  // 60 s at 9 C
  feed(h, 13.0f, 60, now);
  TEST_ASSERT_EQUAL_UINT32(180, h.expS());  // + 120 for 60 s at 13 C
  feed(h, 13.0f, 30, now);
  TEST_ASSERT_EQUAL_UINT32(240, h.expS());  // 30 s above 12 C = 60 weighted s
}

void test_weights_and_fault_is_conservative() {
  TEST_ASSERT_EQUAL(0, exposureWeight(8.0f));
  TEST_ASSERT_EQUAL(1, exposureWeight(8.01f));
  TEST_ASSERT_EQUAL(1, exposureWeight(12.0f));
  TEST_ASSERT_EQUAL(2, exposureWeight(12.01f));
  MemKv kv;
  HeatKeeper h(kv);
  h.begin();
  uint32_t now = 0;
  feed(h, NAN, 10, now, true);
  TEST_ASSERT_EQUAL_UINT32(10, h.expS());
}

void test_at_risk_then_latch_once() {
  MemKv kv;
  HeatKeeper h(kv);
  h.begin();
  uint32_t now = 0;
  feed(h, 13.0f, 1440, now);  // 2880 weighted = 20 % remaining: not yet at risk
  TEST_ASSERT_FALSE(h.atRisk());
  feed(h, 13.0f, 1, now);
  TEST_ASSERT_TRUE(h.atRisk());
  int sets = 0;
  for (int s = 0; s < 400; s++) {
    now += 1000;
    if (h.update(13.0f, false, 1.0f, now)) sets++;
  }
  TEST_ASSERT_EQUAL(1, sets);  // LATCH_SET fires exactly once
  TEST_ASSERT_TRUE(h.latched());
  TEST_ASSERT_FALSE(h.atRisk());  // DISCARD, not AT RISK
  TEST_ASSERT_EQUAL_FLOAT(0.0f, h.remainingPct());
}

void test_latch_and_exposure_survive_reboot() {
  MemKv kv;
  uint32_t now = 0;
  {
    HeatKeeper h(kv);
    h.begin();
    feed(h, 13.0f, 1800, now);
    TEST_ASSERT_TRUE(h.latched());
  }
  HeatKeeper after(kv);  // power cut + reboot
  after.begin();
  TEST_ASSERT_TRUE(after.latched());
  TEST_ASSERT_TRUE(after.expS() >= cc::BUDGET_S);
}

void test_exposure_lost_on_crash_is_at_most_30s_worth() {
  MemKv kv;
  uint32_t now = 0;
  HeatKeeper h(kv);
  h.begin();
  feed(h, 9.0f, 125, now);  // 125 weighted s, last periodic save at <= 30 s ago
  HeatKeeper after(kv);
  after.begin();
  TEST_ASSERT_TRUE(after.expS() <= 125);
  TEST_ASSERT_TRUE(after.expS() >= 125 - 30);
}

void test_nvs_writes_are_throttled() {
  MemKv kv;
  uint32_t now = 0;
  HeatKeeper h(kv);
  h.begin();
  feed(h, 9.0f, 600, now);  // 10 minutes of steady accrual
  TEST_ASSERT_TRUE(kv.writes <= 600 / 30 + 2);
}

void test_reset_clears_latch_and_exposure() {
  MemKv kv;
  uint32_t now = 0;
  HeatKeeper h(kv);
  h.begin();
  feed(h, 13.0f, 1800, now);
  TEST_ASSERT_TRUE(h.resetLatch());
  TEST_ASSERT_FALSE(h.latched());
  TEST_ASSERT_EQUAL_UINT32(0, h.expS());
  HeatKeeper after(kv);
  after.begin();
  TEST_ASSERT_FALSE(after.latched());
  TEST_ASSERT_EQUAL_UINT32(0, after.expS());
}

void test_set_latch_command_persists() {
  MemKv kv;
  HeatKeeper h(kv);
  h.begin();
  TEST_ASSERT_TRUE(h.setLatch());
  TEST_ASSERT_FALSE(h.setLatch());  // already latched
  HeatKeeper after(kv);
  after.begin();
  TEST_ASSERT_TRUE(after.latched());
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_shared_exposure_vectors);
  RUN_TEST(test_checklist_rates);
  RUN_TEST(test_weights_and_fault_is_conservative);
  RUN_TEST(test_at_risk_then_latch_once);
  RUN_TEST(test_latch_and_exposure_survive_reboot);
  RUN_TEST(test_exposure_lost_on_crash_is_at_most_30s_worth);
  RUN_TEST(test_nvs_writes_are_throttled);
  RUN_TEST(test_reset_clears_latch_and_exposure);
  RUN_TEST(test_set_latch_command_persists);
  return UNITY_END();
}
