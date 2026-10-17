import type { Config } from '../config';
import { logger } from './logger';

/**
 * Operator notification: Telegram when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set, always the log as well.
 * Never throws: a notification failure must not break the caller.
 */
export async function notifyOps(config: Config, text: string): Promise<boolean> {
  logger.info({ notify: text }, 'ops notification');
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.TELEGRAM_CHAT_ID, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ status: res.status }, 'telegram notification failed');
    return res.ok;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'telegram notification failed');
    return false;
  }
}
