import type { AppContext } from '../src/shared/http';

/** Forces the coalesced SECURITY_REJECT windows into the chain and returns their payloads. */
export function flushAuditFor(ctx: AppContext) {
  ctx.audit.flushRejects(Date.now(), true);
  ctx.audit.flush();
  return (
    ctx.db
      .prepare("SELECT payload FROM audit_log WHERE event_type = 'SECURITY_REJECT' ORDER BY id")
      .pluck()
      .all() as string[]
  ).map((p) => JSON.parse(p));
}
