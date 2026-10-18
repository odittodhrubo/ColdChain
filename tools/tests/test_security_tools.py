"""Attacks get the stated rejection; tamper edits and restores; verify_envelope names the failing check."""

import json
import sqlite3
import time

import pytest

from coldchain_tools import attack, envelope, tamper, verify_envelope
from coldchain_tools.contracts import vectors

SECRET = "c" * 64
DEV = "fridge-01"


def server_check(payload: str, seen: set) -> str:
    """The server's order: envelope checks, then nonce (stored only after the HMAC verified)."""
    reason, env = envelope.verify(payload, {DEV: SECRET})
    if reason == "OK":
        if env["nonce"] in seen:
            return "REPLAY"
        seen.add(env["nonce"])
    return reason


@pytest.mark.parametrize("name", attack.ATTACKS)
def test_every_attack_gets_the_expected_rejection(name):
    plan = attack.craft(name, DEV, SECRET, int(time.time()))
    seen: set = set()
    for _dev, kind, payload, expect in plan:
        assert kind == "telemetry"
        assert server_check(payload, seen) == expect, name


def test_replay_is_the_exact_same_bytes():
    first, second = attack.craft("replay", DEV, SECRET, int(time.time()))
    assert first[2] == second[2]


def test_flood_rate():
    assert (
        len(attack.craft("flood", DEV, SECRET, int(time.time()))) == attack.FLOOD_RATE * attack.FLOOD_SECONDS
    )


def test_refuses_production_and_bad_prefix(monkeypatch):
    monkeypatch.setenv("NODE_ENV", "production")
    with pytest.raises(SystemExit, match="production"):
        attack.main(["badsig", "--secret", SECRET, "--dry-run"])
    with pytest.raises(SystemExit, match="production"):
        tamper.main(["--restore"])
    monkeypatch.setenv("NODE_ENV", "development")
    for bad in ("", "coldchain/#", "a/+/b", "coldchain/"):
        with pytest.raises(SystemExit):
            attack.check_prefix(bad)


def test_dry_run_prints_without_a_broker(capsys, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "development")
    assert attack.main(["stale", "--secret", SECRET, "--dry-run", "--prefix", "coldchain/v1/t"]) == 0
    assert "expect STALE_TS" in capsys.readouterr().out


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "coldchain.db"
    with sqlite3.connect(path) as con:
        con.execute("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, payload TEXT, hash TEXT)")
        con.execute("CREATE TABLE readings (id INTEGER PRIMARY KEY, temp REAL)")
        con.execute("INSERT INTO audit_log VALUES (5, '{\"a\":1}', 'h5')")
        con.execute("INSERT INTO readings VALUES (12, 4.5)")
        con.executescript(  # the backend's append-only guard (migration 002_audit.sql)
            "CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log "
            "BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;"
            "CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log "
            "BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;"
        )
    return path


def test_tamper_and_restore(db, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "development")
    assert tamper.main(["--db", str(db), "--audit-id", "5", "--field", "payload"]) == 0
    assert tamper.main(["--db", str(db), "--reading-id", "12", "--field", "temp", "--value", "2.0"]) == 0
    with sqlite3.connect(db) as con:
        assert con.execute("SELECT payload FROM audit_log WHERE id=5").fetchone()[0].endswith("[tampered]")
        assert con.execute("SELECT temp FROM readings WHERE id=12").fetchone()[0] == 2.0
    assert tamper.main(["--db", str(db), "--restore"]) == 0
    with sqlite3.connect(db) as con:
        assert con.execute("SELECT payload FROM audit_log WHERE id=5").fetchone()[0] == '{"a":1}'
        assert con.execute("SELECT temp FROM readings WHERE id=12").fetchone()[0] == 4.5
    assert not tamper.backup_path(db).exists()
    with sqlite3.connect(db) as con:  # the guard is back after the edit and the restore
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            con.execute("UPDATE audit_log SET payload = 'x' WHERE id = 5")


