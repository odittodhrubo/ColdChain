# 0002 — HMAC message envelopes, not MQTT-level auth alone

## Status

Accepted.

## Context

Devices reach the backend over MQTT. A broker can authenticate a connection (username/password, per-account ACLs, TLS — all of which we also do, see S4) and that stops an unauthenticated client from publishing. But broker authentication protects the *channel*, not the *message*: it does not prove which device produced a given reading, it does not stop a replay of a captured-but-valid message, and it leaves the backend trusting whatever arrives on a topic. For a tamper-evident cold chain, the record of what a fridge reported has to be defensible on its own.

## Decision

Every device-to-server and server-to-device message is wrapped in a signed envelope (`backend/src/mqtt/envelope.ts`, firmware `crypto`/`cmdguard`). Each device holds a per-device secret. The signature is `HMAC-SHA256(secret, deviceId | kind | ts | nonce | body)`. The backend rejects a message whose signature does not verify, whose timestamp is outside the accepted window (`HMAC_WINDOW_S`), or whose nonce it has already seen. Rejections are counted by reason and shown on the Security page. Broker-level auth and ACLs (S4) sit *underneath* this as defence in depth, not instead of it.

## Consequences

- A reading is bound to a specific device by a secret the broker never sees, so the audit trail means something even if the broker or network is not trusted.
- Replays are caught by the timestamp window plus the nonce table; a captured message cannot be re-sent later.
- The secret lives on the device and in the backend's encrypted store (`encryptSecret`/`decryptSecret`, `APP_SECRET_KEY`), and can be rotated over a signed command (S7).
- The nonce table must be bounded and the timestamp window kept tight, or the table grows and the replay guard weakens; the soak test (Q3) watches memory for exactly this.
- Clock skew matters: timestamps come from the device over NTP, and receipt time is stored next to them so skew is visible rather than silently shifting history.
