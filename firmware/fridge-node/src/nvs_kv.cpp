// NVS-backed Kv (ESP32 only).
#ifdef ARDUINO
#include <Preferences.h>

#include "kv.h"

namespace {
class NvsKv : public Kv {
 public:
  uint32_t getU32(const char* key, uint32_t fallback) override {
    open();
    return prefs_.getUInt(key, fallback);
  }
  void putU32(const char* key, uint32_t value) override {
    open();
    prefs_.putUInt(key, value);
  }
  bool getStr(const char* key, char* out, size_t cap) override {
    open();
    if (!prefs_.isKey(key)) return false;
    const size_t n = prefs_.getString(key, out, cap);
    return n > 0 && n < cap;
  }
  void putStr(const char* key, const char* value) override {
    open();
    prefs_.putString(key, value);
  }

 private:
  void open() {
    if (!open_) open_ = prefs_.begin("coldchain", false);
  }
  Preferences prefs_;
  bool open_ = false;
};
}  // namespace

Kv& nvs::store() {
  static NvsKv kv;
  return kv;
}
#endif
