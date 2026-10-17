// Command acceptance matrix: valid, no clock, stale, bad signature, replayed nonce, wrong device/kind, unknown type.
#include <ArduinoJson.h>
#include <string.h>
#include <unity.h>

#include "cmdguard.h"
#include "messages.h"

void setUp() {}
void tearDown() {}

const char* DEV = "fridge-02";
const char* SECRET = "58b3a2d4883d68a75dddfa65dd8981e761e461d7ba748e382273c0c5146fc5ee";
const uint32_t NOW = 1767230000;
const char* BODY = "{\"cmd_id\":\"3f1d2c4b-8e7a-4b6c-9d0e-1f2a3b4c5d6e\",\"type\":\"RESET_LATCH\",\"args\":{}}";

char buf[1024];

const char* cmd(uint32_t ts, const char* nonce, const char* body = BODY, const char* secret = SECRET,
                const char* device = DEV, const char* kind = "cmd") {
  msg::envelope(device, secret, kind, ts, nonce, body, buf, sizeof buf);
  return buf;
}

void test_valid_command_accepted_and_body_parsed() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  TEST_ASSERT_EQUAL_STRING("OK", verdictName(g.verify(cmd(NOW, "5a5a5a5a00000001"), "cmd", NOW, body)));
  TEST_ASSERT_EQUAL(CmdType::RESET_LATCH, parseCmdType(body["type"]));
  TEST_ASSERT_EQUAL_STRING("3f1d2c4b-8e7a-4b6c-9d0e-1f2a3b4c5d6e", body["cmd_id"]);
}

void test_rejected_without_valid_clock() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  TEST_ASSERT_EQUAL(Verdict::NO_TIME, g.verify(cmd(NOW, "5a5a5a5a00000001"), "cmd", 0, body));
}

void test_timestamp_window_is_30s_both_ways() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  TEST_ASSERT_EQUAL(Verdict::OK, g.verify(cmd(NOW - 30, "0000000000000001"), "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::OK, g.verify(cmd(NOW + 30, "0000000000000002"), "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::STALE_TS, g.verify(cmd(NOW - 31, "0000000000000003"), "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::STALE_TS, g.verify(cmd(NOW - 600, "0000000000000004"), "cmd", NOW, body));
}

void test_bad_signature_and_tampered_body() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  TEST_ASSERT_EQUAL(Verdict::BAD_SIG,
                    g.verify(cmd(NOW, "0000000000000005", BODY, "wrong-secret"), "cmd", NOW, body));
  cmd(NOW, "0000000000000006");
  char* p = strstr(buf, "RESET_LATCH");
  memcpy(p, "SET_LATCH__", 11);  // change the command after signing
  TEST_ASSERT_EQUAL(Verdict::BAD_SIG, g.verify(buf, "cmd", NOW, body));
  cmd(NOW, "0000000000000007");
  char* sig = strstr(buf, "\"sig\":\"") + 7;
  sig[0] = sig[0] == 'a' ? 'b' : 'a';  // flip one hex char
  TEST_ASSERT_EQUAL(Verdict::BAD_SIG, g.verify(buf, "cmd", NOW, body));
}

void test_replay_rejected_and_forgeries_do_not_burn_nonces() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  // A forged message with nonce N must not stop the genuine one with nonce N later.
  TEST_ASSERT_EQUAL(Verdict::BAD_SIG, g.verify(cmd(NOW, "aaaaaaaaaaaaaaaa", BODY, "forger"), "cmd", NOW, body));
  char first[1024];
  strcpy(first, cmd(NOW, "aaaaaaaaaaaaaaaa"));
  TEST_ASSERT_EQUAL(Verdict::OK, g.verify(first, "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::REPLAY, g.verify(first, "cmd", NOW + 5, body));  // exact same bytes again
}

void test_nonce_ring_holds_last_32() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  char nonce[17];
  for (uint32_t i = 0; i < EnvelopeGuard::NONCE_RING; i++) {
    msg::nonceHex(0, i, nonce);
    TEST_ASSERT_EQUAL(Verdict::OK, g.verify(cmd(NOW, nonce), "cmd", NOW, body));
  }
  msg::nonceHex(0, 0, nonce);
  TEST_ASSERT_EQUAL(Verdict::REPLAY, g.verify(cmd(NOW, nonce), "cmd", NOW, body));
}

void test_wrong_device_kind_and_malformed() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  TEST_ASSERT_EQUAL(Verdict::WRONG_DEVICE,
                    g.verify(cmd(NOW, "0000000000000008", BODY, SECRET, "fridge-01"), "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::WRONG_KIND,
                    g.verify(cmd(NOW, "0000000000000009", BODY, SECRET, DEV, "ack"), "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::BAD_JSON, g.verify("{not json", "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::BAD_FIELDS, g.verify("{\"v\":1,\"device_id\":\"fridge-02\"}", "cmd", NOW, body));
  TEST_ASSERT_EQUAL(Verdict::BAD_FIELDS, g.verify(cmd(NOW, "short"), "cmd", NOW, body));
}

void test_unknown_type_is_authenticated_but_not_whitelisted() {
  EnvelopeGuard g(DEV, SECRET);
  JsonDocument body;
  const char* evil = "{\"cmd_id\":\"x\",\"type\":\"FORMAT_FLASH\",\"args\":{}}";
  TEST_ASSERT_EQUAL(Verdict::OK, g.verify(cmd(NOW, "000000000000000a", evil), "cmd", NOW, body));
  TEST_ASSERT_EQUAL(CmdType::UNKNOWN, parseCmdType(body["type"]));
  TEST_ASSERT_EQUAL(CmdType::UNKNOWN, parseCmdType(nullptr));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_valid_command_accepted_and_body_parsed);
  RUN_TEST(test_rejected_without_valid_clock);
  RUN_TEST(test_timestamp_window_is_30s_both_ways);
  RUN_TEST(test_bad_signature_and_tampered_body);
  RUN_TEST(test_replay_rejected_and_forgeries_do_not_burn_nonces);
  RUN_TEST(test_nonce_ring_holds_last_32);
  RUN_TEST(test_wrong_device_kind_and_malformed);
  RUN_TEST(test_unknown_type_is_authenticated_but_not_whitelisted);
  return UNITY_END();
}
