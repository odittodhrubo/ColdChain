import { z } from 'zod';
import { defineRoute, type RouteDef } from '../../shared/http';

// P7: Web Push subscription management. The browser subscribes with the VAPID public key, posts its endpoint
// and keys here, and the server pushes BREACH/DOOR alerts to it (alerts/service.ts). All authenticated: a push
// subscription belongs to the signed-in user.
export function pushRoutes(): RouteDef[] {
  const subscription = z.strictObject({
    endpoint: z.string().url().max(1000),
    keys: z.strictObject({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(200) }),
  });
  return [
    defineRoute({
      method: 'get',
      path: '/api/push/vapid-key',
      access: 'authenticated',
      handler: (_in, { push }) => ({ key: push.publicKey, enabled: push.enabled() }),
    }),
    defineRoute({
      method: 'post',
      path: '/api/push/subscribe',
      access: 'authenticated',
      body: subscription,
      handler({ body, user }, { push }) {
        push.subscribe(user!.id, body);
        return { ok: true };
      },
    }),
    defineRoute({
      method: 'post',
      path: '/api/push/unsubscribe',
      access: 'authenticated',
      body: z.strictObject({ endpoint: z.string().url().max(1000) }),
      handler({ body }, { push }) {
        push.unsubscribe(body.endpoint);
        return { ok: true };
      },
    }),
  ];
}
