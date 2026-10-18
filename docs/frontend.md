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
- `RealtimeProvider` opens **one** Socket.IO connection per session, authenticated with the JWT (`io({auth: {token}})`), and opens it again whenever the token changes. Pages never subscribe themselves: `realtime/merge.ts` applies `fridge:update`, `fridge:latch`, `batch:update`, `alert:new`, `alert:update`, `prediction:update` and `relocation:update` to the query cache.
- When the socket is down the provider refetches the live queries every 5 s, and the top bar shows **Polling every 5 s** (glyph + word) instead of **Live**.

## Shell

- Desktop: label rail on the left with every section the role may open (Users only for Admin). Below `lg`: a bottom bar with Dashboard, Fridges, Inventory, Alerts and a **More** menu.
- Top bar: global status pill (all fridges safe, or open / critical alert counts, linking to Alerts), connection indicator, theme toggle, user menu with sign-out. A skip link jumps to the content.
- DEMO banner on every screen when `/api/health` reports `demoScale ≠ 1`.

## Development

```bash
npm --prefix frontend run dev     # Vite on :5173, proxies /api and /socket.io to the backend on :4000
npm --prefix frontend test        # vitest + Testing Library
npm --prefix frontend run lint    # eslint + tsc
```
