#!/usr/bin/env python3
"""Generate the Wokwi projects for the fridge node from one template.

    python tools/gen_wokwi.py          # write firmware/fridge-node/wokwi/*/{diagram.json,wokwi.toml}
    python tools/gen_wokwi.py --check  # exit 1 if any generated file is stale

GPIO numbers come from firmware/fridge-node/include/pins.h, so the circuit and the firmware cannot drift.
Edit layout or wiring here, never in the generated diagram.json files.
"""

from __future__ import annotations

import json
import re
import sys
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


def read_pins() -> dict[str, int]:
    pins = {
        m[1]: int(m[2])
        for m in re.finditer(r"constexpr\s+uint8_t\s+PIN_(\w+)\s*=\s*(\d+);", PINS_H.read_text())
    }
    if not pins:
        raise SystemExit(f"no PIN_ constants found in {PINS_H}")
    return pins


def part(type_: str, id_: str, top: float, left: float, rotate: int = 0, **attrs: str) -> dict:
    p = {"type": type_, "id": id_, "top": top, "left": left}
    if rotate:
        p["rotate"] = rotate
    p["attrs"] = attrs
    return p


def text(id_: str, top: float, left: float, label: str) -> dict:
    return part("wokwi-text", id_, top, left, text=label)


def diagram(title: str, pin: dict[str, int]) -> dict:
    g = lambda name: f"esp:{pin[name]}"  # noqa: E731

    parts = [
        part("board-esp32-devkit-c-v4", "esp", 0, 0),
        text("title", -150, -10, title),
        # left side: buttons and status LEDs
        part("wokwi-pushbutton", "btn_power", 40, -260, color="red", label="POWER FAIL", key="p"),
        part("wokwi-pushbutton", "btn_wifi", 110, -260, color="blue", label="WI-FI OUTAGE", key="w"),
        text("t_leds", 225, -250, "SAFE  WARN  BREACH"),
        part("wokwi-led", "led_green", 250, -250, color="green"),
        part("wokwi-led", "led_yellow", 250, -200, color="yellow"),
        part("wokwi-led", "led_red", 250, -150, color="red"),
        part("wokwi-resistor", "r_green", 330, -265, rotate=90, value="220"),
        part("wokwi-resistor", "r_yellow", 330, -215, rotate=90, value="220"),
        part("wokwi-resistor", "r_red", 330, -165, rotate=90, value="220"),
        # right side, top to bottom in header-pin order
        part("board-ssd1306", "oled", -110, 150, i2cAddress="0x3c"),
        text("t_mode", -10, 180, "MODE (model/manual)"),
        part("wokwi-slide-switch", "mode", 10, 200),
        text("t_comp", 60, 180, "COMP"),
        part("wokwi-led", "led_blue", 75, 185, color="blue"),
        part("wokwi-resistor", "r_blue", 150, 170, rotate=90, value="220"),
        part("wokwi-buzzer", "buzzer", 60, 260, volume="0.3"),
        text("t_relay", 190, 300, "COMPRESSOR RELAY"),
        part("wokwi-relay-module", "relay", 210, 300),
        text("t_temp", 270, 330, "TEMP PROBE (manual mode)"),
        part("wokwi-ds18b20", "temp", 290, 360, temperature="4.5"),
        part("wokwi-resistor", "r_pullup", 300, 290, rotate=90, value="4700"),
        text("t_door", 340, 180, "DOOR (left=closed)"),
        part("wokwi-slide-switch", "door", 360, 200),
    ]

    connections = [
        ["esp:TX", "$serialMonitor:RX", "", []],
        ["esp:RX", "$serialMonitor:TX", "", []],
        # buttons to GND, INPUT_PULLUP
        ["btn_power:1.l", g("BTN_POWER"), "orange", []],
        ["btn_power:2.l", "esp:GND.1", "black", []],
        ["btn_wifi:1.l", g("BTN_WIFI"), "cyan", []],
        ["btn_wifi:2.l", "esp:GND.1", "black", []],
        # status LEDs: GPIO -> 220R -> anode, cathode -> GND
        [g("LED_GREEN"), "r_green:1", "green", []],
        ["r_green:2", "led_green:A", "green", []],
        ["led_green:C", "esp:GND.1", "black", []],
        [g("LED_YELLOW"), "r_yellow:1", "gold", []],
        ["r_yellow:2", "led_yellow:A", "gold", []],
        ["led_yellow:C", "esp:GND.1", "black", []],
        [g("LED_RED"), "r_red:1", "red", []],
        ["r_red:2", "led_red:A", "red", []],
        ["led_red:C", "esp:GND.1", "black", []],
        [g("LED_BLUE"), "r_blue:1", "blue", []],
        ["r_blue:2", "led_blue:A", "blue", []],
        ["led_blue:C", "esp:GND.3", "black", []],
        # OLED on I2C
        ["oled:VCC", "esp:3V3", "red", []],
        ["oled:GND", "esp:GND.2", "black", []],
        ["oled:SDA", g("I2C_SDA"), "violet", []],
        ["oled:SCL", g("I2C_SCL"), "purple", []],
        # mode and door slide switches: common pin -> GPIO, left pin -> GND (left = LOW)
        ["mode:2", g("MODE"), "gray", []],
        ["mode:1", "esp:GND.2", "black", []],
        ["door:2", g("DOOR"), "white", []],
        ["door:1", "esp:GND.3", "black", []],
        # buzzer
        ["buzzer:2", g("BUZZER"), "magenta", []],
        ["buzzer:1", "esp:GND.3", "black", []],
        # compressor relay module (5 V coil, active HIGH)
        ["relay:VCC", "esp:5V", "red", []],
        ["relay:GND", "esp:GND.3", "black", []],
        ["relay:IN", g("RELAY"), "orange", []],
        # DS18B20 with 4.7k pull-up on DQ
        ["temp:VCC", "esp:3V3", "red", []],
        ["temp:GND", "esp:GND.3", "black", []],
        ["temp:DQ", g("DS18B20"), "green", []],
        ["r_pullup:1", "temp:DQ", "green", []],
        ["r_pullup:2", "esp:3V3", "red", []],
    ]

    return {
        "version": 1,
        "author": "ColdChain",
        "editor": "wokwi",
        "parts": parts,
        "connections": connections,
        "serialMonitor": {"display": "terminal", "newline": "lf"},
        "dependencies": {},
    }


def toml(env: str) -> str:
    build = f"../../.pio/build/{env}"
    return (
        "# AUTO-GENERATED by tools/gen_wokwi.py. DO NOT EDIT.\n"
        f"# Build first: pio run -e {env}   (paths are relative to this file)\n"
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
    return files


def main() -> int:
    check = "--check" in sys.argv[1:]
    stale = []
    for path, content in outputs().items():
        rel = path.relative_to(ROOT).as_posix()
        if check:
            current = path.read_text(encoding="utf-8").replace("\r\n", "\n") if path.exists() else None
            if current != content:
                stale.append(rel)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8", newline="\n")
            print(f"wrote {rel}")
    if stale:
        print("STALE Wokwi projects (run `python tools/gen_wokwi.py`):", *stale, sep="\n  ")
        return 1
    if check:
        print("Wokwi projects are up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
