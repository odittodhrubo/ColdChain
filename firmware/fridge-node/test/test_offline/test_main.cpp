// Offline buffer, stop-and-wait sync over a lossy link, battery model, door alarm.
#include <ArduinoJson.h>
#include <math.h>
#include <string.h>
#include <unity.h>

#include <map>
#include <set>
#include <vector>

#include "constants.h"
#include "messages.h"
#include "node_config.h"
#include "power.h"
#include "ringbuf.h"
#include "syncer.h"

void setUp() {}
void tearDown() {}

Reading sample(uint32_t seq) {
  return {seq, 1767225600 + seq * 5, 4.0f + (seq % 7) * 0.5f, seq % 3 == 0, seq % 2 == 0, false, 100,
          FridgeState::SAFE, seq, false, false, false};
}

// ---------------------------------------------------------------- ring buffer

void test_entry_is_16_bytes_and_round_trips() {
  TEST_ASSERT_EQUAL(16, sizeof(BufEntry));
  Reading r{42, 1767225600, -3.25f, true, false, true, 37, FridgeState::BREACH, 70000, true, true, true, NAN};
  const Reading back = unpackReading(packReading(r));
  TEST_ASSERT_EQUAL_UINT32(42, back.seq);
  TEST_ASSERT_EQUAL_FLOAT(-3.25f, back.temp);
  TEST_ASSERT_TRUE(back.doorOpen && back.onBattery && back.latch && back.manualMode && back.doorReason);
  TEST_ASSERT_FALSE(back.compOn);
  TEST_ASSERT_EQUAL(37, back.battPct);
  TEST_ASSERT_EQUAL(FridgeState::BREACH, back.state);
  TEST_ASSERT_EQUAL_UINT32(65535, back.expS);  // saturates
  r.temp = NAN;
  TEST_ASSERT_TRUE(isnan(unpackReading(packReading(r)).temp));
}

void test_capacity_covers_30_minutes_twice() {
  TEST_ASSERT_EQUAL(720, RingBuffer::CAPACITY);
  TEST_ASSERT_TRUE(RingBuffer::CAPACITY * cc::TELEMETRY_PERIOD_S >= 2 * 30 * 60);
  static RingBuffer buf;  // 30 minutes of readings at 5 s = 360, all kept
  buf = RingBuffer();
  for (uint32_t s = 1; s <= 360; s++) buf.push(packReading(sample(s)));
  TEST_ASSERT_EQUAL(360, buf.size());
  TEST_ASSERT_EQUAL_UINT32(0, buf.dropped());
}

void test_overflow_drops_oldest_and_counts() {
  static RingBuffer buf;
  buf = RingBuffer();
  for (uint32_t s = 1; s <= 800; s++) buf.push(packReading(sample(s)));  // > 60 min outage
  TEST_ASSERT_EQUAL(720, buf.size());
  TEST_ASSERT_EQUAL_UINT32(80, buf.dropped());
  TEST_ASSERT_EQUAL_UINT32(81, buf.at(0).seq);  // oldest kept
  TEST_ASSERT_EQUAL_UINT32(800, buf.at(719).seq);
  for (size_t i = 1; i < buf.size(); i++) TEST_ASSERT_EQUAL_UINT32(buf.at(i - 1).seq + 1, buf.at(i).seq);
}

void test_free_up_to_only_removes_acked() {
  static RingBuffer buf;
  buf = RingBuffer();
  for (uint32_t s = 10; s < 20; s++) buf.push(packReading(sample(s)));
  TEST_ASSERT_EQUAL(0, buf.freeUpTo(9));
  TEST_ASSERT_EQUAL(4, buf.freeUpTo(13));
  TEST_ASSERT_EQUAL_UINT32(14, buf.at(0).seq);
}

