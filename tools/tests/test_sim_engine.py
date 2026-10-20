"""The simulator must behave like the firmware: shared vectors, same thresholds, same timing rules."""

import json
import math
import random
import time

import pytest

from coldchain_tools.contracts import C, firmware_config, vectors
from coldchain_tools.sim_engine import (
    AJAR_K,
    SCENARIOS,
    CompressorControl,
    DoorAlarm,
    FridgeNode,
    HeatKeeper,
    PowerModel,
    RingBuffer,
    Syncer,
    ThermalModel,
    apply_action,
    classify,
    event_json,
    reading_json,
    run_offline,
    sync_json,
)

V = vectors()


def test_firmware_parameters_are_parsed_not_copied():
    f = firmware_config()
    assert (f["T_AMBIENT_C"], f["K_LEAK_PER_S"], f["K_DOOR_PER_S"], f["COOL_RATE_C_PER_S"]) == (
        30,
        0.0004,
        0.004,
        0.02,
    )
    assert (f["FAULT_DUTY_ON_S"], f["FAULT_DUTY_OFF_S"], f["SYNC_ACK_TIMEOUT_MS"]) == (300, 600, 5000)


@pytest.mark.parametrize(
    "v", V["status"], ids=lambda v: f"{v['temp']}-{v['door']}-{v['power']}-{v['sensor_fault']}"
)
def test_status_vectors(v):
    assert classify(v["temp"], v["door"] == 1, v["power"] == "BATTERY", v["sensor_fault"]) == v["expected"]


def test_status_nan_is_a_fault():
    assert classify(math.nan, False, False, False) == "BREACH"
    assert classify(None, False, False, False) == "BREACH"


@pytest.mark.parametrize("v", V["exposure"], ids=lambda v: v["name"])
def test_exposure_vectors(v):
    h = HeatKeeper()
    for dt, temp in v["samples"]:
        for _ in range(int(dt)):
            h.update(temp, False, 1.0)
    assert h.exp_s == v["expected_weighted_s"]
    assert h.remaining_pct == pytest.approx(v["expected_remaining_pct"], abs=1e-3)


def test_latch_once_and_reset():
    h = HeatKeeper()
    sets = sum(h.update(13.0, False, 1.0) for _ in range(2000))
    assert sets == 1 and h.latched and not h.at_risk
    assert h.reset_latch() and h.exp_s == 0 and not h.latched


def test_hysteresis_and_min_off_with_fake_clock():
    c = CompressorControl()
    assert not c.update(6.99, False, False, 0)
    assert c.update(7.0, False, False, 1000) and c.on
    assert c.update(3.0, False, False, 2000) and not c.on
    for t in range(2000, 62000, 250):
        c.update(9.0, False, False, t)
        assert not c.on, "restarted inside the 60 s min-off"
    assert c.update(9.0, False, False, 62000)


def test_boot_lock_holds_min_off_after_a_reboot_like_the_firmware():
    c = CompressorControl()
    c.boot_lock(1200)
    for t in range(1200, 61200, 500):
        assert not c.update(9.0, False, False, t), "started inside the boot lock"
        assert c.waiting_min_off(t)
    assert c.update(9.0, False, False, 61200)
    # the virtual node boots on its first tick: a hot start waits 60 s too
    node = FridgeNode("fridge-01", seed=3)
    node.set_temp(9.0)
    comp_on_at = None
    for i in range(0, 90):
        node.tick(i * 1000, 1.0, lambda: 1_800_000_000)
        if node.comp.on and comp_on_at is None:
            comp_on_at = i * 1000
    assert comp_on_at == 60_000


def test_forced_off_rearms_min_off():
    c = CompressorControl()
    c.update(7.0, False, False, 0)
    assert c.update(7.0, False, True, 10_000)
    assert not c.update(9.0, False, True, 310_000)
    assert not c.update(9.0, False, False, 369_999)
    assert c.update(9.0, False, False, 370_000)


