import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../shared/http';
import { logger } from '../shared/logger';

const NAME = /^coldchain-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

/**
 * An online backup (SQLite backup API: consistent while the app keeps writing) into BACKUP_DIR, then the
 * oldest copies beyond BACKUP_KEEP are deleted. Only files this function named are ever deleted.
 * Restore: stop the backend, copy a backup over DB_PATH, start it, run Verify Integrity.
 */
export async function backupDb(ctx: AppContext, now = new Date()): Promise<string> {
  const dir = path.resolve(ctx.config.BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `coldchain-${now.toISOString().replace(/[:.]/g, '-')}.db`);
  ctx.audit.flush(); // queued audit entries belong in the copy
  await ctx.db.backup(file);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort(); // ISO timestamps sort chronologically
  for (const old of backups.slice(0, Math.max(0, backups.length - ctx.config.BACKUP_KEEP)))
    fs.rmSync(path.join(dir, old), { force: true });
  logger.info({ file, kept: Math.min(backups.length, ctx.config.BACKUP_KEEP) }, 'database backup written');
  return file;
}