void test_events_share_the_buffer() {
  static RingBuffer buf;
  buf = RingBuffer();
  buf.push(packReading(sample(1)));
  buf.push(packEvent(2, 1767225605, eventCode("DOOR_ALARM")));
  buf.push(packReading(sample(3)));
  TEST_ASSERT_TRUE(isEvent(buf.at(1)));
  TEST_ASSERT_EQUAL_STRING("DOOR_ALARM", EVENT_TYPES[buf.at(1).code]);
  TEST_ASSERT_EQUAL(-1, eventCode("NOPE"));
  char body[2048];
  TEST_ASSERT_GREATER_THAN(0, syncBody(buf, 3, body, sizeof body));
  JsonDocument doc;
  TEST_ASSERT_FALSE(deserializeJson(doc, body));
  TEST_ASSERT_EQUAL(1, doc["from_seq"].as<int>());
  TEST_ASSERT_EQUAL(3, doc["to_seq"].as<int>());
  TEST_ASSERT_EQUAL(3, doc["readings"].size());
  TEST_ASSERT_EQUAL_STRING("DOOR_ALARM", doc["readings"][1]["type"]);
  TEST_ASSERT_TRUE(doc["readings"][1]["data"].is<JsonObject>());
  TEST_ASSERT_FALSE(doc["readings"][0]["buf"].is<int>());  // sync readings omit buf / rssi / fw
  // Each item keeps its own temperature (the formatted value is copied, not shared between items).
  TEST_ASSERT_NOT_NULL(strstr(body, "\"seq\":1,\"ts\":1767225605,\"temp\":4.50,"));
  TEST_ASSERT_NOT_NULL(strstr(body, "\"seq\":3,\"ts\":1767225615,\"temp\":5.50,"));
}

void test_full_chunk_fits_the_buffers() {
  static RingBuffer buf;
  buf = RingBuffer();
  for (uint32_t s = 0; s < cc::SYNC_CHUNK; s++) {  // worst case: every field at its longest
    Reading r{4000000000u + s, 4000000000u, -12.34f, true, true, true, 100, FridgeState::WARNING, 70000, true,
              true, false, NAN};
    buf.push(packReading(r));
  }
  static char body[6144];
  const size_t n = syncBody(buf, cc::SYNC_CHUNK, body, sizeof body);
  TEST_ASSERT_GREATER_THAN(0, n);
  static char env[8192];
  TEST_ASSERT_GREATER_THAN(0, msg::envelope("fridge-01", "k", "sync", 4000000000u, "0123456789abcdef", body, env,
                                            sizeof env));
  TEST_ASSERT_TRUE(strlen(env) + 64 < 8192);  // + topic and MQTT header inside the 8 kB PubSubClient buffer
}

// ---------------------------------------------------------------- sync over a lossy link

struct Lcg {
  uint32_t s;
  bool chance(int pct) {
    s = s * 1664525u + 1013904223u;
    return static_cast<int>((s >> 16) % 100) < pct;
  }
  uint32_t below(uint32_t n) {
    s = s * 1664525u + 1013904223u;
    return (s >> 8) % n;
  }
};

// Server: stores each seq once (UNIQUE(device_id, seq)), acks the chunk's to_seq idempotently.
struct FakeServer {
  std::set<uint32_t> stored;
  uint32_t duplicates = 0;
  uint32_t receive(const RingBuffer& buf, size_t n) {
    for (size_t i = 0; i < n; i++)
      if (!stored.insert(buf.at(i).seq).second) duplicates++;
    return buf.at(n - 1).seq;
  }
};

void runLossy(uint32_t seed, int lossPct, uint32_t outageMs) {
  static RingBuffer buf;
  buf = RingBuffer();
  Syncer sync(buf);
  FakeServer server;
  Lcg rng{seed};
  std::multimap<uint32_t, uint32_t> acksInFlight;  // deliver-at -> seq_upto
  uint32_t seq = 0;
  const uint32_t produceUntil = outageMs + 120000;  // keep producing for 2 min after the link returns

  for (uint32_t t = 0; t < produceUntil + 3600000 && (t < produceUntil || !buf.empty()); t += 100) {
    const bool up = t >= outageMs;
    if (t < produceUntil && t % 5000 == 0) {
      seq++;
      if (!up) buf.push(packReading(sample(seq)));  // offline: buffer
      else server.stored.insert(seq);              // online: live telemetry (assume delivered)
    }
    if (sync.due(t, up)) {
      const size_t n = sync.chunkSize();
      sync.sent(t);
      if (!rng.chance(lossPct)) {  // chunk delivered
        const uint32_t ack = server.receive(buf, n);
        if (!rng.chance(lossPct)) acksInFlight.emplace(t + rng.below(8000), ack);  // some arrive after the timeout
      }
    }
    while (!acksInFlight.empty() && acksInFlight.begin()->first <= t) {
      sync.onAck(acksInFlight.begin()->second);
      acksInFlight.erase(acksInFlight.begin());
    }
  }
  TEST_ASSERT_TRUE_MESSAGE(buf.empty(), "buffer never drained");
  TEST_ASSERT_EQUAL_UINT32(0, buf.dropped());
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(seq, server.stored.size(), "a reading was lost");
  uint32_t expect = 1;
  for (uint32_t s : server.stored) TEST_ASSERT_EQUAL_UINT32(expect++, s);  // no gaps, no extras
}

