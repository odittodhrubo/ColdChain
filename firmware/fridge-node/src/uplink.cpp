#include "uplink.h"

#include <Arduino.h>
#include <string.h>

#include "constants.h"
#include "crypto.h"
#include "kv.h"
#include "net.h"
#include "seqstore.h"
#include "settings.h"
#include "test_vectors.h"

namespace {

struct DeviceSecret {
  const char* id;
  const char* secret;
};
constexpr DeviceSecret SECRETS[] = DEVICE_SECRETS;

const char* deviceId = "";
const char* secret = nullptr;
bool enabled = false;
const char* disabledNote = nullptr;

SeqStore seq(nvs::store());

char tTelemetry[96], tEvent[96], tSync[96], tAck[96], tCmd[96], tCmdack[96], tStatus[96];

// Shared scratch, used only from the loop task. 8 kB fits a full sync chunk envelope (P05).
char body[4096];
char envelope[8192];
bool lastSent = false;
const char* lastKind = "";

bool bootPending = true;
bool wifiBackPending = false;
bool wifiSeenUp = false;
uint32_t sent = 0, skippedOffline = 0, tooBig = 0;

bool selfTest() {
  for (size_t i = 0; i < vectors::HMAC_COUNT; i++) {
    const auto& v = vectors::HMAC[i];
    char sig[crypto::SIG_HEX_LEN + 1];
    crypto::signEnvelope(v.secret, v.device_id, v.kind, v.ts, v.nonce, v.body, sig);
    if (!crypto::constTimeEqual(sig, v.sig)) {
      Serial.printf("HMAC SELFTEST FAILED on vector %u (%s): networking disabled\n", static_cast<unsigned>(i), v.kind);
      return false;
    }
  }
  Serial.printf("HMAC SELFTEST OK (%u vectors)\n", static_cast<unsigned>(vectors::HMAC_COUNT));
  return true;
}

// Signs body as `kind` and publishes it on `topic`. The envelope stays in `envelope` for `dump`.
bool sendSigned(const char* kind, const char* topic, const char* bodyStr) {
  char nonce[17];
  msg::nonceHex(esp_random(), esp_random(), nonce);
  lastKind = kind;
  lastSent = false;
  if (!msg::envelope(deviceId, secret, kind, net::nowUnix(), nonce, bodyStr, envelope, sizeof envelope)) {
    tooBig++;
    Serial.printf("[tx] %s envelope too large, dropped\n", kind);
    return false;
  }
  lastSent = net::publish(topic, envelope);
  if (lastSent) sent++;
  // Never log the secret; the first 4 signature chars are enough to match a message in the backend logs.
  const char* sig = strstr(envelope, "\"sig\":\"");
  Serial.printf("[tx] %-9s %4u B sig=%.4s... %s\n", kind, static_cast<unsigned>(strlen(envelope)), sig ? sig + 7 : "",
                lastSent ? "ok" : "FAILED");
  return lastSent;
}

void sendEvent(const char* type, const char* data_json) {
  if (!msg::eventBody(seq.next(), net::nowUnix(), type, data_json, body, sizeof body)) return;
  sendSigned("event", tEvent, body);
}

}  // namespace

