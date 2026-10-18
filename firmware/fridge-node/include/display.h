// 128x64 SSD1306 status screen:
//   FRIDGE-01            SAFE      header, inverted video on BREACH
//   4.6 °C                         large temperature (or SENSOR FAULT)
//   DOOR:CLOSED COMP:ON
//   PWR:MAINS BAT:100%
//   <footer>                       reserved for connectivity (WIFI/MQTT/BUF, P03/P05); shows the mode until then
// Redraws at 2 Hz, or at once when a discrete field changes; never every loop (I2C transfer is ~12 ms).
#pragma once
#include <stdint.h>

#include "status.h"

struct DisplayData {
  FridgeState state;
  float temp;
  bool sensorFault;
  bool doorOpen;
  bool compOn;
  bool onBattery;
  uint8_t battPct;
  bool manualMode;
};

namespace display {
bool begin(const char* fridge_id);  // false if no SSD1306 answers at OLED_I2C_ADDR
void update(const DisplayData& d, uint32_t now_ms);
}  // namespace display
