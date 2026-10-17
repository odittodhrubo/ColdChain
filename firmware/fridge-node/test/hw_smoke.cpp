// Hardware smoke test (P01): proves every part of the fridge-node circuit is wired correctly
// before the real firmware exists. Build/flash:  pio run -e hw-smoke   (Wokwi: wokwi/hw-smoke/)
//
// What it does, all non-blocking on millis():
//   - chases green -> yellow -> red -> blue LEDs, 400 ms each
//   - toggles the compressor relay every 2 s
//   - beeps the buzzer every 5 s
//   - reads the DS18B20 (async, every 1.6 s) and explains -127 / 85 readings
//   - prints every RAW input transition with the time since the previous one (shows switch bounce)
//   - draws a live test screen on the OLED at 4 Hz
// Compiled only for the ESP32 (the native unit-test env skips it).
#ifdef ARDUINO

#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Arduino.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <Wire.h>

#include "pins.h"

using namespace pins;

namespace {

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
OneWire oneWire(PIN_DS18B20);
DallasTemperature ds(&oneWire);
bool oledOk = false;

struct Input {
  const char* name;
  uint8_t pin;
  int level;
  uint32_t lastChangeUs;
  uint32_t transitions;
};
Input inputs[] = {
    {"DOOR", PIN_DOOR, -1, 0, 0},
    {"POWER_BTN", PIN_BTN_POWER, -1, 0, 0},
    {"WIFI_BTN", PIN_BTN_WIFI, -1, 0, 0},
    {"MODE", PIN_MODE, -1, 0, 0},
};

const uint8_t leds[] = {PIN_LED_GREEN, PIN_LED_YELLOW, PIN_LED_RED, PIN_LED_BLUE};
const char* const ledNames[] = {"GREEN", "YELLOW", "RED", "BLUE"};
uint8_t ledIndex = 0;
bool relayOn = false;
float lastTemp = NAN;
const char* tempNote = "waiting";
bool conversionPending = false;

uint32_t tLed = 0, tRelay = 0, tBeep = 0, tTemp = 0, tOled = 0;

bool every(uint32_t& last, uint32_t periodMs) {
  uint32_t now = millis();
  if (now - last < periodMs) return false;  // unsigned subtraction: rollover-safe
  last = now;
  return true;
}

void setRelay(bool on) {
  relayOn = on;
  digitalWrite(PIN_RELAY, (on == (RELAY_ACTIVE_HIGH != 0)) ? HIGH : LOW);
  Serial.printf("[relay] %s\n", on ? "ON (compressor running)" : "OFF");
}

void beep(uint32_t ms) {
#if BUZZER_IS_ACTIVE
  digitalWrite(PIN_BUZZER, HIGH);  // loop() switches it off after 150 ms
#else
  tone(PIN_BUZZER, 2000, ms);
#endif
  Serial.printf("[buzzer] beep %lu ms\n", static_cast<unsigned long>(ms));
}

void scanI2C() {
  Serial.print("[i2c] devices found:");
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf(" 0x%02X", addr);
      found++;
    }
  }
  Serial.println(found ? "" : " none (check SDA=21, SCL=22, VCC, GND)");
}

void pollInputs() {
  for (Input& in : inputs) {
    int level = digitalRead(in.pin);
    if (level == in.level) continue;
    uint32_t nowUs = micros();
    if (in.level >= 0) {
      in.transitions++;
      Serial.printf("[input] %-9s %s  dt=%lu us  (#%lu)\n", in.name, level ? "HIGH" : "LOW ",
                    static_cast<unsigned long>(nowUs - in.lastChangeUs), static_cast<unsigned long>(in.transitions));
    }
    in.level = level;
    in.lastChangeUs = nowUs;
  }
}