namespace uplink {

bool begin(const char* device_id) {
  deviceId = device_id;
  seq.begin();
  Serial.printf("[seq] resuming at %lu\n", static_cast<unsigned long>(seq.last()));

  for (const auto& s : SECRETS)
    if (strcmp(s.id, device_id) == 0) secret = s.secret;
  if (!selfTest()) {
    disabledNote = "HMAC FAIL - OFFLINE";
    return false;
  }
  if (!secret || strlen(secret) < 32) {
    Serial.printf("[cfg] no DEVICE_SECRETS entry for %s in config.h: networking disabled\n", device_id);
    disabledNote = "NO SECRET - OFFLINE";
    return false;
  }
  if (strspn(secret, "0") == strlen(secret))
    Serial.println("[cfg] WARNING: placeholder secret; the server will reject every message (see config.h)");

  msg::topic(cc::TOPIC_TELEMETRY, MQTT_TOPIC_PREFIX, device_id, tTelemetry, sizeof tTelemetry);
  msg::topic(cc::TOPIC_EVENT, MQTT_TOPIC_PREFIX, device_id, tEvent, sizeof tEvent);
  msg::topic(cc::TOPIC_SYNC, MQTT_TOPIC_PREFIX, device_id, tSync, sizeof tSync);
  msg::topic(cc::TOPIC_ACK, MQTT_TOPIC_PREFIX, device_id, tAck, sizeof tAck);
  msg::topic(cc::TOPIC_CMD, MQTT_TOPIC_PREFIX, device_id, tCmd, sizeof tCmd);
  msg::topic(cc::TOPIC_CMDACK, MQTT_TOPIC_PREFIX, device_id, tCmdack, sizeof tCmdack);
  msg::topic(cc::TOPIC_STATUS, MQTT_TOPIC_PREFIX, device_id, tStatus, sizeof tStatus);
  net::begin(device_id, tStatus, tCmd, tAck);
  Serial.printf("[net] %s -> %s:%d (%s), topics %s/%s/...\n", WIFI_SSID, MQTT_HOST, MQTT_PORT,
                MQTT_TLS ? "TLS" : "plain", MQTT_TOPIC_PREFIX, device_id);
  enabled = true;
  return true;
}

void telemetry(Reading r) {
  if (!enabled || !net::uplink()) {
    skippedOffline++;  // P05 buffers these instead
    return;
  }
  r.seq = seq.next();
  r.ts = net::nowUnix();
  const net::Status st = net::status();
  const LiveExtras live{0, st.rssi};
  if (msg::telemetryBody(r, &live, body, sizeof body)) sendSigned("telemetry", tTelemetry, body);
}

void event(const char* type, const char* data_json) {
  Serial.printf("[event] %s\n", type);
  if (!enabled || !net::uplink()) {
    skippedOffline++;
    return;
  }
  sendEvent(type, data_json);
}

void poll(uint32_t) {
  if (!enabled) return;
  const net::Status st = net::status();
  if (st.wifi && !wifiSeenUp && !bootPending) wifiBackPending = true;  // a reconnect, not the first connect
  wifiSeenUp = st.wifi;

  if (net::uplink()) {
    if (bootPending) {
      bootPending = false;  // BOOT needs a valid clock, so it goes out on the first connection
      Serial.println("[event] BOOT");
      sendEvent("BOOT", "{\"fw\":\"1.0.0\"}");
    }
    if (wifiBackPending) {
      wifiBackPending = false;
      Serial.println("[event] WIFI_BACK");
      sendEvent("WIFI_BACK", nullptr);
    }
  }

  static net::Incoming in;
  while (net::receive(in)) {
    // Commands (P04) and sync acks (P05) are verified and handled there; P03 only subscribes.
    Serial.printf("[rx] %s %u B%s\n", in.topic, static_cast<unsigned>(in.len), in.truncated ? " (truncated)" : "");
  }
}

uint32_t lastSeq() { return seq.last(); }

const char* footerNote() {
  if (disabledNote) return disabledNote;
  const net::Status st = net::status();
  if (st.wifi && !st.timeValid) return "SYNCING TIME";
  return nullptr;
}

void dump() {
  if (!*lastKind) {
    Serial.println("nothing sent yet");
    return;
  }
  Serial.printf("last %s envelope (%s):\n%s\n", lastKind, lastSent ? "published" : "NOT published", envelope);
}

void printStatus() {
  const net::Status st = net::status();
  Serial.printf("network    %s  wifi %s  mqtt %s  time %s  rssi %d dBm%s\n", enabled ? "enabled" : "DISABLED",
                st.wifi ? "up" : "down", st.mqtt ? "up" : "down", st.timeValid ? "valid" : "SYNCING", st.rssi,
                st.outage ? "  (simulated outage)" : "");
  Serial.printf("uplink     seq %lu  sent %lu  skipped offline %lu  too big %lu  unix %lu\n",
                static_cast<unsigned long>(seq.last()), static_cast<unsigned long>(sent),
                static_cast<unsigned long>(skippedOffline), static_cast<unsigned long>(tooBig),
                static_cast<unsigned long>(net::nowUnix()));
}

}  // namespace uplink
