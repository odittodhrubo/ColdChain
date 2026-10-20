"""API latency under load (P20): 2 devices every 5 s + an invalid-message flood, 24 h of history, and 8
concurrent clients reading what the dashboard reads. Target: p95 < 200 ms on every endpoint.

    python -m coldchain_tools.perf [--seconds 30] [--clients 8]
    python -m coldchain_tools.perf --soak 24h   # Q3: sample RSS, DB size and p95 every 5 min to a CSV

The soak run keeps the same load on for hours and fails if the backend RSS grows by more than 20 % after
the first hour (a leak: nonce table, timers) or any p95 drifts over 200 ms. Run it once before a real
deployment. RSS comes from the backend's own Prometheus gauge (METRICS_PORT), so it is the Node process
itself, not the tsx/npx wrapper.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import statistics
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from pathlib import Path

from . import attack
from .stack import Stack

ENDPOINTS = [
    "/api/fridges",
    "/api/fridges/fridge-01",
    "/api/fridges/fridge-01/readings?from={from24}&to={now}",  # 24 h: 17 280 readings -> 600 buckets
    "/api/batches?pageSize=200",
    "/api/alerts?status=active&pageSize=8",
    "/api/ml/predictions/fridge-01",
    "/api/relocations",
    "/api/security/summary",
]
METRICS_PORT = 9430
RSS_GROWTH_LIMIT = 1.20  # fail if RSS after the first hour exceeds the 1 h baseline by more than 20 %
P95_LIMIT_MS = 200
SAMPLE_EVERY_S = 300


def p(values: list[float], q: float) -> float:
    return statistics.quantiles(values, n=100)[q - 1] if len(values) >= 2 else (values[0] if values else 0)


def worst_p95(lat: dict[str, list[float]]) -> float:
    return max((p(xs, 95) for xs in lat.values()), default=0.0)


def parse_duration(text: str) -> float:
    """Parse "24h" / "30m" / "90s" / "3600" into seconds."""
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([hms]?)\s*", text)
    if not m:
        raise SystemExit(f"--soak expects a duration like 24h, 30m or 90s, got {text!r}")
    return float(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600}[m.group(2)]


def rss_bytes() -> float | None:
    """The backend's resident set size from its Prometheus gauge, or None if it is not scrapable yet."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{METRICS_PORT}/metrics", timeout=5) as res:
            for line in res.read().decode().splitlines():
                if line.startswith("coldchain_process_process_resident_memory_bytes "):
                    return float(line.split()[1])
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return None


@contextmanager
def _load(args: argparse.Namespace):
    """Bring the whole stack up with 24 h of history, 2 live nodes, a signature flood and `--clients`
    readers hammering the dashboard endpoints. Yields (db, lat, errors, stop); lat and errors fill as the
    load runs, stop ends it early."""
    tmp = Path(tempfile.mkdtemp(prefix="coldchain-perf-"))
    db = tmp / "perf.db"
    os.environ["METRICS_PORT"] = str(METRICS_PORT)  # the stack inherits os.environ; exposes RSS to sampler
    stack = Stack(
        db=db, api_port=4430, ml_port=8430, mqtt_url="mqtt://127.0.0.1:18833",
        prefix="coldchain/v1/perf", ml_interval_ms=30_000, logs=tmp,
    )  # fmt: skip
    nodes: list = []
    stop = threading.Event()
    lat: dict[str, list[float]] = {e: [] for e in ENDPOINTS}
    errors: list[str] = []
    try:
        stack.up(hours=24)
        nodes = [stack.node(f) for f in ("fridge-01", "fridge-02")]
        token = stack.login("INSPECTOR")
        time.sleep(10)

        def flood():  # 250 invalid signed messages over 5 s, repeated while the load runs
            secret = stack.secrets["fridge-01"]
            user, password = stack.mqtt_auth("coldchain")
            while not stop.is_set():
                attack.main(["flood", "--fridge", "fridge-01", "--secret", secret, "--url", stack.mqtt_url,
                             "--username", user, "--password", password,
                             "--prefix", stack.prefix])  # fmt: skip

        def client(i: int):
            k = i
            while not stop.is_set():
                ep = ENDPOINTS[k % len(ENDPOINTS)]
                now = int(time.time())
                t0 = time.perf_counter()
                status, _ = stack.call("GET", ep.format(now=now, from24=now - 86_400), token)
                lat[ep].append((time.perf_counter() - t0) * 1000)
                if status != 200:
                    errors.append(f"{ep} {status}")
                k += 1

        threading.Thread(target=flood, daemon=True).start()
        workers = [threading.Thread(target=client, args=(i,), daemon=True) for i in range(args.clients)]
        for w in workers:
            w.start()
        yield db, lat, errors, stop
    finally:
        stop.set()
        time.sleep(1)
        for n in nodes:
            n.stop()
        stack.down()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--clients", type=int, default=8)
    ap.add_argument("--soak", metavar="DURATION", help="run for this long (e.g. 24h), sampling every 5 min")
    args = ap.parse_args(argv)
    if args.soak:
        return soak(args, parse_duration(args.soak))

    with _load(args) as (_db, lat, errors, stop):
        time.sleep(args.seconds)
        stop.set()
    print(f"{args.clients} clients x {args.seconds:.0f} s, 2 live nodes + signature flood, 24 h of history\n")
    print(f"{'endpoint':<58} {'n':>5} {'p50 ms':>7} {'p95 ms':>7} {'max':>7}")
    worst = 0.0
    for ep, xs in lat.items():
        p95 = p(xs, 95)
        worst = max(worst, p95)
        print(f"{ep.split('?')[0]:<58} {len(xs):>5} {p(xs, 50):>7.1f} {p95:>7.1f} {max(xs, default=0):>7.1f}")
    total = sum(len(x) for x in lat.values())
    print(f"\n{total} requests ({total / args.seconds:.0f}/s), {len(errors)} errors; "
          f"worst p95 {worst:.1f} ms")  # fmt: skip
    ok = worst < P95_LIMIT_MS and not errors
    print("PASS: p95 < 200 ms on every endpoint" if ok else "FAIL: p95 target missed or errors")
    return 0 if ok else 1


