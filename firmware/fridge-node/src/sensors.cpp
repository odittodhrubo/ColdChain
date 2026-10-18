#include "sensors.h"

#include <Arduino.h>
#include <DallasTemperature.h>
#include <OneWire.h>

#include "node_config.h"
#include "pins.h"

namespace {
OneWire oneWire(pins::PIN_DS18B20);
DallasTemperature ds(&oneWire);
DeviceAddress addr;
bool present = false;
bool pending = false;
bool lastBad = true;
float lastTemp = NAN;
uint32_t requestedAt = 0;
uint32_t lastValidAt = 0;
uint32_t lastSearchAt = 0;

bool valid(float t) { return t != DEVICE_DISCONNECTED_C && t != 85.0f && t > -55.0f && t < 125.0f; }

// Cache the address: getTempCByIndex() runs a full 1-Wire search on every call.
void search() {
  ds.begin();
  ds.setWaitForConversion(false);
  present = ds.getAddress(addr, 0);
  pending = false;
}

void accept(float t, uint32_t now_ms) {
  lastBad = !valid(t);
  if (lastBad) return;
  lastTemp = t;
  lastValidAt = now_ms;
}
}  // namespace

namespace sensors {

void begin() {
  search();
  if (!present) return;
  ds.setWaitForConversion(true);  // setup() only: blocking is fine before the loop starts
  ds.requestTemperaturesByAddress(addr);
  ds.setWaitForConversion(false);
  accept(ds.getTempC(addr), millis());
}

void update(uint32_t now_ms) {
  if (!present) {
    lastBad = true;
    if (now_ms - lastSearchAt >= cfg::DS_STALE_MS) {  // probe plugged back in?
      lastSearchAt = now_ms;
      search();
    }
    return;
  }
  if (!pending) {
    ds.requestTemperaturesByAddress(addr);
    requestedAt = now_ms;
    pending = true;
  } else if (now_ms - requestedAt >= cfg::DS_CONVERSION_MS) {
    pending = false;
    const float t = ds.getTempC(addr);
    accept(t, now_ms);
    if (t == DEVICE_DISCONNECTED_C) present = false;
  }
}

float tempC() { return lastTemp; }

bool fault() { return !present || lastBad || millis() - lastValidAt >= cfg::DS_STALE_MS; }

}  // namespace sensors
