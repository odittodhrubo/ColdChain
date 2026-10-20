#!/usr/bin/env python3
"""Generate the Wokwi projects for the fridge node from one template.

    python tools/gen_wokwi.py          # write firmware/fridge-node/wokwi/*/
    python tools/gen_wokwi.py --check  # exit 1 if any generated file is stale

Every project folder is self-contained, so it runs in Wokwi for VS Code and on wokwi.com:
  diagram.json   the circuit. Same parts and GPIOs in every project; wires are routed here (see route_all)
  wokwi.toml     VS Code: runs the PlatformIO build .pio/build/<env>/firmware.bin
  sketch.ino     the ESP32 firmware entry point (src/main.cpp, or test/hw_smoke.cpp for hw-smoke)
  *.h / *.cpp    copies of the firmware modules from include/ and src/
  libraries.txt  libraries wokwi.com installs for the sketch
  config.h       git-ignored, not checked: your include/config.h (secrets), or config.example.h placeholders

GPIO numbers come from firmware/fridge-node/include/pins.h, so the circuit and the firmware cannot drift.
Edit the layout here (PLACES), never in the generated files.
"""

from __future__ import annotations

import heapq
import json
import re
import sys
from bisect import bisect_left
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NODE = ROOT / "firmware" / "fridge-node"
PINS_H = NODE / "include" / "pins.h"
OUT = NODE / "wokwi"

# project dir -> (PlatformIO env whose build it runs, title shown on the canvas)
PROJECTS = {
    "fridge-01": ("fridge-01", "FRIDGE-01"),
    "fridge-02": ("fridge-02", "FRIDGE-02"),
    "hw-smoke": ("hw-smoke", "HW SMOKE TEST"),
}

FIRMWARE_LIBS = [
    "PubSubClient",
    "ArduinoJson",
    "Adafruit SSD1306",
    "Adafruit GFX Library",
    "OneWire",
    "DallasTemperature",
]
SMOKE_LIBS = ["Adafruit SSD1306", "Adafruit GFX Library", "OneWire", "DallasTemperature"]
SMOKE_HEADERS = ["pins.h"]  # plus the generated settings.h; config.h is written separately

# ---------------------------------------------------------------- part geometry (Wokwi px, unrotated)
# Sizes and pin offsets from wokwi-elements / wokwi-boards (board pins are in mm, 1 mm = 96/25.4 px).
# Pin side = the direction a wire leaves the pin in: L, R, T (up) or B (down).
MM = 96 / 25.4
ESP_LEFT = [
    "3V3",
    "EN",
    "VP",
    "VN",
    "34",
    "35",
    "32",
    "33",
    "25",
    "26",
    "27",
    "14",
    "12",
    "GND.1",
    "13",
    "D2",
    "D3",
    "CMD",
    "5V",
]
ESP_RIGHT = [
    "GND.2",
    "23",
    "22",
    "TX",
    "RX",
    "21",
    "GND.3",
    "19",
    "18",
    "5",
    "17",
    "16",
    "4",
    "0",
    "2",
    "15",
    "D1",
    "D0",
    "CLK",
]


def _esp_pins() -> dict:
    pins = {}
    for i, name in enumerate(ESP_LEFT):
        pins[name] = (1.22 * MM, (7.62 + 2.54 * i) * MM, "L")
    for i, name in enumerate(ESP_RIGHT):
        pins[name] = (26.66 * MM, (7.62 + 2.54 * i) * MM, "R")
    return pins


