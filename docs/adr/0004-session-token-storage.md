# 0004 — Session token: `sessionStorage` first, then `HttpOnly` cookies

## Status

Superseded by S1, which moved sessions to `HttpOnly`, `SameSite` cookies with CSRF protection.

## Context

The backend issues a short-lived JWT on login. The frontend has to send it on every API call. Two storage choices were on the table: keep it in `sessionStorage` and attach it as an `Authorization: Bearer` header, or set it as an `HttpOnly` cookie the browser sends automatically. A cookie is not readable by JavaScript, so it survives an XSS better, but it brings CSRF risk and needs a token-based path for non-browser clients (the test tools and scripts).

The original build (through P20) was a hackathon deliverable on a tight deadline, with the app not yet exposed beyond a pilot.

## Decision

**Originally:** store the JWT in `sessionStorage` and send it as a bearer header. This was the smaller, lower-risk choice for a demo: no CSRF surface, trivial for scripts, and the XSS exposure was mitigated by React escaping all text and a Content-Security-Policy being in place (no XSS was found). This storage limitation was later addressed by the decision below.

**Superseded (S1):** move browser sessions to an `HttpOnly`, `SameSite` cookie with CSRF protection, keeping a token-in-body path (`X-Auth-Mode: token`) for scripts and the test tools so they can still obtain a bearer token.

## Consequences

- An XSS can no longer read the session token from the browser, which was the open risk in #9.
- CSRF is now a surface and is handled explicitly; the cookie is `SameSite` and state-changing requests are protected.
- Non-browser clients (scenarios, `perf`, attack tools) ask for the token in the login response body via `X-Auth-Mode: token`, so the switch did not break the automation.
- A 24/7 wall dashboard (P1) still needs a session that does not hard-log-out mid-shift; that is handled with the display role, not by weakening the cookie.
