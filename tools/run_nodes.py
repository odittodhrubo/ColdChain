"""Run virtual nodes in background threads without blocking on stdout."""

from __future__ import annotations

import sys
import time

from coldchain_tools.contracts import device_secret, setting
from coldchain_tools.virtual_node import NodeRunner, SeqFile


def main():
    url = setting("MQTT_URL", "mqtt://localhost:1883")
    prefix = setting("MQTT_TOPIC_PREFIX", "coldchain/v1")
    runners = []
    fridges = ["fridge-01", "fridge-02"]
    for f in fridges:
        secret = device_secret(f)
        runner = NodeRunner(
            device_id=f,
            secret=secret,
            url=url,
            username=setting("MQTT_USERNAME") or "",
            password=setting("MQTT_PASSWORD") or "",
            prefix=prefix,
            thermal_speed=1.0,
            seq_file=SeqFile(f),
            boot_lock=False,
        )
        runner.start()
        runners.append(runner)
        print(f"Started virtual node {f} -> {url} prefix {prefix}")

    sys.stdout.flush()
    try:
        while True:
            time.sleep(30)
            for r in runners:
                print(r.status())
            sys.stdout.flush()
    except KeyboardInterrupt:
        print("Stopping virtual nodes...")
        for r in runners:
            r.stop()


if __name__ == "__main__":
    main()
