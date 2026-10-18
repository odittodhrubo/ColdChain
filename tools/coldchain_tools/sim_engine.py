"""Pure simulation core: a faithful Python port of the fridge-node firmware logic.

Same constants (contracts/constants.json), same firmware parameters (node_config.h, parsed), same algorithms:
thermal model, hysteresis with 60 s min-off, status classification, fridge-level exposure and latch, battery
model, door alarm, offline ring buffer, stop-and-wait sync. No MQTT and no wall clock here: callers pass the
time in, so the live virtual node (real clock) and the offline fast mode (virtual clock, P16 dataset) share
one model.
"""

from __future__ import annotations

import json
import math
import random
from collections import deque
from dataclasses import dataclass, field

from .contracts import C, firmware_config

F = firmware_config()

FW_VERSION = "1.0.0"
EVENT_TYPES = (
    "DOOR_OPEN", "DOOR_CLOSE", "DOOR_ALARM", "POWER_FAIL", "POWER_RESTORE", "BATT_LOW", "COMP_ON", "COMP_OFF",
    "LATCH_SET", "LATCH_RESET", "WIFI_LOST", "WIFI_BACK", "SENSOR_FAULT", "BOOT",
)  # fmt: skip


# ---------------------------------------------------------------- status and exposure (contract section 2)


def classify(temp: float | None, door_open: bool, on_battery: bool, sensor_fault: bool) -> str:
    if sensor_fault or temp is None or math.isnan(temp) or temp > C["SAFE_MAX_C"] or temp < C["SAFE_MIN_C"]:
        return "BREACH"
    if temp > C["WARN_HIGH_C"] or temp < C["WARN_LOW_C"]:
        return "WARNING"
    if door_open or on_battery:
        return "WARNING"
    return "SAFE"


def exposure_weight(temp: float) -> int:
    if temp > C["DOUBLE_ABOVE_C"]:
        return 2
    if temp > C["SAFE_MAX_C"]:
        return 1
    return 0


def remaining_pct(weighted_s: float) -> float:
    return max(0.0, 100.0 * (1.0 - weighted_s / C["BUDGET_S"]))


# ---------------------------------------------------------------- physics and control


THERMAL_PARAMS = ("T_AMBIENT_C", "K_LEAK_PER_S", "K_DOOR_PER_S", "COOL_RATE_C_PER_S", "NOISE_SIGMA_C")


class ThermalModel:
    """dT/dt = k_leak(Tamb-T) + door*k_door(Tamb-T) - comp*cool_rate*efficiency; Euler sub-steps <= 1 s.

    The firmware's parameters by default; `params` overrides some of THERMAL_PARAMS (dataset fridge profiles,
    P16) and may be changed between steps (a drifting ambient)."""

    def __init__(self, seed: int = 0x12345678, speed: float | None = None, params: dict | None = None):
        self.temp = F["T_INITIAL_C"]
        self.efficiency = 1.0
        self.speed = F["THERMAL_SPEED"] if speed is None else speed
        self.params = {k: F[k] for k in THERMAL_PARAMS} | (params or {})
        self._rng = random.Random(seed)

    def step(self, real_dt_s: float, door_open: bool, comp_on: bool) -> None:
        p = self.params
        remaining = real_dt_s * self.speed
        while remaining > 0:
            dt = min(remaining, F["MAX_STEP_S"])
            gap = p["T_AMBIENT_C"] - self.temp
            dtdt = p["K_LEAK_PER_S"] * gap
            if door_open:
                dtdt += p["K_DOOR_PER_S"] * gap
            if comp_on:
                dtdt -= p["COOL_RATE_C_PER_S"] * self.efficiency
            self.temp += dtdt * dt
            remaining -= dt

    def read(self) -> float:
        """Measurement noise only (sigma 0.03 C by default); the state itself never random-walks."""
        return self.temp + self._rng.gauss(0.0, self.params["NOISE_SIGMA_C"])


