// Sensor calibration offset (P4): bounds, persistence through the Kv seam, and application to a reading.
#include <math.h>
#include <unity.h>

#include "calibration.h"
#include "constants.h"
#include "kv.h"

void setUp() {}
void tearDown() {}

void test_clamp_to_bounds() {
  TEST_ASSERT_FLOAT_WITHIN(0.001f, cc::CALIBRATION_MAX_C, Calibration::clampOffset(5.0f));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, -cc::CALIBRATION_MAX_C, Calibration::clampOffset(-5.0f));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 1.3f, Calibration::clampOffset(1.3f));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.0f, Calibration::clampOffset(NAN));
}

void test_set_persists_and_clamps() {
  MemKv kv;
  Calibration c(kv);
  c.begin();
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.0f, c.offsetC());  // unset: no offset
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 1.5f, c.set(1.5f));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, cc::CALIBRATION_MAX_C, c.set(10.0f));  // over the bound

  Calibration back(kv);  // a fresh instance reads what was persisted
  back.begin();
  TEST_ASSERT_FLOAT_WITHIN(0.001f, cc::CALIBRATION_MAX_C, back.offsetC());
  back.set(-0.7f);
  Calibration back2(kv);
  back2.begin();
  TEST_ASSERT_FLOAT_WITHIN(0.001f, -0.7f, back2.offsetC());
}

void test_apply_shifts_reading_and_keeps_fault() {
  MemKv kv;
  Calibration c(kv);
  c.begin();
  c.set(1.5f);
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 5.5f, c.apply(4.0f));
  TEST_ASSERT_TRUE(isnan(c.apply(NAN)));  // a sensor fault stays a fault
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_clamp_to_bounds);
  RUN_TEST(test_set_persists_and_clamps);
  RUN_TEST(test_apply_shifts_reading_and_keeps_fault);
  return UNITY_END();
}
