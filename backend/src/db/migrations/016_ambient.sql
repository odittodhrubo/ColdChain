-- A3: room temperature from an optional second DS18B20 outside the fridge. Nullable: nodes without the sensor
-- (Wokwi, single-sensor nodes) simply never send it. It becomes an ML feature only on a hardware retrain.
ALTER TABLE readings ADD COLUMN ambient REAL;