class CompressorControl:
    """ON at T >= 7.0, OFF at T <= 3.0, no restart within 60 s of the last OFF; fault duty 5 min ON/10 OFF."""

    def __init__(self):
        self.on = False
        self._has_switched_off = False  # boot: min-off counts as satisfied
        self._changed_at_ms = 0

    def _min_off_elapsed(self, now_ms: int) -> bool:
        return not self._has_switched_off or now_ms - self._changed_at_ms >= C["COMP_MIN_OFF_S"] * 1000

    def waiting_min_off(self, now_ms: int) -> bool:
        return not self.on and not self._min_off_elapsed(now_ms)

    def _set(self, on: bool, now_ms: int) -> None:
        self.on = on
        self._changed_at_ms = now_ms
        if not on:
            self._has_switched_off = True

    def update(self, temp: float | None, sensor_fault: bool, force_off: bool, now_ms: int) -> bool:
        was = self.on
        if force_off:
            self._set(False, now_ms)  # re-armed every call: min-off counts from when the force ends
        elif sensor_fault:
            in_state = now_ms - self._changed_at_ms
            if self.on and in_state >= F["FAULT_DUTY_ON_S"] * 1000:
                self._set(False, now_ms)
            elif (
                not self.on
                and self._min_off_elapsed(now_ms)
                and (not self._has_switched_off or in_state >= F["FAULT_DUTY_OFF_S"] * 1000)
            ):
                self._set(True, now_ms)
        elif self.on and temp <= C["COMP_OFF_AT_C"]:
            self._set(False, now_ms)
        elif not self.on and temp >= C["COMP_ON_AT_C"] and self._min_off_elapsed(now_ms):
            self._set(True, now_ms)
        return self.on != was


class HeatKeeper:
    """Fridge-level weighted exposure and DISCARD latch. A sensor fault counts as weight 1 (never under)."""

    def __init__(self, exp_s: float = 0.0, latched: bool = False):
        self.weighted = float(exp_s)
        self.latched = latched

    @property
    def exp_s(self) -> int:
        return int(self.weighted)

    @property
    def remaining_pct(self) -> float:
        return remaining_pct(self.weighted)

    @property
    def at_risk(self) -> bool:
        return not self.latched and self.remaining_pct < C["AT_RISK_PCT"]

    def update(self, temp: float | None, sensor_fault: bool, dt_s: float) -> bool:
        """True when this call set the latch."""
        weight = 1 if sensor_fault or temp is None or math.isnan(temp) else exposure_weight(temp)
        if dt_s > 0:
            self.weighted += weight * dt_s
        if not self.latched and self.exp_s >= C["BUDGET_S"]:
            self.latched = True
            return True
        return False

    def set_latch(self) -> bool:
        was = self.latched
        self.latched = True
        return not was

    def reset_latch(self) -> bool:
        was = self.latched
        self.latched = False
        self.weighted = 0.0
        return was


@dataclass
class PowerEvents:
    power_fail: bool = False
    power_restore: bool = False
    batt_low: bool = False
    died: bool = False
    revived: bool = False


class PowerModel:
    def __init__(self):
        self.pct_exact = 100.0
        self.on_battery = False
        self.dead = False
        self._low_sent = False

    @property
    def pct(self) -> int:
        return int(self.pct_exact + 0.5)

    def update(self, on_battery: bool, dt_s: float) -> PowerEvents:
        ev = PowerEvents()
        if on_battery != self.on_battery:
            self.on_battery = on_battery
            if on_battery:
                ev.power_fail = True
            else:
                ev.power_restore = True
                if self.dead:
                    self.dead = False
                    ev.revived = True
        minutes = dt_s / 60.0
        if self.on_battery:
            self.pct_exact -= F["BATT_DRAIN_PER_MIN"] * minutes
            if self.pct_exact <= 0:
                self.pct_exact = 0.0
                if not self.dead:
                    self.dead = True
                    ev.died = True
            if not self._low_sent and self.pct_exact <= F["BATT_LOW_PCT"]:
                self._low_sent = True
                ev.batt_low = True
        else:
            self.pct_exact = min(100.0, self.pct_exact + F["BATT_CHARGE_PER_MIN"] * minutes)
            if self.pct_exact > F["BATT_LOW_PCT"]:
                self._low_sent = False
        return ev


class DoorAlarm:
    def __init__(self):
        self.active = False
        self._open = False
        self._opened_at_ms = 0

    def update(self, door_open: bool, now_ms: int) -> bool:
        """True once per episode, when the door has been open for more than DOOR_ALARM_S."""
        if not door_open:
            self._open = self.active = False
            return False
        if not self._open:
            self._open = True
            self._opened_at_ms = now_ms
        if not self.active and now_ms - self._opened_at_ms > C["DOOR_ALARM_S"] * 1000:
            self.active = True
            return True
        return False


# ---------------------------------------------------------------- message bodies (contract section 5)


def _json(value) -> str:
    return json.dumps(value, separators=(",", ":"))


