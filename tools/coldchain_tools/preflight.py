"""Demo-day pre-flight: one PASS / FAIL / WARN line per thing that can ruin a take, in about 10 seconds.

    python -m coldchain_tools.preflight                   # after `make demo`, before every take
    python -m coldchain_tools.preflight --expect-scale 20 # also check DEMO_TIME_SCALE
    python -m coldchain_tools.preflight --prove-rbac      # on camera: the server refuses an Inspector's move

Checks: .env, clock skew against an internet time source, the broker (with the backend's credentials),
backend readiness, the ML service and its model files, both nodes online, the latch and batch states a fresh
`make demo` leaves, and DEMO_TIME_SCALE. It signs in with the demo accounts, so it is for the demo database.
"""

from __future__ import annotations

import argparse
import email.utils
import secrets
import sys
import time
import urllib.request
from urllib.parse import urlparse

from .contracts import ROOT, dotenv, setting
from .stack import DEMO_PASSWORDS, EMAILS, FRIDGES, TOKEN_IN_BODY, http_json, wokwi_online

RESULTS: list[tuple[str, str, str]] = []
# The server accepts ±30 s (STALE_TS). The laptop and the nodes each drift, so warn well before the limit.
SKEW_PASS_S = 3.0  # 2 s target + 1 s for the Date header's rounding
SKEW_FAIL_S = 10.0
EXPECTED_LATCHED = {"fridge-02"}  # fresh `make demo`: the seeded Discard batch (Rabies) latches fridge-02


def record(status: str, name: str, detail: str = "") -> None:
    RESULTS.append((status, name, detail))
    print(f"{status:<5} {name}{f': {detail}' if detail else ''}", flush=True)


# ------------------------------------------------------------------------------------------- pure checks


def skew_from_date(date_header: str, local_ts: float) -> float:
    """Local clock minus the time in an HTTP Date header, in seconds (positive = local clock ahead)."""
    return local_ts - email.utils.parsedate_to_datetime(date_header).timestamp()


def skew_verdict(skew: float) -> str:
    return "PASS" if abs(skew) <= SKEW_PASS_S else "WARN" if abs(skew) <= SKEW_FAIL_S else "FAIL"


def check_latches(fridges: list[dict], expected: set[str]) -> tuple[str, str]:
    latched = {f["id"] for f in fridges if f.get("latch")}
    names = ", ".join(sorted(latched)) or "none"
    detail = f"latched: {names} (fresh demo: {', '.join(sorted(expected)) or 'none'})"
    return ("PASS" if latched == expected else "FAIL"), detail


def check_batches(batches: list[dict]) -> tuple[str, str]:
    counts: dict[str, int] = {}
    for b in batches:
        counts[b["status"]] = counts.get(b["status"], 0) + 1
    detail = ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) or "no batches"
    ok = len(batches) in (8, 10) and counts.get("AT_RISK", 0) >= 1 and counts.get("DISCARD", 0) >= 1
    if not ok:
        detail += " (a fresh demo has 8 or 10, incl. At Risk and Discard)"
    return ("PASS" if ok else "FAIL"), detail


# ------------------------------------------------------------------------------------------- live checks


def clock() -> None:
    for url in ("https://www.google.com", "https://www.cloudflare.com"):
        try:
            t0 = time.time()
            with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=5) as res:
                date = res.headers.get("Date")
            if not date:
                continue
            # the Date header has 1 s resolution: compare against the middle of the request
            skew = skew_from_date(date, (t0 + time.time()) / 2)
            verdict = skew_verdict(skew)
            hint = "" if verdict == "PASS" else ": resync the clock (beyond ±30 s every message is STALE_TS)"
            record(verdict, "clock skew", f"{skew:+.1f} s vs {urlparse(url).hostname}{hint}")
            return
        except OSError:
            continue
    record("WARN", "clock skew", "no internet time source reachable: check the clock by hand")


def broker(url: str, username: str, password: str) -> bool:
    import paho.mqtt.client as mqtt

    u = urlparse(url)
    tls = u.scheme in ("mqtts", "ssl")
    port = u.port or (8883 if tls else 1883)
    result: dict = {}
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"preflight-{secrets.token_hex(3)}")
    if username:
        client.username_pw_set(username, password or None)
    if tls:
        client.tls_set()
    client.on_connect = lambda _c, _u, _f, rc, _p=None: result.setdefault("rc", rc)
    try:
        client.connect(u.hostname, port, keepalive=10)
    except OSError as err:
        record("FAIL", "MQTT broker", f"{u.hostname}:{port}: {err}")
        return False
    client.loop_start()
    end = time.monotonic() + 5
    while "rc" not in result and time.monotonic() < end:
        time.sleep(0.05)
    client.loop_stop()
    client.disconnect()
    rc = result.get("rc")
    ok = rc is not None and not rc.is_failure
    record(
        "PASS" if ok else "FAIL",
        "MQTT broker",
        f"{u.hostname}:{port} " + ("connected" if ok else f"refused: {rc}"),
    )
    return ok


