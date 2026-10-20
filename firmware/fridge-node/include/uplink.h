// Everything between the control loop and the broker (ESP32 only): device secret, boot HMAC self-test,
// sequence numbers, signed telemetry and events, offline buffer and sync, received messages.
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "cmdguard.h"
#include "messages.h"

namespace uplink {

// Runs a verified, whitelisted command. Writes a short result into detail; returns ok for the cmdack.
using CommandHandler = bool (*)(CmdType type, char* detail, size_t cap);
void onCommand(CommandHandler handler);

// Picks this device's secret, runs the HMAC self-test and starts the network task. reset_reason goes into
// the BOOT event ({"fw","reset"}), so a watchdog or brownout reset shows on the dashboard and in the audit.
// Returns false when networking is disabled (self-test failed or no secret); control keeps running either way.
bool begin(const char* device_id, const char* reset_reason = "UNKNOWN");

// Fills seq and ts, then publishes live telemetry, or buffers it (same seq) while the uplink is down or the
// publish fails. Dropped only before the clock was ever valid (no ts to give it).
void telemetry(Reading r);

// Prints and publishes (or buffers) an event with a fresh seq. data_json is a JSON object or nullptr for {}.
void event(const char* type, const char* data_json = nullptr);

// Call every loop: BOOT once the clock is valid, WIFI_LOST / WIFI_BACK on uplink changes, verified commands
// (replied on cmdack) and sync acks, and the next sync chunk when one is due.
void poll(uint32_t now_ms);

uint32_t rejectedCmds();
uint32_t bufferedCount();

// SYNC_REQUEST: resend from the oldest unacked buffered entry now. Writes a short result into detail.
void restartSync(char* detail, size_t cap);

// DEAD battery: persist the exact seq (the node "powers off" without a reboot).
void shutdown();

uint32_t lastSeq();
const char* footerNote();  // nullptr = show WIFI/MQTT/SEQ
void dump();               // console: last envelope, to paste into backend tests
void printStatus();        // console: network section of `status`

}  // namespace uplink