def test_tamper_rejects_unknown_columns_and_rows(db, monkeypatch):
    monkeypatch.setenv("NODE_ENV", "development")
    with pytest.raises(SystemExit, match="no editable column"):
        tamper.main(["--db", str(db), "--audit-id", "5", "--field", "payload; DROP TABLE readings"])
    with pytest.raises(SystemExit, match="no editable column"):
        tamper.main(["--db", str(db), "--audit-id", "5", "--field", "id"])
    with pytest.raises(SystemExit, match="no row"):
        tamper.main(["--db", str(db), "--audit-id", "99", "--field", "payload"])


def test_envelope_round_trip_and_reasons():
    now = int(time.time())
    good = envelope.build(SECRET, DEV, "telemetry", '{"seq":1}', ts=now)
    assert envelope.verify(good, {DEV: SECRET}, now=now)[0] == "OK"
    assert envelope.verify("{nope", {DEV: SECRET})[0] == "BAD_JSON"
    assert envelope.verify(good, {}, now=now)[0] == "UNKNOWN_DEVICE"
    assert envelope.verify(good, {DEV: SECRET}, now=now + 31)[0] == "STALE_TS"
    assert envelope.verify(good, {DEV: "x"}, now=now)[0] == "BAD_SIG"
    bad_body = envelope.build(SECRET, DEV, "telemetry", "not json", ts=now)
    assert envelope.verify(bad_body, {DEV: SECRET}, now=now)[0] == "BAD_BODY"


def test_shared_hmac_vectors_sign_in_python():
    for v in vectors()["hmac"]:
        assert (
            envelope.sign(v["secret"], v["device_id"], v["kind"], v["ts"], v["nonce"], v["body"]) == v["sig"]
        )


def test_verify_envelope_cli(tmp_path, capsys):
    v = vectors()["hmac"][0]
    env = {k: v[k] for k in ("device_id", "kind", "ts", "nonce", "body", "sig")} | {"v": 1}
    path = tmp_path / "env.json"
    path.write_text(json.dumps(env))
    assert verify_envelope.main([str(path), "--secret", v["secret"], "--no-time"]) == 0
    assert "OK telemetry from fridge-01" in capsys.readouterr().out
    assert verify_envelope.main([str(path), "--secret", v["secret"], "--now", str(v["ts"] + 3600)]) == 1
    out = capsys.readouterr().out
    assert "FAIL" in out and "STALE_TS" in out
    env["body"] = env["body"].replace("4.62", "9.99")
    path.write_text(json.dumps(env))
    assert verify_envelope.main([str(path), "--secret", v["secret"], "--no-time"]) == 1
    assert "BAD_SIG" in capsys.readouterr().out


def test_secret_scan_catches_real_values_and_ignores_placeholders():
    from coldchain_tools.security_check import scan

    hits: list[str] = []
    scan(
        "JWT_SECRET=change-me-long-random\nAPP_SECRET_KEY=32-byte-hex-for-encrypting-device-secrets\n",
        "x",
        hits,
    )
    scan("DEVICE_SECRET_FRIDGE_01=" + "ab" * 32 + "\n", "y", hits)  # repeated pattern: a test fixture
    assert hits == []
    # deterministic high-entropy values (hex and mixed base64): the two shapes RANDOM accepts
    scan("DEVICE_SECRET_FRIDGE_01=" + "0a9f3c" * 11 + "\n", "leak", hits)
    scan("JWT_SECRET=" + "aB3xZ9" * 8 + "\n", "leak2", hits)
    # assembled at runtime so the full key never appears as a literal in this tracked file
    scan("-----BEGIN PRIVATE KEY-----\n" + "MIIBVgIBADANBg" * 4 + "\n", "key", hits)
    assert len(hits) == 3
    scan("-----BEGIN PRIVATE KEY-----\n", "bare header, not a leak", hits)  # no key body
    assert len(hits) == 3
