// Verification of signed server -> device envelopes (cmd and sync ack). Pure, native-tested.
// Checks, in order: clock valid, JSON + fields, device_id and kind, |now - ts| <= HMAC_WINDOW_S, HMAC (constant
// time), nonce unseen in the last NONCE_RING messages. A nonce is remembered only after its HMAC verified, so
// forged messages cannot evict real nonces. Stale replays are caught by the timestamp window, fresh ones by the ring.
#pragma once
#include <ArduinoJson.h>
#include <stddef.h>
#include <stdint.h>

enum class Verdict { OK, NO_TIME, BAD_JSON, BAD_FIELDS, WRONG_DEVICE, WRONG_KIND, STALE_TS, BAD_SIG, REPLAY };
const char* verdictName(Verdict v);

class EnvelopeGuard {
 public:
  static constexpr size_t NONCE_RING = 32;

  EnvelopeGuard(const char* device_id, const char* secret) : device_id_(device_id), secret_(secret) {}

  // After a ROTATE_SECRET (S7): verify with the new secret from now on. The pointer must stay valid.
  void setSecret(const char* secret) { secret_ = secret; }

  // On OK, body receives the parsed body object. now_unix = 0 means the clock is not valid yet.
  Verdict verify(const char* json, const char* expected_kind, uint32_t now_unix, JsonDocument& body);

 private:
  bool seen(const char* nonce) const;
  void remember(const char* nonce);

  const char* device_id_;
  const char* secret_;
  char nonces_[NONCE_RING][17] = {};
  size_t next_ = 0;
};

// Commands the device accepts (contract section 5). Anything else is rejected after authentication.
enum class CmdType { RESET_LATCH, SET_LATCH, BUZZER_TEST, SYNC_REQUEST, ROTATE_SECRET, SET_CALIBRATION, UNKNOWN };
CmdType parseCmdType(const char* s);
