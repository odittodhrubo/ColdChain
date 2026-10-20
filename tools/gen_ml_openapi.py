#!/usr/bin/env python3
"""Freeze the ML service's OpenAPI schema so the backend can check it agrees (Q4).

The backend builds /predict requests by hand (backend/src/ml/client.ts, types.ts); the ML service
validates them with Pydantic (ml/app/main.py, PredictIn, extra="forbid"). This writes that schema to
contracts/ml_openapi.json; a backend test validates a real request fixture against it, so a renamed or
dropped field breaks CI instead of the running system.

    python tools/gen_ml_openapi.py          # write contracts/ml_openapi.json
    python tools/gen_ml_openapi.py --check  # exit 1 if it is stale
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "contracts" / "ml_openapi.json"


def schema() -> str:
    sys.path.insert(0, str(ROOT / "ml"))  # main.py does `from constants import ...` relative to ml/
    from app.main import app

    return json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"


def main() -> int:
    content = schema()
    rel = TARGET.relative_to(ROOT).as_posix()
    if "--check" in sys.argv[1:]:
        current = TARGET.read_text(encoding="utf-8").replace("\r\n", "\n") if TARGET.exists() else None
        if current != content:
            print(f"STALE generated file (run `python tools/gen_ml_openapi.py`):\n  {rel}")
            return 1
        print(f"{rel} is up to date")
        return 0
    TARGET.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
