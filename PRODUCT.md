# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Pharmacist** (primary, day to day): watches the fridges, manages vaccine batches (create, edit, move between fridges), acknowledges alerts, confirms AI relocation suggestions with one click.
- **Admin**: everything a pharmacist does, plus users, resetting a fridge's red DISCARD latch after disposal, and acknowledging discards.
- **Inspector**: read-only auditor: dashboards, batches, alerts, security events, the hash-chained audit log and Verify Integrity.
- **Anyone with a vial in hand** (no login): scans a batch QR code and sees Safe / At Risk / Discard and expiry on the public check page.
- **Right now the deciding audience is the FastRoboX 1.0 hackathon judges** (Round 1), who run the demo and watch a ≤ 3-minute video. The app must read as professional and medical-grade, and must run fully without any external accounts.

Usage is **desktop first**: a clinic PC or laptop, and a wall monitor for the live dashboard. Phones matter mainly for the public QR check page; the app shell still works at 360 px.

## Product Purpose

Vaccines and insulin lose potency outside 2–8 °C. ColdChain monitors fridges in real time, tracks each batch's heat-exposure budget, keeps the temperature safe automatically (compressor hysteresis on the device), and tells people when something is wrong. Success: no batch is ever used after it exceeded its budget, and every incident is visible, alerted and auditable.

## Positioning

Per-batch heat budgets recomputed from authenticated device data (HMAC + timestamp + nonce), a tamper-evident hash-chained log with one-button Verify Integrity, offline buffering with ordered, duplicate-free sync, and AI that forecasts a breach 30 minutes ahead and proposes which batches to move where.

## Operating Context

- Two ESP32 fridge nodes (Wokwi simulation, same firmware) publish signed MQTT telemetry every 5 s and on door changes; a Python virtual node and attack/tamper tools exist for demos.
- Statuses: fridge SAFE / WARNING / BREACH (plus OFFLINE); batch SAFE / AT RISK / DISCARD. Discard is permanent; the red latch stays on until an Admin resets it.
- Alerts arrive in-app (primary), and optionally on Telegram / email.
- A demo mode accelerates heat exposure (`DEMO_TIME_SCALE`); the UI must disclose it with a banner, never silently.

## Capabilities and Constraints

- Stack is fixed by the build spec: React 18, Vite, TypeScript, Tailwind CSS, React Router, TanStack Query, socket.io-client, Recharts, lucide-react, qrcode.react.
- Backend REST + Socket.IO (`fridge:update`, `batch:update`, `alert:new`, `prediction:update`, `relocation:update`); the server enforces every permission, the UI only mirrors it.
- Auth tokens live in memory + `sessionStorage`, never `localStorage`.
- Roles and permission matrix: `docs/CONTRACTS.md` §8.

## Brand Commitments

- Name: **ColdChain**. Spec direction: clean clinical look, white/slate surfaces, teal primary; status colours used consistently everywhere: SAFE green, WARNING amber, BREACH red, AT RISK orange, DISCARD deep red/black with a strike pattern, OFFLINE grey, DEMO banner violet. Light and dark mode (system default + toggle). Icons: lucide-react.

## Evidence on Hand

- Live data comes from the fridge nodes / virtual node; there are no real customers, testimonials or deployment claims, and none may be invented.

## Product Principles

1. Safety state is never ambiguous: every status carries colour **and** an icon or text label.
2. Real time first, but honest: show when the data is live, polling, offline or accelerated.
3. Hiding a button is not authorisation: every action still handles a server 403.
4. Calm until it matters: quiet surfaces, loud only for breach and discard.

## Accessibility & Inclusion

Keyboard accessible with visible focus rings, `aria` labels, `prefers-reduced-motion` respected, text contrast ≥ 4.5:1, no layout shift; Lighthouse accessibility ≥ 90 on login and the shell; works at 360, 768 and 1440 px.
