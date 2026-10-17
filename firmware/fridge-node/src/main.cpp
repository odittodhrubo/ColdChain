// P00 placeholder: boots and reports identity. Control loop arrives in P02, networking in P03.
#include <Arduino.h>

#include "constants.h"

#ifndef FRIDGE_ID
#error "FRIDGE_ID must be set via build_flags in platformio.ini"
#endif

void setup() {
  Serial.begin(115200);
  Serial.printf("ColdChain node %s booting (telemetry every %us)\n", FRIDGE_ID, cc::TELEMETRY_PERIOD_S);
}

void loop() {}
