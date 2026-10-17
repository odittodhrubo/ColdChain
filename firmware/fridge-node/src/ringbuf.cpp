#include "ringbuf.h"

#include <math.h>
#include <string.h>

int eventCode(const char* type) {
  for (size_t i = 0; i < EVENT_TYPE_COUNT; i++)
    if (strcmp(EVENT_TYPES[i], type) == 0) return static_cast<int>(i);
  return -1;
}

BufEntry packReading(const Reading& r) {
  BufEntry e{};
  e.seq = r.seq;
  e.ts = r.ts;
  if (isnan(r.temp)) {
    e.temp_c100 = INT16_MIN;
  } else {
    const float c = roundf(r.temp * 100.0f);
    e.temp_c100 = static_cast<int16_t>(c > 32767 ? 32767 : c < -32767 ? -32767 : c);
  }
  e.exp_s = static_cast<uint16_t>(r.expS > 65535 ? 65535 : r.expS);
  e.batt = r.battPct;
  e.code = static_cast<uint8_t>(r.state);
  e.flags = (r.doorOpen ? bufflag::DOOR : 0) | (r.compOn ? bufflag::COMP : 0) | (r.onBattery ? bufflag::BATTERY : 0) |
            (r.latch ? bufflag::LATCH : 0) | (r.manualMode ? bufflag::MANUAL : 0) |
            (r.doorReason ? bufflag::REASON_DOOR : 0);
  return e;
}

BufEntry packEvent(uint32_t seq, uint32_t ts, int code) {
  BufEntry e{};
  e.seq = seq;
  e.ts = ts;
  e.code = static_cast<uint8_t>(code);
  e.flags = bufflag::EVENT;
  return e;
}

Reading unpackReading(const BufEntry& e) {
  Reading r{};
  r.seq = e.seq;
  r.ts = e.ts;
  r.temp = e.temp_c100 == INT16_MIN ? NAN : e.temp_c100 / 100.0f;
  r.doorOpen = e.flags & bufflag::DOOR;
  r.compOn = e.flags & bufflag::COMP;
  r.onBattery = e.flags & bufflag::BATTERY;
  r.battPct = e.batt;
  r.state = static_cast<FridgeState>(e.code);
  r.expS = e.exp_s;
  r.latch = e.flags & bufflag::LATCH;
  r.manualMode = e.flags & bufflag::MANUAL;
  r.doorReason = e.flags & bufflag::REASON_DOOR;
  return r;
}

void RingBuffer::push(const BufEntry& e) {
  if (count_ == CAPACITY) {
    head_ = (head_ + 1) % CAPACITY;  // overwrite the oldest
    count_--;
    dropped_++;
  }
  items_[(head_ + count_) % CAPACITY] = e;
  count_++;
}

size_t RingBuffer::freeUpTo(uint32_t seq) {
  size_t n = 0;
  while (count_ && items_[head_].seq <= seq) {
    head_ = (head_ + 1) % CAPACITY;
    count_--;
    n++;
  }
  return n;
}
