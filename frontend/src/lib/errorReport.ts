// Error tracking (D4), off unless the build sets VITE_ERROR_DSN. Same envelope protocol and scrubbing as the
// backend (backend/src/shared/errorReport.ts), without an SDK: one POST per error, capped at 30 a minute.

/** beforeSend: no session tokens, emails, device secrets or cookies ever reach the tracker. */
export function scrub(text: string): string {
  return text
    .replace(/eyJ[\w-]*\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [token]')
    .replace(/cc_session=[^;\s"]*/g, 'cc_session=[token]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[secret]');
}

/** https://<key>@<host>[/<path>]/<project> -> the envelope endpoint, or null for a malformed DSN. */
export function envelopeUrl(dsn: string): string | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.split('/').filter(Boolean).pop();
    if (!u.username || !project || !/^\d+$/.test(project)) return null;
    const prefix = u.pathname.slice(0, u.pathname.lastIndexOf('/'));
    return `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/?sentry_version=7&sentry_key=${u.username}`;
  } catch {
    return null;
  }
}

export function createErrorReporter(
  dsn: string | undefined,
  send: (url: string, body: string) => void = (url, body) => {
    void fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
  },
) {
  const url = dsn ? envelopeUrl(dsn) : null;
  let windowStart = 0;
  let sent = 0;
  return (err: unknown, tags: Record<string, string> = {}) => {
    if (!url) return;
    const now = Date.now();
    if (now - windowStart > 60_000) [windowStart, sent] = [now, 0];
    if (++sent > 30) return;
    const e = err instanceof Error ? err : new Error(String(err));
    const eventId = crypto.randomUUID().replace(/-/g, '');
    const event = {
      event_id: eventId,
      timestamp: now / 1000,
      level: 'error',
      platform: 'javascript',
      environment: import.meta.env.MODE,
      tags: { ...tags, page: location.pathname },
      exception: { values: [{ type: e.name, value: e.message }] },
      extra: { stack: e.stack ?? '' },
    };
    send(
      url,
      scrub(
        `${JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() })}\n{"type":"event"}\n${JSON.stringify(event)}`,
      ),
    );
  };
}

export const reportError = createErrorReporter(import.meta.env.VITE_ERROR_DSN as string | undefined);
