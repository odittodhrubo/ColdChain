"""Shared contracts for every tool: constants, test vectors, topics, .env settings.

Reads contracts/constants.json directly, the same source the firmware and backend headers are generated from,
so the simulator cannot drift from them.
"""

from __future__ import annotations

import json
import os
import re
from functools import cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"


@cache
def constants() -> dict:
    return json.loads((CONTRACTS / "constants.json").read_text(encoding="utf-8"))


@cache
def vectors() -> dict:
    return json.loads((CONTRACTS / "test_vectors.json").read_text(encoding="utf-8"))


C = constants()


@cache
def firmware_config() -> dict[str, float]:
    """`constexpr` values from firmware/fridge-node/include/node_config.h (thermal, battery, sync timing).

    Parsed, not copied, so the simulator and the firmware share one set of parameters.
    """
    text = (ROOT / "firmware" / "fridge-node" / "include" / "node_config.h").read_text(encoding="utf-8")
    macros = {m[1]: m[2] for m in re.finditer(r"^#define (\w+) (\S+)", text, re.M)}
    out: dict[str, float] = {}
    for name, expr in re.findall(r"constexpr \w+ (\w+) = ([^;]+);", text):
        expr = macros.get(expr.strip(), expr)
        expr = re.sub(r"(?<=\d)(f|UL|u)\b", "", expr)
        if not re.fullmatch(r"[\d.\s*+/()-]+", expr):
            raise ValueError(f"node_config.h: cannot evaluate {name} = {expr}")
        out[name] = float(eval(expr, {"__builtins__": {}}))  # digits and arithmetic only, checked above
    return out


def topic(prefix: str, device_id: str, kind: str) -> str:
    return C["TOPICS"][kind].replace("{prefix}", prefix).replace("{device_id}", device_id)


@cache
def dotenv() -> dict[str, str]:
    """KEY=value pairs from the repo .env (no interpolation). Missing file = empty."""
    path = ROOT / ".env"
    if not path.exists():
        return {}
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    return out


def setting(name: str, default: str = "") -> str:
    """Environment variable, else .env, else default."""
    return os.environ.get(name) or dotenv().get(name) or default


def secret_var(device_id: str) -> str:
    return "DEVICE_SECRET_" + device_id.replace("-", "_").upper()


def device_secret(device_id: str) -> str:
    secret = setting(secret_var(device_id))
    if not secret:
        raise SystemExit(
            f"no secret for {device_id}: set {secret_var(device_id)} in .env (npm run env:init) "
            "or pass --secret"
        )
    return secret


def refuse_in_production() -> None:
    """Attack and tamper tools must never run against a production deployment."""
    if setting("NODE_ENV") == "production":
        raise SystemExit("refusing to run: NODE_ENV=production")
