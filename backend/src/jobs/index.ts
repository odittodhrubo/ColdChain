import { purgeRevoked } from '../auth/tokens';
import { backupDb } from '../db/backup';
import { writeAnchor } from '../modules/audit/chain';
import { anchorDigest, requestTimestamp } from '../modules/audit/tsa';
import { refreshAllStatuses } from '../modules/batches/service';
import { retireReadings, rollupReadings } from '../modules/fridges/retention';
import { DailySummary } from '../modules/fridges/summary';
import { scoringTick } from '../ml/scoring';
import type { AppContext } from '../shared/http';
import { logger } from '../shared/logger';
import { notifyOps } from '../shared/notify';

export const ANCHOR_EVERY_MS = 60 * 60_000;

/** Records the audit head in audit_anchor and sends it off-box, where a DB attacker cannot rewrite it. */
export async function anchorAudit(ctx: AppContext) {
  ctx.audit.flush();
  const a = writeAnchor(ctx.db);
  const id = ctx.db.prepare('SELECT MAX(id) FROM audit_anchor').pluck().get() as number;
  await notifyOps(ctx.config, `ColdChain audit anchor: head #${a.head_id} ${a.head_hash} (${a.count} rows)`);
  const url = ctx.config.ANCHOR_TSA_URL;
  if (url) {
    // S8: a third party's signed clock on the anchor; a failure only means this anchor has no external timestamp
    try {
      const reply = await requestTimestamp(url, anchorDigest(a));
      ctx.db
        .prepare('UPDATE audit_anchor SET tsa_url = ?, tsa_reply = ?, tsa_at = ? WHERE id = ?')
        .run(url, reply.toString('base64'), Date.now(), id);
    } catch (err) {
      logger.warn({ err: (err as Error).message, url }, 'audit anchor not timestamped externally');
    }
  }
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
  const summary = new DailySummary(ctx);
  const timers = [
    every(5 * 60_000, 'daily-summary', () => summary.tick()), // P2: twice-daily temperature summary
    every(10 * 60_000, 'purge-revoked', () => purgeRevoked(ctx.db)),
    every(10_000, 'flush-rejects', () => ctx.audit.flushRejects()), // coalesced SECURITY_REJECT, one per minute
    every(ANCHOR_EVERY_MS, 'anchor', () => anchorAudit(ctx)),
    every(1000, 'ingest-tick', () => ctx.ingest.tick()), // seq-gap SYNC_REQUEST, offline watchdog
    every(10_000, 'heat-tick', () => ctx.heat.tick()), // exposure over data holes that were never synced
    every(5000, 'alerts-tick', () => ctx.alerts.tick()), // door escalation, re-notification, flood windows
    every(30_000, 'commands-sweep', () => ctx.commands.sweep()), // commands without cmdack -> TIMEOUT
    every(60_000, 'purge-nonces', () => ctx.ingest.purgeNonces()), // nonces only matter for NONCE_TTL_S
    every(10 * 60_000, 'batch-statuses', () => refreshAllStatuses(ctx)), // expiry -> DISCARD at UTC midnight
    every(ctx.config.ML_INTERVAL_MS, 'ml-tick', () => {
      const end = ctx.metrics.mlTick.startTimer();
      return ctx.ml.tick().finally(end);
    }), // forecasts, health, alerts, relocation plans
    every(ctx.config.BACKUP_EVERY_MS, 'backup', () => backupDb(ctx)), // online SQLite copy, newest BACKUP_KEEP kept
    every(10 * 60_000, 'readings-rollup', () => rollupReadings(ctx)), // finished hours -> readings_hourly
    every(60 * 60_000, 'readings-retention', () => retireReadings(ctx)), // old rolled-up blocks, audited
    every(5 * 60_000, 'forecast-scoring', () => scoringTick(ctx)), // A1: score 30-min forecasts, drift signal
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