def _object(pairs: list[tuple[str, str]]) -> str:
    return "{" + ",".join(f"{_json(k)}:{v}" for k, v in pairs) + "}"


def reading_json(r: dict, live: dict | None = None) -> str:
    """Byte-for-byte the firmware's field order and formatting (temp with 2 decimals, null on a fault)."""
    temp = "null" if r["temp"] is None else f"{r['temp']:.2f}"
    pairs = [
        ("seq", _json(r["seq"])),
        ("ts", _json(r["ts"])),
        ("temp", temp),
        ("door", _json(int(r["door"]))),
        ("comp", _json(int(r["comp"]))),
        ("power", _json(r["power"])),
        ("batt", _json(r["batt"])),
        ("state", _json(r["state"])),
        ("exp_s", _json(r["exp_s"])),
        ("latch", _json(int(r["latch"]))),
        ("mode", _json(r["mode"])),
    ]
    if live is not None:
        pairs += [("buf", _json(live["buf"])), ("rssi", _json(live["rssi"])), ("fw", _json(FW_VERSION))]
        if live.get("dropped"):
            pairs.append(("dropped", _json(live["dropped"])))
    pairs.append(("reason", _json(r["reason"])))
    return _object(pairs)


def event_json(seq: int, ts: int, type_: str, data: dict | None = None) -> str:
    return _object(
        [("seq", _json(seq)), ("ts", _json(ts)), ("type", _json(type_)), ("data", _json(data or {}))]
    )


def sync_json(entries: list[dict]) -> str:
    """Sync chunk; buffered events travel in the same array as event bodies (data not kept)."""
    items = [event_json(e["seq"], e["ts"], e["type"]) if "type" in e else reading_json(e) for e in entries]
    return _object(
        [
            ("from_seq", _json(entries[0]["seq"])),
            ("to_seq", _json(entries[-1]["seq"])),
            ("readings", "[" + ",".join(items) + "]"),
        ]
    )


# ---------------------------------------------------------------- offline buffer and sync


class RingBuffer:
    """BUFFER_CAPACITY entries; when full the oldest is overwritten and counted."""

    def __init__(self, capacity: int = C["BUFFER_CAPACITY"]):
        self.capacity = capacity
        self.items: deque[dict] = deque()
        self.dropped = 0

    def __len__(self) -> int:
        return len(self.items)

    def push(self, entry: dict) -> None:
        if len(self.items) == self.capacity:
            self.items.popleft()
            self.dropped += 1
        self.items.append(entry)

    def free_up_to(self, seq: int) -> int:
        n = 0
        while self.items and self.items[0]["seq"] <= seq:
            self.items.popleft()
            n += 1
        return n


class Syncer:
    """Stop-and-wait: one chunk in flight, freed only on ack, 5 s retry, 5 retries then 60 s backoff."""

    def __init__(self, buf: RingBuffer):
        self.buf = buf
        self.waiting = False
        self.retries = 0
        self.acked_up_to = 0
        self._backoff = False
        self._sent_at = 0
        self._backoff_at = 0

    def due(self, now_ms: int, uplink: bool) -> bool:
        if not uplink or not self.buf.items:
            self.waiting = False
            return False
        if self._backoff:
            if now_ms - self._backoff_at < F["SYNC_BACKOFF_MS"]:
                return False
            self._backoff = False
        if not self.waiting:
            return True
        if now_ms - self._sent_at < F["SYNC_ACK_TIMEOUT_MS"]:
            return False
        if self.retries >= F["SYNC_MAX_RETRIES"]:
            self._backoff, self._backoff_at, self.waiting, self.retries = True, now_ms, False, 0
            return False
        self.retries += 1
        return True

    def chunk(self) -> list[dict]:
        return list(self.buf.items)[: C["SYNC_CHUNK"]]

    def sent(self, now_ms: int) -> None:
        self.waiting = True
        self._sent_at = now_ms

    def on_ack(self, seq_upto: int) -> bool:
        if not self.buf.items or seq_upto < self.buf.items[0]["seq"]:
            return False  # late duplicate
        self.buf.free_up_to(seq_upto)
        self.acked_up_to = seq_upto
        self.waiting, self.retries, self._backoff = False, 0, False
        return True

    def restart(self) -> None:
        self.waiting, self.retries, self._backoff = False, 0, False


# ---------------------------------------------------------- the node (main.cpp loop, without the uplink)


