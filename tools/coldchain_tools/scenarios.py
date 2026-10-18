"""End-to-end scenarios S1-S10 and failure injection, through the real stack (P20).

Starts its own isolated stack (local MQTT broker, ML service, backend on spare ports, a throwaway database
with 3 h of seeded history), drives virtual nodes (the firmware's logic, over MQTT) and checks every outcome
through the REST API, the way the UI sees it, plus the database for ordering / duplicate checks.

    python -m coldchain_tools.scenarios                 # quick: shortened waits, about 12 minutes
    python -m coldchain_tools.scenarios --full          # the spec's durations, door-ajar lead time (~45 min)
    python -m coldchain_tools.scenarios --only S3 S7    # a subset

DEMO_TIME_SCALE=60 here (a 60-minute heat budget lasts 60 s at x1) and the nodes run their physics 4x faster
for S1-S6; S10 restarts a clean stack at real speed, which is what the models were trained on.
"""

from __future__ import annotations

import argparse
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
import traceback
from collections.abc import Callable
from pathlib import Path

from . import attack, tamper
from .sim_engine import AJAR_K
from .stack import Stack

FRIDGE_ALERTS = {"FRIDGE_BREACH", "DOOR_OPEN_LONG", "POWER_FAILURE", "FRIDGE_OFFLINE", "BATTERY_LOW"}


class Fail(AssertionError):
    pass


def check(cond, msg: str) -> None:
    if not cond:
        raise Fail(msg)


def until(fn: Callable, timeout: float, msg: str, every: float = 1.0):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        last = fn()
        if last:
            return last
        time.sleep(every)
    raise Fail(f"{msg} (waited {timeout:.0f} s, last: {last!r})")


