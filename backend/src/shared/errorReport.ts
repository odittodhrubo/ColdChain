// Error tracking (D4), off unless ERROR_DSN is set. It speaks the Sentry envelope protocol, which Sentry and the
// self-hosted GlitchTip both accept, so there is no SDK: one POST per unexpected error, scrubbed before it leaves.
import { randomBytes } from 'node:crypto';
import { logger } from './logger';

export type ReportError = (err: unknown, tags?: Record<string, string | undefined>) => void;

/** beforeSend: no session tokens, emails, device secrets or cookies ever reach the tracker. */
export function scrub(text: string): string {
  return text
    .replace(/eyJ[\w-]*\.[\w-]+\.[\w-]+/g, '[token]') // JWTs (session, MFA)
    .replace(/Bearer\s+\S+/gi, 'Bearer [token]')
    .replace(/cc_session=[^;\s"]*/g, 'cc_session=[token]')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\b[0-9a-f]{64}\b/gi, '[secret]'); // device secrets, APP_SECRET_KEY-sized hex
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

/** V8 stack lines -> Sentry frames, oldest call first. */
function frames(stack: string | undefined) {
  return (stack ?? '')
    .split('\n')
    .map((l) => /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(l))
    .filter((m) => m !== null)
    .map((m) => ({ function: m[1] ?? '?', filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) }))
    .reverse();
}

export function eventEnvelope(
  err: unknown,
  tags: Record<string, string | undefined>,
  meta: { environment: string; platform: string },
): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const eventId = randomBytes(16).toString('hex');
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    level: 'error',
    ...meta,
    tags: Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined)),
    exception: { values: [{ type: e.name, value: e.message, stacktrace: { frames: frames(e.stack) } }] },
  };
  return scrub(
    `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n{"type":"event"}\n${JSON.stringify(event)}`,
  );
}

const MAX_PER_MINUTE = 30; // an error loop must not flood the tracker or the network

export function createErrorReporter(
  dsn: string | undefined,
  meta: { environment: string },
  send: (url: string, body: string) => Promise<unknown> = (url, body) =>
    fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(5000) }),
): ReportError {
  const url = dsn ? envelopeUrl(dsn) : null;
  if (dsn && !url) logger.warn('ERROR_DSN is not a valid DSN: error tracking stays off');
  if (!url) return () => {};
  let windowStart = 0;
  let sent = 0;
  return (err, tags = {}) => {
    const now = Date.now();
    if (now - windowStart > 60_000) [windowStart, sent] = [now, 0];
    if (++sent > MAX_PER_MINUTE) return;
    send(url, eventEnvelope(err, tags, { ...meta, platform: 'node' })).catch((e: Error) =>
      logger.warn({ err: e.message }, 'error report not sent'),
    );
  };
}
