import { purgeRevoked } from '../auth/tokens';
import { writeAnchor } from '../modules/audit/chain';
import { ML_INTERVAL_MS } from '../ml/engine';
import { refreshAllStatuses } from '../modules/batches/service';
import type { AppContext } from '../shared/http';
import { logger } from '../shared/logger';
import { notifyOps } from '../shared/notify';

export const ANCHOR_EVERY_MS = 60 * 60_000;

/** Records the audit head in audit_anchor and sends it off-box, where a DB attacker cannot rewrite it. */
export async function anchorAudit(ctx: AppContext) {
  ctx.audit.flush();
  const a = writeAnchor(ctx.db);
  await notifyOps(ctx.config, `ColdChain audit anchor: head #${a.head_id} ${a.head_hash} (${a.count} rows)`);
  return a;
}

/** Runs a job and logs a failure instead of letting one bad row take the whole server down. */
export function guarded(name: string, job: () => unknown): () => void {
  return () => {
    try {
      const r = job();
      if (r instanceof Promise)
        r.catch((err: Error) => logger.error({ job: name, err: err.message }, 'job failed'));
    } catch (err) {
      logger.error({ job: name, err: (err as Error).message }, 'job failed');
    }
  };
}

/** Background jobs. Returns a stop function that also flushes pending audit entries. */
export function startJobs(ctx: AppContext): () => void {
  const every = (ms: number, name: string, job: () => unknown) => setInterval(guarded(name, job), ms);
  const timers = [
    every(10 * 60_000, 'purge-revoked', () => purgeRevoked(ctx.db)),
    every(10_000, 'flush-rejects', () => ctx.audit.flushRejects()), // coalesced SECURITY_REJECT, one per minute
    every(ANCHOR_EVERY_MS, 'anchor', () => anchorAudit(ctx)),
    every(1000, 'ingest-tick', () => ctx.ingest.tick()), // seq-gap SYNC_REQUEST, offline watchdog
    every(10_000, 'heat-tick', () => ctx.heat.tick()), // exposure over data holes that were never synced
    every(5000, 'alerts-tick', () => ctx.alerts.tick()), // door escalation, re-notification, flood windows
    every(30_000, 'commands-sweep', () => ctx.commands.sweep()), // commands without cmdack -> TIMEOUT
    every(60_000, 'purge-nonces', () => ctx.ingest.purgeNonces()), // nonces only matter for NONCE_TTL_S
    every(10 * 60_000, 'batch-statuses', () => refreshAllStatuses(ctx)), // expiry -> DISCARD at UTC midnight
    every(ML_INTERVAL_MS, 'ml-tick', () => ctx.ml.tick()), // forecasts, health, alerts, relocation plans
  ];
  guarded('batch-statuses', () => refreshAllStatuses(ctx))();
  void anchorAudit(ctx); // an anchor at every start, so a restart cannot hide a truncation
  return () => {
    timers.forEach(clearInterval);
    ctx.commands.stop();
    ctx.audit.flushRejects(Date.now(), true);
    ctx.audit.flush();
  };
}