def soak(args: argparse.Namespace, duration_s: float) -> int:
    out = Path(tempfile.gettempdir()) / f"coldchain-soak-{int(time.time())}.csv"
    print(f"Soak: {duration_s / 3600:.2f} h, {args.clients} clients, sample every {SAMPLE_EVERY_S // 60} min")
    print(f"CSV: {out}\n")
    rows: list[dict] = []
    with _load(args) as (db, lat, errors, stop), out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["elapsed_h", "rss_mb", "db_mb", "worst_p95_ms", "errors"])
        w.writeheader()
        print(f"{'elapsed_h':>9} {'rss_mb':>8} {'db_mb':>8} {'worst_p95_ms':>13} {'errors':>7}")
        start = time.monotonic()
        while (elapsed := time.monotonic() - start) < duration_s:
            time.sleep(min(SAMPLE_EVERY_S, duration_s - elapsed))  # fixed grid, never overrun the duration
            window = {ep: xs[:] for ep, xs in lat.items()}  # p95 of the window just ended, then reset it
            for xs in lat.values():
                xs.clear()
            rss = rss_bytes()
            row = {
                "elapsed_h": round((time.monotonic() - start) / 3600, 3),
                "rss_mb": round(rss / 1e6, 1) if rss else "",
                "db_mb": round(db.stat().st_size / 1e6, 1) if db.exists() else "",
                "worst_p95_ms": round(worst_p95(window), 1),
                "errors": len(errors),
            }
            rows.append(row)
            w.writerow(row)
            fh.flush()
            print(f"{row['elapsed_h']:>9} {str(row['rss_mb']):>8} {str(row['db_mb']):>8} "
                  f"{row['worst_p95_ms']:>13} {row['errors']:>7}")  # fmt: skip
        stop.set()
    return _verdict(rows, out)


def _verdict(rows: list[dict], out: Path) -> int:
    """Fail if RSS grew more than 20 % over its first-hour baseline, or any p95 crossed 200 ms."""
    worst_p95_ms = max((r["worst_p95_ms"] for r in rows), default=0.0)
    rss = [(r["elapsed_h"], r["rss_mb"]) for r in rows if isinstance(r["rss_mb"], (int, float))]
    baseline = next((v for h, v in rss if h >= 1.0), rss[0][1] if rss else None)  # first sample at/after 1 h
    after = [v for h, v in rss if h >= 1.0]
    peak = max(after, default=baseline or 0.0)
    grew = bool(baseline) and peak > baseline * RSS_GROWTH_LIMIT

    print(f"\nSamples: {len(rows)}; CSV: {out}")
    if baseline:
        print(f"RSS 1 h baseline {baseline:.1f} MB -> peak after 1 h {peak:.1f} MB "
              f"({peak / baseline - 1:+.0%}, limit +{RSS_GROWTH_LIMIT - 1:.0%})")  # fmt: skip
    elif rss:
        print("RSS sampled but the run was under 1 h: no leak baseline (run a full soak before deployment)")
    else:
        print("RSS never scraped: is METRICS_PORT reachable? (leak check skipped)")
    print(f"Worst p95 over the run: {worst_p95_ms:.1f} ms (limit {P95_LIMIT_MS} ms)")
    ok = not grew and worst_p95_ms < P95_LIMIT_MS
    print("PASS: no leak, p95 within budget" if ok else "FAIL: RSS growth or p95 over budget")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
