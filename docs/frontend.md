# Frontend

React 18 + Vite + TypeScript + Tailwind CSS v4, React Router, TanStack Query, socket.io-client, lucide-react. Product context lives in [`PRODUCT.md`](../PRODUCT.md) and the visual system in [`DESIGN.md`](../DESIGN.md).

```
src/
  App.tsx              providers (theme, toasts, query cache, auth, realtime) and routes
  index.css            design tokens (light + dark), base styles, focus, selection, reduced motion
  ui/                  design-system components: StatusChip + VvmMark, Button, Panel, Field, Table,
                       Modal (native <dialog>), Toast, Skeleton, EmptyState, ErrorState
  layout/              AppShell, Sidebar (bottom bar below lg), TopBar, DemoBanner, nav model
  auth/                session store, AuthProvider, guards, permission matrix mirror
  realtime/            RealtimeProvider (one Socket.IO connection) and the event -> cache merge
  lib/api.ts           typed fetch wrapper, ApiError, retry policy
  pages/               login, no-permission, not-found, pages per route
```

## Status vocabulary

Every status is colour **and** a glyph **and** a word (`StatusChip`). The glyph is the vaccine vial monitor mark (`VvmMark`): a square inside a circle whose square darkens as heat budget is used, struck through for DISCARD, dashed for OFFLINE. It pulses once when a status changes, never on first render, and not at all under `prefers-reduced-motion`.

| Status | Token | Meaning |
|---|---|---|
| Safe | `--safe` (green) | in 2–8 °C / budget intact |
| Warning | `--warning` (amber) | near the edge, door open, on battery |
| Breach | `--breach` (red) | outside 2–8 °C |
| At risk | `--atrisk` (orange) | under 20 % heat budget left |
| Discard | `--discard` (deep red, strike pattern) | budget spent or expired: never use |
| Offline | `--offline` (grey) | no data from the node |
| Demo | `--demo` (violet) | the DEMO MODE banner when `demoScale ≠ 1` |

Light and dark themes share the tokens (`:root` / `.dark`); the theme follows the system and the top-bar toggle overrides it (stored in `localStorage`, a display preference only).

## Auth

- `POST /api/auth/login` returns `{token, expiresAt, user}`. The token lives in memory, mirrored to **`sessionStorage`** (this tab only), never `localStorage`.
- Any 401 on an authenticated call, or reaching `expiresAt`, ends the session (once, even when several requests fail together) and the user is told. Sign-out calls `POST /api/auth/logout` so the server revokes the token, and clears the query cache.
- `GET /api/auth/me` refreshes the role on load, so a demotion shows in the UI as well as on the server.
- Route guards (`RequireAuth`, `RequirePermission`) and the role-aware navigation mirror the server's matrix (`auth/permissions.ts`). Hiding is not authorisation: pages still render a friendly no-permission state for a server 403 (`ErrorState`).

## Data and realtime

- `api<T>()` normalises every failure to `ApiError {status, code, message, details}` (`status 0` = server unreachable). Queries pass TanStack's `AbortSignal`, so leaving a page cancels its requests. 4xx responses are never retried; network errors and 5xx retry twice.
- `RealtimeProvider` opens **one** Socket.IO connection per session, authenticated with the JWT (`io({auth: {token}})`), and opens it again whenever the token changes. Pages never subscribe themselves: `realtime/merge.ts` applies `fridge:update`, `fridge:latch`, `batch:update`, `alert:new`, `alert:update`, `prediction:update`, `relocation:update` and `security:event` to the query cache.
- When the socket is down the provider refetches the live queries every 5 s, and the top bar shows **Polling every 5 s** (glyph + word) instead of **Live**.

## Shell

- Desktop: label rail on the left with every section the role may open (Users only for Admin). Below `lg`: a bottom bar with Dashboard, Fridges, Inventory, Alerts and a **More** menu.
- Top bar: global status pill (all fridges safe, or open / critical alert counts, linking to Alerts), connection indicator, theme toggle, user menu with sign-out. A skip link jumps to the content.
- DEMO banner on every screen when `/api/health` reports `demoScale ≠ 1`.

