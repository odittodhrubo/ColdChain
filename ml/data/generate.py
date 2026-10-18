"""Synthetic training data from the simulator's own physics (tools/coldchain_tools/sim_engine.py, offline
mode).

Each fridge profile runs for --days at 5 s steps with the firmware's thermal model, compressor hysteresis
(7.0 / 3.0 °C, 60 s minimum off, forced off on battery) and battery model, plus disturbances the forecaster
has to cope with: door openings that follow the working day, power failures (5-90 min; past ~50 min the
node's battery dies and it goes silent), gradual compressor degradation arcs (efficiency 1.0 -> 0.3 over
weeks, then a repair), sudden compressor faults, a drifting ambient (daily cycle + random walk) and sensor
noise, and rare missing segments. The 5 s readings go through features.to_minutes, the same function serving
uses, and are stored as 1-minute rows:

    fridge_profile, ts, temp, door, comp, power, batt, efficiency_true, ambient_true

efficiency_true and ambient_true are simulator truth: labels only, never features.

    python -m data.generate                    # 8 profiles x 60 days -> ml/data/raw/*.csv.gz, card, stats
    python -m data.generate --days 3 --out /tmp/x --no-card
"""

from __future__ import annotations

import argparse
import math
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))  # coldchain_tools, when it is not pip-installed
from coldchain_tools.sim_engine import CompressorControl, PowerModel, ThermalModel  # noqa: E402

from features import to_minutes  # noqa: E402

DATA = Path(__file__).resolve().parent
START_TS = 1767225600  # 2026-01-01 00:00 UTC
STEP_S = 5
DAY_S = 86_400
SEED = 2026


@dataclass(frozen=True)
class Profile:
    name: str
    ambient_c: float  # mean room temperature
    leak: float  # K_LEAK_PER_S
    k_door: float  # K_DOOR_PER_S
    margin: float  # cooling capacity / heat leak at the mean ambient: < 1/margin efficiency cannot hold 7 °C
    noise: float  # sensor sigma, °C
    door_per_hour: float  # working-hours rate (08-20 UTC); nights get a tenth
    degrades: bool = False  # gradual efficiency arcs
    faults: int = 0  # sudden compressor faults
    held_out: bool = False  # test-only profile

    @property
    def cool_rate(self) -> float:
        return self.margin * self.leak * (self.ambient_c - 3.0)


PROFILES: tuple[Profile, ...] = (
    Profile("district-store", 26, 0.00030, 0.0012, 3.2, 0.03, 1.2),
    Profile("rural-clinic", 34, 0.00040, 0.0015, 2.6, 0.08, 1.5, degrades=True, faults=1),
    Profile("pharmacy", 30, 0.00035, 0.0020, 3.0, 0.05, 2.0, faults=1),
    Profile("health-post", 36, 0.00045, 0.0012, 2.4, 0.10, 1.0, degrades=True),
    Profile("hospital-ward", 24, 0.00025, 0.0018, 3.5, 0.04, 1.8),
    Profile("outreach-hub", 32, 0.00038, 0.0016, 2.8, 0.06, 1.3, degrades=True, faults=1),
    Profile("mobile-unit", 29, 0.00042, 0.0014, 2.7, 0.07, 1.4, degrades=True, faults=1, held_out=True),
    Profile("city-depot", 27, 0.00028, 0.0010, 3.3, 0.05, 1.1, faults=1, held_out=True),
)  # fmt: skip


@dataclass
class Schedule:
    """Everything that happens to one fridge, decided before simulating (seconds from the start)."""

    doors: list[tuple[int, int]] = field(default_factory=list)  # (start, duration)
    power_failures: list[tuple[int, int]] = field(default_factory=list)
    arcs: list[tuple[int, int, float]] = field(default_factory=list)  # (start, end, efficiency at the end)
    faults: list[tuple[int, int, float]] = field(default_factory=list)  # (start, duration, efficiency)
    missing: list[tuple[int, int]] = field(default_factory=list)  # (start, duration): rows dropped


def _poisson_times(rng: random.Random, start: int, end: int, rate_per_s) -> list[int]:
    """Event times of a Poisson process with a time-varying rate (thinning, upper bound 1/600 s)."""
    out, t, peak = [], float(start), 1 / 600
    while True:
        t += rng.expovariate(peak)
        if t >= end:
            return out
        if rng.random() < rate_per_s(int(t)) / peak:
            out.append(int(t))


