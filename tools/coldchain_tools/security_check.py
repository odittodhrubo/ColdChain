"""Security review checklist, automated where it can be (P20). Prints one PASS / FAIL / WARN line per check.

    python -m coldchain_tools.security_check            # static checks + live probes on an isolated stack
    python -m coldchain_tools.security_check --static   # dependency audit, secrets, ignore rules only

Static: npm audit (backend, frontend, production dependencies), pip-audit when installed, a secrets scan of
the working tree AND the whole git history, and the ignore rules for .env / config.h / databases.
Live (own stack on spare ports): security headers, CORS, login and public-endpoint rate limits, SQL injection
on every list endpoint's query parameters, stored XSS payloads, JWT forgery (role edit, alg none, wrong key,
expired), the public batch endpoint's field whitelist, and the per-device broker ACL.

Each run rewrites the results block in docs/SECURITY.md (skip with --no-doc).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

from .contracts import ROOT, setting
from .stack import EMAILS, IS_WIN, Stack, python

RESULTS: list[tuple[str, str, str]] = []

# What a leaked credential looks like. Test fixtures use obviously fake values (repeated characters).
SECRET_PATTERNS = {
    # the header plus real key material: a bare header line (docs, this file's own tests) is not a leak
    "private key": re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/]{40,}"),
    "GitHub token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b"),
    "AWS key": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "env secret assignment": re.compile(
        r"^(JWT_SECRET|APP_SECRET_KEY|DEVICE_SECRET_\w+|MQTT_PASSWORD|SMTP_PASS|TELEGRAM_BOT_TOKEN)=(\S{12,})$",
        re.M,
    ),
    "C secret literal": re.compile(r'DEVICE_SECRET\w*\s*=?\s*"[0-9a-fA-F]{64}"'),
}
FAKE = re.compile(r"^(.)\1+$|change-me|example|placeholder|your-|<", re.I)
RANDOM = re.compile(r"[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_=]{24,}")  # what a generated secret looks like


def looks_real(value: str) -> bool:
    """High-entropy and not a documented placeholder (those are words joined by hyphens)."""
    mixed = any(c.isdigit() for c in value) and any(c.isalpha() for c in value)
    return bool(RANDOM.fullmatch(value)) and mixed and not FAKE.search(value)


def record(status: str, name: str, detail: str = "") -> None:
    RESULTS.append((status, name, detail))
    print(f"{status:<5} {name}{f': {detail}' if detail else ''}", flush=True)


def run(cmd: list[str], cwd: Path) -> subprocess.CompletedProcess:
    exe = shutil.which(cmd[0] + (".cmd" if IS_WIN and cmd[0] in ("npm", "npx") else "")) or cmd[0]
    return subprocess.run([exe, *cmd[1:]], cwd=cwd, capture_output=True, text=True, encoding="utf-8")


# ------------------------------------------------------------------------------------------- static checks


def npm_audit() -> None:
    for app in ("backend", "frontend"):
        out = run(["npm", "audit", "--omit=dev", "--json"], ROOT / app)
        try:
            vulns = json.loads(out.stdout)["metadata"]["vulnerabilities"]
        except (ValueError, KeyError):
            record("WARN", f"npm audit {app}", "could not run (offline?)")
            continue
        serious = vulns.get("high", 0) + vulns.get("critical", 0)
        detail = ", ".join(f"{k} {v}" for k, v in vulns.items() if v and k != "total") or "none"
        record("PASS" if serious == 0 else "FAIL", f"npm audit {app} (production deps)", detail)


def pip_audit() -> None:
    out = run(
        [python(), "-m", "pip_audit", "-r", str(ROOT / "ml" / "requirements.txt"), "--format", "json"], ROOT
    )
    if out.returncode not in (0, 1) or not out.stdout.strip().startswith("{"):
        record("WARN", "pip-audit ml", "could not run (pip install -r ml/requirements-dev.txt; offline?)")
        return
    deps = json.loads(out.stdout).get("dependencies", [])
    found = [f"{d['name']} {v['id']}" for d in deps for v in d.get("vulns", [])]
    record("PASS" if not found else "FAIL", "pip-audit ml", ", ".join(found) or "no known vulnerabilities")


def scan(text: str, where: str, hits: list[str]) -> None:
    for name, pat in SECRET_PATTERNS.items():
        for m in pat.finditer(text):
            value = m.group(m.lastindex or 0)
            if m.lastindex is None or looks_real(value):
                hits.append(f"{name} in {where}")


def secrets_scan() -> None:
    files = run(["git", "ls-files"], ROOT).stdout.split()
    hits: list[str] = []
    for f in files:
        p = ROOT / f
        if p.suffix in (".png", ".joblib", ".gz", ".ico", ".woff2") or not p.is_file():
            continue
        try:
            scan(p.read_text(encoding="utf-8"), f, hits)
        except UnicodeDecodeError:
            continue
    record("PASS" if not hits else "FAIL", "secrets in tracked files", "; ".join(hits[:5]) or "none")
    history = run(["git", "log", "--all", "-p", "--no-color", "--", ".", ":(exclude)*.joblib"], ROOT).stdout
    hits = []
    scan("\n".join(line[1:] for line in history.splitlines() if line.startswith("+")), "git history", hits)
    record(
        "PASS" if not hits else "FAIL", "secrets in git history", "; ".join(sorted(set(hits))[:5]) or "none"
    )


def ignore_rules() -> None:
    must = [
        ".env",
        "firmware/fridge-node/include/config.h",
        "backend/data/coldchain.db",
        "ml/data/raw/x.csv.gz",
        "infra/mosquitto/passwd.prod",
        "infra/mosquitto/certs/server.key",
    ]
    out = run(["git", "check-ignore", *must], ROOT).stdout.split()
    missing = [m for m in must if m not in out]
    record("PASS" if not missing else "FAIL", "secrets and data are git-ignored", ", ".join(missing) or "all")


# ------------------------------------------------------------------------------------------- live checks


def b64(d: dict | bytes) -> str:
    raw = d if isinstance(d, bytes) else json.dumps(d, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def live(stack: Stack) -> None:
    api = stack.api
    admin = stack.login("ADMIN")

    # headers
    import urllib.request

    with urllib.request.urlopen(f"{api}/api/health") as res:
        h = {k.lower(): v for k, v in res.headers.items()}
    want = {
        "x-content-type-options": "nosniff",
        "content-security-policy": None,
        "x-frame-options": None,
        "strict-transport-security": None,
        "referrer-policy": None,
    }
    missing = [k for k, v in want.items() if k not in h or (v and h[k] != v)]
    record(
        "PASS" if not missing and "x-powered-by" not in h else "FAIL",
        "security headers",
        f"missing {missing}" if missing else "helmet set, no X-Powered-By",
    )

    # A fixed allowlist still emits the configured origin on every request; a browser blocks a mismatch.
    # What must never happen: the foreign origin reflected back, or a wildcard.
    req = urllib.request.Request(f"{api}/api/health", headers={"Origin": "https://evil.example"})
    with urllib.request.urlopen(req) as res:
        acao = res.headers.get("Access-Control-Allow-Origin")
    record(
        "PASS" if acao not in ("https://evil.example", "*") else "FAIL",
        "CORS refuses other origins",
        f"ACAO={acao!r} (not the request origin)",
    )

    # JWT forgery: every variant must be refused as unauthenticated (401), never treated as a role
    def sign(h: str, p: str, key: bytes) -> str:
        return f"{h}.{p}.{b64(hmac.new(key, f'{h}.{p}'.encode(), hashlib.sha256).digest())}"

    head, payload, sig = stack.login("PHARMACIST").split(".")
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    secret = setting("JWT_SECRET", "").encode()
    forged = {
        "role edited to ADMIN, old signature": f"{head}.{b64({**claims, 'role': 'ADMIN'})}.{sig}",
        "alg none": f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({**claims, 'role': 'ADMIN'})}.",
        "signed with a wrong key": sign(
            head, b64({**claims, "role": "ADMIN"}), b"not-the-server-key-0123456789abcdef"
        ),
        "expired (valid signature)": sign(
            head, b64({**claims, "iat": 1, "exp": int(time.time()) - 60}), secret
        ),
    }
    bad = [n for n, t in forged.items() if stack.call("GET", "/api/users", t)[0] != 401]
    record("PASS" if not bad else "FAIL", "JWT tampering refused (401)", ", ".join(bad) or ", ".join(forged))

    # SQL injection on every list endpoint's free-text parameters; the database must survive intact
    probes = [
        "' OR '1'='1",
        "1; DROP TABLE batches; --",
        "x' UNION SELECT password_hash FROM users --",
        "%' --",
    ]
    before = stack.call("GET", "/api/batches?pageSize=200", admin)[1]["total"]
    targets = [
        ("/api/batches", "q"),
        ("/api/batches", "fridge_id"),
        ("/api/audit", "actor"),
        ("/api/alerts", "fridge_id"),
        ("/api/security/events", "device_id"),
    ]
    errors = []
    import urllib.parse

    for path, param in targets:
        for p in probes:
            status, body = stack.call("GET", f"{path}?{param}={urllib.parse.quote(p)}", admin)
            if status >= 500 or (
                path == "/api/batches" and status == 200 and body["total"] > 0 and param == "q"
            ):
                errors.append(f"{path}?{param} {status}")
    after = stack.call("GET", "/api/batches?pageSize=200", admin)[1]["total"]
    record(
        "PASS" if not errors and after == before else "FAIL",
        "SQL injection probes (parameterised queries)",
        "; ".join(errors) or f"{len(targets) * len(probes)} probes, no 5xx, no extra rows, data intact",
    )

    # stored XSS: the API keeps the text verbatim (JSON); React renders it as text (frontend test)
    xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
    status, body = stack.call(
        "POST",
        "/api/batches",
        admin,
        {
            "name": xss,
            "manufacturer": xss,
            "lot_number": "XSS-1",
            "quantity": 1,
            "expiry_date": "2030-01-01",
            "criticality": 1,
            "fridge_id": "fridge-01",
        },
    )
    ok = status == 201 and body["batch"]["name"] == xss
    with urllib.request.urlopen(f"{api}/api/public/batch/{body['batch']['public_token']}") as res:
        ctype = res.headers.get("Content-Type", "")
        pub = json.loads(res.read())
    record(
        "PASS" if ok and ctype.startswith("application/json") else "FAIL",
        "stored XSS payload",
        "stored verbatim, served as JSON; the UI escapes it (src/pages/pages.test.tsx)",
    )

    # public endpoint: whitelist only, same 404 for an unknown (well-formed) and a malformed token, so the
    # response is no oracle for which tokens exist. Both reach the route; urllib.quote keeps them one segment.
    keys = set(pub)
    allowed = {"name", "lot_number", "expiry_date", "status", "expired", "last_checked"}
    bad = urllib.parse.quote("not a token!", safe="")
    s1, b1 = stack.call("GET", f"/api/public/batch/{'A' * 12}")  # well-formed (12 chars), does not exist
    s2, b2 = stack.call("GET", f"/api/public/batch/{bad}")  # malformed: reaches the route, must also 404
    record(
        "PASS" if keys <= allowed and s1 == 404 and s2 == 404 and b1 == b2 else "FAIL",
        "public batch endpoint leaks nothing",
        f"fields {sorted(keys)}; unknown and malformed both {s1}/{s2}, identical body {b1 == b2}",
    )

    # browser session (S1): HttpOnly + SameSite=Strict cookie, no token in the body; a cookie write from
    # another origin is refused (CSRF)
    req = urllib.request.Request(
        f"{api}/api/auth/login",
        data=json.dumps({"email": EMAILS["ADMIN"], "password": stack.passwords["ADMIN"]}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as res:
        cookie = next(
            (v for k, v in res.headers.items() if k.lower() == "set-cookie" and "cc_session=" in v), ""
        )
        login_body = json.loads(res.read())
    flags_ok = "HttpOnly" in cookie and "SameSite=Strict" in cookie and "token" not in login_body
    session = cookie.split(";")[0]
    forged = urllib.request.Request(
        f"{api}/api/batches/1",
        data=json.dumps({"quantity": 1}).encode(),
        headers={"Content-Type": "application/json", "Cookie": session, "Origin": "https://evil.example"},
        method="PATCH",
    )
    try:
        with urllib.request.urlopen(forged) as res:
            csrf = res.status
    except urllib.error.HTTPError as err:
        csrf = err.code
    record(
        "PASS" if flags_ok and csrf == 403 else "FAIL",
        "session cookie and CSRF",
        f"cookie {'HttpOnly, SameSite=Strict' if flags_ok else repr(cookie[:60])}; "
        f"token in body: {'token' in login_body}; cross-origin cookie write -> {csrf}",
    )

    # rate limits
    codes = [
        stack.call("POST", "/api/auth/login", None, {"email": "nobody@x.io", "password": "wrong-password-1"})[
            0
        ]
        for _ in range(12)
    ]
    record("PASS" if 429 in codes else "FAIL", "login rate limit", f"statuses {sorted(set(codes))}")
    codes = [stack.call("GET", "/api/public/batch/AAAAAAAAAAAA")[0] for _ in range(70)]
    record(
        "PASS" if 429 in codes else "FAIL",
        "public QR endpoint rate limit",
        f"429 after {codes.index(429) if 429 in codes else '-'} calls",
    )


DOC = ROOT / "docs" / "SECURITY.md"


def write_doc(ran_live: bool) -> None:
    """Rewrite the <!-- results:start -->..<!-- results:end --> block in SECURITY.md with this run."""
    start, end = "<!-- results:start -->", "<!-- results:end -->"
    try:
        text = DOC.read_text(encoding="utf-8")
    except OSError:
        return
    if start not in text or end not in text:
        return
    passed = sum(1 for s, *_ in RESULTS if s == "PASS")
    scope = "static checks and live probes" if ran_live else "static checks only (`--static`)"
    lines = [
        start,
        f"Run on {time.strftime('%Y-%m-%d')} ({scope}): "
        f"{passed}/{len(RESULTS)} PASS, {sum(1 for s, *_ in RESULTS if s == 'FAIL')} FAIL, "
        f"{sum(1 for s, *_ in RESULTS if s == 'WARN')} WARN.",
        "",
        "| Result | Check | Detail |",
        "|---|---|---|",
        *(f"| {s} | {n} | {d or ''} |" for s, n, d in RESULTS),
        end,
    ]
    before, after = text.split(start)[0], text.split(end)[1]
    with DOC.open("w", encoding="utf-8", newline="\n") as f:  # LF on Windows too (.gitattributes eol=lf)
        f.write(before + "\n".join(lines) + after)


def broker_acl(stack: Stack) -> None:
    """With per-account ACLs, fridge-01's account can neither speak as fridge-02 nor read its commands."""
    import paho.mqtt.client as mqtt

    u = urlparse(stack.mqtt_url)

    def connect(account: str):
        c = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=f"acl-probe-{account}-{secrets.token_hex(3)}"
        )
        c.username_pw_set(*stack.mqtt_auth(account))
        c.connect(u.hostname, u.port, keepalive=10)
        c.loop_start()
        return c

    received: list[str] = []
    spy = connect("backend")  # may read every device's uplink
    spy.on_message = lambda _c, _u, m: received.append(m.topic)
    spy.subscribe(f"{stack.prefix}/+/telemetry", qos=1)
    refused: list[bool] = []
    snoop = connect("fridge-01")
    snoop.on_subscribe = lambda _c, _u, _mid, codes, _p=None: refused.append(codes[0].is_failure)
    time.sleep(1)
    snoop.subscribe(f"{stack.prefix}/fridge-02/cmd", qos=1)
    device = connect("fridge-01")
    own, forged = f"{stack.prefix}/fridge-01/telemetry", f"{stack.prefix}/fridge-02/telemetry"
    device.publish(own, "acl-probe", qos=0)  # control: its own topic goes through
    time.sleep(0.5)
    device.publish(forged, "acl-probe", qos=0)  # another device's topic: the broker drops it
    time.sleep(2)
    for c in (spy, snoop, device):
        c.loop_stop()
        c.disconnect()
    ok = own in received and forged not in received and refused == [True]
    record(
        "PASS" if ok else "FAIL",
        "broker ACL per device",
        f"own topic {'delivered' if own in received else 'MISSING'}; "
        f"as fridge-02 {'DELIVERED' if forged in received else 'dropped'}; "
        f"subscribe to fridge-02/cmd {'refused' if refused == [True] else f'NOT refused {refused}'}",
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--static", action="store_true", help="skip the live probes")
    ap.add_argument("--no-doc", action="store_true", help="do not update docs/SECURITY.md")
    args = ap.parse_args(argv)
    npm_audit()
    pip_audit()
    secrets_scan()
    ignore_rules()
    if not args.static:
        tmp = Path(tempfile.mkdtemp(prefix="coldchain-security-"))
        stack = Stack(
            db=tmp / "sec.db",
            api_port=4420,
            ml_port=8420,
            mqtt_url="mqtt://127.0.0.1:18832",
            prefix="coldchain/v1/sec",
            logs=tmp,
            acl=True,  # per-account broker ACLs, as in infra/mosquitto/acl
        )
        try:
            stack.up(hours=0)
            live(stack)
            broker_acl(stack)
        finally:
            stack.down()
    if not args.no_doc:
        write_doc(ran_live=not args.static)
    failed = [r for r in RESULTS if r[0] == "FAIL"]
    print(
        f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed"
        + (f", {len(failed)} FAILED" if failed else "")
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
