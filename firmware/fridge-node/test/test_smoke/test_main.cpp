// Native smoke test: the generated constants compile and keep the ordering the control logic relies on.
#include <unity.h>

#include "constants.h"

void setUp() {}
void tearDown() {}

void test_threshold_ordering() {
  TEST_ASSERT_TRUE(cc::SAFE_MIN_C < cc::WARN_LOW_C);
  TEST_ASSERT_TRUE(cc::WARN_LOW_C < cc::COMP_OFF_AT_C);
  TEST_ASSERT_TRUE(cc::COMP_OFF_AT_C < cc::COMP_ON_AT_C);
  TEST_ASSERT_TRUE(cc::COMP_ON_AT_C < cc::WARN_HIGH_C);
  TEST_ASSERT_TRUE(cc::WARN_HIGH_C < cc::SAFE_MAX_C);
  TEST_ASSERT_TRUE(cc::SAFE_MAX_C < cc::DOUBLE_ABOVE_C);
}

void test_buffer_holds_30_minutes() {
  TEST_ASSERT_TRUE(cc::BUFFER_CAPACITY * cc::TELEMETRY_PERIOD_S >= 30u * 60u);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_threshold_ordering);
  RUN_TEST(test_buffer_holds_30_minutes);
  return UNITY_END();
}
