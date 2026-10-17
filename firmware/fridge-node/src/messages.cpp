#include "messages.h"

#include <ArduinoJson.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "constants.h"
#include "crypto.h"

namespace {
size_t finish(const JsonDocument& doc, char* out, size_t cap) {
  if (measureJson(doc) >= cap) return 0;
  return serializeJson(doc, out, cap);
}
}  // namespace

namespace msg {

size_t telemetryBody(const Reading& r, const LiveExtras* live, char* out, size_t cap) {
  JsonDocument doc;
  char temp[12];
  doc["seq"] = r.seq;
  doc["ts"] = r.ts;
  if (isnan(r.temp)) {
    doc["temp"] = nullptr;
  } else {
    snprintf(temp, sizeof temp, "%.2f", r.temp);  // fixed 2 decimals, no float-printing surprises
    doc["temp"] = serialized(static_cast<const char*>(temp));
  }
  doc["door"] = r.doorOpen ? 1 : 0;
  doc["comp"] = r.compOn ? 1 : 0;
  doc["power"] = r.onBattery ? "BATTERY" : "MAINS";
  doc["batt"] = r.battPct;
  doc["state"] = stateName(r.state);
  doc["exp_s"] = r.expS;
  doc["latch"] = r.latch ? 1 : 0;
  doc["mode"] = r.manualMode ? "manual" : "model";
  if (live) {
    doc["buf"] = live->buf;
    doc["rssi"] = live->rssi;
    doc["fw"] = FW_VERSION;
  }
  doc["reason"] = r.doorReason ? "door" : "periodic";
  return finish(doc, out, cap);
}

size_t eventBody(uint32_t seq, uint32_t ts, const char* type, const char* data_json, char* out, size_t cap) {
  JsonDocument doc;
  doc["seq"] = seq;
  doc["ts"] = ts;
  doc["type"] = type;
  doc["data"] = serialized(data_json && *data_json ? data_json : "{}");
  return finish(doc, out, cap);
}

size_t cmdackBody(const char* cmd_id, bool ok, const char* detail, char* out, size_t cap) {
  JsonDocument doc;
  doc["cmd_id"] = cmd_id;
  doc["ok"] = ok;
  doc["detail"] = detail;
  return finish(doc, out, cap);
}

size_t envelope(const char* device_id, const char* secret, const char* kind, uint32_t ts, const char* nonce,
                const char* body, char* out, size_t cap) {
  char sig[crypto::SIG_HEX_LEN + 1];
  crypto::signEnvelope(secret, device_id, kind, ts, nonce, body, sig);
  JsonDocument doc;
  doc["v"] = cc::ENVELOPE_VERSION;
  doc["device_id"] = device_id;
  doc["kind"] = kind;
  doc["ts"] = ts;
  doc["nonce"] = nonce;
  doc["body"] = body;  // embedded as a string: exactly the bytes that were signed
  doc["sig"] = sig;
  return finish(doc, out, cap);
}

void topic(const char* tpl, const char* prefix, const char* device_id, char* out, size_t cap) {
  size_t n = 0;
  auto put = [&](const char* s) {
    while (*s && n + 1 < cap) out[n++] = *s++;
  };
  while (*tpl) {
    if (strncmp(tpl, "{prefix}", 8) == 0) {
      put(prefix);
      tpl += 8;
    } else if (strncmp(tpl, "{device_id}", 11) == 0) {
      put(device_id);
      tpl += 11;
    } else if (n + 1 < cap) {
      out[n++] = *tpl++;
    } else {
      break;
    }
  }
  out[n] = '\0';
}

void nonceHex(uint32_t a, uint32_t b, char out[17]) {
  snprintf(out, 17, "%08lx%08lx", static_cast<unsigned long>(a), static_cast<unsigned long>(b));
}

}  // namespace msg
