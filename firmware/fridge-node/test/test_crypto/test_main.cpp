// HMAC + envelope against the shared vectors (same check the device runs at boot).
#include <ArduinoJson.h>
#include <math.h>
#include <string.h>
#include <unity.h>

#include "crypto.h"
#include "messages.h"
#include "test_vectors.h"

void setUp() {}
void tearDown() {}

void test_rfc4231_case2() {
  crypto::Hmac h;
  h.begin("Jefe");
  h.update("what do ya want for nothing?");
  char out[65];
  h.finishHex(out);
  TEST_ASSERT_EQUAL_STRING("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", out);
}

void test_long_key_is_hashed_first() {
  char key[131];
  memset(key, 'k', 130);
  key[130] = '\0';
  crypto::Hmac a;
  a.begin(key);
  a.update("x");
  char outA[65];
  a.finishHex(outA);
  TEST_ASSERT_EQUAL(64, strlen(outA));  // just must not crash or truncate; device secrets are 64 chars
}

void test_shared_hmac_vectors() {
  TEST_ASSERT_EQUAL(5, vectors::HMAC_COUNT);
  for (const auto& v : vectors::HMAC) {
    char sig[65];
    crypto::signEnvelope(v.secret, v.device_id, v.kind, v.ts, v.nonce, v.body, sig);
    TEST_ASSERT_EQUAL_STRING_MESSAGE(v.sig, sig, v.kind);
  }
}

void test_envelope_round_trip_keeps_exact_body() {
  const auto& v = vectors::HMAC[0];
  char env[2048];
  TEST_ASSERT_GREATER_THAN(0, msg::envelope(v.device_id, v.secret, v.kind, v.ts, v.nonce, v.body, env, sizeof env));
  JsonDocument doc;
  TEST_ASSERT_FALSE(deserializeJson(doc, env));
  TEST_ASSERT_EQUAL(1, doc["v"].as<int>());
  TEST_ASSERT_EQUAL_STRING(v.device_id, doc["device_id"]);
  TEST_ASSERT_EQUAL_STRING(v.kind, doc["kind"]);
  TEST_ASSERT_EQUAL_UINT32(v.ts, doc["ts"].as<uint32_t>());
  TEST_ASSERT_EQUAL_STRING(v.nonce, doc["nonce"]);
  TEST_ASSERT_EQUAL_STRING(v.body, doc["body"]);  // a string, byte-identical to what was signed
  TEST_ASSERT_EQUAL_STRING(v.sig, doc["sig"]);
}

void test_envelope_reports_too_small_buffer() {
  const auto& v = vectors::HMAC[0];
  char env[64];
  TEST_ASSERT_EQUAL(0, msg::envelope(v.device_id, v.secret, v.kind, v.ts, v.nonce, v.body, env, sizeof env));
}

void test_constant_time_equal() {
  TEST_ASSERT_TRUE(crypto::constTimeEqual("abcd", "abcd"));
  TEST_ASSERT_FALSE(crypto::constTimeEqual("abcd", "abce"));
  TEST_ASSERT_FALSE(crypto::constTimeEqual("abcd", "abc"));
}

void test_telemetry_body_matches_contract_shape() {
  Reading r{1204, 1767225600, 4.62f, false, true, false, 100, FridgeState::SAFE, 0, false, false, false};
  LiveExtras live{0, -58};
  char body[512];
  TEST_ASSERT_GREATER_THAN(0, msg::telemetryBody(r, &live, body, sizeof body));
  // Same field order and formatting as the shared "telemetry periodic" vector, so the signature matches too.
  TEST_ASSERT_EQUAL_STRING(vectors::HMAC[0].body, body);
}

void test_sync_reading_omits_live_fields_and_null_temp() {
  Reading r{7, 100, NAN, true, false, true, 92, FridgeState::BREACH, 30, false, true, true};
  char body[512];
  msg::telemetryBody(r, nullptr, body, sizeof body);
  TEST_ASSERT_EQUAL_STRING(
      "{\"seq\":7,\"ts\":100,\"temp\":null,\"door\":1,\"comp\":0,\"power\":\"BATTERY\",\"batt\":92,\"state\":\"BREACH\","
      "\"exp_s\":30,\"latch\":0,\"mode\":\"manual\",\"reason\":\"door\"}",
      body);
}

void test_event_body() {
  char body[128];
  msg::eventBody(88, 1767225604, "DOOR_OPEN", nullptr, body, sizeof body);
  TEST_ASSERT_EQUAL_STRING(vectors::HMAC[1].body, body);
}

void test_cmdack_body() {
  char body[128];
  msg::cmdackBody("abc", true, "latch cleared", body, sizeof body);
  TEST_ASSERT_EQUAL_STRING("{\"cmd_id\":\"abc\",\"ok\":true,\"detail\":\"latch cleared\"}", body);
}

void test_topic_and_nonce() {
  char t[96];
  msg::topic("{prefix}/{device_id}/telemetry", "coldchain/v1", "fridge-01", t, sizeof t);
  TEST_ASSERT_EQUAL_STRING("coldchain/v1/fridge-01/telemetry", t);
  char n[17];
  msg::nonceHex(0x9f2c1a7b, 0x05d3e4f6, n);
  TEST_ASSERT_EQUAL_STRING("9f2c1a7b05d3e4f6", n);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_rfc4231_case2);
  RUN_TEST(test_long_key_is_hashed_first);
  RUN_TEST(test_shared_hmac_vectors);
  RUN_TEST(test_envelope_round_trip_keeps_exact_body);
  RUN_TEST(test_envelope_reports_too_small_buffer);
  RUN_TEST(test_constant_time_equal);
  RUN_TEST(test_telemetry_body_matches_contract_shape);
  RUN_TEST(test_sync_reading_omits_live_fields_and_null_temp);
  RUN_TEST(test_event_body);
  RUN_TEST(test_cmdack_body);
  RUN_TEST(test_topic_and_nonce);
  return UNITY_END();
}