def test_thermal_model_cycles_like_the_firmware():
    m = ThermalModel(42)
    c = CompressorControl()
    temps, on_edges = [], 0
    for s in range(3600):
        m.step(1.0, False, c.on)
        if c.update(m.read(), False, False, s * 1000) and c.on:
            on_edges += 1
        if s >= 600:
            temps.append(m.temp)
    assert on_edges >= 3
    assert C["WARN_LOW_C"] < min(temps) < 3.3 and 6.7 < max(temps) < C["WARN_HIGH_C"]


def test_bodies_are_byte_identical_to_the_shared_vectors():
    tel = json.loads(V["hmac"][0]["body"])
    reading = {k: tel[k] for k in tel if k not in ("buf", "rssi", "fw")}
    assert reading_json(reading, {"buf": 0, "rssi": -58}) == V["hmac"][0]["body"]
    ev = json.loads(V["hmac"][1]["body"])
    assert event_json(ev["seq"], ev["ts"], ev["type"]) == V["hmac"][1]["body"]
    # The JS-generated sync vector prints 8.4 where firmware and simulator print 8.40: same JSON, and the HMAC
    # always covers the exact string sent, so only the parsed content must match here.
    sync = json.loads(V["hmac"][2]["body"])
    assert json.loads(sync_json(sync["readings"])) == sync
    assert '"temp":8.40,' in sync_json(sync["readings"])


def test_reading_json_formats_like_firmware():
    r = {"seq": 1, "ts": 2, "temp": 5.0, "door": 1, "comp": 0, "power": "MAINS", "batt": 100,
         "state": "WARNING", "exp_s": 0, "latch": 0, "mode": "model", "reason": "door"}  # fmt: skip
    assert '"temp":5.00,' in reading_json(r)
    assert '"temp":null,' in reading_json({**r, "temp": None})
    assert '"dropped":3' in reading_json(r, {"buf": 0, "rssi": -1, "dropped": 3})
    assert '"dropped"' not in reading_json(r, {"buf": 0, "rssi": -1, "dropped": 0})


def test_ring_buffer_capacity_and_overflow():
    b = RingBuffer()
    for s in range(1, 361):
        b.push({"seq": s})
    assert len(b) == 360 and b.dropped == 0  # 30 minutes at 5 s
    for s in range(361, 801):
        b.push({"seq": s})
    assert len(b) == 720 and b.dropped == 80 and b.items[0]["seq"] == 81


@pytest.mark.parametrize("seed", range(10))
def test_sync_over_lossy_link_delivers_everything_once(seed):
    rng = random.Random(seed)
    buf = RingBuffer()
    sync = Syncer(buf)
    for s in range(1, 49):  # 4-minute outage
        buf.push({"seq": s})
    stored, acks = set(), []
    t = 0
    while buf.items and t < 3_600_000:
        if sync.due(t, True):
            chunk = sync.chunk()
            sync.sent(t)
            if rng.random() >= 0.3:
                stored.update(e["seq"] for e in chunk)
                if rng.random() >= 0.3:
                    acks.append((t + rng.randrange(8000), chunk[-1]["seq"]))
        for a in [a for a in acks if a[0] <= t]:
            sync.on_ack(a[1])
            acks.remove(a)
        t += 100
    assert not buf.items and stored == set(range(1, 49))


def test_battery_and_door_alarm():
    p = PowerModel()
    lows, died = 0, False
    p.update(True, 0)
    for _ in range(60):
        ev = p.update(True, 60)
        lows += ev.batt_low
        died = died or ev.died
    assert lows == 1 and died and p.dead
    assert p.update(False, 0).revived
    a = DoorAlarm()
    assert not a.update(True, 0) and not a.update(True, 60_000) and a.update(True, 60_001)
    assert not a.update(True, 90_000) and not a.update(False, 90_100)


