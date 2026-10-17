import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

// Numbered SQL files, applied in order at start and tracked in schema_migrations. Re-running is a no-op.
export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all() as number[]);
  const applied: string[] = [];
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()) {
    const version = Number.parseInt(file, 10);
    if (done.has(version)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        version,
        file,
        Date.now(),
      );
    })();
    applied.push(file);
  }
  return applied;
}
