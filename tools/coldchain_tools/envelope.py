"""Signed envelope (contract section 4): build, sign, and verify with the server's reason codes."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time

from .contracts import C

FIELDS = ("v", "device_id", "kind", "ts", "nonce", "body", "sig")


def signing_string(device_id: str, kind: str, ts: int, nonce: str, body: str) -> str:
    return f"{device_id}|{kind}|{ts}|{nonce}|{body}"


def sign(secret: str, device_id: str, kind: str, ts: int, nonce: str, body: str) -> str:
    """Key = UTF-8 bytes of the secret string as stored (not hex-decoded)."""
    msg = signing_string(device_id, kind, ts, nonce, body).encode()
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


def new_nonce() -> str:
    return secrets.token_hex(8)


def build(
    secret: str, device_id: str, kind: str, body: str, ts: int | None = None, nonce: str | None = None
) -> str:
    """Envelope JSON text. body is the exact string that is signed and embedded."""
    ts = int(time.time()) if ts is None else ts
    nonce = nonce or new_nonce()
    env = {
        "v": C["ENVELOPE_VERSION"],
        "device_id": device_id,
        "kind": kind,
        "ts": ts,
        "nonce": nonce,
        "body": body,
        "sig": sign(secret, device_id, kind, ts, nonce, body),
    }
    return json.dumps(env, separators=(",", ":"))


def verify(
    text: str,
    secrets_by_device: dict[str, str],
    now: int | None = None,
    window_s: int | None = None,
    expected_kind: str | None = None,
) -> tuple[str, dict | None]:
    """Server-order checks: parse, known device, timestamp window, HMAC, body JSON.

    Returns (reason, envelope): "OK" or BAD_JSON / UNKNOWN_DEVICE / STALE_TS / BAD_SIG / BAD_BODY.
    Nonce replay needs server state and is not checked here.
    """
    try:
        env = json.loads(text)
    except (ValueError, TypeError):
        return "BAD_JSON", None
    if not isinstance(env, dict) or any(k not in env for k in FIELDS) or not isinstance(env["body"], str):
        return "BAD_JSON", env if isinstance(env, dict) else None
    secret = secrets_by_device.get(env["device_id"])
    if secret is None:
        return "UNKNOWN_DEVICE", env
    if expected_kind and env["kind"] != expected_kind:
        return "BAD_BODY", env
    now = int(time.time()) if now is None else now
    window = C["HMAC_WINDOW_S"] if window_s is None else window_s
    if not isinstance(env["ts"], int) or abs(now - env["ts"]) > window:
        return "STALE_TS", env
    expected = sign(secret, env["device_id"], env["kind"], env["ts"], str(env["nonce"]), env["body"])
    if not hmac.compare_digest(expected, str(env["sig"])):
        return "BAD_SIG", env
    try:
        json.loads(env["body"])
    except ValueError:
        return "BAD_BODY", env
    return "OK", env


# ---------------------------------------------------------------- ROTATE_SECRET (S7)
# The new secret sealed under the old one, exactly as tools/gen_vectors.js rotateSeal and the firmware's
# crypto::rotateOpen: pad = HMAC(old, "coldchain-rotate-pad|" + nonce), ct = hex(bytes(new) XOR pad),
# tag = HMAC(old, "coldchain-rotate-tag|" + nonce + "|" + ct). Key = UTF-8 bytes of the old secret string.


def _mac(key: str, msg: str) -> bytes:
    return hmac.new(key.encode(), msg.encode(), hashlib.sha256).digest()


def rotate_seal(old_secret: str, new_secret: str, nonce: str) -> tuple[str, str]:
    pad = _mac(old_secret, f"coldchain-rotate-pad|{nonce}")
    ct = bytes(a ^ b for a, b in zip(bytes.fromhex(new_secret), pad, strict=True)).hex()
    return ct, _mac(old_secret, f"coldchain-rotate-tag|{nonce}|{ct}").hex()


def rotate_open(old_secret: str, nonce: str, ct: str, tag: str) -> str | None:
    """The new 64-hex secret, or None for a wrong tag or malformed input (the tag is checked first)."""
    if not (isinstance(nonce, str) and isinstance(ct, str) and isinstance(tag, str)):
        return None
    if len(nonce) != 32 or len(ct) != 64 or len(tag) != 64:
        return None
    try:
        cipher = bytes.fromhex(ct)
    except ValueError:
        return None
    if not hmac.compare_digest(_mac(old_secret, f"coldchain-rotate-tag|{nonce}|{ct}").hex(), tag):
        return None
    pad = _mac(old_secret, f"coldchain-rotate-pad|{nonce}")
    return bytes(a ^ b for a, b in zip(cipher, pad, strict=True)).hex()