def schedule(profile: Profile, days: int, seed: int) -> Schedule:
    rng = random.Random(f"{seed}:{profile.name}")
    end = days * DAY_S
    s = Schedule()

    def door_rate(t: int) -> float:
        hour = (t % DAY_S) // 3600
        return profile.door_per_hour / 3600 * (1.0 if 8 <= hour < 20 else 0.1)

    last_end = -1
    for t in _poisson_times(rng, 0, end, door_rate):
        if t <= last_end:
            continue
        # mostly quick openings (5-60 s), some long ones (1-5 min): log-uniform in each band
        lo, hi = (60, 300) if rng.random() < 0.15 else (5, 60)
        dur = int(math.exp(rng.uniform(math.log(lo), math.log(hi))))
        s.doors.append((t, dur))
        last_end = t + dur

    last_end = -1
    for t in _poisson_times(rng, 3600, end - 7200, lambda _t: 1 / (4 * DAY_S)):
        if t <= last_end + 3600:
            continue
        dur = int(60 * math.exp(rng.uniform(math.log(5), math.log(90))))
        s.power_failures.append((t, dur))
        last_end = t + dur

    if profile.degrades:  # 3+ arcs in 60 days: decline over 8-13 days, a repair, 2-5 healthy days
        t = int(rng.uniform(1, 3) * DAY_S)
        while True:
            length = int(rng.uniform(8, 13) * DAY_S)
            if t + length > end:
                break
            s.arcs.append((t, t + length, round(rng.uniform(0.3, 0.45), 3)))
            t += length + int(rng.uniform(2, 5) * DAY_S)

    for _ in range(profile.faults):
        t = int(rng.uniform(0.1, 0.9) * end)
        s.faults.append((t, int(rng.uniform(3, 24) * 3600), round(rng.uniform(0.15, 0.35), 3)))

    for _ in range(max(1, days // 20)):
        s.missing.append((int(rng.uniform(0, end - 7200)), int(60 * rng.uniform(10, 90))))
    return s


def efficiency_at(s: Schedule, t: int) -> float:
    eff = 1.0
    for a, b, low in s.arcs:
        if a <= t < b:
            eff = 1.0 - (1.0 - low) * (t - a) / (b - a)
    for a, dur, low in s.faults:
        if a <= t < a + dur:
            eff = min(eff, low)
    return eff


def _seed(*parts) -> int:
    """Stable per-profile seed (str hashing is salted per process; random.Random(str) is not)."""
    return random.Random(":".join(map(str, parts))).getrandbits(31)


def _intervals_mask(intervals: list[tuple[int, int]], n_steps: int) -> np.ndarray:
    mask = np.zeros(n_steps, dtype=bool)
    for a, dur in intervals:
        mask[a // STEP_S : (a + dur) // STEP_S + 1] = True
    return mask


def simulate(profile: Profile, days: int, seed: int = SEED) -> tuple[pd.DataFrame, Schedule]:
    """One profile -> (1-minute rows, its schedule)."""
    s = schedule(profile, days, seed)
    n = days * DAY_S // STEP_S
    door = _intervals_mask(s.doors, n)
    on_battery = _intervals_mask(s.power_failures, n)
    rng = np.random.default_rng(_seed(seed, profile.name, "ambient"))
    minutes = days * 1440
    # ambient: daily cycle (peak mid-afternoon) plus a slow mean-reverting random walk
    walk = np.zeros(minutes)
    for i in range(1, minutes):
        walk[i] = walk[i - 1] * (1 - 1 / 720) + rng.normal(0, 0.05)
    hours = np.arange(minutes) / 60.0
    ambient = profile.ambient_c + 2.5 * np.sin(2 * np.pi * (hours - 9) / 24) + walk
    eff = np.array([efficiency_at(s, m * 60) for m in range(minutes)])

    model = ThermalModel(
        seed=_seed(seed, profile.name, "noise"),
        speed=1.0,
        params={
            "T_AMBIENT_C": float(ambient[0]),
            "K_LEAK_PER_S": profile.leak,
            "K_DOOR_PER_S": profile.k_door,
            "COOL_RATE_C_PER_S": profile.cool_rate,
            "NOISE_SIGMA_C": profile.noise,
        },
    )
    comp, power = CompressorControl(), PowerModel()
    params = model.params
    ts_out, temp_out, door_out, comp_out, power_out, batt_out = [], [], [], [], [], []
    for k in range(n):
        t = k * STEP_S
        if k % 12 == 0:
            m = k // 12
            params["T_AMBIENT_C"] = float(ambient[m])
            model.efficiency = float(eff[m])
        d = bool(door[k])
        power.update(bool(on_battery[k]), STEP_S if k else 0.0)  # same order as FridgeNode.tick
        model.step(STEP_S if k else 0.0, d, comp.on)
        now_ms = t * 1000
        if power.dead:  # unpowered node: nothing measured, nothing sent, compressor held off
            comp.update(model.temp, False, True, now_ms)
            continue
        temp = model.read()
        comp.update(temp, False, power.on_battery, now_ms)
        ts_out.append(START_TS + t)
        temp_out.append(temp)
        door_out.append(int(d))
        comp_out.append(int(comp.on))
        power_out.append("BATTERY" if power.on_battery else "MAINS")
        batt_out.append(power.pct)

    raw = pd.DataFrame(
        {
            "ts": ts_out,
            "temp": temp_out,
            "door": door_out,
            "comp": comp_out,
            "power": power_out,
            "batt": batt_out,
        }
    )
    rows = to_minutes(raw)
    m = rows["minute"].to_numpy() - START_TS // 60
    gone = np.zeros(minutes + 1, dtype=bool)
    for a, dur in s.missing:
        gone[a // 60 : (a + dur) // 60 + 1] = True
    keep = ~gone[m]
    rows, m = rows[keep], m[keep]
    out = pd.DataFrame(
        {
            "fridge_profile": profile.name,
            "ts": rows["minute"].to_numpy() * 60,
            "temp": rows["temp"].round(3).to_numpy(),
            "door": rows["door"].round(3).to_numpy(),
            "comp": rows["comp"].round(3).to_numpy(),
            "power": rows["power"].astype(int).to_numpy(),
            "batt": rows["batt"].astype(int).to_numpy(),
            "efficiency_true": eff[m].round(4),
            "ambient_true": ambient[m].round(3),
        }
    )
    return out, s


def _run(args: tuple[Profile, int, int, Path]) -> dict:
    profile, days, seed, out = args
    t0 = time.perf_counter()
    df, s = simulate(profile, days, seed)
    df.to_csv(out / f"{profile.name}.csv.gz", index=False)
    return {
        "profile": asdict(profile) | {"cool_rate": round(profile.cool_rate, 6)},
        "rows": len(df),
        "days": days,
        "door_events": len(s.doors),
        "power_failures": len(s.power_failures),
        "degradation_arcs": len(s.arcs),
        "faults": len(s.faults),
        "missing_segments": len(s.missing),
        "minutes_above_8": int((df["temp"] > 8).sum()),
        "seconds": round(time.perf_counter() - t0, 1),
    }


def load_raw(directory: Path = DATA / "raw") -> pd.DataFrame:
    files = sorted(directory.glob("*.csv.gz"))
    if not files:
        raise FileNotFoundError(f"no dataset in {directory}: run `python -m data.generate` in ml/")
    return pd.concat([pd.read_csv(f) for f in files], ignore_index=True)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--out", type=Path, default=DATA / "raw")
    ap.add_argument(
        "--no-card", action="store_true", help="raw rows only: no features, labels or DATASET_CARD.md"
    )
    args = ap.parse_args(argv)
    args.out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    with ProcessPoolExecutor() as pool:
        stats = list(pool.map(_run, [(p, args.days, args.seed, args.out) for p in PROFILES]))
    for st in stats:
        print(f"{st['profile']['name']:15} {st['rows']:>7} rows  {st['seconds']:>5} s")
    print(f"generated in {time.perf_counter() - t0:.0f} s -> {args.out}")
    if not args.no_card:
        from data.dataset import build

        build(args.out, stats=stats, seed=args.seed)


if __name__ == "__main__":
    main()
