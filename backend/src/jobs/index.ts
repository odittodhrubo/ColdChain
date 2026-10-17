import { purgeRevoked } from '../auth/tokens';
import { writeAnchor } from '../modules/audit/chain';
import { refreshAllStatuses } from '../modules/batches/service';
import type { AppContext } from '../shared/http';
import { notifyOps } from '../shared/notify';

export const ANCHOR_EVERY_MS = 60 * 60_000;

/** Records the audit head in audit_anchor and sends it off-box, where a DB attacker cannot rewrite it. */
export async function anchorAudit(ctx: AppContext) {
  ctx.audit.flush();
  const a = writeAnchor(ctx.db);
  await notifyOps(ctx.config, `ColdChain audit anchor: head #${a.head_id} ${a.head_hash} (${a.count} rows)`);
  return a;
}

/** Background jobs. Returns a stop function that also flushes pending audit entries. */
export function startJobs(ctx: AppContext): () => void {
  const timers = [
    setInterval(() => purgeRevoked(ctx.db), 10 * 60_000),
    setInterval(() => ctx.audit.flushRejects(), 10_000), // coalesced SECURITY_REJECT windows, one per minute
    setInterval(() => void anchorAudit(ctx), ANCHOR_EVERY_MS),
    setInterval(() => ctx.ingest.tick(), 1000), // seq-gap SYNC_REQUEST, offline watchdog
    setInterval(() => ctx.ingest.purgeNonces(), 60_000), // nonces only matter for NONCE_TTL_S
    setInterval(() => refreshAllStatuses(ctx), 10 * 60_000), // expiry turns batches DISCARD at UTC midnight
  ];
  refreshAllStatuses(ctx);
  void anchorAudit(ctx); // an anchor at every start, so a restart cannot hide a truncation
  return () => {
    timers.forEach(clearInterval);
    ctx.audit.flushRejects(Date.now(), true);
    ctx.audit.flush();
  };
}
