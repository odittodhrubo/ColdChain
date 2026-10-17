# Scenario: Wi-Fi outage, offline buffer and ordered sync (video)

Shows Task 3: the node keeps measuring through a network outage, buffers every reading, and delivers all of them in order, without gaps or duplicates, when the link returns.

## Before you start

- Build and start `fridge-01` (`pio run -e fridge-01`, then **Wokwi: Start Simulator** on `wokwi/fridge-01/diagram.json`). `config.h` must point at the same broker as the backend (`node tools/init_firmware_config.js`).
- Wait for the OLED footer to show `WIFI√ MQTT√ SEQ nnnn` (after `SYNCING TIME`), and the dashboard to show live readings for fridge-01.
- Optional, for a busier chart: type `set speed 4` in the serial monitor so the compressor cycles faster.

## Steps

| # | Do | Expect |
|---|---|---|
| 1 | Press **WI-FI OUTAGE** (blue button, or key `w`) | Serial: `[wifi] simulated outage ON`, `[event] WIFI_LOST`. OLED footer: `OFFLINE buf:1`. Dashboard: fridge-01 goes stale / offline |
| 2 | Wait about **3–4 minutes**. While waiting, toggle **DOOR** open and closed once | `buf:` grows by one every 5 s, plus the door events and door-reason readings; aim for **40+** (about 3.5 min). The compressor keeps cycling: the control loop does not depend on the network |
| 3 | Type `status` in the serial monitor | `buffer N / 720  dropped 0` |
| 4 | Press **WI-FI OUTAGE** again | `[wifi] simulated outage OFF`, then after reconnecting `[event] WIFI_BACK`. Footer `SYNC buf:N`, serial `[sync] seq a..b (25 readings)` followed by `[ack] seq_upto b: freed 25`, chunk after chunk |
| 5 | Watch the dashboard | the gap fills in with the buffered readings, in seq order, and the door open/close events appear at their original times. The footer returns to `WIFI√ MQTT√ SEQ nnnn` when `buf` reaches 0 |
| 6 | (P09 onwards) check the database | `SELECT seq FROM readings WHERE device_id='fridge-01' ORDER BY seq` has no gaps and no repeats across the outage |

## Why this proves the requirement

- **30 minutes of capacity:** 30 min at one reading per 5 s = **360** readings. The buffer holds **720** (60 min, `BUFFER_CAPACITY`). Waiting 30 real minutes in a video is impractical, so the capacity is proved by the native tests instead (`pio test -e native -f test_offline`):
  - `test_capacity_covers_30_minutes_twice`: 360 readings kept, none dropped;
  - `test_sync_full_30_minute_outage`: a full 30-minute outage synced over a link that loses 30 % of chunks and 30 % of acks, with every seq delivered exactly once and in order;
  - `test_overflow_drops_oldest_and_counts`: beyond 60 minutes the oldest readings are overwritten and counted. The count is reported as `dropped` in the next telemetry.
- **No loss:** entries are freed only after a verified ack; a missing ack resends the same chunk after 5 s (fresh `ts` and `nonce`, so it is never rejected as a replay).
- **No duplicates:** the server stores by `UNIQUE(device_id, seq)` and re-acks a resent chunk.

## Related scenarios (same circuit)

- **Power failure:** press **POWER FAIL** (`p`). `PWR:BATTERY BAT:nn%`, compressor forced OFF, status WARNING, `POWER_FAIL`. Press again: `POWER_RESTORE`, and the compressor stays off for at least 60 s (min-off). A demo build with `-DBATT_DRAIN_PCT_PER_MIN=6` reaches `BATT_LOW` at 20 % after about 13 min and DEAD after about 17 min. DEAD turns the OLED off; restoring power sends `BOOT` and continues from the persisted seq.
- **Door alarm:** slide **DOOR** open and leave it for more than 60 s. The buzzer beeps 200 ms on / 200 ms off, the OLED shows `DOOR OPEN!`, and one `DOOR_ALARM` event is sent (buffered too, if offline). Closing the door silences it and sends `DOOR_CLOSE`.