void readTemperature() {
  if (!conversionPending) {
    ds.requestTemperatures();  // async: setWaitForConversion(false)
    conversionPending = true;
    return;
  }
  conversionPending = false;
  lastTemp = ds.getTempCByIndex(0);
  if (lastTemp == DEVICE_DISCONNECTED_C) {
    tempNote = "NO SENSOR";
    Serial.println("[ds18b20] -127 C = no device: check DQ on GPIO4 and the 4.7k pull-up to 3V3");
  } else if (lastTemp == 85.0f) {
    tempNote = "RESET 85";
    Serial.println("[ds18b20] 85 C = power-on value, conversion not finished (or supply too weak)");
  } else {
    tempNote = "OK";
    Serial.printf("[ds18b20] %.2f C\n", lastTemp);
  }
}

const char* show(uint8_t pin, int activeLevel, const char* active, const char* idle) {
  return digitalRead(pin) == activeLevel ? active : idle;
}

void drawScreen() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.fillRect(0, 0, 128, 10, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oled.print(" HW SMOKE TEST");
  oled.setTextColor(SSD1306_WHITE);
  oled.setCursor(0, 13);
  if (isnan(lastTemp) || lastTemp == DEVICE_DISCONNECTED_C) {
    oled.printf("TEMP: %s", tempNote);
  } else {
    oled.printf("TEMP: %.2f C %s", lastTemp, tempNote);
  }
  oled.setCursor(0, 24);
  oled.printf("DOOR:%s MODE:%s", show(PIN_DOOR, DOOR_OPEN_LEVEL, "OPEN  ", "CLOSED"),
              show(PIN_MODE, MODE_MANUAL_LEVEL, "MAN", "MOD"));
  oled.setCursor(0, 35);
  oled.printf("PWR:%s WIFI:%s", show(PIN_BTN_POWER, LOW, "DOWN", "up  "), show(PIN_BTN_WIFI, LOW, "DOWN", "up"));
  oled.setCursor(0, 46);
  oled.printf("RELAY:%s LED:%s", relayOn ? "ON " : "OFF", ledNames[ledIndex]);
  oled.drawRect(0, 56, 128, 8, SSD1306_WHITE);
  oled.fillRect(2, 58, (millis() / 40) % 124, 4, SSD1306_WHITE);  // moving bar = loop alive
  oled.display();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== ColdChain hardware smoke test ===");

  for (uint8_t pin : leds) pinMode(pin, OUTPUT);
  pinMode(PIN_RELAY, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  for (Input& in : inputs) pinMode(in.pin, INPUT_PULLUP);
  setRelay(false);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  scanI2C();
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR);
  if (oledOk) {
    oled.clearDisplay();
    oled.fillRect(0, 0, 128, 64, SSD1306_WHITE);  // all-pixels test
    oled.display();
    Serial.printf("[oled] SSD1306 OK at 0x%02X\n", OLED_I2C_ADDR);
  } else {
    Serial.printf("[oled] SSD1306 NOT found at 0x%02X: wrong address gives a blank screen\n", OLED_I2C_ADDR);
  }

  ds.begin();
  ds.setWaitForConversion(false);
  Serial.printf("[ds18b20] %u device(s) on GPIO%u\n", ds.getDeviceCount(), PIN_DS18B20);

  pollInputs();  // capture initial levels
  for (const Input& in : inputs) Serial.printf("[input] %-9s initial %s\n", in.name, in.level ? "HIGH" : "LOW");
  Serial.println("Toggle DOOR / MODE switches and press POWER FAIL / WI-FI OUTAGE to see raw transitions.");
}

void loop() {
  pollInputs();

  if (every(tLed, 400)) {
    digitalWrite(leds[ledIndex], LOW);
    ledIndex = (ledIndex + 1) % 4;
    digitalWrite(leds[ledIndex], HIGH);
  }
  if (every(tRelay, 2000)) setRelay(!relayOn);
  if (every(tBeep, 5000)) beep(150);
#if BUZZER_IS_ACTIVE
  if (millis() - tBeep >= 150) digitalWrite(PIN_BUZZER, LOW);
#endif
  if (every(tTemp, 800)) readTemperature();  // request, then read 800 ms later (12-bit takes 750 ms)
  if (every(tOled, 250)) drawScreen();
}

#endif  // ARDUINO
