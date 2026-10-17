"""Integrity demo: edit a row directly in the SQLite database so that Verify Integrity (P08) catches it.

    python -m coldchain_tools.tamper --audit-id 5 --field payload [--value '{"x":1}']
    python -m coldchain_tools.tamper --reading-id 120 --field temp [--value 4.0]
    python -m coldchain_tools.tamper --restore        # undo every edit, newest first

The original values are kept in <db>.tamper.json next to the database. Without --value, text gets a visible
marker appended and numbers are changed by +1. Refuses to run when NODE_ENV=production.

audit_log is append-only at the database level (BEFORE UPDATE/DELETE triggers). Like an attacker with direct
file access, the tool drops those triggers for its edit and recreates them. That is defence in depth: the
triggers stop accidents and ordinary SQL, and the hash chain still catches someone who bypasses them.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from .contracts import ROOT, refuse_in_production, setting

TABLES = {"audit": "audit_log", "reading": "readings"}


def default_db() -> Path:
    path = Path(setting("DB_PATH", "./data/coldchain.db"))
    return path if path.is_absolute() else ROOT / "backend" / path


def backup_path(db: Path) -> Path:
    return db.with_name(db.name + ".tamper.json")


def columns(con: sqlite3.Connection, table: str) -> list[str]:
    return [
        row[1] for row in con.execute(f"PRAGMA table_info({table})")
    ]  # table is from TABLES, never user input


def write_cell(con: sqlite3.Connection, table: str, field: str, value, row_id: int) -> None:
    """UPDATE one cell, temporarily removing the table's triggers (the audit log's append-only guard)."""
    triggers = con.execute(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?", (table,)
    ).fetchall()
    for name, _ in triggers:
        con.execute(f'DROP TRIGGER "{name}"')
    con.execute(f'UPDATE {table} SET "{field}" = ? WHERE id = ?', (value, row_id))
    for _, sql in triggers:
        con.execute(sql)


def tampered(old):
    if isinstance(old, (int, float)) and not isinstance(old, bool):
        return old + 1
    return f"{old} [tampered]"


def tamper(db: Path, table: str, row_id: int, field: str, value=None) -> tuple[object, object]:
    """Change one cell; returns (old, new). The field name is checked against the table's real columns."""
    with sqlite3.connect(db) as con:
        cols = columns(con, table)
        if not cols:
            raise SystemExit(f"table {table} not found in {db}")
        if field not in cols or field == "id":
            raise SystemExit(f"{table} has no editable column {field!r}; columns: {', '.join(cols)}")
        row = con.execute(f'SELECT "{field}" FROM {table} WHERE id = ?', (row_id,)).fetchone()
        if row is None:
            raise SystemExit(f"{table} has no row with id {row_id}")
        old = row[0]
        new = tampered(old) if value is None else value
        write_cell(con, table, field, new, row_id)
    log = json.loads(backup_path(db).read_text()) if backup_path(db).exists() else []
    log.append({"table": table, "id": row_id, "field": field, "old": old})
    backup_path(db).write_text(json.dumps(log, indent=2))
    return old, new


def restore(db: Path) -> int:
    path = backup_path(db)
    if not path.exists():
        print("nothing to restore")
        return 0
    log = json.loads(path.read_text())
    with sqlite3.connect(db) as con:
        for entry in reversed(log):
            if entry["field"] not in columns(con, entry["table"]) or entry["table"] not in TABLES.values():
                raise SystemExit(f"backup entry does not match the schema: {entry}")
            write_cell(con, entry["table"], entry["field"], entry["old"], entry["id"])
    path.unlink()
    return len(log)


def parse_value(text: str | None):
    if text is None:
        return None
    try:
        return json.loads(text) if text.strip()[:1] in "-0123456789" else text
    except ValueError:
        return text


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--audit-id", type=int)
    target.add_argument("--reading-id", type=int)
    target.add_argument("--restore", action="store_true")
    ap.add_argument("--field", help="column to change, e.g. payload (audit_log) or temp (readings)")
    ap.add_argument("--value", help="new value (default: visibly altered old value)")
    ap.add_argument("--db", type=Path, default=None, help="SQLite file (default: backend DB_PATH)")
    args = ap.parse_args(argv)

    refuse_in_production()
    db = args.db or default_db()
    if not db.exists():
        raise SystemExit(f"database not found: {db}")
    if args.restore:
        print(f"restored {restore(db)} edit(s) in {db}")
        return 0
    if not args.field:
        ap.error("--field is required with --audit-id / --reading-id")
    table = TABLES["audit"] if args.audit_id is not None else TABLES["reading"]
    row_id = args.audit_id if args.audit_id is not None else args.reading_id
    old, new = tamper(db, table, row_id, args.field, parse_value(args.value))
    print(f"{table} id {row_id}: {args.field} {old!r} -> {new!r}")
    print("Run Verify Integrity now; undo with: python -m coldchain_tools.tamper --restore")
    return 0


if __name__ == "__main__":
    sys.exit(main())