void test_sync_survives_30pct_loss_of_data_and_acks() {
  for (uint32_t seed = 1; seed <= 20; seed++) runLossy(seed, 30, 4 * 60 * 1000);  // 4 min outage, 48 readings
}

void test_sync_full_30_minute_outage() { runLossy(7, 30, 30 * 60 * 1000); }  // 360 readings

// ---------------------------------------------------------------- R1: retain until acknowledged

void test_replay_moves_only_the_gap_in_seq_order() {
  static RingBuffer recent, buf;
  recent = RingBuffer();
  buf = RingBuffer();
  for (uint32_t s = 1; s <= 50; s++) recent.push(packReading(sample(s)));  // sent live
  for (uint32_t s = 60; s <= 70; s++) buf.push(packReading(sample(s)));    // a later Wi-Fi outage
  TEST_ASSERT_EQUAL(11, recent.moveRangeTo(buf, 20, 30));
  TEST_ASSERT_EQUAL(22, buf.size());
  for (size_t i = 1; i < buf.size(); i++) TEST_ASSERT_TRUE(buf.at(i - 1).seq < buf.at(i).seq);  // ordered
  TEST_ASSERT_EQUAL_UINT32(20, buf.at(0).seq);
  TEST_ASSERT_EQUAL_UINT32(60, buf.at(11).seq);
  TEST_ASSERT_EQUAL(39, recent.size());  // 1..19 and 31..50 stay replayable
  TEST_ASSERT_EQUAL_UINT32(19, recent.at(18).seq);
  TEST_ASSERT_EQUAL_UINT32(31, recent.at(19).seq);
  TEST_ASSERT_EQUAL_UINT32(0, buf.dropped());
}

void test_insert_sorted_ignores_duplicates_and_never_overwrites() {
  static RingBuffer buf;
  buf = RingBuffer();
  for (uint32_t s = 1; s <= RingBuffer::CAPACITY; s += 1) buf.push(packReading(sample(s * 2)));  // full, even seqs
  TEST_ASSERT_TRUE(buf.insertSorted(packReading(sample(10))));  // already there: no-op
  TEST_ASSERT_FALSE(buf.insertSorted(packReading(sample(11))));  // full: refused, nothing lost
  TEST_ASSERT_EQUAL(RingBuffer::CAPACITY, buf.size());
  TEST_ASSERT_EQUAL_UINT32(0, buf.dropped());
  buf.freeUpTo(100);
  TEST_ASSERT_TRUE(buf.insertSorted(packReading(sample(101))));
  TEST_ASSERT_EQUAL_UINT32(101, buf.at(0).seq);
  TEST_ASSERT_EQUAL_UINT32(102, buf.at(1).seq);
}

void test_ack_never_frees_an_entry_replayed_after_its_chunk_went_out() {
  static RingBuffer recent, buf;
  recent = RingBuffer();
  buf = RingBuffer();
  Syncer sync(buf);
  for (uint32_t s = 150; s <= 160; s++) recent.push(packReading(sample(s)));
  for (uint32_t s = 200; s <= 219; s++) buf.push(packReading(sample(s)));
  TEST_ASSERT_TRUE(sync.due(0, true));
  sync.sent(0);                                      // chunk 200..219 in flight
  TEST_ASSERT_EQUAL(11, recent.moveRangeTo(buf, 150, 160));  // SYNC_REQUEST for the gap meanwhile
  TEST_ASSERT_TRUE(sync.onAck(219));                 // the server acks the chunk it got
  TEST_ASSERT_EQUAL(11, buf.size());                 // 150..160 were never sent: still here
  TEST_ASSERT_EQUAL_UINT32(150, buf.at(0).seq);
  TEST_ASSERT_TRUE(sync.due(1, true));
  TEST_ASSERT_EQUAL(11, sync.chunkSize());
}