class Run:
    def __init__(self, full: bool):
        self.full = full
        self.tmp = Path(tempfile.mkdtemp(prefix="coldchain-scenarios-"))
        self.stack: Stack | None = None
        self.nodes: dict = {}
        self.tokens: dict[str, str] = {}
        self.notes: list[str] = []

    # ---------------------------------------------------------------- setup

    def up(self, weak: dict[str, float] | None = None, speed: float = 4.0, hours: float = 3) -> None:
        self.down()
        self.stack = Stack(
            db=self.tmp / f"scenarios-{secrets.token_hex(3)}.db",
            api_port=4410,
            ml_port=8410,
            mqtt_url="mqtt://127.0.0.1:18831",
            prefix=f"coldchain/v1/scn{secrets.token_hex(3)}",
            demo_scale=60,
            ml_interval_ms=5000,
            logs=self.tmp / "logs",
        )
        self.stack.logs.mkdir(parents=True, exist_ok=True)
        self.stack.up(hours=hours, weak=weak)
        self.tokens = {r: self.stack.login(r) for r in ("ADMIN", "PHARMACIST", "INSPECTOR")}
        for f in ("fridge-01", "fridge-02"):
            node = self.stack.node(f, thermal_speed=speed)
            node.act("eff", (weak or {}).get(f, 1.0))
            node.act("temp", self.stack.seeded["last_temp"].get(f, 5.0))
            self.nodes[f] = node
        until(lambda: all(self.fridge(f)["status"] != "OFFLINE" for f in self.nodes), 60, "nodes online")

    def down(self) -> None:
        for n in self.nodes.values():
            n.stop()
        self.nodes = {}
        if self.stack:
            self.stack.down()

    # ---------------------------------------------------------------- API helpers

    def get(self, path: str, role: str = "ADMIN"):
        status, body = self.stack.call("GET", path, self.tokens[role])
        check(status == 200, f"GET {path} -> {status} {body}")
        return body

    def fridge(self, fid: str) -> dict:
        return self.get(f"/api/fridges/{fid}")["fridge"]

    def detail(self, fid: str) -> dict:
        return self.get(f"/api/fridges/{fid}")

    def alerts(self, status: str = "all") -> list[dict]:
        return self.get(f"/api/alerts?status={status}&pageSize=200")["alerts"]

    def db(self) -> sqlite3.Connection:
        return sqlite3.connect(f"file:{self.stack.db.as_posix()}?mode=ro", uri=True, timeout=10)

    def events(self, fid: str, since_s: float, type_: str | None = None) -> list[tuple]:
        with self.db() as db:
            sql = "SELECT ts, type, seq FROM events WHERE fridge_id = ? AND ts >= ?"
            args: list = [fid, int(since_s)]
            if type_:
                sql += " AND type = ?"
                args.append(type_)
            return db.execute(sql + " ORDER BY ts, seq", args).fetchall()

    def readings(self, fid: str, since_s: float) -> list[tuple]:
        with self.db() as db:
            return db.execute(
                "SELECT ts, seq, temp, comp, door, power, batt, late FROM readings "
                "WHERE fridge_id = ? AND ts >= ? AND seeded = 0 ORDER BY ts, seq",
                (fid, int(since_s)),
            ).fetchall()

    # ---------------------------------------------------------------- scenarios

    def s1_normal(self) -> None:
        """Two fridges publish; the compressor cycles between 3 and 7 °C; status SAFE; no fridge alerts."""
        start = time.time()
        minutes = 10 if self.full else 4
        time.sleep(minutes * 60)
        for f in self.nodes:
            rows = self.readings(f, start)
            check(len(rows) >= minutes * 60 / 5 * 0.9, f"{f}: only {len(rows)} readings in {minutes} min")
            temps = [r[2] for r in rows if r[2] is not None]
            check(
                min(temps) > 2.0 and max(temps) < 8.0,
                f"{f}: temperature left 2-8 °C: {min(temps)}-{max(temps)}",
            )
            ons, offs = self.events(f, start, "COMP_ON"), self.events(f, start, "COMP_OFF")
            check(ons and offs, f"{f}: no complete compressor cycle ({len(ons)} on, {len(offs)} off)")
            check(self.fridge(f)["status"] in ("SAFE", "WARNING"), f"{f}: status {self.fridge(f)['status']}")
        raised = [a for a in self.alerts() if a["type"] in FRIDGE_ALERTS and a["created_at"] >= start * 1000]
        check(not raised, f"fridge alerts during normal operation: {[a['type'] for a in raised]}")
        self.s1_start = start

    def s2_hysteresis(self) -> None:
        """Hysteresis: never running below 3 °C, never off above 7 °C outside the 60 s minimum-off time."""
        since = getattr(self, "s1_start", time.time() - 600)
        for f in self.nodes:
            # Readings come every 5 s, so the switching instants themselves are rarely sampled. What the
            # readings can prove: the compressor never runs below 3.0 °C, never switches on below 7.0 °C, and
            # is off above 7.0 °C only during the 60 s minimum-off time (or with the door open / on battery).
            noise = 0.1
            rows = self.readings(f, since)  # ts, seq, temp, comp, door, power, ...
            offs = [e[0] for e in self.events(f, since, "COMP_OFF")]
            ons = [e[0] for e in self.events(f, since, "COMP_ON")]
            for ts, _seq, temp, comp, door, power, *_ in rows:
                if temp is None:
                    continue
                # (the exact 7.0 / 3.0 switching points are asserted by the firmware's native test_control)
                if comp:
                    check(temp > 3.0 - noise, f"{f}: compressor running at {temp:.2f} °C (OFF is at 3.0)")
                elif temp > 7.0 + noise and not door and power == "MAINS":
                    last_off = max((o for o in offs if o <= ts), default=None)
                    check(last_off is not None and ts - last_off < 60 + 6,
                          f"{f}: off at {temp:.2f} °C outside the minimum-off window")  # fmt: skip
            for on in ons:
                last_off = max((o for o in offs if o < on), default=None)
                if last_off is not None:
                    check(on - last_off >= 60, f"{f}: restarted {on - last_off} s after OFF (< 60 s)")

    def s3_door(self) -> None:
        """Door open > 60 s: buzzer event, alert delivered within 5 s, temperature WARNING -> BREACH."""
        node, f, start = self.nodes["fridge-01"], "fridge-01", time.time()
        seen: list[str] = []
        stop = threading.Event()

        def watch():
            while not stop.is_set():
                seen.append(self.fridge(f)["status"])
                time.sleep(1)

        t = threading.Thread(target=watch, daemon=True)
        t.start()
        node.act("door", True)
        try:
            alarm = until(lambda: self.events(f, start, "DOOR_ALARM"), 90, "DOOR_ALARM event")
            alert = until(
                lambda: next(
                    (
                        a
                        for a in self.alerts()
                        if a["type"] == "DOOR_OPEN_LONG"
                        and a["fridge_id"] == f
                        and a["created_at"] >= start * 1000
                    ),
                    None,
                ),
                15,
                "DOOR_OPEN_LONG alert",
            )
            delay = alert["created_at"] / 1000 - alarm[0][0]
            check(delay <= 6, f"alert {delay:.1f} s after the alarm (> 5 s)")
            check(
                alert["delivery_status"].get("in_app", {}).get("status") == "sent", "in-app delivery not sent"
            )
            until(lambda: "BREACH" in seen, 120, "status reached BREACH")
            check("WARNING" in seen[: seen.index("BREACH")], f"no WARNING before BREACH: {seen[:20]}")
        finally:
            node.act("door", False)
            stop.set()
        self.notes.append(
            f"S3: alert {delay:.1f} s after DOOR_ALARM; statuses {'→'.join(dict.fromkeys(seen))}"
        )

    def s4_budget(self) -> None:
        """Hold 9 °C (x1) and 13 °C (x2): rates; At risk < 20 %; Discard at 0 with the latch; reset by Admin;
        the QR keeps saying Discard."""
        node, f = self.nodes["fridge-02"], "fridge-02"
        status, body = self.stack.call(
            "POST",
            "/api/batches",
            self.tokens["PHARMACIST"],
            {
                "name": "S4 budget",
                "manufacturer": "Test",
                "lot_number": f"S4-{secrets.token_hex(2)}",
                "quantity": 5,
                "expiry_date": "2030-01-01",
                "criticality": 2,
                "fridge_id": f,
            },
        )
        check(status == 201, f"create batch {status} {body}")
        batch = body["batch"]
        hold = {"t": None}
        stop = threading.Event()

        def holder():
            while not stop.is_set():
                if hold["t"] is not None:
                    node.act("temp", hold["t"])
                time.sleep(0.3)

        threading.Thread(target=holder, daemon=True).start()

        def used() -> float:
            return self.get(f"/api/batches/{batch['id']}")["batch"]["weighted_exposure_s"]

        def rate(temp: float, seconds: float = 20) -> float:
            hold["t"] = temp
            time.sleep(8)  # readings at the new temperature reach the server
            a, t0 = used(), time.monotonic()
            time.sleep(seconds)
            return (used() - a) / (time.monotonic() - t0)

        try:
            r1 = rate(9.0, 12)
            r2 = rate(13.0, 6)
            scale = 60
            check(0.6 * scale <= r1 <= 1.4 * scale, f"x1 rate {r1:.0f} budget-s per s (expected ~{scale})")
            check(1.4 * scale <= r2 <= 2.6 * scale and r2 > 1.5 * r1, f"x2 rate {r2:.0f} vs x1 {r1:.0f}")
            until(
                lambda: self.get(f"/api/batches/{batch['id']}")["batch"]["status"] in ("AT_RISK", "DISCARD"),
                60,
                "AT_RISK",
            )
            b = until(
                lambda: (x := self.get(f"/api/batches/{batch['id']}")["batch"])["status"] == "DISCARD" and x,
                90,
                "DISCARD",
            )
            check(b["remaining_pct"] == 0, f"DISCARD with {b['remaining_pct']} % left")
            until(lambda: self.fridge(f)["latch"], 30, "fridge latched")
        finally:
            hold["t"] = None
            stop.set()
            node.act("temp", 5.0)
        for role in ("INSPECTOR", "PHARMACIST"):
            status, _ = self.stack.call(
                "POST", f"/api/fridges/{f}/reset-latch", self.tokens[role], {"reason": "test"}
            )
            check(status == 403, f"{role} reset-latch -> {status}")
        status, body = self.stack.call(
            "POST",
            f"/api/fridges/{f}/reset-latch",
            self.tokens["ADMIN"],
            {"reason": "S4: discarded batch disposed"},
        )
        check(status in (200, 202), f"admin reset-latch -> {status} {body}")
        status, pub = self.stack.call("GET", f"/api/public/batch/{batch['public_token']}")
        check(status == 200 and pub["status"] == "DISCARD", f"public QR after reset: {status} {pub}")
        self.notes.append(f"S4: x1 {r1:.0f}/s, x2 {r2:.0f}/s at DEMO_TIME_SCALE {scale}")

    def s5_power(self) -> None:
        """Battery mode, compressor off, battery drains, alert, restore, min-off honoured."""
        node, f, start = self.nodes["fridge-02"], "fridge-02", time.time()
        node.act("power")
        until(lambda: (self.fridge(f)["live"] or {}).get("power") == "BATTERY", 20, "on battery")
        until(lambda: (self.fridge(f)["live"] or {}).get("comp") == 0, 20, "compressor off on battery")
        b0 = self.fridge(f)["live"]["batt"]
        until(
            lambda: any(
                a["type"] == "POWER_FAILURE" and a["fridge_id"] == f and a["status"] != "RESOLVED"
                for a in self.alerts()
            ),
            20,
            "POWER_FAILURE alert",
        )
        until(lambda: self.fridge(f)["live"]["batt"] < b0, 90, "battery draining")
        restored = time.time()
        node.act("power")
        until(lambda: self.fridge(f)["live"]["power"] == "MAINS", 20, "mains back")
        until(
            lambda: any(
                a["type"] == "POWER_FAILURE" and a["fridge_id"] == f and a["status"] == "RESOLVED"
                for a in self.alerts()
            ),
            20,
            "POWER_FAILURE resolved",
        )
        on = until(lambda: self.events(f, restored, "COMP_ON"), 180, "compressor restarted after restore")
        offs = [e for e in self.events(f, start - 120, "COMP_OFF") if e[0] <= on[0][0]]
        if offs:
            check(on[0][0] - offs[-1][0] >= 60, f"restart {on[0][0] - offs[-1][0]} s after OFF (< 60 s)")

    def s6_offline(self) -> None:
        """Wi-Fi outage: buffer grows; on reconnect every reading arrives, in order, no duplicates."""
        node, f = self.nodes["fridge-01"], "fridge-01"
        outage = 330 if self.full else 90
        with self.db() as db:
            seq0 = db.execute("SELECT MAX(seq) FROM readings WHERE fridge_id = ?", (f,)).fetchone()[0]
        start = time.time()
        node.act("wifi", True)
        until(lambda: self.fridge(f)["status"] == "OFFLINE", 40, "fridge shown OFFLINE")
        time.sleep(outage)
        buffered = node.uplink.buffer.__len__()
        check(buffered >= outage / 5 * 0.8, f"buffer only {buffered} after {outage} s")
        node.act("wifi", False)
        until(lambda: len(node.uplink.buffer) == 0, 180, "buffer drained by sync", every=2)
        time.sleep(3)
        with self.db() as db:
            seqs = [
                r[0]
                for r in db.execute(
                    "SELECT seq FROM readings WHERE fridge_id = ? AND seq > ? UNION ALL "
                    "SELECT seq FROM events WHERE fridge_id = ? AND seq > ? ORDER BY 1",
                    (f, seq0, f, seq0),
                )
            ]
            late = db.execute(
                "SELECT COUNT(*) FROM readings WHERE fridge_id = ? AND late = 1 AND ts >= ?", (f, int(start))
            ).fetchone()[0]
        check(len(seqs) == len(set(seqs)), "duplicate seq stored")
        holes = [b for a, b in zip(seqs, seqs[1:], strict=False) if b != a + 1]
        check(not holes, f"seq holes after sync: {holes[:5]}")
        check(late >= buffered * 0.8, f"only {late} late readings for {buffered} buffered")
        rows = self.readings(f, start)
        check(all(a[0] <= b[0] for a, b in zip(rows, rows[1:], strict=False)), "readings out of order by ts")
        self.notes.append(f"S6: {outage} s outage, {buffered} buffered, {late} stored late, seq contiguous")

    def s7_security(self) -> None:
        """Replay, bad signature, stale, unknown device, tampered body, flood: rejected, listed, audited."""
        start = time.time()
        secret = self.stack.secrets["fridge-01"]
        expected: set[str] = set()
        for name in ("replay", "badsig", "stale", "unknown-device", "tamper-body", "flood"):
            for *_rest, expect in attack.craft(name, "fridge-01", secret, int(time.time())):
                expected.add(expect)
            args = [
                name,
                "--fridge",
                "fridge-01",
                "--secret",
                secret,
                "--url",
                self.stack.mqtt_url,
                "--username",
                "",
                "--password",
                "",
                "--prefix",
                self.stack.prefix,
            ]
            if name == "replay":
                args.append("--own")
            check(attack.main(args) == 0, f"attack {name} failed to run")
        expected.discard("OK")

        def listed(reason: str) -> bool:  # per reason: the flood alone fills a page of BAD_SIG
            evs = self.get(f"/api/security/events?reason={reason}&pageSize=5")["events"]
            return any(e["ts"] >= start - 5 for e in evs)

        until(lambda: all(listed(r) for r in expected), 30, f"rejections listed {sorted(expected)}")
        until(lambda: any(a["type"] == "SECURITY_FLOOD" for a in self.alerts()), 30, "SECURITY_FLOOD alert")
        until(
            lambda: self.get("/api/audit?type=SECURITY_REJECT")["total"] > 0,
            90,
            "SECURITY_REJECT in the audit chain",
            every=5,
        )
        self.notes.append(f"S7: rejected {sorted(expected)}")

    def s8_tamper(self) -> None:
        """Edit an audit row in the database: Verify Integrity red at that record; restore: green."""
        ok = self.get("/api/audit/verify", "INSPECTOR")
        check(ok["valid"], f"chain not valid before tampering: {ok}")
        check(
            tamper.main(["--db", str(self.stack.db), "--audit-id", "3", "--field", "payload"]) == 0, "tamper"
        )
        try:
            bad = self.get("/api/audit/verify", "INSPECTOR")
            check(not bad["valid"] and bad["firstBrokenId"] == 3, f"verify after tamper: {bad}")
        finally:
            check(tamper.main(["--db", str(self.stack.db), "--restore"]) == 0, "tamper --restore")
        check(self.get("/api/audit/verify", "INSPECTOR")["valid"], "chain not valid after restore")

    def s9_rbac(self) -> None:
        """Every capability x every role against the live server (deny by default)."""
        bid = self.get("/api/batches?pageSize=1")["batches"][0]["id"]
        alert = self.alerts("active")[0]["id"] if self.alerts("active") else 1
        cases = [  # method, path, body, roles allowed
            ("GET", "/api/fridges", None, {"ADMIN", "PHARMACIST", "INSPECTOR"}),
            (
                "POST",
                "/api/batches",
                {
                    "name": "rbac",
                    "manufacturer": "x",
                    "lot_number": "RB",
                    "quantity": 1,
                    "expiry_date": "2030-01-01",
                    "criticality": 1,
                    "fridge_id": "fridge-01",
                },
                {"ADMIN", "PHARMACIST"},
            ),
            ("PATCH", f"/api/batches/{bid}", {"quantity": 40}, {"ADMIN", "PHARMACIST"}),
            ("DELETE", f"/api/batches/{bid}", None, {"ADMIN"}),
            ("POST", "/api/fridges/fridge-01/reset-latch", {"reason": "rbac test"}, {"ADMIN"}),
            ("POST", f"/api/alerts/{alert}/ack", None, {"ADMIN", "PHARMACIST"}),
            ("POST", "/api/fridges/fridge-01/buzzer-test", None, {"ADMIN", "PHARMACIST"}),
            ("GET", "/api/users", None, {"ADMIN"}),
            ("GET", "/api/audit", None, {"ADMIN", "PHARMACIST", "INSPECTOR"}),
            ("GET", "/api/audit/verify", None, {"ADMIN", "PHARMACIST", "INSPECTOR"}),
            ("GET", "/api/metrics/ingest", None, {"ADMIN", "INSPECTOR"}),
            (
                "POST",
                "/api/relocations/00000000-0000-4000-8000-000000000000/confirm",
                {"version": 1},
                {"ADMIN", "PHARMACIST"},
            ),
        ]
        wrong = []
        for method, path, body, allowed in cases:
            for role in ("ADMIN", "PHARMACIST", "INSPECTOR", None):
                status, _ = self.stack.call(method, path, self.tokens.get(role) if role else None, body)
                if role is None:
                    if status != 401:
                        wrong.append(f"anonymous {method} {path} -> {status}")
                elif (status not in (401, 403)) != (role in allowed):
                    wrong.append(f"{role} {method} {path} -> {status}")
        check(not wrong, "RBAC mismatches: " + "; ".join(wrong))

    def failures(self) -> None:
        """Kill the ML service, the broker and the backend mid-run; everything degrades and recovers."""
        f = "fridge-01"
        # ML down: the rule-based fallback answers, marked stale; back up: the model again
        self.stack.stop("ml")
        until(
            lambda: (self.get(f"/api/ml/predictions/{f}")["latest"] or {}).get("source") == "fallback",
            40,
            "fallback predictions while ML is down",
        )
        self.stack.start("ml")
        until(
            lambda: (self.get(f"/api/ml/predictions/{f}")["latest"] or {}).get("source") == "model",
            60,
            "model predictions after ML is back",
        )
        # broker down: nodes buffer; back up: they sync, nothing lost
        with self.db() as db:
            seq0 = db.execute("SELECT MAX(seq) FROM readings WHERE fridge_id = ?", (f,)).fetchone()[0]
        self.stack.stop("broker")
        time.sleep(40)
        check(len(self.nodes[f].uplink.buffer) > 0, "node did not buffer while the broker was down")
        self.stack.start("broker")
        until(
            lambda: len(self.nodes[f].uplink.buffer) == 0, 180, "buffer synced after broker restart", every=2
        )
        time.sleep(3)
        with self.db() as db:
            seqs = [
                r[0]
                for r in db.execute(
                    "SELECT seq FROM readings WHERE fridge_id = ? AND seq > ? UNION ALL "
                    "SELECT seq FROM events WHERE fridge_id = ? AND seq > ? ORDER BY 1",
                    (f, seq0, f, seq0),
                )
            ]
        missing = sum(b - a - 1 for a, b in zip(seqs, seqs[1:], strict=False) if b != a + 1)
        check(len(seqs) == len(set(seqs)), "duplicate seq after the broker restart")
        # QoS 0: a message already in the dying socket is gone (KNOWN_ISSUES.md); the buffer covers the rest
        check(
            missing <= 2, f"{missing} messages lost across the broker restart (more than the in-flight ones)"
        )
        self.notes.append(f"FI: broker restart: {len(seqs)} messages stored, {missing} lost in flight")
        # backend down: it comes back, reconnects and ingests again (QoS 0 messages sent meanwhile are gone)
        self.stack.stop("backend")
        down_at = time.time()
        time.sleep(20)
        self.stack.start("backend")
        self.tokens = {r: self.stack.login(r) for r in self.tokens}
        until(lambda: self.readings(f, time.time() - 10), 60, "ingesting again after backend restart")
        with self.db() as db:
            gap = db.execute(
                "SELECT MIN(ts) FROM readings WHERE fridge_id = ? AND seeded = 0 AND ts > ?",
                (f, int(down_at)),
            ).fetchone()[0]
        self.notes.append(
            f"FI: ML fallback + recovery; broker restart lossless; backend gap {gap - down_at:.0f} s "
            "(QoS 0 messages during the outage are not recoverable: KNOWN_ISSUES.md)"
        )

    def s10_ai(self) -> None:
        """weak_compressor: health < 70, Weakening; relocation proposed, Pharmacist confirms, batches moved,
        audited. --full: door left ajar warns >= 10 min before 8 °C."""
        self.up(weak={"fridge-02": 0.4}, speed=1.0, hours=3)
        f = "fridge-02"
        p = until(
            lambda: (
                (x := self.get(f"/api/ml/predictions/{f}")["latest"])
                and x.get("source") == "model"
                and x["health_score"] is not None
                and x
            ),
            90,
            "model prediction for fridge-02",
        )
        check(p["health_score"] < 70 and p["weakening"], f"weak compressor scored {p['health_score']}")
        until(
            lambda: any(a["type"] == "COMPRESSOR_WEAK" and a["fridge_id"] == f for a in self.alerts()),
            60,
            "COMPRESSOR_WEAK alert",
        )
        plan = until(
            lambda: next(
                (
                    x
                    for x in self.get("/api/relocations")["plans"]
                    if x["from_fridge"] == f and x["status"] == "PROPOSED"
                ),
                None,
            ),
            120,
            "relocation plan",
        )
        moved = [m["batch_id"] for m in plan["moves"]]
        check(
            moved and all(m["to_fridge"] == "fridge-01" for m in plan["moves"]), f"plan moves {plan['moves']}"
        )
        status, body = self.stack.call(
            "POST",
            f"/api/relocations/{plan['id']}/confirm",
            self.tokens["INSPECTOR"],
            {"version": plan["version"]},
        )
        check(status == 403, f"inspector confirm -> {status}")
        status, body = self.stack.call(
            "POST",
            f"/api/relocations/{plan['id']}/confirm",
            self.tokens["PHARMACIST"],
            {"version": plan["version"]},
        )
        if status == 409:  # refreshed between read and click: confirm the refreshed version, as the UI does
            plan = body["error"]["details"]["plan"]
            moved = [m["batch_id"] for m in plan["moves"]]
            status, body = self.stack.call(
                "POST",
                f"/api/relocations/{plan['id']}/confirm",
                self.tokens["PHARMACIST"],
                {"version": plan["version"]},
            )
        check(status == 200 and body["plan"]["status"] == "CONFIRMED", f"confirm -> {status} {body}")
        for bid in moved:
            check(
                self.get(f"/api/batches/{bid}")["batch"]["fridge_id"] == "fridge-01", f"batch {bid} not moved"
            )
        audit = self.get("/api/audit?type=BATCH_MOVED&pageSize=50")["entries"]
        check(
            sum(1 for e in audit if e["payload"].get("plan_id") == plan["id"]) == len(moved), "audit entries"
        )
        self.notes.append(f"S10: health {p['health_score']:.0f}, plan moved {len(moved)} batches")
        if not self.full:
            return
        node = self.nodes["fridge-01"]
        start = time.time()
        node.act("ajar", AJAR_K)
        try:
            warned = until(
                lambda: next(
                    (
                        x
                        for x in self.get("/api/ml/predictions/fridge-01?limit=500")["predictions"]
                        if x["created_at"] >= start * 1000 and x["breach_level"] != "LOW"
                    ),
                    None,
                ),
                1800,
                "warning after the door was left ajar",
                every=5,
            )
            crossed = until(
                lambda: next((r[0] for r in self.readings("fridge-01", start) if r[2] and r[2] > 8), None),
                2400,
                "temperature passing 8 °C",
                every=5,
            )
            lead = crossed - warned["created_at"] / 1000
            self.notes.append(f"S10: door ajar, warned {lead / 60:.1f} min before 8 °C")
            check(lead >= 600, f"warning only {lead / 60:.1f} min ahead")
        finally:
            node.act("ajar", None)


