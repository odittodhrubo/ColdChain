import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../src/db';
import { decryptSecret, encryptSecret } from '../src/shared/secretbox';

const PART_3_6 = [
  'users', 'devices', 'fridges', 'readings', 'events', 'batches', 'batch_assignments', 'alerts', 'nonces',
  'security_events', 'audit_log', 'relocation_plans', 'ml_predictions',
]; // prettier-ignore

describe('migrations', () => {
  it('create every Part 3.6 table plus auth tables, and re-running is a no-op', () => {
    const db = openDb(':memory:');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    expect(tables).toEqual(
      expect.arrayContaining([...PART_3_6, 'revoked_tokens', 'login_attempts', 'schema_migrations']),
    );
    const before = db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get();
    expect(migrate(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM schema_migrations').pluck().get()).toBe(before);
  });

  it('has the required unique keys and indexes, and enforces foreign keys', () => {
    const db = openDb(':memory:');
    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
      sql: string | null;
    }[];
    const names = indexes.map((i) => i.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_readings_fridge_ts',
        'idx_events_fridge_ts',
        'idx_nonces_expires',
        'idx_batch_assignments_batch_to',
      ]),
    );
    const uniques = (table: string) =>
      (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string; unique: number }[])
        .filter((i) => i.unique)
        .map((i) =>
          (db.prepare(`PRAGMA index_info(${i.name})`).all() as { name: string }[])
            .map((c) => c.name)
            .join(','),
        );
    expect(uniques('readings')).toContain('device_id,seq');
    expect(uniques('nonces')).toContain('device_id,nonce');
    expect(uniques('batches')).toContain('public_token');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      db
        .prepare(
          "INSERT INTO devices (device_id, fridge_id, secret_enc, created_at) VALUES ('d', 'no-such-fridge', 'x', 0)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });
});

describe('device secrets at rest', () => {
  const key = 'ab'.repeat(32);
  it('AES-256-GCM round-trips and refuses tampered or wrong-key ciphertext', () => {
    const enc = encryptSecret('s3cret', key);
    expect(enc).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(enc).not.toContain('s3cret');
    expect(encryptSecret('s3cret', key)).not.toBe(enc); // random IV
    expect(decryptSecret(enc, key)).toBe('s3cret');
    const parts = enc.split(':');
    parts[3] = (parts[3][0] === '0' ? '1' : '0') + parts[3].slice(1);
    expect(() => decryptSecret(parts.join(':'), key)).toThrow();
    expect(() => decryptSecret(enc, 'cd'.repeat(32))).toThrow();
  });
});