@dataclass
class Message:
    kind: str  # "telemetry" or "event"
    seq: int
    ts: int
    reading: dict | None = None  # telemetry
    type: str | None = None  # event
    data: dict = field(default_factory=dict)


class FridgeNode:
    """Control logic of one fridge node. Call tick() often (<= 1 s); it samples, controls and emits messages.

    Messages carry seq and ts; delivering them (live, buffered, or into a dataset) is the caller's job.
    """

    SAMPLE_MS = 1000

    def __init__(self, device_id: str, seed: int = 1, start_seq: int = 0, thermal_speed: float | None = None):
        self.device_id = device_id
        self.model = ThermalModel(seed, thermal_speed)
        self.comp = CompressorControl()
        self.heat = HeatKeeper()
        self.power = PowerModel()
        self.door_alarm = DoorAlarm()
        self.seq = start_seq
        self.door_open = False
        self.battery_requested = False
        self.temp: float = self.model.read()
        self.sensor_fault = False  # no DS18B20 in the simulator; kept so the logic matches the firmware
        self.state = "SAFE"
        self._last_sample_ms: int | None = None
        self._last_telemetry_ms: int | None = None
        self._last_door = False
        self._out: list[Message] = []
        self._ts_fn = lambda: 0

    # ---- inputs (buttons, switches, console)

    def set_door(self, open_: bool) -> None:
        self.door_open = open_

    def toggle_power(self) -> None:
        self.battery_requested = not self.battery_requested

    def set_efficiency(self, eff: float) -> None:
        self.model.efficiency = max(0.0, eff)

    def set_temp(self, temp: float) -> None:
        self.model.temp = temp

    # ---- outputs

    def event(self, type_: str, data: dict | None = None) -> None:
        """Queue an event with the next seq. Also used by the uplink (WIFI_LOST / WIFI_BACK) between ticks."""
        self.seq += 1
        self._out.append(Message("event", self.seq, self._ts_fn(), type=type_, data=data or {}))

    def drain(self) -> list[Message]:
        """Messages produced since the last drain (tick() returns this), oldest first."""
        out, self._out = self._out, []
        return out

    def reading(self, door_reason: bool) -> dict:
        return {
            "seq": 0,
            "ts": 0,
            "temp": None if self.sensor_fault else round(self.temp, 4),
            "door": int(self.door_open),
            "comp": int(self.comp.on),
            "power": "BATTERY" if self.power.on_battery else "MAINS",
            "batt": self.power.pct,
            "state": self.state,
            "exp_s": self.heat.exp_s,
            "latch": int(self.heat.latched),
            "mode": "model",
            "reason": "door" if door_reason else "periodic",
        }

    def _telemetry(self, door_reason: bool) -> None:
        r = self.reading(door_reason)
        self.seq += 1
        r["seq"], r["ts"] = self.seq, self._ts_fn()
        self._out.append(Message("telemetry", self.seq, r["ts"], reading=r))

    def _latch_set(self, reason: str) -> None:
        self.event("LATCH_SET", {"exp_s": self.heat.exp_s, "reason": reason})

    # ---- commands (already verified by the caller)

    def command(self, type_: str) -> tuple[bool, str]:
        if type_ == "RESET_LATCH":
            was = self.heat.reset_latch()
            self.event("LATCH_RESET")
            return True, "latch cleared, exp_s reset" if was else "not latched, exp_s reset"
        if type_ == "SET_LATCH":
            if self.heat.set_latch():
                self._latch_set("command")
                return True, "latch set"
            return True, "already latched"
        if type_ == "BUZZER_TEST":
            return True, "beeped 1000 ms"
        return False, "unknown command type"

    # ---- loop

    def tick(self, now_ms: int, dt_s: float, ts_fn) -> list[Message]:
        """Advance by dt_s real seconds to now_ms. ts_fn() gives the unix time for message timestamps.

        Returns every message queued since the last drain, including ones from commands between ticks."""
        self._ts_fn = ts_fn
        ev = self.power.update(self.battery_requested, dt_s)
        if ev.power_fail:
            self.event("POWER_FAIL")
        if ev.revived:
            self.event("BOOT", {"fw": FW_VERSION, "revived": True})
        if ev.power_restore:
            self.event("POWER_RESTORE")
        if ev.batt_low:
            self.event("BATT_LOW", {"batt": self.power.pct})

        self.model.step(dt_s, self.door_open, self.comp.on)
        if self.power.dead:  # unpowered: nothing measured or sent; keep the compressor forced off
            if self._last_sample_ms is None or now_ms - self._last_sample_ms >= self.SAMPLE_MS:
                self._last_sample_ms = now_ms
                self.comp.update(self.temp, False, True, now_ms)
            self._last_door = self.door_open
            return self.drain()

        door_changed = self.door_open != self._last_door
        if self._last_sample_ms is None or now_ms - self._last_sample_ms >= self.SAMPLE_MS or door_changed:
            dt_heat = 0 if self._last_sample_ms is None else (now_ms - self._last_sample_ms) / 1000.0
            self._last_sample_ms = now_ms
            self._sample(now_ms, dt_heat)

        if door_changed:
            self._last_door = self.door_open
            self.event("DOOR_OPEN" if self.door_open else "DOOR_CLOSE")
            self._telemetry(True)
            self._last_telemetry_ms = now_ms
        elif (
            self._last_telemetry_ms is None
            or now_ms - self._last_telemetry_ms >= C["TELEMETRY_PERIOD_S"] * 1000
        ):
            self._telemetry(False)
            self._last_telemetry_ms = now_ms
        if self.door_alarm.update(self.door_open, now_ms):
            self.event("DOOR_ALARM")
        return self.drain()

    def _sample(self, now_ms: int, dt_heat: float) -> None:
        self.temp = self.model.read()
        if self.heat.update(self.temp, self.sensor_fault, dt_heat):
            self._latch_set("budget")
        self.state = classify(self.temp, self.door_open, self.power.on_battery, self.sensor_fault)
        if self.comp.update(self.temp, self.sensor_fault, self.power.on_battery, now_ms):
            self.event("COMP_ON" if self.comp.on else "COMP_OFF")


