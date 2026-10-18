"""API latency under load (P20): 2 devices every 5 s + an invalid-message flood, 24 h of history, and 8
concurrent clients reading what the dashboard reads. Target: p95 < 200 ms on every endpoint.

    python -m coldchain_tools.perf [--seconds 30] [--clients 8]
"""

from __future__ import annotations

import argparse
import statistics
import tempfile
import threading
import time
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


def p(values: list[float], q: float) -> float:
    return statistics.quantiles(values, n=100)[q - 1] if len(values) >= 2 else (values[0] if values else 0)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--clients", type=int, default=8)
    args = ap.parse_args(argv)
    tmp = Path(tempfile.mkdtemp(prefix="coldchain-perf-"))
    stack = Stack(
        db=tmp / "perf.db",
        api_port=4430,
        ml_port=8430,
        mqtt_url="mqtt://127.0.0.1:18833",
        prefix="coldchain/v1/perf",
        ml_interval_ms=30_000,
        logs=tmp,
    )
    nodes = []
    try:
        stack.up(hours=24)
        nodes = [stack.node(f) for f in ("fridge-01", "fridge-02")]
        token = stack.login("INSPECTOR")
        time.sleep(10)
        stop = threading.Event()

        def flood():  # 250 invalid signed messages over 5 s, repeated while the load runs
            secret = stack.secrets["fridge-01"]
            while not stop.is_set():
                attack.main(
                    [
                        "flood",
                        "--fridge",
                        "fridge-01",
                        "--secret",
                        secret,
                        "--url",
                        stack.mqtt_url,
                        "--username",
                        "",
                        "--password",
                        "",
                        "--prefix",
                        stack.prefix,
                    ]
                )

        threading.Thread(target=flood, daemon=True).start()
        lat: dict[str, list[float]] = {e: [] for e in ENDPOINTS}
        errors: list[str] = []

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

        workers = [threading.Thread(target=client, args=(i,), daemon=True) for i in range(args.clients)]
        for w in workers:
            w.start()
        time.sleep(args.seconds)
        stop.set()
        for w in workers:
            w.join(timeout=5)
    finally:
        for n in nodes:
            n.stop()
        stack.down()

    print(f"{args.clients} clients x {args.seconds:.0f} s, 2 live nodes + signature flood, 24 h of history\n")
    print(f"{'endpoint':<58} {'n':>5} {'p50 ms':>7} {'p95 ms':>7} {'max':>7}")
    worst = 0.0
    for ep, xs in lat.items():
        p95 = p(xs, 95)
        worst = max(worst, p95)
        print(f"{ep.split('?')[0]:<58} {len(xs):>5} {p(xs, 50):>7.1f} {p95:>7.1f} {max(xs, default=0):>7.1f}")
    total = sum(len(x) for x in lat.values())
    print(
        f"\n{total} requests ({total / args.seconds:.0f}/s), {len(errors)} errors; worst p95 {worst:.1f} ms"
    )
    ok = worst < 200 and not errors
    print("PASS: p95 < 200 ms on every endpoint" if ok else "FAIL: p95 target missed or errors")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
