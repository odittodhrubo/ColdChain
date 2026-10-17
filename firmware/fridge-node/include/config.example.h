// Copy to config.h (git-ignored) and edit, or run `node tools/init_firmware_config.js` to generate it from .env.
// Without config.h the firmware builds with these placeholder values (and a compiler warning): the node runs and
// connects, but the server rejects its messages because DEVICE_SECRETS holds no real secret.
// Never commit real secrets: config.h is git-ignored, this file holds placeholders only.
#pragma once

// ---- network ----

#define WIFI_SSID "Wokwi-GUEST"  // Wokwi's simulated open network; real SSID on hardware
#define WIFI_PASS ""
#define NTP_SERVER "pool.ntp.org"

// Broker. Wokwi reaches the public internet but not your localhost, so use a cloud broker.
#define MQTT_HOST "xxxx.s1.eu.hivemq.cloud"
#define MQTT_PORT 8883
#define MQTT_TLS 1  // 1 = WiFiClientSecure (port 8883), 0 = plain TCP (e.g. broker.hivemq.com:1883 for quick tests)
#define MQTT_USER ""
#define MQTT_PASS ""
#define MQTT_TOPIC_PREFIX "coldchain/v1"  // use a unique prefix on shared brokers

// TLS server check. The simulator accepts any certificate (Wokwi has no trust store and the cluster CA may
// change); a real deployment must remove ALLOW_INSECURE_TLS and pin the broker's root CA instead, e.g.
// HiveMQ Cloud uses Let's Encrypt, so paste the ISRG Root X1 PEM:
//   #define MQTT_CA_CERT "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"
#define ALLOW_INSECURE_TLS

// ---- device identity ----
// FRIDGE_ID comes from the PlatformIO env (fridge-01 / fridge-02); define it here only for a custom board.
// One config.h serves both Wokwi projects, so secrets are listed per device id (64 hex chars each, the same
// values the backend stores for the device).
#define DEVICE_SECRETS                                                                 \
  {                                                                                    \
    {"fridge-01", "0000000000000000000000000000000000000000000000000000000000000000"}, \
    {"fridge-02", "0000000000000000000000000000000000000000000000000000000000000000"}, \
  }

// ---- real-hardware switches: same pins, only these values change ----

// #define RELAY_ACTIVE_HIGH 0      // most blue 5 V relay boards switch on LOW
// #define DOOR_OPEN_LEVEL 1        // reed switch to GND: magnet present (door closed) = LOW
// #define MODE_MANUAL_LEVEL 0      // tie GPIO23 to GND and set 0 to always use the DS18B20 probe
// #define BUZZER_IS_ACTIVE 1       // active buzzer module instead of a passive piezo
// #define OLED_I2C_ADDR 0x3D       // some 128x64 modules ship at 0x3D
// #define OLED_I2C_HZ 400000UL     // default 800 kHz; drop to spec if the screen shows garbage

// Power-fail input. 0 = simulator push button that toggles MAINS/BATTERY (Wokwi).
// 1 = real mains-sense level on GPIO32 (HIGH = mains present), e.g. a 10k/20k divider from the 5 V adapter rail.
// Honoured by the firmware from P05.
// #define POWER_SENSE_IS_LEVEL 1
