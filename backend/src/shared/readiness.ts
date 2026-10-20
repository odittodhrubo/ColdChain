import type { AppContext } from './http';

export interface Readiness {
  ready: boolean;
  status: 'ok' | 'degraded' | 'down';
  checks: {
    db: 'ok' | 'fail';
    mqtt: 'connected' | 'disconnected' | 'not started';
    ingest: { last_message_age_s: number | null };
    ml: { state: 'model' | 'fallback' | 'idle'; last_model_age_s: number | null };
  };
}

/**
 * /api/ready. Ready (200) needs a working database and, once the broker client runs, a broker connection:
 * without either the backend cannot do its job. Silent fridges and the ML service only make it "degraded"
 * (alerts and the rule-based fallback cover them), so a supervisor never restarts a healthy backend because
 * a node is offline. No secrets, nothing per fridge: the route is public.
 */
export function readiness(ctx: AppContext, nowMs = Date.now()): Readiness {
  let db: 'ok' | 'fail' = 'ok';
  try {
    ctx.db.prepare('SELECT 1').get();
  } catch {
    db = 'fail';
  }
  const mqtt = !ctx.mqttConnected ? 'not started' : ctx.mqttConnected() ? 'connected' : 'disconnected';

  const lastSeen = Math.max(0, ...ctx.ingest.snapshot(nowMs).devices.map((d) => d.last_seen ?? 0));
  const age = (ms: number) => (ms > 0 ? Math.round((nowMs - ms) / 1000) : null);
  const { lastModelAt, lastFallbackAt } = ctx.ml;
  const ml =
    lastFallbackAt > lastModelAt
      ? 'fallback'
      : nowMs - lastModelAt <= 3 * ctx.config.ML_INTERVAL_MS
        ? 'model'
        : 'idle';

  const ready = db === 'ok' && mqtt !== 'disconnected';
  const silent = lastSeen > 0 && nowMs - lastSeen > 60_000;
  return {
    ready,
    status: !ready ? 'down' : ml === 'fallback' || silent ? 'degraded' : 'ok',
    checks: {
      db,
      mqtt,
      ingest: { last_message_age_s: age(lastSeen) },
      ml: { state: ml, last_model_age_s: age(lastModelAt) },
    },
  };
}