## Dashboard and fridge detail (P14)

- **Dashboard** (`pages/DashboardPage.tsx`): a summary strip (fridges Safe / Warning / Breach, batches Safe / At risk / Discard, open alerts, nodes offline, last updated), one card per fridge, its heat-budget panel, and the open-alerts feed with permission-aware Ack.
- **Fridge card** (`dashboard/FridgeCard.tsx`): name + status chip; the temperature large, with a gauge showing the 2–8 °C band, the 3 / 7 °C compressor thresholds and a gliding needle; door (open for mm:ss, an alarm with a pulsing bell past 60 s), power (Mains / Battery with a battery bar and "since"), compressor (on, or the off-timer until restart is allowed), link (online / offline, last seen, "buffered n readings, syncing…"), the red **DISCARD LATCH** banner with an Admin-only **Reset** (reason required, waits for the node's confirmation), and a 30-minute sparkline. After 20 s without data the card turns grey and says "No data for n s".
- **Heat budget panel**: every batch in the fridge, lowest remaining first: a budget bar (green, amber from 50 %, orange below 20 %, red and struck at 0), minutes used, how it accrues right now (`accruing ×1` above 8 °C, `×2` above 12 °C), status chip. A row opens the batch drawer with the cumulative exposure chart against the 60-minute line.
- **Fridge detail** (`/fridges/:id`): Recharts history for 15 min / 1 h / 6 h / 24 h (server-side buckets, ≤ 600 points) with the safe band shaded, 8 °C and 12 °C lines, compressor-running strips, door-open and power-failure markers, diamonds where data arrived late through sync, and a tooltip with exact values; the event timeline (door, power, alarm, latch, Wi-Fi / sync, with a "synced" tag for late events); recent readings with a `late · synced` flag; a reserved panel for the AI forecast and health score (P19).
- Status shown is always the server's (`live.state` from the shared `classify()`), never recomputed differently; timers use server timestamps (`lib/time.ts`). Pure rules live in `dashboard/logic.ts` and are unit-tested, including against the shared status vectors.
- Thresholds come from `src/lib/constants.ts`, generated from `contracts/constants.json` like the other targets.

## Inventory, QR, public check, security, audit, users (P15)

- **Routing**: `/check/:token` is public (outside `RequireAuth`, no chrome). Every signed-in page is lazy-loaded, so a QR scan downloads only the public card.
- **Inventory** (`pages/InventoryPage.tsx`): search (name, lot, manufacturer), fridge / status filters, "Expiring ≤ 30 days", sortable columns (`aria-sort`). Row actions follow the role: Edit and Move need `batch:write` and are hidden for discarded batches; QR and Details are for everyone. Discarded rows are struck through with "Disposal required" and, for Admin, a link to acknowledge it on the fridge page.
  - **Add / edit** (`inventory/BatchForm.tsx`): validated before sending (future expiry, quantity, fridge); `FRIDGE_FULL` is explained in place.
  - **Move** (`inventory/MoveDialog.tsx`): fridges with load / capacity and status; full fridges and the current one are disabled.
  - **QR** (`inventory/QrDialog.tsx`): the SVG is fetched with the bearer token and shown as a data URL; **Copy public link** uses `public_url` from the batch detail; **Print label** prints only the label (name, lot, expiry, QR with quiet zone; `@media print` in `index.css`).
  - **Details** (`inventory/DetailsDrawer.tsx`): assignment history, the cumulative exposure chart, and the batch's audit entries (`/api/audit?batch_id=`).
- **Public check** (`pages/PublicCheckPage.tsx`): one card with SAFE / AT RISK / DISCARD as icon + word + plain guidance, name, lot, expiry (flagged when expired) and last checked. "Batch not found" for an unknown token, a wait message on 429. Sends no token, adds `noindex, nofollow`.
- **Security** (`pages/SecurityPage.tsx`): last-hour accepted / rejected counts by reason and per-device last seen and open sequence gap (`/api/security/summary`), then the rejected messages filterable by reason and device. Five or more rejects with the same device and reason within a minute are marked as a **burst**.
- **Audit Log** (`pages/AuditPage.tsx`): the chain newest first, filterable by event and actor, with short `prev_hash` / `hash` that copy in full. **Verify Integrity** (every role) streams `GET /api/audit/verify?stream=1` with a progress bar, then a green "Chain intact — n records" or a red panel with the first broken record and why; that row is highlighted and the list jumps to its page.
- **Alerts** (`pages/AlertsPage.tsx`): history filtered by status, severity, type and fridge, the alert's detail lines, per-channel delivery result (in-app / Telegram / email: sent, failed, skipped) and Ack for roles with `alert:ack`.
- **Users** (Admin, `pages/UsersPage.tsx`): add users (password rule checked as on the server), change role inline, reset a password, disable / enable. Refusals such as `LAST_ADMIN` are explained and the row snaps back.

## AI forecast, health, relocation and report (P19)

- **Forecast** (`ai/Forecast.tsx`, `ai/AiPanel.tsx`):
  - The fridge detail shows a risk badge (glyph + word: Low / Medium / High risk) and one sentence: "Forecast 8.9 °C in 30 min – may exceed 8 °C in ~18 min". It also shows the 80 % range and the breach probability.
  - The history chart gets a dashed forecast line from the last reading to +30 min, a shaded p10–p90 band and a marker at the predicted value.
  - Each fridge card carries a "Next 30 min" chip.
  - The prediction's age is always shown. A rule-based fallback is labelled "AI service down". Anything older than two scheduler runs is marked `stale` and is never drawn on the chart as current.
- **Compressor health** (`ai/HealthGauge.tsx`):
  - A 0–100 semicircle with Good / Weakening / Failing bands, the score and its band in words, and the 7-day trend.
  - When weakening, a "Weakening compressor – service recommended" banner appears.
  - "Why this score" lists the factors in plain language: cooling rate while running, share of time running, cycles per hour, trend.
- **Relocation** (`ai/RelocationPanel.tsx`, `ai/Relocations.tsx`):
  - Each active plan appears above the dashboard and on `/relocations`. It shows the reason, a table of batch → destination with urgency (Move first / Soon / When possible) and budget left, batches with no room, batches to dispose of, the destination's safety and an expiry countdown.
  - **Confirm relocation** is one click for Admin / Pharmacist, disabled while in flight. It sends the plan `version`. On success a toast links to the audit entry, and inventory, fridges and alerts refresh.
  - A `409` swaps in the refreshed plan and lists what changed; nothing is claimed as moved.
  - **No safe target** has its own red state with the refused fridges and the manual-action advice.
  - An Inspector sees plans read-only. Dismiss asks for a reason.
- **AI Report** (`/ai-report`):
  - A "Trained on synthetic data" badge with the model version.
  - KPI cards: forecast MAE against the baselines, breach recall and precision, lead time, health error.
  - The dataset summary, the permutation importances, and `REPORT.md` rendered with `react-markdown` + `remark-gfm` (no raw HTML).
  - The figures are fetched with the session token.
- **Realtime:** `prediction:update` patches the cached latest forecast in place, with no refetch. `relocation:update` refreshes the plans.
- **Playwright AI flow** (`e2e/ai.spec.ts`):
  - The run starts the real ML service (`e2e/ml-server.mjs`, port 8310) and runs the scheduler every 5 s (`ML_INTERVAL_MS`).
  - `e2e/feed_readings.py` writes 3 h of weak-compressor history plus live readings into the e2e database. It stands in for the nodes, so no broker is needed.
  - The test checks that health drops, a plan appears, the Pharmacist confirms, and inventory shows the batches in Fridge B.

## Development

```bash
npm --prefix frontend run dev     # Vite on :5173, proxies /api and /socket.io to the backend on :4000
npm --prefix frontend test        # vitest + Testing Library
npm --prefix frontend run lint    # eslint + tsc
npm --prefix frontend run e2e     # Playwright: starts a seeded backend (:4310) and Vite (:5310); the integrity test runs
                                  # coldchain_tools.tamper against the e2e DB (needs the tools venv)
```
