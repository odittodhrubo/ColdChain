#include "display.h"

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <Wire.h>
#include <ctype.h>
#include <string.h>

#include "node_config.h"
#include "pins.h"

namespace {
Adafruit_SSD1306 oled(128, 64, &Wire, -1, OLED_I2C_HZ, 100000UL);
bool ok = false;
char title[16];
DisplayData shown;
bool drawnOnce = false;
uint32_t lastDrawAt = 0;

constexpr uint8_t DEGREE = 248;  // degree sign in the CP437 font
constexpr uint8_t CHECK = 251;   // square-root sign, the closest CP437 glyph to a check mark

bool discreteChanged(const DisplayData& a, const DisplayData& b) {
  return a.state != b.state || a.sensorFault != b.sensorFault || a.doorOpen != b.doorOpen || a.compOn != b.compOn ||
         a.onBattery != b.onBattery || a.battPct != b.battPct || a.manualMode != b.manualMode || a.wifi != b.wifi ||
         a.mqtt != b.mqtt || a.netNote != b.netNote || a.latch != b.latch || a.atRisk != b.atRisk ||
         a.budgetPct != b.budgetPct || a.doorAlarm != b.doorAlarm;
}

void draw(const DisplayData& d) {
  oled.clearDisplay();
  oled.setTextSize(1);

  const bool breach = d.state == FridgeState::BREACH;
  if (breach) oled.fillRect(0, 0, 128, 10, SSD1306_WHITE);
  oled.setTextColor(breach ? SSD1306_BLACK : SSD1306_WHITE);
  oled.setCursor(1, 1);
  oled.print(title);
  oled.print(d.manualMode ? " MAN" : " SIM");
  const char* word = stateName(d.state);
  oled.setCursor(127 - 6 * strlen(word), 1);
  oled.print(word);
  oled.setTextColor(SSD1306_WHITE);

  oled.setTextSize(2);
  oled.setCursor(0, 13);
  if (d.sensorFault || isnan(d.temp)) {
    oled.print("--.-");
  } else {
    oled.printf("%.1f", d.temp);
  }
  oled.setCursor(oled.getCursorX() + 2, 13);
  oled.write(DEGREE);
  oled.print("C");

  // Status line, most urgent first.
  oled.setTextSize(1);
  oled.setCursor(0, 31);
  if (d.sensorFault) {
    oled.print("SENSOR FAULT");
  } else if (d.doorAlarm) {
    oled.print("DOOR OPEN!");
  } else if (d.latch) {
    oled.print("DISCARD - RESET REQ");
  } else if (d.atRisk) {
    oled.printf("AT RISK %u%%", d.budgetPct);
  } else {
    oled.printf("BUDGET %u%%", d.budgetPct);
  }

  oled.setCursor(0, 40);
  oled.printf("DOOR:%s COMP:%s", d.doorOpen ? "OPEN" : "CLOSED", d.compOn ? "ON" : "OFF");
  oled.setCursor(0, 48);
  oled.printf("PWR:%s BAT:%u%%", d.onBattery ? "BATTERY" : "MAINS", d.battPct);
  oled.setCursor(0, 56);
  if (d.netNote) {
    oled.print(d.netNote);
  } else {
    oled.print("WIFI");
    oled.write(d.wifi ? CHECK : 'x');
    oled.print(" MQTT");
    oled.write(d.mqtt ? CHECK : 'x');
    oled.printf(" SEQ %lu", static_cast<unsigned long>(d.seq));
  }
  oled.display();
}
}  // namespace

namespace display {

bool begin(const char* fridge_id) {
  Wire.begin(pins::PIN_I2C_SDA, pins::PIN_I2C_SCL);
  ok = oled.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR);
  if (!ok) return false;
  size_t i = 0;
  for (; fridge_id[i] && i < sizeof(title) - 1; i++) title[i] = toupper(static_cast<unsigned char>(fridge_id[i]));
  title[i] = '\0';
  oled.cp437(true);
  oled.clearDisplay();
  oled.display();
  return true;
}

void setPower(bool on) {
  if (!ok) return;
  oled.ssd1306_command(on ? SSD1306_DISPLAYON : SSD1306_DISPLAYOFF);
  if (on) drawnOnce = false;  // redraw at the next update
}

void update(const DisplayData& d, uint32_t now_ms) {
  if (!ok) return;
  if (drawnOnce && !discreteChanged(d, shown) && now_ms - lastDrawAt < cfg::OLED_REFRESH_MS) return;
  draw(d);
  shown = d;
  drawnOnce = true;
  lastDrawAt = now_ms;
}

}  // namespace display
