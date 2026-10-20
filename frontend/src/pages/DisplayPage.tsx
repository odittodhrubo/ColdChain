import { useEffect, useState } from 'react';
import { SAFE_MAX_C, SAFE_MIN_C } from '../lib/constants';
import { serverNow, useServerNow } from '../lib/time';
import type { Alert, Fridge } from '../lib/types';

// P1: wall-display (kiosk) mode. A full-screen, read-only, navigation-free view driven by a long-lived display
// token (created on the Users page). The token rides in the link's fragment; it never becomes a cookie, so this
// page talks to the API with a Bearer header instead of the normal same-origin session. It polls, reconnects on
// its own, shows how stale the data is, and shifts a few pixels every couple of minutes to avoid screen burn-in.

const TOKEN_KEY = 'coldchain.display';
const POLL_MS = 5000;
const STALE_MS = 15_000; // no fresh data for this long turns the clock red

function readToken(): string | null {
  const m = /[#&]token=([\w-]+\.[\w-]+\.[\w-]+)/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]);
    } catch {
      /* storage blocked: the in-URL token still works for this view */
    }
    history.replaceState(null, '', location.pathname); // drop the token from the address bar
    return m[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

const STATUS_INK: Record<string, string> = {
  SAFE: 'var(--safe)',
  WARNING: 'var(--warning)',
  BREACH: 'var(--breach)',
  OFFLINE: 'var(--offline)',
};

function FridgeTile({ fridge }: { fridge: Fridge }) {
  const ink = STATUS_INK[fridge.status] ?? 'var(--ink-3)';
  const temp = fridge.live?.temp;
  return (
    <section
      className="flex flex-col justify-between rounded-2xl border-2 p-6"
      style={{ borderColor: ink, backgroundColor: `color-mix(in oklab, ${ink} 7%, var(--panel))` }}
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="truncate text-2xl font-bold text-ink">{fridge.name}</h2>
        <span className="text-xl font-black tracking-wide" style={{ color: ink }}>
          {fridge.status}
        </span>
      </header>
      <p className="figures my-4 text-center text-7xl font-black tabular-nums" style={{ color: ink }}>
        {temp === null || temp === undefined ? '—' : `${temp.toFixed(1)}°`}
      </p>
      <footer className="figures flex justify-between text-base text-ink-2">
        <span>
          Safe {SAFE_MIN_C}–{SAFE_MAX_C} °C
        </span>
        <span>
          {fridge.load} batch{fridge.load === 1 ? '' : 'es'}
          {fridge.latch ? ' · LATCHED' : ''}
        </span>
      </footer>
    </section>
  );
}

export function DisplayPage() {
  const [token] = useState(readToken);
  const [fridges, setFridges] = useState<Fridge[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [shift, setShift] = useState(0);
  const now = useServerNow(1000);

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    let stop = false;
    const poll = async () => {
      try {
        const [f, a] = await Promise.all([
          fetch('/api/fridges', { headers }).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
          fetch('/api/alerts?status=active&pageSize=20', { headers }).then((r) =>
            r.ok ? r.json() : Promise.reject(r.status),
          ),
        ]);
        if (stop) return;
        setFridges(f.fridges);
        setAlerts(a.alerts);
        setLastOk(serverNow());
        setFailed(false);
      } catch {
        if (!stop) setFailed(true); // keep showing the last data; the clock will redden
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [token]);

  // Burn-in guard: nudge the whole screen a few pixels every two minutes.
  useEffect(() => {
    const t = setInterval(() => setShift((s) => (s + 1) % 4), 120_000);
    return () => clearInterval(t);
  }, []);

  if (!token)
    return (
      <main className="grid min-h-dvh place-items-center bg-canvas p-8 text-center">
        <p className="max-w-md text-lg text-ink-2">
          Open this screen from the display link an administrator created on the Users page.
        </p>
      </main>
    );

  const staleMs = lastOk === null ? Infinity : now - lastOk;
  const stale = failed || staleMs > STALE_MS;
  const ago = lastOk === null ? 'no data yet' : `${Math.round(staleMs / 1000)} s ago`;

  return (
    <main
      className="min-h-dvh bg-canvas p-6 lg:p-10"
      style={{ transform: `translate(${(shift % 2) * 4}px, ${shift > 1 ? 4 : 0}px)` }}
    >
      <header className="mb-6 flex items-center justify-between gap-4">
        <h1 className="text-xl font-black tracking-tight text-ink lg:text-2xl">ColdChain — live status</h1>
        <span
          className="figures inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold"
          style={{
            color: stale ? 'var(--breach)' : 'var(--safe)',
            backgroundColor: `color-mix(in oklab, ${stale ? 'var(--breach)' : 'var(--safe)'} 12%, var(--panel))`,
          }}
          role="status"
          aria-live="polite"
        >
          <span className="size-2.5 rounded-full" style={{ background: stale ? 'var(--breach)' : 'var(--safe)' }} />
          {stale ? `Stale — updated ${ago}` : `Live — updated ${ago}`}
        </span>
      </header>

      <div className="grid gap-5 sm:grid-cols-2">
        {fridges.map((f) => (
          <FridgeTile key={f.id} fridge={f} />
        ))}
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-bold text-ink">
          Active alerts {alerts.length > 0 && <span className="text-breach">({alerts.length})</span>}
        </h2>
        {alerts.length === 0 ? (
          <p className="text-lg text-ink-2">No active alerts. All fridges are being monitored.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {alerts.map((a) => {
              const ink = a.severity === 'CRITICAL' ? 'var(--breach)' : 'var(--warning)';
              return (
                <li
                  key={a.id}
                  className="flex items-center gap-3 rounded-xl border px-4 py-3 text-lg"
                  style={{
                    borderColor: `color-mix(in oklab, ${ink} 40%, transparent)`,
                    backgroundColor: `color-mix(in oklab, ${ink} 8%, var(--panel))`,
                  }}
                >
                  <span className="size-3 shrink-0 rounded-full" style={{ background: ink }} aria-hidden />
                  <span className="font-bold" style={{ color: ink }}>
                    {a.severity}
                  </span>
                  <span className="truncate text-ink">{a.data.title ?? a.message}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}

export default DisplayPage;