GEOMETRY = {
    "board-esp32-devkit-c-v4": (27.9 * MM, 56.628 * MM, _esp_pins()),
    "board-ssd1306": (
        27.7 * MM,
        22.6 * MM,
        {
            n: (x * MM, 1.71 * MM, "T")
            for n, x in [("GND", 10.1), ("VCC", 12.6), ("SCL", 15.1), ("SDA", 17.7)]
        },
    ),
    "wokwi-ds18b20": (
        8.564 * MM,
        13.388 * MM,
        {n: (x * MM, 13 * MM, "B") for n, x in [("GND", 1.46), ("DQ", 4), ("VCC", 6.54)]},
    ),
    # IN/VCC/GND header on the left edge, NC/COM/NO screw terminal on the right (wokwi-relay-module.svg)
    "wokwi-relay-module": (
        128.0,
        58.24,
        {
            "VCC": (0, 18.7, "L"),
            "GND": (0, 28.4, "L"),
            "IN": (0, 38.2, "L"),
            "NC": (113.7, 20.1, "R"),
            "COM": (113.7, 29.7, "R"),
            "NO": (113.7, 39.4, "R"),
        },
    ),
    "wokwi-led": (40.0, 50.0, {"A": (25, 42, "B"), "C": (15, 42, "B")}),
    "wokwi-resistor": (15.645 * MM, 3 * MM, {"1": (0, 5.65, "L"), "2": (58.8, 5.65, "R")}),
    "wokwi-pushbutton": (
        17.802 * MM,
        12 * MM + 14,
        {"1.l": (0, 13, "L"), "2.l": (0, 32, "L"), "1.r": (67, 13, "R"), "2.r": (67, 32, "R")},
    ),
    "wokwi-slide-switch": (
        8.5 * MM,
        9.23 * MM,
        {"1": (6.5, 34, "B"), "2": (16, 34, "B"), "3": (25.5, 34, "B")},
    ),
    "wokwi-buzzer": (17 * MM, 20 * MM, {"1": (27, 84, "B"), "2": (37, 84, "B")}),
}


def text_size(label: str) -> tuple[float, float]:
    lines = label.split("\n")
    return 8.0 * max(len(s) for s in lines), 16.0 * len(lines)


def part_box(p: dict) -> tuple[float, float, float, float]:
    if p["type"] == "wokwi-text":
        w, h = text_size(p["attrs"]["text"])
    else:
        w, h, _ = GEOMETRY[p["type"]]
    return p["left"], p["top"], p["left"] + w, p["top"] + h


def pin_xy(p: dict, pin: str) -> tuple[float, float, str]:
    x, y, side = GEOMETRY[p["type"]][2][pin]
    if p["type"] == "wokwi-led" and p["attrs"].get("flip"):
        x = 40 - x  # flip swaps anode and cathode
    return round(p["left"] + x, 2), round(p["top"] + y, 2), side


# ---------------------------------------------------------------- the circuit (same for every project)
def read_pins() -> dict[str, int]:
    text = PINS_H.read_text(encoding="utf-8")
    pins = {m[1]: int(m[2]) for m in re.finditer(r"constexpr\s+uint8_t\s+PIN_(\w+)\s*=\s*(\d+);", text)}
    if not pins:
        raise SystemExit(f"no PIN_ constants found in {PINS_H}")
    return pins


def part(type_: str, id_: str, top: float, left: float, **attrs: str) -> dict:
    return {"type": type_, "id": id_, "top": top, "left": left, "attrs": attrs}


def text(id_: str, top: float, left: float, label: str) -> dict:
    return part("wokwi-text", id_, top, left, text=label)