// The backend is down for a while: live messages reach the socket but the broker drops them (QoS 0). When it
// is back it sees the seq gap and asks for that range; the replay window has it. Nothing is lost.
void test_backend_outage_recovered_from_the_replay_window() {
  static RingBuffer recent, buf;
  recent = RingBuffer();
  buf = RingBuffer();
  Syncer sync(buf);
  std::set<uint32_t> stored;
  uint32_t seq = 0, maxSeen = 0;
  bool gapRequested = false;
  for (uint32_t t = 0; t < 30 * 60 * 1000; t += 100) {
    const bool backendUp = t < 5 * 60 * 1000 || t >= 15 * 60 * 1000;  // 10 min outage
    if (t < 20 * 60 * 1000 && t % 5000 == 0) {
      seq++;
      recent.push(packReading(sample(seq)));  // published live (the uplink to the broker is fine)
      if (backendUp) {
        if (maxSeen && seq > maxSeen + 1 && !gapRequested) {  // server: gap -> SYNC_REQUEST {from, to}
          recent.moveRangeTo(buf, maxSeen + 1, seq - 1);
          sync.restart();
          gapRequested = true;
        }
        stored.insert(seq);
        maxSeen = seq > maxSeen ? seq : maxSeen;
      }
    }
    if (sync.due(t, true)) {
      const size_t n = sync.chunkSize();
      for (size_t i = 0; i < n; i++) stored.insert(buf.at(i).seq);
      sync.sent(t);
      sync.onAck(buf.at(n - 1).seq);
    }
  }
  TEST_ASSERT_TRUE(gapRequested);
  TEST_ASSERT_TRUE(buf.empty());
  TEST_ASSERT_EQUAL_UINT32_MESSAGE(seq, stored.size(), "a reading sent during the backend outage was lost");
}

void test_no_free_before_ack_and_retry_cadence() {
  static RingBuffer buf;
  buf = RingBuffer();
  Syncer sync(buf);
  for (uint32_t s = 1; s <= 30; s++) buf.push(packReading(sample(s)));
  TEST_ASSERT_TRUE(sync.due(0, true));
  TEST_ASSERT_EQUAL(25, sync.chunkSize());
  sync.sent(0);
  TEST_ASSERT_FALSE(sync.due(cfg::SYNC_ACK_TIMEOUT_MS - 1, true));  // waiting for the ack
  TEST_ASSERT_EQUAL(30, buf.size());                                // nothing freed without an ack
  uint32_t t = 0;
  for (uint32_t i = 0; i < cfg::SYNC_MAX_RETRIES; i++) {  // 5 retries of the same chunk
    t += cfg::SYNC_ACK_TIMEOUT_MS;
    TEST_ASSERT_TRUE(sync.due(t, true));
    sync.sent(t);
  }
  t += cfg::SYNC_ACK_TIMEOUT_MS;
  TEST_ASSERT_FALSE(sync.due(t, true));  // gives up and backs off
  TEST_ASSERT_FALSE(sync.due(t + cfg::SYNC_BACKOFF_MS - 1, true));
  TEST_ASSERT_TRUE(sync.due(t + cfg::SYNC_BACKOFF_MS, true));
  TEST_ASSERT_EQUAL(30, buf.size());
}

void test_ack_advances_stale_ack_ignored_restart_resends() {
  static RingBuffer buf;
  buf = RingBuffer();
  Syncer sync(buf);
  for (uint32_t s = 100; s < 130; s++) buf.push(packReading(sample(s)));
  sync.due(0, true);
  sync.sent(0);
  TEST_ASSERT_TRUE(sync.onAck(124));
  TEST_ASSERT_EQUAL(5, buf.size());
  TEST_ASSERT_TRUE(sync.due(1, true));  // next chunk goes at once
  sync.sent(1);
  TEST_ASSERT_FALSE(sync.onAck(124));  // a late duplicate of the first ack changes nothing
  TEST_ASSERT_TRUE(sync.waiting());
  sync.restart();                      // SYNC_REQUEST
  TEST_ASSERT_TRUE(sync.due(2, true));
  TEST_ASSERT_FALSE(sync.due(3, false));  // link down: nothing is sent
}

