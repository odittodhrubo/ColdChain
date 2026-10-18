"""Run the whole system locally: MQTT broker (when none is reachable), ML service, backend, web UI, nodes.

    python -m coldchain_tools.stack demo            # make demo: reset + seed + 6 h history, everything up
    python -m coldchain_tools.stack demo --no-ui --no-nodes --hours 2

`demo` RESETS the configured database (DB_PATH), seeds users, both fridges and eight batches in varied states,
backfills seeded history (labelled in the UI), starts what is not already running, starts a virtual node for
each fridge whose Wokwi node is not online, prints the credentials and QR URLs, and runs until Ctrl-C.

The scenario tests (coldchain_tools.scenarios) use the Stack class with their own ports and a throwaway DB.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

from .backfill import backfill
from .contracts import ROOT, dotenv, setting

DEMO_PASSWORDS = {
    "ADMIN": "Demo-Admin-2026!",
    "PHARMACIST": "Demo-Pharm-2026!",
    "INSPECTOR": "Demo-Insp-2026!",
}
EMAILS = {r: f"{r.lower()}@coldchain.local" for r in DEMO_PASSWORDS}
FRIDGES = ("fridge-01", "fridge-02")
IS_WIN = os.name == "nt"


def python() -> str:
    for p in (ROOT / ".venv/Scripts/python.exe", ROOT / ".venv/bin/python"):
        if p.exists():
            return str(p)
    return sys.executable


def npx() -> str:
    found = shutil.which("npx.cmd" if IS_WIN else "npx")
    if not found:
        raise SystemExit("npx not found: install Node.js 20+")
    return found


def reachable(url: str) -> bool:
    u = urlparse(url)
    port = u.port or {"http": 80, "https": 443, "mqtt": 1883, "mqtts": 8883}.get(u.scheme, 80)
    try:
        with socket.create_connection((u.hostname or "localhost", port), timeout=1):
            return True
    except OSError:
        return False


def http_json(method: str, url: str, token: str | None = None, body: dict | None = None, timeout: float = 10):
    """(status, parsed JSON or None). Never raises on an HTTP error status."""
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, json.loads(
                raw
            ) if raw and res.headers.get_content_type() == "application/json" else None
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw)
        except ValueError:
            return err.code, None
    except (urllib.error.URLError, OSError):
        return 0, None  # nothing listening (yet)


@dataclass
class Proc:
    name: str
    popen: subprocess.Popen
    log: Path

    def stop(self) -> None:
        if self.popen.poll() is not None:
            return
        if IS_WIN:  # tsx / npx spawn children: take the whole tree down
            subprocess.run(["taskkill", "/PID", str(self.popen.pid), "/T", "/F"], capture_output=True)
        else:
            os.killpg(self.popen.pid, signal.SIGTERM)
        try:
            self.popen.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.popen.kill()


@dataclass
class Stack:
    db: Path
    api_port: int = 4000
    ml_port: int = 8000
    web_port: int | None = None
    mqtt_url: str = "mqtt://127.0.0.1:1883"
    prefix: str = "coldchain/v1/local"
    demo_scale: float = 1
    ml_interval_ms: int = 30_000
    passwords: dict[str, str] = field(default_factory=lambda: dict(DEMO_PASSWORDS))
    logs: Path = field(default_factory=lambda: Path(tempfile.mkdtemp(prefix="coldchain-stack-")))
    procs: dict[str, Proc] = field(default_factory=dict)
    seeded: dict = field(default_factory=dict)

    def __post_init__(self):
        env = dotenv()
        self.secrets = {
            f: setting(f"DEVICE_SECRET_{f.upper().replace('-', '_')}", "") or secrets.token_hex(32)
            for f in FRIDGES
        }
        if not env.get("JWT_SECRET") and not os.environ.get("JWT_SECRET"):
            raise SystemExit("no .env: run `node tools/init_env.js` (npm run env:init) first")

    # ------------------------------------------------------------------ processes

    @property
    def api(self) -> str:
        return f"http://127.0.0.1:{self.api_port}"

    @property
    def ml_url(self) -> str:
        return f"http://127.0.0.1:{self.ml_port}"

    def env(self) -> dict[str, str]:
        e = dict(os.environ)
        e.update(
            {
                "DB_PATH": str(self.db),
                "PORT": str(self.api_port),
                "MQTT_URL": self.mqtt_url,
                "MQTT_TOPIC_PREFIX": self.prefix,
                # the local dev broker has no accounts; a hosted one uses the .env credentials
                "MQTT_USERNAME": "" if self._local_broker else setting("MQTT_USERNAME", ""),
                "MQTT_PASSWORD": "" if self._local_broker else setting("MQTT_PASSWORD", ""),
                "ML_URL": self.ml_url,
                "ML_INTERVAL_MS": str(self.ml_interval_ms),
                "DEMO_TIME_SCALE": str(self.demo_scale),
                "SEED_ADMIN_PASSWORD": self.passwords["ADMIN"],
                "SEED_PHARMACIST_PASSWORD": self.passwords["PHARMACIST"],
                "SEED_INSPECTOR_PASSWORD": self.passwords["INSPECTOR"],
                **{f"DEVICE_SECRET_{f.upper().replace('-', '_')}": s for f, s in self.secrets.items()},
            }
        )
        if self.web_port:
            e["CORS_ORIGIN"] = f"http://localhost:{self.web_port}"
            e["PUBLIC_BASE_URL"] = f"http://localhost:{self.web_port}"
        return e

    @property
    def _local_broker(self) -> bool:
        return urlparse(self.mqtt_url).hostname in ("127.0.0.1", "localhost")

    def spawn(self, name: str, args: list[str], cwd: Path, env: dict | None = None) -> Proc:
        log = self.logs / f"{name}.log"
        popen = subprocess.Popen(
            args, cwd=cwd, env=env or self.env(), stdout=log.open("w", encoding="utf-8"),
            stderr=subprocess.STDOUT,
            start_new_session=not IS_WIN,
        )  # fmt: skip
        self.procs[name] = Proc(name, popen, log)
        return self.procs[name]

    def wait(self, name: str, ok, timeout: float = 60) -> None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if ok():
                return
            p = self.procs.get(name)
            if p and p.popen.poll() is not None:
                raise SystemExit(f"{name} exited: see {p.log}\n{p.log.read_text(encoding='utf-8')[-2000:]}")
            time.sleep(0.5)
        raise SystemExit(f"{name} did not come up in {timeout:.0f} s: see {self.procs[name].log}")

    def start(self, name: str) -> None:
        """Start one service (also used to bring it back after failure injection)."""
        if name == "broker":
            port = urlparse(self.mqtt_url).port or 1883
            self.spawn("broker", [npx(), "tsx", "src/scripts/broker.ts"], ROOT / "backend",
                       {**self.env(), "BROKER_PORT": str(port)})  # fmt: skip
            self.wait("broker", lambda: reachable(self.mqtt_url))
        elif name == "ml":
            self.spawn("ml", [python(), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                              "--port", str(self.ml_port)], ROOT / "ml")  # fmt: skip
            self.wait("ml", lambda: http_json("GET", f"{self.ml_url}/health")[0] == 200)
        elif name == "backend":
            self.spawn("backend", [npx(), "tsx", "src/index.ts"], ROOT / "backend")
            self.wait("backend", lambda: http_json("GET", f"{self.api}/api/health")[0] == 200)
        elif name == "web":
            env = {**self.env(), "VITE_PROXY_TARGET": self.api}
            self.spawn(
                "web", [npx(), "vite", "--port", str(self.web_port), "--strictPort"], ROOT / "frontend", env
            )
            self.wait("web", lambda: reachable(f"http://127.0.0.1:{self.web_port}"))

    def stop(self, name: str) -> None:
        p = self.procs.pop(name, None)
        if p:
            p.stop()

    def seed(self, hours: float, weak: dict[str, float] | None = None) -> dict:
        """Fresh database: users, fridges, the eight demo batches, `hours` of seeded history."""
        out = subprocess.run([npx(), "tsx", "src/scripts/demo-seed.ts", "--reset"], cwd=ROOT / "backend",
                             env=self.env(), capture_output=True, text=True, encoding="utf-8")  # fmt: skip
        line = next(
            (x for x in reversed(out.stdout.splitlines()) if x.startswith("{") and '"batches"' in x), None
        )
        if out.returncode != 0 or not line:
            raise SystemExit(f"demo seed failed:\n{out.stdout}\n{out.stderr}")
        self.seeded = json.loads(line)
        if hours > 0:
            self.seeded["last_temp"] = backfill(
                str(self.db), hours, {f: (weak or {}).get(f, 1.0) for f in FRIDGES}
            )
        return self.seeded

    def up(self, hours: float = 6, ui: bool = False, weak: dict[str, float] | None = None) -> Stack:
        if self._local_broker and not reachable(self.mqtt_url):
            self.start("broker")
        self.seed(hours, weak)
        if not reachable(self.ml_url):
            self.start("ml")
        self.start("backend")
        if ui and self.web_port:
            self.start("web")
        return self

    def down(self) -> None:
        for name in list(self.procs)[::-1]:
            self.stop(name)

    # ------------------------------------------------------------------ API helpers

    def login(self, role: str) -> str:
        status, body = http_json("POST", f"{self.api}/api/auth/login",
                                 body={"email": EMAILS[role], "password": self.passwords[role]})  # fmt: skip
        if status != 200:
            raise RuntimeError(f"login {role} failed: {status} {body}")
        return body["token"]

    def call(self, method: str, path: str, token: str | None = None, body: dict | None = None):
        return http_json(method, f"{self.api}{path}", token, body)

    def node(self, fridge: str, thermal_speed: float = 1.0):
        from .virtual_node import NodeRunner

        return NodeRunner(fridge, self.secrets[fridge], self.mqtt_url, self.env()["MQTT_USERNAME"],
                          self.env()["MQTT_PASSWORD"], self.prefix, thermal_speed).start()  # fmt: skip


def wokwi_online(url: str, username: str, password: str, prefix: str, wait_s: float = 3.0) -> set[str]:
    """Device ids whose retained status is 'online' (a Wokwi node or another virtual node is running)."""
    import paho.mqtt.client as mqtt

    online: set[str] = set()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"stack-probe-{secrets.token_hex(3)}")
    if username:
        client.username_pw_set(username, password or None)
    u = urlparse(url)
    if u.scheme in ("mqtts", "ssl"):
        client.tls_set()
    client.on_connect = lambda c, *_a: c.subscribe(f"{prefix}/+/status")
    client.on_message = lambda _c, _u, m: (
        online.add(m.topic.split("/")[-2]) if m.payload.decode() == "online" else None
    )
    try:
        client.connect(u.hostname, u.port or (8883 if u.scheme in ("mqtts", "ssl") else 1883), keepalive=10)
    except OSError:
        return online
    client.loop_start()
    time.sleep(wait_s)
    client.loop_stop()
    client.disconnect()
    return online


def demo(args: argparse.Namespace) -> int:
    db = Path(setting("DB_PATH", "./data/coldchain.db"))
    db = db if db.is_absolute() else ROOT / "backend" / db
    db.parent.mkdir(parents=True, exist_ok=True)
    mqtt_url = args.mqtt or setting("MQTT_URL", "mqtt://127.0.0.1:1883")
    stack = Stack(db=db, api_port=int(setting("PORT", "4000")), ml_port=8000,
                  web_port=None if args.no_ui else 5173,
                  mqtt_url=mqtt_url, prefix=setting("MQTT_TOPIC_PREFIX", "coldchain/v1"),
                  demo_scale=float(setting("DEMO_TIME_SCALE", "1")),
                  logs=ROOT / "backend" / "data" / "demo-logs")  # fmt: skip
    stack.logs.mkdir(parents=True, exist_ok=True)
    if reachable(stack.api):
        raise SystemExit(
            f"something already listens on {stack.api}: stop the backend first (demo resets its DB)"
        )
    print(f"Resetting {db} and seeding the demo ...")
    try:
        stack.up(hours=args.hours, ui=not args.no_ui)
        nodes = []
        if not args.no_nodes:
            env = stack.env()
            online = wokwi_online(mqtt_url, env["MQTT_USERNAME"], env["MQTT_PASSWORD"], stack.prefix)
            for f in FRIDGES:
                if f in online:
                    print(f"  {f}: a node is already online (Wokwi?), not starting a virtual one")
                    continue
                node = stack.node(f)
                node.act("temp", stack.seeded.get("last_temp", {}).get(f, 5.0))  # carry on from the history
                nodes.append(node)
        s = stack.seeded
        print(
            "\nColdChain demo is running"
            + (f": open http://localhost:{stack.web_port}" if stack.web_port else "")
        )
        print(f"  API {stack.api} · ML {stack.ml_url} · MQTT {mqtt_url} · logs {stack.logs}")
        print(
            f"  {args.hours:g} h of SEEDED history before now (labelled in the UI); "
            f"DEMO_TIME_SCALE={stack.demo_scale:g}"
        )
        print("\n  Demo users:")
        for role, pw in stack.passwords.items():
            print(f"    {role:<10} {EMAILS[role]:<28} {pw}")
        print("\n  Batches (public QR check URLs):")
        for b in s["batches"]:
            print(
                f"    {b['name']:<16} {b['fridge']}  {b['status']:<8} {b['remaining_pct']:>5.1f} %  "
                f"{b['public_url']}"
            )
        names = ", ".join(n.node.device_id for n in nodes) or "none"
        print(f"\n  Virtual nodes: {names}  (Ctrl-C stops everything)")
        while True:
            time.sleep(60)
            for n in nodes:
                print("  " + n.status())
    except KeyboardInterrupt:
        print("\nstopping ...")
    finally:
        for n in locals().get("nodes", []):
            n.stop()
        stack.down()
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="reset + seed + run everything")
    d.add_argument("--hours", type=float, default=6, help="seeded history (default 6)")
    d.add_argument("--no-ui", action="store_true")
    d.add_argument("--no-nodes", action="store_true", help="do not start virtual nodes")
    d.add_argument("--mqtt", help="broker URL (default MQTT_URL from .env; a local one is started if needed)")
    args = ap.parse_args(argv)
    return demo(args)


if __name__ == "__main__":
    raise SystemExit(main())