# Layout. The board sits at the origin: left header x=4.6, right header x=100.8, pins 9.6 px apart.
# Left: the two simulation buttons and the status LEDs. Right: OLED, mode, compressor LED, buzzer, probe,
# door and relay. Leave >= 30 px between parts so the router has room for wires.
def parts_for(title: str) -> list[dict]:
    return [
        part("board-esp32-devkit-c-v4", "esp", 0, 0),
        text("title", -190, -330, title),
        # left: simulation buttons (pressed = GPIO to GND)
        part("wokwi-pushbutton", "btn_power", -60, -215, color="red", label="POWER FAIL", key="p"),
        part("wokwi-pushbutton", "btn_wifi", 25, -215, color="blue", label="WI-FI OUTAGE", key="w"),
        # left: status LEDs, GPIO -> 220R -> anode, cathode -> GND
        text("t_green", 135, -330, "SAFE"),
        part("wokwi-led", "led_green", 120, -260, color="green"),
        part("wokwi-resistor", "r_green", 174.35, -175, value="220"),
        text("t_yellow", 215, -330, "WARNING"),
        part("wokwi-led", "led_yellow", 200, -260, color="yellow"),
        part("wokwi-resistor", "r_yellow", 254.35, -175, value="220"),
        text("t_red", 295, -330, "BREACH /\nDISCARD"),
        part("wokwi-led", "led_red", 280, -260, color="red"),
        part("wokwi-resistor", "r_red", 334.35, -175, value="220"),
        # top right: OLED
        part("board-ssd1306", "oled", -170, 140, i2cAddress="0x3c"),
        # right: mode switch, compressor indicator, buzzer, probe + pull-up, door, relay
        text("t_mode", -30, 330, "MODE (model/manual)"),
        part("wokwi-slide-switch", "mode", -40, 290),
        text("t_comp", 45, 350, "COMP"),
        part("wokwi-led", "led_blue", 40, 300, color="blue", flip="1"),
        part("wokwi-resistor", "r_blue", 94.35, 200, value="220"),
        part("wokwi-buzzer", "buzzer", 20, 420, volume="0.3"),
        text("t_temp", 180, 285, "TEMP PROBE\n(manual mode)"),
        part("wokwi-ds18b20", "temp", 170, 240, temperature="4.5"),
        part("wokwi-resistor", "r_pullup", 245, 300, value="4700"),
        text("t_door", 316, 285, "DOOR\n(left=closed)"),
        part("wokwi-slide-switch", "door", 312, 240),
        text("t_relay", 372, 200, "COMPRESSOR RELAY"),
        part("wokwi-relay-module", "relay", 395, 200),
    ]


def nets_for(pin: dict[str, int]) -> list[tuple[str, list[str]]]:
    """(color, endpoints) per net. Endpoints are routed in order; each joins the wires already drawn for its
    net.
    Ground is split into three trees (all GND pins are one node on the board), so no ground wire has to cross
    the whole circuit. The list order is the routing order, which decides who gets the short lanes: this one
    came out of a search over orders (fewest crossings, then shortest wires). tools/tests/test_wokwi.py pins
    the crossing count, so a layout change that makes the drawing messier fails the tests."""
    g = lambda name: f"esp:{pin[name]}"  # noqa: E731
    return [
        ("cyan", [g("BTN_WIFI"), "btn_wifi:1.r"]),  # buttons and switches: INPUT_PULLUP, closed = GND
        ("gray", [g("MODE"), "mode:2"]),
        ("white", [g("DOOR"), "door:2"]),
        ("red", [g("LED_RED"), "r_red:2"]),  # status LEDs: GPIO -> 220R -> anode
        ("red", ["r_red:1", "led_red:A"]),
        ("gold", [g("LED_YELLOW"), "r_yellow:2"]),
        ("gold", ["r_yellow:1", "led_yellow:A"]),
        ("green", [g("LED_GREEN"), "r_green:2"]),
        ("black", ["esp:GND.3", "led_blue:C", "buzzer:1"]),
        ("green", ["r_green:1", "led_green:A"]),
        ("blue", [g("LED_BLUE"), "r_blue:1"]),  # compressor indicator
        ("blue", ["r_blue:2", "led_blue:A"]),
        ("black", ["esp:GND.2", "oled:GND", "mode:1"]),
        ("purple", [g("I2C_SCL"), "oled:SCL"]),
        ("brown", [g("RELAY"), "relay:IN"]),
        ("orange", [g("BTN_POWER"), "btn_power:1.r"]),
        ("magenta", [g("BUZZER"), "buzzer:2"]),
        ("limegreen", [g("DS18B20"), "temp:DQ", "r_pullup:1"]),  # 1-Wire data with the 4.7k pull-up
        ("red", ["esp:3V3", "oled:VCC", "r_pullup:2", "temp:VCC"]),
        ("red", ["esp:5V", "relay:VCC"]),  # relay coil
        ("violet", [g("I2C_SDA"), "oled:SDA"]),
        (
            "black",
            [
                "esp:GND.1",
                "led_red:C",
                "led_yellow:C",
                "led_green:C",
                "btn_wifi:2.l",
                "btn_power:2.l",
                "relay:GND",
                "door:1",
                "temp:GND",
            ],
        ),
    ]


