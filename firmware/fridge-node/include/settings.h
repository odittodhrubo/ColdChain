// Board settings: config.h (git-ignored, real secrets) if present, otherwise the committed placeholders.
#pragma once

// COLDCHAIN_HAS_CONFIG_H comes from config_check.py (a bare __has_include would also match other libraries' config.h).
#ifdef COLDCHAIN_HAS_CONFIG_H
#include "config.h"
#else
#ifdef ARDUINO
#warning "include/config.h not found: using config.example.h placeholders (run node tools/init_firmware_config.js)"
#endif
#include "config.example.h"
#endif

#if defined(ARDUINO) && (!defined(WIFI_SSID) || !defined(MQTT_HOST) || !defined(DEVICE_SECRETS))
#error "config.h predates P03: copy the network and DEVICE_SECRETS sections from config.example.h"
#endif