def test_web_manual_controls_hold_power_and_ajar():
    """The web app's manual controls (POST /api/fridges/:id/sim) reach the node through apply_action."""
    node = FridgeNode("fridge-01", seed=3, boot_lock=False)
    tick = lambda s: node.tick(s * 1000, 1.0 if s else 0.0, lambda: 1767225600 + s)  # noqa: E731
    apply_action(node, "hold", 11.5)  # manual mode: the reading stays pinned while the model keeps running
    msgs = [m for s in range(0, 12) for m in tick(s)]
    last = [m.reading for m in msgs if m.kind == "telemetry"][-1]
    assert last["temp"] == 11.5 and last["mode"] == "manual" and last["state"] == "BREACH"
    apply_action(node, "hold", None)  # released: the model carries on from the held value, no jump
    assert node.hold is None and node.model.temp == 11.5 and node.reading(False)["mode"] == "model"
    apply_action(node, "hold", 9.0)
    apply_action(node, "temp", 4.0)  # a one-off jump also releases the hold
    assert node.hold is None and node.model.temp == 4.0

    apply_action(node, "power", True)  # explicit, so a repeated click cannot flip it back
    apply_action(node, "power", True)
    assert node.battery_requested
    apply_action(node, "power", False)
    assert not node.battery_requested
    apply_action(node, "power", None)  # scenarios and the CLI still toggle
    assert node.battery_requested

    apply_action(node, "ajar", True)
    assert node.door_open and node.model.params["K_DOOR_PER_S"] == AJAR_K
    apply_action(node, "door", False)  # a real close ends the ajar episode and restores the full door leak
    assert not node.door_open and node.model.params["K_DOOR_PER_S"] != AJAR_K


def test_node_emits_like_main_cpp():
    node = FridgeNode("fridge-01", seed=3)
    msgs = []
    for s in range(0, 31):
        if s == 10:
            node.set_door(True)
        msgs += node.tick(s * 1000, 1.0 if s else 0.0, lambda s=s: 1767225600 + s)
    kinds = [(m.kind, m.type or m.reading["reason"]) for m in msgs]
    assert kinds[0] == ("telemetry", "periodic")
    assert ("event", "DOOR_OPEN") in kinds and ("telemetry", "door") in kinds
    assert [m.seq for m in msgs] == list(range(1, len(msgs) + 1))  # one counter for telemetry and events
    assert sum(1 for k in kinds if k == ("telemetry", "periodic")) == 6  # every 5 s, except the door reading


def test_fast_mode_runs_24h_in_seconds():
    started = time.perf_counter()
    readings = [m.reading for m, _ in run_offline(24 * 3600) if m.kind == "telemetry"]
    assert time.perf_counter() - started < 10
    assert len(readings) == 24 * 3600 // C["TELEMETRY_PERIOD_S"] + 1
    temps = [r["temp"] for r in readings]
    assert C["WARN_LOW_C"] < min(temps) and max(temps) < C["WARN_HIGH_C"]


def test_fast_mode_weak_compressor_breaches_and_reports_truth():
    rows = [
        (m.reading, truth)
        for m, truth in run_offline(4 * 3600, scenario="weak_compressor")
        if m.kind == "telemetry"
    ]
    assert max(r["temp"] for r, _ in rows) > C["SAFE_MAX_C"]
    assert rows[-1][1]["efficiency"] == 0.4


def test_every_scenario_runs_offline():
    for name, script in SCENARIOS.items():
        msgs = [m for m, _ in run_offline(max([a[0] for a in script], default=0) + 120, scenario=name)]
        assert msgs, name
    events = {m.type for m, _ in run_offline(400, scenario="power_fail")}
    assert {"POWER_FAIL", "POWER_RESTORE"} <= events
    events = {m.type for m, _ in run_offline(400, scenario="door_open")}
    assert {"DOOR_OPEN", "DOOR_ALARM", "DOOR_CLOSE"} <= events