# ---------------------------------------------------------------- wire router
# Orthogonal A* on a grid made of regular lanes plus every pin's own coordinate, so wires leave pins straight.
# Rules: never through a part or label; never along (or closer than SEP to) another net's wire; crossing
# another net costs a lot, every bend costs a little; a net reuses its own wires for free-ish (that is how
# one ground wire feeds several parts: Wokwi wires join pins, the shared stretches simply overlap).
STEP = 10.0  # regular lane spacing
ESC = 10.0  # straight stub out of every pin
PAD = 8.0  # clearance around parts
SEP = 7.0  # minimum gap between parallel wires of different nets
BEND, CROSS, SHARED = 15.0, 120.0, 0.15


class Router:
    def __init__(self, parts: list[dict]):
        self.parts = {p["id"]: p for p in parts}
        self.boxes = [part_box(p) for p in parts]
        # wires indexed by line: horizontal ones by y, vertical ones by x -> [(lo, hi, net, is_pin_stub)]
        self.lines: tuple[dict, dict] = ({}, {})
        self.keys: tuple[list, list] = ([], [])
        self.block_cache: dict = {}
        x0 = min(b[0] for b in self.boxes) - 40
        y0 = min(b[1] for b in self.boxes) - 40
        x1 = max(b[2] for b in self.boxes) + 40
        y1 = max(b[3] for b in self.boxes) + 40
        self.area = (x0, y0, x1, y1)

    def pin(self, end: str) -> tuple[float, float, float, float]:
        pid, name = end.split(":", 1)
        p = self.parts[pid]
        x, y, side = pin_xy(p, name)
        bx0, by0, bx1, by1 = part_box(p)
        ex, ey = {
            "L": (bx0 - ESC, y),
            "R": (bx1 + ESC, y),
            "T": (x, by0 - ESC),
            "B": (x, max(by1, y) + ESC),
        }[side]
        return x, y, round(ex, 2), round(ey, 2)

    def build_grid(self, ends: list[str]) -> None:
        fixed_x, fixed_y = set(), set()
        for end in ends:
            x, y, ex, ey = self.pin(end)
            fixed_x |= {x, ex}
            fixed_y |= {y, ey}
        x0, y0, x1, y1 = self.area

        def lanes(lo: float, hi: float, fixed: set) -> list[float]:
            regular = [round(lo + i * STEP, 2) for i in range(int((hi - lo) / STEP) + 1)]
            keep = [v for v in regular if all(abs(v - f) >= STEP / 2 for f in fixed)]
            return sorted(set(keep) | fixed)

        self.xs = lanes(x0, x1, fixed_x)
        self.ys = lanes(y0, y1, fixed_y)

    def blocked(self, ax: float, ay: float, bx: float, by: float) -> bool:
        key = (ax, ay, bx, by)
        if key not in self.block_cache:
            lx, hx, ly, hy = min(ax, bx), max(ax, bx), min(ay, by), max(ay, by)
            self.block_cache[key] = any(
                lx < x1 + PAD and hx > x0 - PAD and ly < y1 + PAD and hy > y0 - PAD
                for x0, y0, x1, y1 in self.boxes
            )
        return self.block_cache[key]

    def near(self, axis: int, lo: float, hi: float) -> list[float]:
        keys = self.keys[axis]
        return keys[bisect_left(keys, lo) : bisect_left(keys, hi + 1e-9)]

    def conflict(self, ax: float, ay: float, bx: float, by: float, net: int) -> tuple[bool, float, bool]:
        """(forbidden, crossings, shared) for the move a->b."""
        horiz = ay == by
        axis = 0 if horiz else 1  # 0: horizontal lines keyed by y
        me = ay if horiz else ax
        lo, hi = (min(ax, bx), max(ax, bx)) if horiz else (min(ay, by), max(ay, by))
        shared = False
        for c in self.near(axis, me - SEP + 1e-9, me + SEP - 1e-9):
            for slo, shi, snet, _ in self.lines[axis][c]:
                if snet == net:
                    shared |= c == me and hi > slo and lo < shi
                elif hi >= slo and lo <= shi:
                    return True, 0, False  # along, or too close to, another wire
        crossings = 0
        for c in self.near(1 - axis, lo, hi):
            for slo, shi, snet, stub in self.lines[1 - axis][c]:
                if snet != net and slo <= me <= shi:
                    if stub or me in (slo, shi):
                        return True, 0, False  # pin stub, or the other wire ends/bends on this line
                    crossings += 0.5 if c in (lo, hi) else 1  # a crossing on a node is shared by two moves
        return False, crossings, shared

    def on_other(self, x: float, y: float, net: int) -> bool:
        """Is (x, y) on another net's wire? Bending there would look like a junction."""
        for axis, c, me in ((0, y, x), (1, x, y)):
            for slo, shi, snet, _ in self.lines[axis].get(c, ()):
                if snet != net and slo <= me <= shi:
                    return True
        return False

    def add(self, pts: list[tuple[float, float]], net: int, stub: bool = False) -> None:
        for (ax, ay), (bx, by) in zip(pts, pts[1:], strict=False):
            if (ax, ay) == (bx, by):
                continue
            axis, c, lo, hi = (
                (0, ay, min(ax, bx), max(ax, bx)) if ay == by else (1, ax, min(ay, by), max(ay, by))
            )
            if c not in self.lines[axis]:
                self.lines[axis][c] = []
                self.keys[axis].insert(bisect_left(self.keys[axis], c), c)
            self.lines[axis][c].append((lo, hi, net, stub))

    def astar(
        self, start: tuple[float, float], goals: list[tuple[float, float]], net: int
    ) -> list[tuple[float, float]]:
        xs, ys = self.xs, self.ys
        s = (bisect_left(xs, start[0]), bisect_left(ys, start[1]), -1)
        goal_ij = {(bisect_left(xs, gx), bisect_left(ys, gy)) for gx, gy in goals}

        def h(i: int, j: int) -> float:
            return min(abs(xs[i] - gx) + abs(ys[j] - gy) for gx, gy in goals) * SHARED

        best = {s: 0.0}
        prev: dict = {}
        heap = [(h(s[0], s[1]), 0.0, s)]
        moves = [(1, 0), (-1, 0), (0, 1), (0, -1)]
        while heap:
            _, cost, key = heapq.heappop(heap)
            i, j, d = key
            if (i, j) in goal_ij:
                path = [(xs[i], ys[j])]
                while key != s:
                    key = prev[key]
                    path.append((xs[key[0]], ys[key[1]]))
                return path[::-1]
            if cost > best[key]:
                continue
            for nd, (di, dj) in enumerate(moves):
                if d >= 0 and (di, dj) == (-moves[d][0], -moves[d][1]):
                    continue
                ni, nj = i + di, j + dj
                if not (0 <= ni < len(xs) and 0 <= nj < len(ys)):
                    continue
                ax, ay, bx, by = xs[i], ys[j], xs[ni], ys[nj]
                if self.blocked(ax, ay, bx, by):
                    continue
                bad, crossings, shared = self.conflict(ax, ay, bx, by, net)
                if bad or (d >= 0 and nd != d and self.on_other(ax, ay, net)):
                    continue
                step = abs(bx - ax) + abs(by - ay)
                c = (
                    cost
                    + step * (SHARED if shared else 1.0)
                    + crossings * CROSS
                    + (BEND if d >= 0 and nd != d else 0)
                )
                nkey = (ni, nj, nd)
                if c < best.get(nkey, float("inf")):
                    best[nkey] = c
                    prev[nkey] = key
                    heapq.heappush(heap, (c + h(ni, nj), c, nkey))
        raise SystemExit(f"router: no path for net {net} from {start}")