# ---------------------------------------------------------- scenarios (timed scripts, seconds from start)

# Actions: ("door", bool), ("power", None) toggles, ("wifi", bool), ("eff", float), ("temp", float)
SCENARIOS: dict[str, list[tuple[float, str, object]]] = {
    "normal": [],
    "door_open": [(60, "door", True), (150, "door", False)],  # 90 s open: DOOR_ALARM after 60 s
    "power_fail": [(60, "power", None), (240, "power", None)],  # 3 min on battery
    "wifi_loss": [(120, "wifi", True), (240, "wifi", False)],  # 2 min up, 2 min down, then restore
    "heat_spike": [(60, "temp", 13.0), (60, "door", True), (240, "door", False)],  # x2 exposure for minutes
    "weak_compressor": [(60, "eff", 0.4)],  # cooling below the leak at 7 C: slow breach (P17 health demo)
    "full_demo": [
        (60, "door", True),
        (150, "door", False),
        (210, "power", None),
        (390, "power", None),
        (450, "wifi", True),
        (570, "wifi", False),
        (630, "temp", 13.0),
        (630, "door", True),
        (750, "door", False),
        (810, "eff", 0.4),
    ],  # fmt: skip
}


def apply_action(node: FridgeNode, action: str, arg) -> None:
    """Apply a scenario action that the node itself handles (wifi is the uplink's job)."""
    if action == "door":
        node.set_door(bool(arg))
    elif action == "power":
        node.toggle_power()
    elif action == "eff":
        node.set_efficiency(float(arg))
    elif action == "temp":
        node.set_temp(float(arg))


def run_offline(
    duration_s: float,
    device_id: str = "fridge-01",
    seed: int = 1,
    start_ts: int = 1767225600,
    dt_s: float = 1.0,
    thermal_speed: float | None = None,
    scenario: str | list = "normal",
):
    """Fast mode: virtual clock, no MQTT. Yields (Message, truth) with truth = model ground truth
    (true temperature, compressor efficiency) for the ML dataset (P16). 24 h at dt 1 s runs in seconds."""
    node = FridgeNode(device_id, seed=seed, thermal_speed=thermal_speed)
    script = sorted(SCENARIOS[scenario] if isinstance(scenario, str) else scenario, key=lambda a: a[0])
    t = 0.0
    i = 0
    while t <= duration_s:
        while i < len(script) and script[i][0] <= t:
            apply_action(node, script[i][1], script[i][2])
            i += 1
        ts = start_ts + int(t)
        for m in node.tick(int(t * 1000), dt_s if t > 0 else 0.0, lambda ts=ts: ts):
            yield m, {"true_temp": node.model.temp, "efficiency": node.model.efficiency}
        t += dt_s
