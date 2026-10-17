// classify() against the shared status vectors (contracts/test_vectors.json via include/test_vectors.h)
// plus the exact threshold boundaries.
#include <math.h>
#include <stdio.h>
#include <unity.h>

#include "status.h"
#include "test_vectors.h"

void setUp() {}
void tearDown() {}

void test_shared_status_vectors() {
  TEST_ASSERT_EQUAL(12, vectors::STATUS_COUNT);
  for (const auto& v : vectors::STATUS) {
    char msg[96];
    snprintf(msg, sizeof msg, "temp=%.2f door=%d battery=%d fault=%d", v.temp, v.door_open, v.on_battery, v.sensor_fault);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(v.expected, stateName(classify(v.temp, v.door_open, v.on_battery, v.sensor_fault)),
                                     msg);
  }
}

void test_boundaries() {
  TEST_ASSERT_EQUAL(FridgeState::BREACH, classify(1.99f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::WARNING, classify(2.0f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::WARNING, classify(2.49f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::SAFE, classify(2.5f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::SAFE, classify(3.0f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::SAFE, classify(7.0f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::SAFE, classify(7.5f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::WARNING, classify(7.51f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::WARNING, classify(8.0f, false, false, false));
  TEST_ASSERT_EQUAL(FridgeState::BREACH, classify(8.01f, false, false, false));
}

void test_precedence_and_fault() {
  TEST_ASSERT_EQUAL(FridgeState::BREACH, classify(12.0f, true, true, false));  // BREACH beats door/battery
  TEST_ASSERT_EQUAL(FridgeState::WARNING, classify(5.0f, true, true, false));
  TEST_ASSERT_EQUAL(FridgeState::BREACH, classify(5.0f, false, false, true));
  TEST_ASSERT_EQUAL(FridgeState::BREACH, classify(NAN, false, false, false));  // unknown temperature = fault
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_shared_status_vectors);
  RUN_TEST(test_boundaries);
  RUN_TEST(test_precedence_and_fault);
  return UNITY_END();
}