def simplify(pts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for p in pts:
        if out and p == out[-1]:
            continue
        if len(out) >= 2 and (out[-2][0] == out[-1][0] == p[0] or out[-2][1] == out[-1][1] == p[1]):
            out[-1] = p
        else:
            out.append(p)
    return out


def route_all(parts: list[dict], nets: list[tuple[str, list[str]]]) -> list[tuple[str, str, str, list]]:
    """Wires as (from, to, color, absolute polyline from the 'from' pin to the 'to' pin)."""
    r = Router(parts)
    r.build_grid([e for _, ends in nets for e in ends])
    stubs = {}
    for n, (_, ends) in enumerate(nets):
        for end in ends:
            x, y, ex, ey = r.pin(end)
            stubs[end] = ((x, y), (ex, ey))
            r.add([(x, y), (ex, ey)], n, stub=True)
    wires = []
    for n, (color, ends) in enumerate(nets):
        joined = [ends[0]]
        for end in ends[1:]:
            pin_pt, esc = stubs[end]
            goals = {stubs[j][1]: j for j in joined}
            path = r.astar(esc, list(goals), n)
            target = goals[path[-1]]
            pts = simplify([pin_pt, *path, stubs[target][0]])
            r.add(pts, n)
            wires.append((end, target, color, pts))
            joined.append(end)
    return wires


def instructions(pts: list[tuple[float, float]]) -> list[str]:
    """Wokwi wire placement: moves from the source pin. Wokwi draws the last straight stretch to the pin."""
    out = []
    for (ax, ay), (bx, by) in zip(pts[:-2], pts[1:-1], strict=True):
        d = round((bx - ax) if ay == by else (by - ay), 2)
        out.append(f"{'h' if ay == by else 'v'}{d:g}")
    return out


def diagram(title: str, pin: dict[str, int]) -> dict:
    parts = parts_for(title)
    connections = [["esp:TX", "$serialMonitor:RX", "", []], ["esp:RX", "$serialMonitor:TX", "", []]]
    for src, dst, color, pts in route_all(parts, nets_for(pin)):
        connections.append([src, dst, color, instructions(pts)])
    return {
        "version": 1,
        "author": "ColdChain",
        "editor": "wokwi",
        "parts": parts,
        "connections": connections,
        "serialMonitor": {"display": "terminal", "newline": "lf"},
        "dependencies": {},
    }


# ---------------------------------------------------------------- sketch folder (wokwi.com / Arduino IDE)
def banner(src: str) -> str:
    return f"// GENERATED by tools/gen_wokwi.py from firmware/fridge-node/{src}. DO NOT EDIT this copy.\n"


SKETCH_SETTINGS = """\
// GENERATED by tools/gen_wokwi.py (sketch version of include/settings.h). DO NOT EDIT.
// Board settings for the sketch: config.h next to this file. gen_wokwi.py copies your git-ignored
// include/config.h (real secrets) here, or the config.example.h placeholders if you have none yet.
#pragma once
#include "config.h"

#if !defined(WIFI_SSID) || !defined(MQTT_HOST) || !defined(DEVICE_SECRETS)
#error "config.h predates P03: copy the network and DEVICE_SECRETS sections from config.example.h"
#endif
"""


def sketch_files(name: str) -> dict[str, str]:
    if name == "hw-smoke":
        smoke = (NODE / "test" / "hw_smoke.cpp").read_text(encoding="utf-8")
        files = {"sketch.ino": banner("test/hw_smoke.cpp") + smoke}
        headers = SMOKE_HEADERS
        libs = SMOKE_LIBS
    else:
        main = (NODE / "src" / "main.cpp").read_text(encoding="utf-8")
        fridge_id = f'#define FRIDGE_ID "{name}"  // the PlatformIO env sets this\n\n'
        files = {"sketch.ino": banner("src/main.cpp") + fridge_id + main}
        skip = ("config.h", "config.example.h", "settings.h")
        headers = sorted(p.name for p in (NODE / "include").glob("*.h") if p.name not in skip)
        libs = FIRMWARE_LIBS
        for src in sorted((NODE / "src").glob("*.cpp")):
            if src.name != "main.cpp":
                files[src.name] = banner(f"src/{src.name}") + src.read_text(encoding="utf-8")
    for h in headers:
        files[h] = banner(f"include/{h}") + (NODE / "include" / h).read_text(encoding="utf-8")
    files["settings.h"] = SKETCH_SETTINGS
    files["libraries.txt"] = (
        "# Wokwi library manager (generated by tools/gen_wokwi.py)\n" + "\n".join(libs) + "\n"
    )
    return {k: v.replace("\r\n", "\n") for k, v in files.items()}


def config_h() -> str:
    own = NODE / "include" / "config.h"
    src = own if own.exists() else NODE / "include" / "config.example.h"
    return banner(f"include/{src.name}") + src.read_text(encoding="utf-8").replace("\r\n", "\n")


def toml(env: str) -> str:
    build = f"../../.pio/build/{env}"
    return (
        "# AUTO-GENERATED by tools/gen_wokwi.py. DO NOT EDIT.\n"
        f"# VS Code: build first with `pio run -e {env}` (paths are relative to this file).\n"
        "# wokwi.com: upload diagram.json, sketch.ino, libraries.txt and every .h/.cpp file in this folder.\n"
        "[wokwi]\n"
        "version = 1\n"
        f"firmware = '{build}/firmware.bin'\n"
        f"elf = '{build}/firmware.elf'\n"
    )


def outputs() -> dict[Path, str]:
    pin = read_pins()
    files = {}
    for name, (env, title) in PROJECTS.items():
        files[OUT / name / "diagram.json"] = json.dumps(diagram(title, pin), indent=2) + "\n"
        files[OUT / name / "wokwi.toml"] = toml(env)
        for fname, content in sketch_files(name).items():
            files[OUT / name / fname] = content
    return files


def main() -> int:
    check = "--check" in sys.argv[1:]
    stale = []
    expected = outputs()
    for path, content in expected.items():
        rel = path.relative_to(ROOT).as_posix()
        if check:
            current = path.read_text(encoding="utf-8").replace("\r\n", "\n") if path.exists() else None
            if current != content:
                stale.append(rel)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
    for name in PROJECTS:
        folder = OUT / name
        for extra in sorted(folder.glob("*.*")):
            if extra not in expected and extra.name != "config.h":
                if check:
                    stale.append(f"{extra.relative_to(ROOT).as_posix()} (no longer generated)")
                else:
                    extra.unlink()
        if not check:
            (folder / "config.h").write_text(config_h(), encoding="utf-8", newline="\n")
    if stale:
        print("STALE Wokwi projects (run `python tools/gen_wokwi.py`):", *stale, sep="\n  ")
        return 1
    print(
        "Wokwi projects are up to date"
        if check
        else f"wrote {len(expected)} files in {OUT.relative_to(ROOT).as_posix()}/"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
