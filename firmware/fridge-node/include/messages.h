// Message bodies and the signed envelope (contract: docs/CONTRACTS.md sections 3-5). Pure, native-tested.
// The body is serialised once, signed, and embedded as a JSON string; it is never re-serialised after signing.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "status.h"

constexpr const char* FW_VERSION = "1.0.0";

struct Reading {
  uint32_t seq;
  uint32_t ts;  // reading time (unix s); the envelope ts is the send time
  float temp;   // NAN on sensor fault, sent as null
  bool doorOpen;
  bool compOn;
  bool onBattery;
  uint8_t battPct;
  FridgeState state;
  uint32_t expS;
  bool latch;
  bool manualMode;
  bool doorReason;  // reason "door" (immediate on a door change) instead of "periodic"
};

// Fields only live telemetry carries (a sync reading omits buf, rssi and fw).
struct LiveExtras {
  uint32_t buf;
  int rssi;
};

namespace msg {

// Each returns the length written (excluding NUL), or 0 if out is too small.
size_t telemetryBody(const Reading& r, const LiveExtras* live, char* out, size_t cap);
size_t eventBody(uint32_t seq, uint32_t ts, const char* type, const char* data_json, char* out, size_t cap);
size_t cmdackBody(const char* cmd_id, bool ok, const char* detail, char* out, size_t cap);
size_t envelope(const char* device_id, const char* secret, const char* kind, uint32_t ts, const char* nonce,
                const char* body, char* out, size_t cap);

// "{prefix}/{device_id}/telemetry" -> "coldchain/v1/fridge-01/telemetry"
void topic(const char* tpl, const char* prefix, const char* device_id, char* out, size_t cap);

// 16 lowercase hex chars from two 32-bit random words (esp_random() on the device).
void nonceHex(uint32_t a, uint32_t b, char out[17]);

}  // namespace msg