def demo_login(api: str) -> str | None:
    creds = {"email": EMAILS["INSPECTOR"], "password": DEMO_PASSWORDS["INSPECTOR"]}
    status, body = http_json("POST", f"{api}/api/auth/login", body=creds, headers=TOKEN_IN_BODY)
    return body["token"] if status == 200 else None


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--expect-scale", type=float, help="DEMO_TIME_SCALE the script expects (e.g. 20)")
    ap.add_argument("--prove-rbac", action="store_true", help="show the server refusing an Inspector's move")
    args = ap.parse_args(argv)

    api = f"http://127.0.0.1:{setting('PORT', '4000')}"
    if args.prove_rbac:
        return prove_rbac(api)

    env = dotenv()
    record(
        "PASS" if env.get("JWT_SECRET") else "FAIL", ".env", "present" if env else "missing: npm run env:init"
    )
    clock()

    mqtt_url = setting("MQTT_URL", "mqtt://127.0.0.1:1883")
    local = urlparse(mqtt_url).hostname in ("127.0.0.1", "localhost")
    # the same credentials the demo backend uses (stack.Stack.env): none for the local dev broker
    user, pw = ("", "") if local else (setting("MQTT_USERNAME"), setting("MQTT_PASSWORD"))
    if broker(mqtt_url, user, pw):
        prefix = setting("MQTT_TOPIC_PREFIX", "coldchain/v1")
        online: set[str] = set()
        end = time.monotonic() + 10  # nodes started a moment ago may still be connecting
        while time.monotonic() < end and not set(FRIDGES) <= online:
            online |= wokwi_online(mqtt_url, user, pw, prefix)
        missing = [f for f in FRIDGES if f not in online]
        detail = ", ".join(sorted(online)) or "none"
        record("PASS" if not missing else "FAIL", "nodes online",
               detail + (f"; offline: {', '.join(missing)}" if missing else ""))  # fmt: skip

    status, body = http_json("GET", f"{api}/api/ready")
    if status == 404:  # a backend from before /api/ready
        status, body = http_json("GET", f"{api}/api/health")
    detail = f"{api} -> {status or 'not running'}"
    if status not in (0, 200) and isinstance(body, dict) and body.get("checks"):
        detail += f" {body['checks']}"
    record("PASS" if status == 200 else "FAIL", "backend ready", detail)

    ml = setting("ML_URL", "http://127.0.0.1:8000").replace("localhost", "127.0.0.1")
    models = sorted(p.name for p in (ROOT / "ml" / "models").glob("*.joblib"))
    status, body = http_json("GET", f"{ml}/health")
    # 200 with "degraded" = running, but the models were refused (missing, or a hash mismatch: S6)
    loaded = status == 200 and isinstance(body, dict) and body.get("status") == "ok"
    detail = f"{ml} -> {status or 'not running'}; models: {', '.join(models) or 'none'}"
    if status == 200 and not loaded:
        detail += f"; NOT loaded: {(body or {}).get('error', 'unknown')}"
    record("PASS" if loaded and len(models) >= 2 else "FAIL", "ML service", detail)

    status, health = http_json("GET", f"{api}/api/health")
    if status == 200:
        scale = health.get("demoScale")
        if args.expect_scale is None:
            record("PASS", "DEMO_TIME_SCALE", f"{scale:g} (add --expect-scale to check it)")
        else:
            ok = scale == args.expect_scale
            record("PASS" if ok else "FAIL", "DEMO_TIME_SCALE", f"{scale:g}, expected {args.expect_scale:g}")

    token = demo_login(api)
    if not token:
        record("FAIL", "demo state", "the Inspector demo login failed: run `make demo` first")
    else:
        _, fridges = http_json("GET", f"{api}/api/fridges", token)
        record(*with_name("red latch", check_latches(fridges["fridges"], EXPECTED_LATCHED)))
        _, batches = http_json("GET", f"{api}/api/batches?pageSize=200", token)
        record(*with_name("batch states", check_batches(batches["batches"])))

    failed = sum(1 for s, *_ in RESULTS if s == "FAIL")
    tail = f", {failed} to fix before recording" if failed else ""
    print(f"\n{len(RESULTS) - failed}/{len(RESULTS)} ready{tail}")
    return 1 if failed else 0


def with_name(name: str, result: tuple[str, str]) -> tuple[str, str, str]:
    return result[0], name, result[1]


def prove_rbac(api: str) -> int:
    """What shot 11 of the video shows: the server itself refuses an Inspector, not just the UI."""
    token = demo_login(api)
    if not token:
        print("Inspector demo login failed: is `make demo` running?")
        return 1
    _, batches = http_json("GET", f"{api}/api/batches?pageSize=1", token)
    batch = batches["batches"][0]
    print(f"signed in as INSPECTOR ({EMAILS['INSPECTOR']})")
    print(f'POST /api/batches/{batch["id"]}/move {{"to_fridge_id": "fridge-02"}}   ({batch["name"]})')
    status, body = http_json(
        "POST", f"{api}/api/batches/{batch['id']}/move", token, {"to_fridge_id": "fridge-02"}
    )
    code = ((body or {}).get("error") or {}).get("code", "")
    verdict = "refused by the server (role checked on every request)" if status == 403 else "NOT refused!"
    print(f"-> {status} {code}: {verdict}")
    return 0 if status == 403 else 1


if __name__ == "__main__":
    raise SystemExit(main())
