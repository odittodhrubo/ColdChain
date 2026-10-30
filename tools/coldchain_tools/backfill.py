"""Seeded history: realistic real-world refrigeration telemetry written straight into the backend database.

Used by the demo (so charts and forecasts have realistic context from the first minute) and by the
scenario tests. The UI labels these rows "seeded demo history"; they never pass for device data.
Negative seq numbers keep them clear of anything a node sends.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sqlite3
import time
import zlib

from .contracts import C, firmware_config

F = firmware_config()

COLS = (
    "device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, reason, "
    "received_at, seeded"
)
EVENT_COLS = "device_id, fridge_id, seq, ts, type, data, late, received_at"


def simulate_realistic_history(
    fid: str,
    device_id: str,
    start_ts: int,
    end_ts: int,
    eff: float = 1.0,
    seed: int = 5,
    dt: float = 5.0,
) -> tuple[list[tuple], float, list[tuple]]:
    """Simulates realistic, non-harmonic, real-world refrigerator telemetry and events.

    Features:
    - Diurnal ambient temperature curve (day vs. night) with smooth random walk drift
    - Thermostat stochastic hysteresis: fluctuating cut-in (5.9-6.95 °C) and cut-out (2.9-3.85 °C)
      setpoints so no two cycles share the same amplitude or duration
    - Realistic daytime clinic door openings (10-26s every 20-50 min during working hours)
      introducing natural thermal influx spikes
    - Thermal convection and analog ADC measurement noise
    - Safe-range enforcement for healthy units; gradual heat accumulation and latch for degraded units
    """
    rng = random.Random(seed ^ zlib.crc32(fid.encode()))
    total_steps = max(1, int((end_ts - start_ts) / dt))
    is_weak = eff < 0.8

    # Initial state: two-node thermal model (chamber air and high-mass buffered probe)
    t_air = (6.0 if is_weak else 4.9) + rng.uniform(-0.2, 0.2)
    t_probe = t_air
    comp = 0
    comp_changed_at = 0.0
    min_off_s = rng.uniform(2400, 4800)  # 40 to 80 min of resting/plateau
    target_on = rng.uniform(5.4, 6.0) if not is_weak else rng.uniform(6.8, 7.5)
    target_off = rng.uniform(4.0, 4.5) if not is_weak else rng.uniform(4.8, 5.5)
    amb_drift = 0.0
    exp_s = 0.0
    latched = False

    # Schedule realistic clinic door events during working hours (08:00 - 19:30)
    door_intervals: list[tuple[float, float]] = []
    t_door = 0.0
    span_s = float(end_ts - start_ts)
    while t_door < span_s - 300:
        cur_hour = ((start_ts + t_door) / 3600.0) % 24
        if 8.0 <= cur_hour <= 19.5:
            t_door += rng.uniform(1800, 3600)  # every 30 to 60 min
            dur = rng.uniform(12, 35)  # 12 to 35 seconds open
            door_intervals.append((t_door, t_door + dur))
        else:
            t_door += 3600.0  # night time: staff absent, quiet

    rows = []
    events = []
    prev_door = False
    prev_comp = comp
    seq = 1

    for step in range(total_steps):
        cur_t = step * dt
        ts = start_ts + int(cur_t)
        hour = (ts / 3600.0) % 24

        # Diurnal ambient temperature: warm afternoon (~25-27°C), cooler night (~20-22°C) + slow drift
        amb_base = (26.0 if is_weak else 23.0) + 2.5 * math.sin(2 * math.pi * (hour - 9) / 24)
        amb_drift += rng.gauss(0, 0.005) - 0.001 * amb_drift
        t_amb = amb_base + amb_drift

        # Check door state
        door_open = any(t_s <= cur_t <= t_e for t_s, t_e in door_intervals)
        door = 1 if door_open else 0

        # Door state change events
        if door_open and not prev_door:
            events.append(
                (device_id, fid, -start_ts * 100_000 - seq, ts, "DOOR_OPEN", json.dumps({"reason": "clinic"}), 0, ts * 1000)
            )
        elif not door_open and prev_door:
            events.append(
                (device_id, fid, -start_ts * 100_000 - seq, ts, "DOOR_CLOSE", json.dumps({"reason": "clinic"}), 0, ts * 1000)
            )
        prev_door = door_open

        # Physics: high-mass insulated cabinet with slow natural leak and gentle cooling
        k_leak = (0.00007 if not is_weak else 0.00018) * (1.0 + rng.gauss(0, 0.008))
        k_door = 0.0022 if not is_weak else 0.0035
        cool_rate = (0.0024 if not is_weak else 0.0011) * eff * (1.0 + rng.gauss(0, 0.008))

        gap = t_amb - t_air
        dtdt = k_leak * gap + (k_door * gap if door else 0.0) - (cool_rate if comp else 0.0)
        t_air += dtdt * dt + rng.gauss(0, 0.006)

        # Thermal inertia: probe immersed in liquid/thermal mass (low-pass filter, tau ~ 150 s)
        alpha = dt / (150.0 + dt)
        t_probe += alpha * (t_air - t_probe)

        # Thermostat hysteresis with organic plateaus and gentle cycles
        time_since_change = cur_t - comp_changed_at
        if comp:
            if t_probe <= target_off or time_since_change > (2400 if not is_weak else 1800):
                comp = 0
                comp_changed_at = cur_t
                min_off_s = rng.uniform(2200, 4800)  # 36 to 80 min rest/plateau
                target_on = rng.uniform(5.3, 5.9) if not is_weak else rng.uniform(6.8, 7.5)
        else:
            can_start = time_since_change >= 60.0
            if can_start and ((t_probe >= target_on and time_since_change >= min_off_s) or t_probe >= 6.3):
                comp = 1
                comp_changed_at = cur_t
                target_off = rng.uniform(4.0, 4.5) if not is_weak else rng.uniform(4.8, 5.5)

        if comp != prev_comp:
            events.append(
                (device_id, fid, -start_ts * 100_000 - seq, ts, "COMP_ON" if comp else "COMP_OFF", "{}", 0, ts * 1000)
            )
            prev_comp = comp

        # Heat exposure tracking based on probe temperature
        if t_probe > C["DOUBLE_ABOVE_C"]:
            exp_s += 2.0 * dt
        elif t_probe > C["SAFE_MAX_C"]:
            exp_s += 1.0 * dt

        if is_weak and exp_s >= C["BUDGET_S"] and not latched:
            latched = True
            events.append(
                (device_id, fid, -start_ts * 100_000 - seq, ts, "LATCH_SET", json.dumps({"exp_s": int(exp_s)}), 0, ts * 1000)
            )

        # Measurement ADC noise
        reading_temp = round(t_probe + rng.gauss(0, 0.02), 2)
        if reading_temp > C["SAFE_MAX_C"] or reading_temp < C["SAFE_MIN_C"]:
            state = "BREACH"
        elif reading_temp > C["WARN_HIGH_C"] or reading_temp < C["WARN_LOW_C"] or door:
            state = "WARNING"
        else:
            state = "SAFE"

        # Unique negative sequence number for backfilled data
        neg_seq = -start_ts * 100_000 + seq
        reason = "door" if door else "periodic"
        rows.append(
            (
                device_id,
                fid,
                neg_seq,
                ts,
                reading_temp,
                door,
                comp,
                "MAINS",
                100,
                state,
                int(exp_s),
                int(latched),
                "model",
                reason,
                ts * 1000,
                1,
            )
        )
        seq += 1

    last_temp = rows[-1][4]
    return rows, last_temp, events


def backfill(
    db_path: str,
    hours: float,
    fridges: dict[str, float],
    end_ts: int | None = None,
    seed: int = 5,
) -> dict[str, float]:
    """Writes `hours` of telemetry ending at end_ts (default now) for each fridge (value = compressor
    efficiency). Returns each fridge's last temperature, so a live node can carry on from it."""
    end = end_ts or int(time.time())
    start = end - int(hours * 3600)
    db = sqlite3.connect(db_path, timeout=10)
    last: dict[str, float] = {}
    try:
        for fid, eff in fridges.items():
            sql = "SELECT device_id FROM devices WHERE fridge_id = ? LIMIT 1"
            device = db.execute(sql, (fid,)).fetchone()
            if not device:
                raise SystemExit(f"no device for {fid}: seed the database first")
            device_id = device[0]
            rows, last_temp, events = simulate_realistic_history(
                fid, device_id, start, end - 5, eff=eff, seed=seed
            )
            db.executemany(f"INSERT OR IGNORE INTO readings ({COLS}) VALUES ({','.join('?' * 16)})", rows)
            if events:
                db.executemany(f"INSERT OR IGNORE INTO events ({EVENT_COLS}) VALUES ({','.join('?' * 8)})", events)
            last[fid] = last_temp
        db.commit()
    finally:
        db.close()
    return last


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", required=True)
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--fridge", action="append", default=[], help="ID or ID=efficiency (default both, 1.0)")
    args = ap.parse_args(argv)
    fridges = {f.split("=")[0]: float(f.split("=")[1]) if "=" in f else 1.0 for f in args.fridge}
    last = backfill(args.db, args.hours, fridges or {"fridge-01": 1.0, "fridge-02": 1.0})
    ends = ", ".join(f"{k} ends at {v:.1f} °C" for k, v in last.items())
    print(f"seeded {args.hours} h of realistic history: {ends}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
