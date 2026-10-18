# Known issues and checklist status

Bug-bash of P20, 2026-10-18. Each issue has a workaround. The checklist status per prompt follows.

## Open issues

| # | Issue | Impact | Workaround / plan |
|---|---|---|---|
| 1 | **Readings published while the backend is down are lost.** Nodes publish with QoS 0 (PubSubClient on the ESP32 supports no QoS 1 publish), so the broker does not keep them for an absent subscriber. | A gap in history equal to the outage. Exposure over the hole is counted conservatively (weight 1, `GAP_CONSERVATIVE_S`), and the open sequence gap shows on the Security page. | Keep the backend supervised (Docker `restart`, systemd). The device buffer covers Wi-Fi and broker outages fully (scenarios S6, FI). A real fix needs an MQTT client with QoS 1 publish on the node and a persistent backend session. |
| 2 | **A message already in a dying broker connection can be lost.** Same cause: QoS 0. | At most the one or two messages in flight when the broker dies (FI measured 0 on the last run). | Same as #1. The sequence gap is detected and shown. |
| 3 | **A door flung wide open cannot be forecast 10 minutes ahead.** With the demo door constant, the temperature passes 8 °C within about a minute. | The forecaster warns within the minute, not before the cause. | The early warning works where physics allows: a door left ajar (`door_ajar` scenario; ≥ 10 min, asserted in `ml/tests` and in `scenarios --full`), and a weakening compressor. |
| 4 | **react-router 6 advisories** (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg, moderate). | Not reachable here: every `<Link>` / `navigate` target is a constant internal path, and there is no SSR. | Accepted. Move to react-router 7 in a later release; it is a breaking change. |
| 5 | **Wokwi simulations were not run in CI.** `wokwi-cli` needs a `WOKWI_CLI_TOKEN`. | The circuits are checked structurally (`tools/tests/test_wokwi.py`: every wire, pin map, no overlaps). The firmware logic is covered by 66 native unit tests and by its Python port. | Create a token at wokwi.com/dashboard/ci and run `wokwi-cli --timeout 20000 firmware/fridge-node/wokwi/hw-smoke`. |
| 6 | **Docker images not built on this machine** (Docker Desktop not running). | `infra/docker-compose.yml` and the Dockerfiles are not exercised by the tests. | `make up`. The same services run natively through `make demo`, which is what the scenarios use. |
| 7 | **AI models trained on synthetic data.** | Scores flatter the models (see the report's honesty note). | `python -m data.export_live` exports real readings in the training schema for a retrain. |
| 8 | **The health trend needs ≥ 6 h of scores** before it can flag "falling > 5 points/day". | A fresh deployment flags weakening by the score (< 70) only. | By design: minutes of jitter must not read as a collapse. |
| 9 | **The session token is in `sessionStorage`.** | An XSS would expose it. React escapes all text and the CSP is on; no XSS was found. | Cookie sessions (`HttpOnly`, `SameSite`) if this goes beyond a pilot. |

## Checklist status

✅ = verified by automated tests or scenarios, named in the evidence column. ⚠ = verified with a caveat from the issues above.

| Prompt | Status | Evidence |
|---|---|---|
| P00 Scaffold | ✅ | `make test` runs every suite and fails on zero tests; generated files are checked for staleness |
| P01 Wokwi hardware | ⚠ | `test_wokwi.py` (wiring, pins, crossings); simulation run needs a Wokwi token (#5) |
| P02 Firmware core | ⚠ | native tests (control, thermal, status, UI); S1, S2 on the Python port; on-device run in Wokwi (#5) |
| P03 Networking, signed messages | ✅ | HMAC vectors on every target; S7 |
| P04 Heat exposure, latch, commands | ✅ | native tests; S4 (latch, Admin-only reset over a signed command) |
| P05 Power, buffer, sync, door alarm | ✅ | S3, S5, S6, FI (broker restart) |
| P06 Virtual node, attack, tamper tools | ✅ | `tools/tests`; S7, S8 drive them |
| P07 Auth, RBAC | ✅ | RBAC test (150 route × role cases); S9 live |
| P08 Hash-chain audit, Verify Integrity | ✅ | backend tests; S8; Playwright tamper flow |
| P09 Secure ingestion, dedupe, sync | ✅ | ingest tests; S6, S7 |
| P10 Inventory, QR, public check | ✅ | backend tests; Playwright pharmacist flow; security check (public endpoint) |
| P11 Heat budget engine | ✅ | property test (live = late = recompute); S4 rates ×1 / ×2 |
| P12 Alerts, commands | ✅ | alert tests; S3 delivery within 5 s; S5 |
| P13 Frontend foundation | ✅ | unit tests, design checks |
| P14 Dashboard, fridge detail | ✅ | unit tests, Playwright dashboard |
| P15 Inventory, QR, security, audit, users UI | ✅ | unit tests, Playwright flows |
| P16 Dataset, features | ✅ | `ml/tests/test_features.py` (no look-ahead, parity) |
| P17 Models, report | ✅ | `ml/tests/test_models.py`; `reports/REPORT.md` |
| P18 ML service, scheduler, relocation | ✅ | backend tests (planner, confirm race, 409, idempotency); `ml/tests/test_service.py`; S10, FI (ML down) |
| P19 AI in the UI | ✅ | component tests; Playwright AI flow |
| P20 Integration, hardening | ⚠ | S1–S10 and FI pass (`make scenarios`); `make security`; `make perf`; quick-start not yet timed on a second machine |
