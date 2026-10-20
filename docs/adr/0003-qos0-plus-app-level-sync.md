# 0003 — QoS 0 on the device plus an application-level sync

## Status

Accepted.

## Context

The ESP32 nodes publish over MQTT with `PubSubClient`, whose publish path supports only QoS 0: the broker does not store a QoS-0 message for a subscriber that is absent. So a reading sent while the backend is down, or a message in flight when the broker connection dies, can be dropped by the transport. The obvious transport-level fix — QoS 1 publish from the device — would mean replacing the firmware MQTT stack (AsyncMqttClient or esp-mqtt), which is a large, risky rewrite of code that is otherwise tested and working.

## Decision

Keep QoS 0 on the device and recover lost data at the application layer instead:

- The node keeps a monotonic sequence number and an on-device ring buffer. An entry stays replayable until the backend acknowledges it is stored; only then is it freed (R1, "retain until acked").
- The backend detects a gap in the sequence and asks the device for exactly the missing range with `SYNC_REQUEST {from_seq, to_seq}` (`backend/src/mqtt/`, firmware `uplink`).
- The backend holds a persistent broker session (`clean: false`, stable client id) and subscribes/publishes at QoS 1, so the broker queues messages for it across a backend restart (R2).

## Consequences

- A Wi-Fi or broker outage is covered fully: the device buffers and the backend re-requests the gap (scenarios S5, S6, failure injection).
- A backend restart no longer loses the messages the broker can queue, because the backend session persists (R2).
- The tested, working firmware MQTT code is kept; we do not take on an MQTT-stack rewrite for QoS 1.
- A residual edge remains: the one or two device-to-broker messages in flight at the instant the broker itself dies are still QoS 0 and can be lost. This is detected as a sequence gap and shown on the Security page, and exposure across the gap is counted conservatively. Closing it entirely would require QoS 1 on the device — the rewrite this decision declines.
