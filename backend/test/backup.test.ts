import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db';
import { backupDb } from '../src/db/backup';
import { verifyChain } from '../src/modules/audit/chain';
import type { AppContext } from '../src/shared/http';
import { makeApp } from './helpers';

describe('backupDb', () => {
  it('writes a consistent copy whose audit chain verifies, and keeps only the newest BACKUP_KEEP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coldchain-backup-'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup: never deleted');
    const t = makeApp({ BACKUP_DIR: dir, BACKUP_KEEP: '2' });
    const ctx = t.app.locals.ctx as AppContext;
    ctx.audit.append('system', 'AUDIT_VERIFY', { n: 1 });
    ctx.audit.append('system', 'AUDIT_VERIFY', { n: 2 }); // queued: the backup must flush it first

    const files: string[] = [];
    for (let i = 0; i < 3; i++) files.push(await backupDb(ctx, new Date(Date.UTC(2026, 9, 18, 12, 0, i))));

    const left = fs.readdirSync(dir).sort();
    expect(left).toEqual([path.basename(files[1]), path.basename(files[2]), 'notes.txt']);
    const copy = openDb(files[2]);
    try {
      expect(copy.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBeGreaterThanOrEqual(2);
      expect((await verifyChain(copy)).valid).toBe(true);
      expect(copy.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(
        t.db.prepare('SELECT COUNT(*) FROM users').pluck().get(),
      );
    } finally {
      copy.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
