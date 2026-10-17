// Everything between the control loop and the broker (ESP32 only): device secret, boot HMAC self-test,
// sequence numbers, signed telemetry and events, received messages.
#pragma once
#include <stdint.h>

#include "messages.h"

namespace uplink {

// Picks this device's secret, runs the HMAC self-test and starts the network task.
// Returns false when networking is disabled (self-test failed or no secret); control keeps running either way.
bool begin(const char* device_id);

// Fills seq and ts, signs and publishes live telemetry. Skipped (counted) while the uplink is down.
void telemetry(Reading r);

// Prints and publishes an event with a fresh seq. data_json is a JSON object or nullptr for {}.
void event(const char* type, const char* data_json = nullptr);

// Call every loop: drains received messages, sends deferred BOOT / WIFI_BACK events.
void poll(uint32_t now_ms);

uint32_t lastSeq();
const char* footerNote();  // nullptr = show WIFI/MQTT/SEQ
void dump();               // console: last envelope, to paste into backend tests
void printStatus();        // console: network section of `status`

}  // namespace uplink
