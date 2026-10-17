"""Static checks of the generated Wokwi circuits against the pin-map contract (docs/CONTRACTS.md §9)."""

import configparser
import json
import re
from pathlib import Path

import pytest

NODE = Path(__file__).resolve().parents[2] / "firmware" / "fridge-node"
PROJECTS = ["fridge-01", "fridge-02", "hw-smoke"]

# Part 3.9 of the build spec. Deliberately restated here: this is what pins.h is checked against.
SPEC_PINS = {
    "DS18B20": 4,
    "DOOR": 15,
    "RELAY": 16,
    "LED_GREEN": 25,
    "LED_YELLOW": 26,
    "LED_RED": 27,
    "LED_BLUE": 19,
    "BUZZER": 18,
    "BTN_POWER": 32,
    "BTN_WIFI": 33,
    "MODE": 23,
    "I2C_SDA": 21,
    "I2C_SCL": 22,
}

# Pin names per Wokwi part type (docs.wokwi.com / wokwi-boards).
KNOWN_PINS = {
    "board-esp32-devkit-c-v4": {
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
    },
    "wokwi-ds18b20": {"VCC", "DQ", "GND"},
    "wokwi-pushbutton": {"1.l", "1.r", "2.l", "2.r"},
    "wokwi-relay-module": {"VCC", "GND", "IN", "NC", "COM", "NO"},
    "wokwi-led": {"A", "C"},
    "wokwi-resistor": {"1", "2"},
    "wokwi-buzzer": {"1", "2"},
    "wokwi-slide-switch": {"1", "2", "3"},
    "board-ssd1306": {"GND", "VCC", "SCL", "SDA"},
    "wokwi-text": set(),
}

# GPIO12 is a boot strapping pin; 34-39 (VP/VN) are input-only without pull-ups; 6-11 drive the SPI flash.
FORBIDDEN = {"12", "34", "35", "VP", "VN", "CLK", "D0", "D1", "D2", "D3", "CMD"}
GND = {"esp:GND.1", "esp:GND.2", "esp:GND.3"}


def pins_h() -> dict[str, int]:
    src = (NODE / "include" / "pins.h").read_text()
    return {m[1]: int(m[2]) for m in re.finditer(r"constexpr\s+uint8_t\s+PIN_(\w+)\s*=\s*(\d+);", src)}


def load(project: str) -> dict:
    return json.loads((NODE / "wokwi" / project / "diagram.json").read_text(encoding="utf-8"))


def nets(d: dict) -> dict[str, frozenset]:
    """Union-find over wires: endpoint -> set of endpoints electrically joined by wires."""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b, *_ in d["connections"]:
        parent[find(a)] = find(b)
    groups: dict[str, set] = {}
    for x in parent:
        groups.setdefault(find(x), set()).add(x)
    return {x: frozenset(groups[find(x)]) for x in parent}


def test_pins_h_matches_spec():
    assert pins_h() == SPEC_PINS


@pytest.mark.parametrize("project", PROJECTS)
def test_parts_and_pins_exist(project):
    d = load(project)
    ids = [p["id"] for p in d["parts"]]
    assert len(ids) == len(set(ids)), "duplicate part ids"
    types = {p["id"]: p["type"] for p in d["parts"]}
    for conn in d["connections"]:
        for end in conn[:2]:
            pid, pin = end.split(":", 1)
            if pid == "$serialMonitor":
                continue
            assert pid in types, f"{end}: unknown part"
            assert pin in KNOWN_PINS[types[pid]], f"{end}: no such pin on {types[pid]}"


@pytest.mark.parametrize("project", PROJECTS)
def test_wiring_matches_pin_map(project):
    n = nets(load(project))
    p = SPEC_PINS
    joined = lambda a, b: b in n.get(a, ())  # noqa: E731
    direct = {
        "DS18B20": "temp:DQ",
        "DOOR": "door:2",
        "RELAY": "relay:IN",
        "BUZZER": "buzzer:2",
        "BTN_POWER": "btn_power:1.l",
        "BTN_WIFI": "btn_wifi:1.l",
        "MODE": "mode:2",
        "I2C_SDA": "oled:SDA",
        "I2C_SCL": "oled:SCL",
    }
    for name, target in direct.items():
        assert joined(f"esp:{p[name]}", target), f"GPIO{p[name]} ({name}) not wired to {target}"
    for color in ["green", "yellow", "red", "blue"]:
        gpio = p[f"LED_{color.upper()}"]
        assert joined(f"esp:{gpio}", f"r_{color}:1"), f"GPIO{gpio} not wired to r_{color}"
        assert joined(f"r_{color}:2", f"led_{color}:A")
        assert n[f"led_{color}:C"] & GND


@pytest.mark.parametrize("project", PROJECTS)
def test_electrical_rules(project):
    d = load(project)
    n = nets(d)
    attrs = {p["id"]: p["attrs"] for p in d["parts"]}
    # 4.7k pull-up from DQ to 3V3
    assert attrs["r_pullup"]["value"] == "4700"
    assert "r_pullup:1" in n["temp:DQ"] and "esp:3V3" in n["r_pullup:2"]
    # LED series resistors
    for c in ["green", "yellow", "red", "blue"]:
        assert attrs[f"r_{c}"]["value"] == "220"
    # INPUT_PULLUP inputs switch to GND
    for end in ["btn_power:2.l", "btn_wifi:2.l", "door:1", "mode:1"]:
        assert n[end] & GND, f"{end} must go to GND"
    # power rails
    assert "esp:3V3" in n["oled:VCC"] and "esp:3V3" in n["temp:VCC"] and "esp:5V" in n["relay:VCC"]
    assert attrs["oled"]["i2cAddress"] == "0x3c"
    # no strapping / input-only / flash pins anywhere
    used = {end.split(":", 1)[1] for c in d["connections"] for end in c[:2] if end.startswith("esp:")}
    assert not used & FORBIDDEN, f"forbidden ESP32 pins used: {used & FORBIDDEN}"


@pytest.mark.parametrize("project", PROJECTS)
def test_video_labels(project):
    d = load(project)
    labels = " | ".join(p["attrs"].get("text", "") + p["attrs"].get("label", "") for p in d["parts"])
    for required in ["DOOR", "COMPRESSOR RELAY", "POWER FAIL", "WI-FI OUTAGE", "MODE (model/manual)"]:
        assert required in labels


def test_projects_share_one_circuit():
    def strip_title(d):
        return [p for p in d["parts"] if p["id"] != "title"], d["connections"]

    base = strip_title(load(PROJECTS[0]))
    for project in PROJECTS[1:]:
        assert strip_title(load(project)) == base


@pytest.mark.parametrize("project", PROJECTS)
def test_wokwi_toml_points_at_a_platformio_env(project):
    toml = (NODE / "wokwi" / project / "wokwi.toml").read_text()
    env = re.search(r"firmware = '\.\./\.\./\.pio/build/([\w-]+)/firmware\.bin'", toml)[1]
    ini = configparser.ConfigParser()
    ini.read(NODE / "platformio.ini")
    assert f"env:{env}" in ini.sections()