// ---------------------------------------------------------------- battery and door alarm

void test_battery_drains_warns_once_dies_and_recharges() {
  PowerModel p;
  PowerModel::Events ev = p.update(true, 0);
  TEST_ASSERT_TRUE(ev.powerFail);
  TEST_ASSERT_TRUE(p.onBattery());
  int lows = 0;
  bool died = false;
  float minutes = 0;
  while (!died && minutes < 100) {
    ev = p.update(true, 60);  // one minute
    minutes++;
    lows += ev.battLow;
    died = ev.died;
  }
  TEST_ASSERT_EQUAL(1, lows);
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 100.0f / cfg::BATT_DRAIN_PER_MIN, minutes);  // 50 min at 2 %/min
  TEST_ASSERT_TRUE(p.dead());
  TEST_ASSERT_EQUAL(0, p.pct());
  ev = p.update(true, 60);
  TEST_ASSERT_FALSE(ev.died);  // reported once
  ev = p.update(false, 0);
  TEST_ASSERT_TRUE(ev.powerRestore && ev.revived);
  TEST_ASSERT_FALSE(p.dead());
  p.update(false, 60);
  TEST_ASSERT_EQUAL(5, p.pct());  // 5 %/min recharge
  for (int i = 0; i < 30; i++) p.update(false, 60);
  TEST_ASSERT_EQUAL(100, p.pct());  // capped
  int lowsAgain = 0;
  for (int i = 0; i < 45; i++) lowsAgain += p.update(true, 60).battLow;
  TEST_ASSERT_EQUAL(1, lowsAgain);  // re-armed for the next discharge
}

void test_door_alarm_after_60s_once_per_episode() {
  DoorAlarm a;
  TEST_ASSERT_FALSE(a.update(true, 0));
  TEST_ASSERT_FALSE(a.update(true, cc::DOOR_ALARM_S * 1000));  // exactly 60 s: not yet (> 60 s)
  TEST_ASSERT_TRUE(a.update(true, cc::DOOR_ALARM_S * 1000 + 1));
  TEST_ASSERT_TRUE(a.active());
  TEST_ASSERT_FALSE(a.update(true, 200000));  // once per episode
  TEST_ASSERT_FALSE(a.update(false, 200100));
  TEST_ASSERT_FALSE(a.active());  // closing silences it
  TEST_ASSERT_FALSE(a.update(true, 300000));
  TEST_ASSERT_TRUE(a.update(true, 300000 + cc::DOOR_ALARM_S * 1000 + 1));  // new episode
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_entry_is_16_bytes_and_round_trips);
  RUN_TEST(test_capacity_covers_30_minutes_twice);
  RUN_TEST(test_overflow_drops_oldest_and_counts);
  RUN_TEST(test_free_up_to_only_removes_acked);
  RUN_TEST(test_events_share_the_buffer);
  RUN_TEST(test_full_chunk_fits_the_buffers);
  RUN_TEST(test_sync_survives_30pct_loss_of_data_and_acks);
  RUN_TEST(test_sync_full_30_minute_outage);
  RUN_TEST(test_replay_moves_only_the_gap_in_seq_order);
  RUN_TEST(test_insert_sorted_ignores_duplicates_and_never_overwrites);
  RUN_TEST(test_ack_never_frees_an_entry_replayed_after_its_chunk_went_out);
  RUN_TEST(test_backend_outage_recovered_from_the_replay_window);
  RUN_TEST(test_no_free_before_ack_and_retry_cadence);
  RUN_TEST(test_ack_advances_stale_ack_ignored_restart_resends);
  RUN_TEST(test_battery_drains_warns_once_dies_and_recharges);
  RUN_TEST(test_door_alarm_after_60s_once_per_episode);
  return UNITY_END();
}
