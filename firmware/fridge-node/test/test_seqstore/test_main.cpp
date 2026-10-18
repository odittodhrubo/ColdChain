// Sequence numbers never repeat across reboots or crashes, and NVS is written only every 20 increments.
#include <unity.h>

#include "kv.h"
#include "seqstore.h"

void setUp() {}
void tearDown() {}

void test_monotonic_and_throttled_writes() {
  MemKv kv;
  SeqStore s(kv);
  s.begin();
  const int bootWrites = kv.writes;
  uint32_t prev = s.last();
  for (int i = 0; i < 100; i++) {
    const uint32_t n = s.next();
    TEST_ASSERT_EQUAL_UINT32(prev + 1, n);
    prev = n;
  }
  TEST_ASSERT_EQUAL(100 / SeqStore::SAVE_EVERY, kv.writes - bootWrites);
}

void test_crash_never_reuses_a_seq() {
  MemKv kv;
  uint32_t highestUsed = 0;
  for (int boot = 0; boot < 5; boot++) {
    SeqStore s(kv);  // crash = new instance, no flush
    s.begin();
    for (int i = 0; i < 7 + boot * 13; i++) {
      const uint32_t n = s.next();
      TEST_ASSERT_TRUE_MESSAGE(n > highestUsed, "seq reused after a crash");
      highestUsed = n;
    }
  }
}

void test_flush_then_reboot_continues_above() {
  MemKv kv;
  SeqStore a(kv);
  a.begin();
  for (int i = 0; i < 5; i++) a.next();
  a.flush();
  const uint32_t last = a.last();
  SeqStore b(kv);
  b.begin();
  TEST_ASSERT_TRUE(b.next() > last);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_monotonic_and_throttled_writes);
  RUN_TEST(test_crash_never_reuses_a_seq);
  RUN_TEST(test_flush_then_reboot_continues_above);
  return UNITY_END();
}
