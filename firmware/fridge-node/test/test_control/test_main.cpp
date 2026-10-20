// Compressor hysteresis and the 60 s minimum off-time, driven by a fake millisecond clock.
#include <math.h>
#include <unity.h>

#include "constants.h"
#include "control.h"

void setUp() {}
void tearDown() {}

constexpr uint32_t MIN_OFF_MS = cc::COMP_MIN_OFF_S * 1000u;

void test_hysteresis_thresholds() {
  CompressorControl c;
  TEST_ASSERT_FALSE(c.update(6.99f, false, false, 0));
  TEST_ASSERT_FALSE(c.on());
  TEST_ASSERT_TRUE(c.update(7.0f, false, false, 1000));  // ON at exactly 7.0
  TEST_ASSERT_TRUE(c.on());
  TEST_ASSERT_FALSE(c.update(5.0f, false, false, 2000));  // stays ON inside the band
  TEST_ASSERT_FALSE(c.update(3.01f, false, false, 3000));
  TEST_ASSERT_TRUE(c.on());
  TEST_ASSERT_TRUE(c.update(3.0f, false, false, 4000));  // OFF at exactly 3.0
  TEST_ASSERT_FALSE(c.on());
  TEST_ASSERT_FALSE(c.update(6.99f, false, false, 4000 + MIN_OFF_MS));  // stays OFF inside the band
}

void test_boot_counts_min_off_as_satisfied() {
  CompressorControl c;
  TEST_ASSERT_TRUE(c.update(7.5f, false, false, 0));
  TEST_ASSERT_TRUE(c.on());
}

void test_boot_lock_holds_the_min_off_after_a_reboot() {
  CompressorControl c;
  const uint32_t boot = 1200;  // millis() when setup() ends
  c.bootLock(boot);
  for (uint32_t t = boot; t < boot + MIN_OFF_MS; t += 500) {  // hot from the start, still must wait
    TEST_ASSERT_FALSE_MESSAGE(c.update(9.0f, false, false, t), "started inside the boot lock");
    TEST_ASSERT_TRUE(c.waitingMinOff(t));
  }
  TEST_ASSERT_TRUE(c.update(9.0f, false, false, boot + MIN_OFF_MS));
}

void test_boot_lock_never_rearms_after_millis_rollover() {
  CompressorControl c;
  c.bootLock(0);
  TEST_ASSERT_TRUE(c.update(7.5f, false, false, MIN_OFF_MS));  // served: ON
  TEST_ASSERT_TRUE(c.update(2.0f, false, false, MIN_OFF_MS + 1000));
  // ~49.7 days later millis() has wrapped and now - boot_at is small again: only the normal min-off applies
  const uint32_t wrapped = 10000;
  TEST_ASSERT_TRUE(c.update(9.0f, false, false, MIN_OFF_MS + 1000 + MIN_OFF_MS));
  TEST_ASSERT_TRUE(c.update(2.0f, false, false, 0xFFFFFFFFu - MIN_OFF_MS));
  TEST_ASSERT_TRUE(c.update(9.0f, false, false, wrapped));  // 60 s after that OFF, across the wrap
}

void test_boot_lock_delays_the_sensor_fault_duty_by_60s_only() {
  CompressorControl c;
  c.bootLock(0);
  TEST_ASSERT_FALSE(c.update(NAN, true, false, MIN_OFF_MS - 1));
  TEST_ASSERT_TRUE(c.update(NAN, true, false, MIN_OFF_MS));  // never ran: duty starts ON, not after 10 min
}

void test_never_restarts_within_60s_of_off() {
  CompressorControl c;
  c.update(7.0f, false, false, 0);
  const uint32_t offAt = 500000;
  c.update(3.0f, false, false, offAt);
  TEST_ASSERT_FALSE(c.on());
  for (uint32_t t = offAt; t < offAt + MIN_OFF_MS; t += 250) {  // hot the whole time, still must wait
    c.update(9.0f, false, false, t);
    TEST_ASSERT_FALSE_MESSAGE(c.on(), "restarted inside the min-off window");
  }
  TEST_ASSERT_TRUE(c.waitingMinOff(offAt + MIN_OFF_MS - 1));
  TEST_ASSERT_TRUE(c.update(9.0f, false, false, offAt + MIN_OFF_MS));
}

void test_min_off_survives_millis_rollover() {
  CompressorControl c;
  c.update(7.0f, false, false, 0xFFFFFFFFu - 20000);
  const uint32_t offAt = 0xFFFFFFFFu - 9999;  // OFF 10 s before millis() wraps
  c.update(3.0f, false, false, offAt);
  const uint32_t due = offAt + MIN_OFF_MS;  // wraps to 50000
  TEST_ASSERT_EQUAL_UINT32(50000, due);
  TEST_ASSERT_FALSE(c.update(9.0f, false, false, 0));
  TEST_ASSERT_FALSE(c.update(9.0f, false, false, due - 1));
  TEST_ASSERT_TRUE(c.update(9.0f, false, false, due));
}

void test_forced_off_starts_min_off_timer() {
  CompressorControl c;
  c.update(7.0f, false, false, 0);
  TEST_ASSERT_TRUE(c.update(7.0f, false, true, 10000));  // power fail while running
  TEST_ASSERT_FALSE(c.on());
  // Held off for 5 minutes; the 60 s counts from when the force ends, so a flapping supply cannot short-cycle.
  TEST_ASSERT_FALSE(c.update(9.0f, false, true, 310000));
  TEST_ASSERT_FALSE(c.update(9.0f, false, false, 310000 + MIN_OFF_MS - 1));
  TEST_ASSERT_TRUE(c.update(9.0f, false, false, 310000 + MIN_OFF_MS));
}

void test_sensor_fault_duty_cycle() {
  CompressorControl c;
  TEST_ASSERT_TRUE(c.update(NAN, true, false, 0));  // unknown temperature: start cautious cooling
  TEST_ASSERT_FALSE(c.update(NAN, true, false, 5 * 60000 - 1));
  TEST_ASSERT_TRUE(c.update(NAN, true, false, 5 * 60000));  // 5 min ON -> OFF
  TEST_ASSERT_FALSE(c.on());
  TEST_ASSERT_FALSE(c.update(NAN, true, false, 15 * 60000 - 1));
  TEST_ASSERT_TRUE(c.update(NAN, true, false, 15 * 60000));  // 10 min OFF -> ON
  TEST_ASSERT_TRUE(c.on());
  TEST_ASSERT_TRUE(c.update(NAN, true, true, 15 * 60000 + 1));  // force-off still wins during a fault
}

void test_fault_cleared_returns_to_hysteresis() {
  CompressorControl c;
  c.update(NAN, true, false, 0);
  TEST_ASSERT_TRUE(c.on());
  TEST_ASSERT_TRUE(c.update(2.9f, false, false, 1000));
  TEST_ASSERT_FALSE(c.on());
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_hysteresis_thresholds);
  RUN_TEST(test_boot_counts_min_off_as_satisfied);
  RUN_TEST(test_boot_lock_holds_the_min_off_after_a_reboot);
  RUN_TEST(test_boot_lock_never_rearms_after_millis_rollover);
  RUN_TEST(test_boot_lock_delays_the_sensor_fault_duty_by_60s_only);
  RUN_TEST(test_never_restarts_within_60s_of_off);
  RUN_TEST(test_min_off_survives_millis_rollover);
  RUN_TEST(test_forced_off_starts_min_off_timer);
  RUN_TEST(test_sensor_fault_duty_cycle);
  RUN_TEST(test_fault_cleared_returns_to_hysteresis);
  return UNITY_END();
}
