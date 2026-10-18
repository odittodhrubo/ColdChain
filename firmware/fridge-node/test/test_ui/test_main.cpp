// LED pattern selection and input debouncing.
#include <unity.h>

#include "inputs.h"
#include "leds.h"

void setUp() {}
void tearDown() {}

void assertPattern(LedPattern p, bool g, bool y, bool r) {
  TEST_ASSERT_EQUAL(g, p.green);
  TEST_ASSERT_EQUAL(y, p.yellow);
  TEST_ASSERT_EQUAL(r, p.red);
}

void test_one_led_per_state() {
  assertPattern(ledPattern(FridgeState::SAFE, false, 0), true, false, false);
  assertPattern(ledPattern(FridgeState::WARNING, false, 0), false, true, false);
}

void test_breach_blinks_at_1hz() {
  assertPattern(ledPattern(FridgeState::BREACH, false, 0), false, false, true);
  assertPattern(ledPattern(FridgeState::BREACH, false, 499), false, false, true);
  assertPattern(ledPattern(FridgeState::BREACH, false, 500), false, false, false);
  assertPattern(ledPattern(FridgeState::BREACH, false, 1000), false, false, true);
}

void test_latch_is_solid_red_and_overrides_state() {
  const uint32_t times[] = {0, 500, 750};
  for (uint32_t t : times) {
    assertPattern(ledPattern(FridgeState::BREACH, true, t), false, false, true);
    assertPattern(ledPattern(FridgeState::SAFE, true, t), false, false, true);
  }
}

void test_debounce_ignores_bounce() {
  Debouncer d;
  d.reset(false);
  TEST_ASSERT_FALSE(d.update(true, 100));
  TEST_ASSERT_FALSE(d.update(false, 102));  // bounce
  TEST_ASSERT_FALSE(d.update(true, 104));
  TEST_ASSERT_FALSE(d.update(true, 104 + cfg::DEBOUNCE_MS - 1));
  TEST_ASSERT_TRUE(d.update(true, 104 + cfg::DEBOUNCE_MS));
  TEST_ASSERT_TRUE(d.level());
  TEST_ASSERT_FALSE(d.update(true, 1000));  // reported once
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_one_led_per_state);
  RUN_TEST(test_breach_blinks_at_1hz);
  RUN_TEST(test_latch_is_solid_red_and_overrides_state);
  RUN_TEST(test_debounce_ignores_bounce);
  return UNITY_END();
}
