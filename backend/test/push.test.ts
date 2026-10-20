import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/shared/http';
import { PushSender } from '../src/modules/push/service';
import type { AlertMessage } from '../src/modules/alerts/notifier';
import { addUser, bearer, makeApp, tokenFor } from './helpers';

const SUB = { endpoint: 'https://push.example.com/a', keys: { p256dh: 'BPk', auth: 'auth0' } };

describe('Web Push subscriptions (P7)', () => {
  it('reports the VAPID key and whether push is on (off without keys)', async () => {
    const t = makeApp();
    const token = tokenFor(t, await addUser(t, 'ADMIN'));
    const res = await t.http().get('/api/push/vapid-key').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ key: null, enabled: false });
  });

  it('subscribe stores the endpoint, unsubscribe removes it', async () => {
    const t = makeApp();
    const token = tokenFor(t, await addUser(t, 'PHARMACIST'));
    const count = () =>
      (t.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get() as { n: number }).n;

    expect((await t.http().post('/api/push/subscribe').set(bearer(token)).send(SUB)).status).toBe(200);
    expect(count()).toBe(1);

    // subscribing the same endpoint again is an upsert, not a duplicate
    await t.http().post('/api/push/subscribe').set(bearer(token)).send(SUB);
    expect(count()).toBe(1);

    expect(
      (await t.http().post('/api/push/unsubscribe').set(bearer(token)).send({ endpoint: SUB.endpoint }))
        .status,
    ).toBe(200);
    expect(count()).toBe(0);
  });

  it('a POST without a session is refused', async () => {
    const t = makeApp();
    expect((await t.http().post('/api/push/subscribe').send(SUB)).status).toBe(401);
  });

  it('notify pushes to every subscription and prunes the ones the push service says are gone', async () => {
    const t = makeApp();
    const user = await addUser(t, 'ADMIN');
    for (const endpoint of ['https://push.example.com/live', 'https://push.example.com/dead'])
      t.db
        .prepare('INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?,?,?,?,?)')
        .run(endpoint, user.id, 'k', 'a', Date.now());

    const send = vi.fn(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith('/dead')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    });
    // keys present so push is "configured"; the injected send skips the real web-push call
    const config = { ...t.config, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    const push = new PushSender({ config, db: t.db } as unknown as AppContext, send);
    expect(push.enabled()).toBe(true);

    const msg: AlertMessage = { title: 'Breach', lines: ['fridge-01', '9.1 °C'], severity: 'CRITICAL' };
    await push.notify(msg);

    expect(send).toHaveBeenCalledTimes(2);
    const left = t.db.prepare('SELECT endpoint FROM push_subscriptions').all() as { endpoint: string }[];
    expect(left.map((r) => r.endpoint)).toEqual(['https://push.example.com/live']);
  });

  it('notify is a no-op when push is not configured', async () => {
    const t = makeApp();
    const send = vi.fn();
    const push = new PushSender({ config: t.config, db: t.db } as unknown as AppContext, send);
    await push.notify({ title: 'x', lines: [], severity: 'CRITICAL' });
    expect(send).not.toHaveBeenCalled();
  });
});
