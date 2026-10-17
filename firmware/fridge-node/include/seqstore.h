// One monotonic message sequence number per device, shared by telemetry and events (contract section 5).
// Written to NVS only every SAVE_EVERY increments to spare the flash. On boot the stored value jumps by
// SAVE_EVERY, so a crash between saves can never make the device reuse a seq the server already has.
#pragma once
#include <stdint.h>

#include "kv.h"

class SeqStore {
 public:
  static constexpr uint32_t SAVE_EVERY = 20;

  explicit SeqStore(Kv& kv) : kv_(kv) {}
  void begin();          // boot recovery: last = stored + SAVE_EVERY, saved at once
  uint32_t next();       // the seq for the next message
  uint32_t last() const { return last_; }
  void flush();          // orderly shutdown (DEAD battery, P05): save the exact value

 private:
  Kv& kv_;
  uint32_t last_ = 0;
  uint32_t saved_ = 0;
};
