import webpush from 'web-push';
import type { AppContext } from '../../shared/http';
import { logger } from '../../shared/logger';
import type { AlertMessage } from '../alerts/notifier';

// P7: Web Push for BREACH and DOOR alerts, so a pharmacist hears about a breach with the tab closed. Off unless
// both VAPID keys are configured. The browser's own push keys (p256dh, auth) are stored; none of our secrets.

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

type Send = (sub: webpush.PushSubscription, payload: string) => Promise<unknown>;
interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export class PushSender {
  private readonly configured: boolean;
  private readonly send: Send;

  constructor(
    private readonly ctx: AppContext,
    send?: Send,
  ) {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = ctx.config;
    this.configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
    if (this.configured && !send)
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
    this.send = send ?? ((sub, payload) => webpush.sendNotification(sub, payload));
  }

  get publicKey(): string | null {
    return this.ctx.config.VAPID_PUBLIC_KEY ?? null;
  }

  enabled(): boolean {
    return this.configured;
  }

  subscribe(userId: number, sub: PushSubscriptionInput): void {
    this.ctx.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      )
      .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, Date.now());
  }

  unsubscribe(endpoint: string): void {
    this.ctx.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  /** Push to every subscription; prunes the ones the push service says are gone (404/410). Never throws. */
  async notify(m: AlertMessage): Promise<void> {
    if (!this.configured) return;
    const rows = this.ctx.db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions')
      .all() as SubRow[];
    if (rows.length === 0) return;
    const payload = JSON.stringify({ title: m.title, body: m.lines.join('\n'), url: m.link ?? '/' });
    await Promise.all(
      rows.map(async (r) => {
        try {
          await this.send({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload);
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) this.unsubscribe(r.endpoint); // gone: forget it
          else logger.warn({ err: (err as Error).message, code }, 'web push failed');
        }
      }),
    );
  }
}
