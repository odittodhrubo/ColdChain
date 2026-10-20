// Compressor control: hysteresis (ON at T >= 7.0, OFF at T <= 3.0) with a 60 s minimum off-time.
// Pure logic driven by a caller-supplied millisecond clock, so the native tests use a fake clock.
// All time checks use unsigned subtraction (now - since), which stays correct across the 49-day millis() rollover.
#pragma once
#include <stdint.h>

class CompressorControl {
 public:
  // Call every loop. force_off: power failure (P05) or DEAD battery; it holds the min-off timer
  // at zero, so the compressor waits 60 s after power returns (a flapping supply cannot short-cycle it).
  // sensor_fault: temperature unknown, so run the fail-safe duty cycle (5 min ON / 10 min OFF) instead.
  // Returns true when the compressor state changed on this call.
  bool update(float temp, bool sensor_fault, bool force_off, uint32_t now_ms);

  // Call once at boot. A reboot is an OFF the controller never saw (the relay de-energises): no start for
  // COMP_MIN_OFF_S after it, so a watchdog reset or brownout mid-cycle cannot short-cycle the compressor.
  // Without it (the native tests, the ML data generator) boot counts the min-off as already satisfied.
  void bootLock(uint32_t now_ms) {
    boot_locked_ = true;
    boot_at_ms_ = now_ms;
  }

  bool on() const { return on_; }
  // True when the min-off rule is what keeps the compressor off (shown on the console).
  bool waitingMinOff(uint32_t now_ms) const { return !on_ && !minOffElapsed(now_ms); }

 private:
  bool minOffElapsed(uint32_t now_ms) const;
  void set(bool on, uint32_t now_ms);

  bool on_ = false;
  bool has_switched_off_ = false;  // false at boot: the min-off timer counts as already satisfied
  uint32_t changed_at_ms_ = 0;     // time of the last ON or OFF transition
  bool boot_locked_ = false;       // bootLock() was called and its 60 s have not passed yet
  uint32_t boot_at_ms_ = 0;
};
