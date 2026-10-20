// Persistent key-value store seam: NVS (Preferences) on the ESP32, an in-memory fake in native tests.
#pragma once
#include <stdint.h>
#include <string.h>

class Kv {
 public:
  virtual ~Kv() = default;
  virtual uint32_t getU32(const char* key, uint32_t fallback) = 0;
  virtual void putU32(const char* key, uint32_t value) = 0;
  // Strings (the rotated device secret, S7): true and a NUL-terminated copy in out when the key exists and fits.
  virtual bool getStr(const char* key, char* out, size_t cap) = 0;
  virtual void putStr(const char* key, const char* value) = 0;
};

#ifdef ARDUINO
namespace nvs {
Kv& store();  // namespace "coldchain", opened on first use
}
#else
// Fake NVS for tests: counts writes so flash-wear throttling can be asserted.
class MemKv : public Kv {
 public:
  uint32_t getU32(const char* key, uint32_t fallback) override {
    for (int i = 0; i < n_; i++)
      if (strcmp(keys_[i], key) == 0) return vals_[i];
    return fallback;
  }
  void putU32(const char* key, uint32_t value) override {
    writes++;
    for (int i = 0; i < n_; i++)
      if (strcmp(keys_[i], key) == 0) {
        vals_[i] = value;
        return;
      }
    if (n_ < 16) {
      strncpy(keys_[n_], key, sizeof keys_[0] - 1);
      vals_[n_++] = value;
    }
  }
  bool getStr(const char* key, char* out, size_t cap) override {
    for (int i = 0; i < sn_; i++)
      if (strcmp(skeys_[i], key) == 0 && strlen(svals_[i]) < cap) {
        strcpy(out, svals_[i]);
        return true;
      }
    return false;
  }
  void putStr(const char* key, const char* value) override {
    writes++;
    for (int i = 0; i < sn_; i++)
      if (strcmp(skeys_[i], key) == 0) {
        strncpy(svals_[i], value, sizeof svals_[0] - 1);
        return;
      }
    if (sn_ < 4) {
      strncpy(skeys_[sn_], key, sizeof skeys_[0] - 1);
      strncpy(svals_[sn_++], value, sizeof svals_[0] - 1);
    }
  }
  int writes = 0;

 private:
  char keys_[16][16] = {};
  uint32_t vals_[16] = {};
  int n_ = 0;
  char skeys_[4][16] = {};
  char svals_[4][80] = {};
  int sn_ = 0;
};
#endif