SCENARIOS = {
    "S1": Run.s1_normal,
    "S2": Run.s2_hysteresis,
    "S3": Run.s3_door,
    "S4": Run.s4_budget,
    "S5": Run.s5_power,
    "S6": Run.s6_offline,
    "S7": Run.s7_security,
    "S8": Run.s8_tamper,
    "S9": Run.s9_rbac,
    "FI": Run.failures,
    "S10": Run.s10_ai,
}


def main(argv: list[str] | None = None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--full", action="store_true", help="the spec's durations and the door-ajar lead time")
    ap.add_argument("--only", nargs="*", choices=list(SCENARIOS), help="run these (S2 needs S1's data)")
    args = ap.parse_args(argv)
    names = args.only or list(SCENARIOS)
    run = Run(args.full)
    results: list[tuple[str, str, float]] = []
    try:
        if any(n != "S10" for n in names):
            print("starting the stack ...", flush=True)
            run.up()
        for name in names:
            t0 = time.monotonic()
            print(f"{name}: {SCENARIOS[name].__doc__.splitlines()[0]}", flush=True)
            try:
                SCENARIOS[name](run)
                results.append((name, "PASS", time.monotonic() - t0))
            except Exception as err:  # noqa: BLE001 - one failing scenario must not hide the others
                detail = str(err) if isinstance(err, Fail) else traceback.format_exc(limit=3)
                results.append((name, f"FAIL {detail}", time.monotonic() - t0))
            print(f"  {results[-1][1]} ({results[-1][2]:.0f} s)", flush=True)
    finally:
        run.down()
    print("\n=== scenarios")
    for name, outcome, secs in results:
        print(
            f"{outcome.split(' ')[0]:<5} {name:<4} {secs:6.0f} s  {'' if outcome == 'PASS' else outcome[5:]}"
        )
    for note in run.notes:
        print("      " + note)
    print(f"logs: {run.tmp / 'logs'}")
    return 0 if all(o == "PASS" for _, o, _ in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
