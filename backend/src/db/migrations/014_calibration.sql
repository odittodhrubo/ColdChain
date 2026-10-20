-- P4: the last sensor calibration offset accepted for a device, in °C (bounded to ±CALIBRATION_MAX_C). Shown on
-- the fridge detail page. The device holds the authoritative copy in NVS; this mirrors the last SET_CALIBRATION.
ALTER TABLE devices ADD COLUMN calibration_offset_c REAL NOT NULL DEFAULT 0;
