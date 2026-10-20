import { describe, expect, it, vi } from 'vitest';
import { createErrorReporter, envelopeUrl, eventEnvelope, scrub } from '../src/shared/errorReport';
import type { AppContext } from '../src/shared/http';
import { addUser, bearer, makeApp, tokenFor } from './helpers';

// D4: optional error tracking, Sentry envelope protocol, scrubbed before it leaves.
describe('error reporting', () => {
  it('scrubs tokens, emails, cookies and secrets', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    const out = scrub(
      `Bearer abc.def ${jwt} cc_session=${jwt}; admin@coldchain.local ${'a1'.repeat(32)} in metrics.test.ts:12`,
    );
    expect(out).toBe('Bearer [token] [token] cc_session=[token]; [email] [secret] in metrics.test.ts:12');
  });

  it('derives the envelope endpoint from a DSN and refuses malformed ones', () => {
    expect(envelopeUrl('https://k3y@o1.ingest.sentry.io/42')).toBe(
      'https://o1.ingest.sentry.io/api/42/envelope/?sentry_version=7&sentry_key=k3y',
    );
    expect(envelopeUrl('http://k@glitchtip.local:8000/sub/7')).toBe(
      'http://glitchtip.local:8000/sub/api/7/envelope/?sentry_version=7&sentry_key=k',
    );
    expect(envelopeUrl('https://o1.ingest.sentry.io/42')).toBeNull(); // no key
    expect(envelopeUrl('not a url')).toBeNull();
  });

  it('builds a three-line envelope with the exception and its frames', () => {
    const err = new Error('boom for nurse@clinic.org');
    const [head, item, body] = eventEnvelope(
      err,
      { route: '/api/x', reqId: undefined },
      {
        environment: 'test',
        platform: 'node',
      },
    ).split('\n');
    expect(JSON.parse(item)).toEqual({ type: 'event' });
    const event = JSON.parse(body);
    expect(event.event_id).toBe(JSON.parse(head).event_id);
    expect(event).toMatchObject({ level: 'error', environment: 'test', tags: { route: '/api/x' } });
    expect(event.exception.values[0]).toMatchObject({ type: 'Error', value: 'boom for [email]' });
    expect(event.exception.values[0].stacktrace.frames.at(-1).filename).toMatch(/errorReport\.test\.ts$/);
  });

  it('is off without a DSN, sends with one, and caps a flood at 30 a minute', () => {
    const send = vi.fn(() => Promise.resolve());
    createErrorReporter(undefined, { environment: 'test' }, send)(new Error('x'));
    createErrorReporter('nonsense', { environment: 'test' }, send)(new Error('x'));
    expect(send).not.toHaveBeenCalled();
    const report = createErrorReporter('https://k@sentry.example/1', { environment: 'test' }, send);
    for (let i = 0; i < 50; i++) report(new Error(`e${i}`));
    expect(send).toHaveBeenCalledTimes(30);
    expect(send.mock.calls[0]).toEqual([expect.stringContaining('/api/1/envelope/'), expect.any(String)]);
  });

  it('an unexpected 500 is reported with its route; a 4xx is not', async () => {
    const t = makeApp();
    const ctx = t.app.locals.ctx as AppContext;
    const reported = vi.fn();
    ctx.reportError = reported;
    const token = tokenFor(t, await addUser(t, 'ADMIN'));
    expect((await t.http().get('/api/auth/me')).status).toBe(401);
    expect(reported).not.toHaveBeenCalled();
    t.db.close();
    const res = await t.http().get('/api/fridges').set(bearer(token));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL');
    expect(reported).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ method: 'GET' }));
  });
});
