import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db';
import { canonicalJson } from '../src/modules/audit/canonical';
import {
  appendAudit,
  appendEntries,
  checkpointReadings,
  GENESIS,
  rowHash,
  verifyChain,
  writeAnchor,
  type AuditRow,
} from '../src/modules/audit/chain';
import { AuditLog, REJECT_WINDOW_MS } from '../src/modules/audit/service';
import { addUser, bearer, makeApp, PASSWORD, tokenFor } from './helpers';

function chain(n = 10): Db {
  const db = openDb(':memory:');
  for (let i = 1; i <= n; i++) appendAudit(db, 'system', 'DEVICE_EVENT', { i, temp: i / 10 }, 1_000 + i);
  return db;
}

/** What an attacker with direct DB access does first: remove the append-only triggers. */
function unlock(db: Db) {
  db.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
}

const row = (db: Db, id: number) => db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id) as AuditRow;

describe('canonical JSON', () => {
  it('is independent of key order, whitespace and number spelling', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ t: 5.0, u: -0, v: 1e21, w: 0.1 + 0.2 })).toBe(
      '{"t":5,"u":0,"v":1e+21,"w":0.30000000000000004}',
    );
    expect(canonicalJson({ s: 'é "q" \n', skip: undefined, arr: [undefined] })).toBe(
      '{"arr":[null],"s":"é \\"q\\" \\n"}',
    );
    expect(canonicalJson(JSON.parse('{"x":5.0,"y":"5"}'))).toBe('{"x":5,"y":"5"}');
    for (const bad of [NaN, Infinity, new Date(), () => 1])
      expect(() => canonicalJson({ bad })).toThrow(TypeError);
  });
});

describe('hash chain', () => {
  it('starts at genesis zeros and links every row to the previous hash', () => {
    const db = chain(5);
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all() as AuditRow[];
    expect(rows[0].prev_hash).toBe(GENESIS);
    rows.forEach((r, i) => {
      if (i > 0) expect(r.prev_hash).toBe(rows[i - 1].hash);
      expect(r.hash).toBe(rowHash(r.prev_hash, r.id, r.ts, r.actor, r.event_type, r.payload));
      expect(r.payload).toBe(canonicalJson(JSON.parse(r.payload)));
    });
  });

  it('verifies a clean log, and an empty one', async () => {
    expect(await verifyChain(chain(10))).toMatchObject({ valid: true, checked: 10, headId: 10 });
    expect(await verifyChain(openDb(':memory:'))).toMatchObject({
      valid: true,
      checked: 0,
      headHash: GENESIS,
    });
  });

  it('triggers block ordinary UPDATE and DELETE', () => {
    const db = chain(3);
    expect(() => db.prepare("UPDATE audit_log SET payload = '{}' WHERE id = 2").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log WHERE id = 3').run()).toThrow(/append-only/);
  });

  const cases: [string, (db: Db) => void, string, number][] = [
    [
      'edited payload',
      (db) => db.prepare(`UPDATE audit_log SET payload = '{"i":5,"temp":0.1}' WHERE id = 5`).run(),
      'HASH_MISMATCH',
      5,
    ],
    [
      'edited hash',
      (db) => db.prepare(`UPDATE audit_log SET hash = '${'a'.repeat(64)}' WHERE id = 5`).run(),
      'HASH_MISMATCH',
      5,
    ],
    [
      'changed timestamp',
      (db) => db.prepare('UPDATE audit_log SET ts = ts + 1 WHERE id = 7').run(),
      'HASH_MISMATCH',
      7,
    ],
    [
      'deleted row in the middle',
      (db) => db.prepare('DELETE FROM audit_log WHERE id = 5').run(),
      'ID_GAP',
      6,
    ],
    ['deleted first row', (db) => db.prepare('DELETE FROM audit_log WHERE id = 1').run(), 'ID_GAP', 2],
    [
      'row inserted in the middle (later rows renumbered, forged row hashed correctly)',
      (db) => {
        db.prepare('UPDATE audit_log SET id = id + 1000 WHERE id >= 5').run();
        db.prepare('UPDATE audit_log SET id = id - 999 WHERE id >= 1000').run();
        const prev = row(db, 4).hash;
        const payload = canonicalJson({ forged: true });
        db.prepare('INSERT INTO audit_log VALUES (5, 1, ?, ?, ?, ?, ?)').run(
          'system', 'DEVICE_EVENT', payload, prev, rowHash(prev, 5, 1, 'system', 'DEVICE_EVENT', payload),
        ); // prettier-ignore
      },
      'PREV_LINK_BROKEN',
      6,
    ],
    [
      'two rows swapped',
      (db) => {
        const [a, b] = [row(db, 3), row(db, 4)];
        const set = db.prepare(
          'UPDATE audit_log SET ts = ?, actor = ?, event_type = ?, payload = ?, prev_hash = ?, hash = ? WHERE id = ?',
        );
        set.run(b.ts, b.actor, b.event_type, b.payload, b.prev_hash, b.hash, 3);
        set.run(a.ts, a.actor, a.event_type, a.payload, a.prev_hash, a.hash, 4);
      },
      'PREV_LINK_BROKEN',
      3,
    ],
    [
      'genesis replaced (hash recomputed to match)',
      (db) => {
        const r = row(db, 1);
        const prev = 'f'.repeat(64);
        db.prepare('UPDATE audit_log SET prev_hash = ?, hash = ? WHERE id = 1').run(
          prev,
          rowHash(prev, 1, r.ts, r.actor, r.event_type, r.payload),
        );
      },
      'GENESIS_INVALID',
      1,
    ],
  ];
  for (const [name, tamper, reason, id] of cases) {
    it(`detects: ${name} -> ${reason} at #${id}`, async () => {
      const db = chain(10);
      unlock(db);
      tamper(db);
      expect(await verifyChain(db)).toMatchObject({ valid: false, reason, firstBrokenId: id });
    });
  }

  it('a deleted tail is invisible to the links but caught by the anchor', async () => {
    const db = chain(10);
    writeAnchor(db);
    appendAudit(db, 'system', 'DEVICE_EVENT', { i: 11 });
    unlock(db);
    db.prepare('DELETE FROM audit_log WHERE id >= 10').run();
    const result = await verifyChain(db);
    expect(result).toMatchObject({
      valid: false,
      reason: 'ANCHOR_MISMATCH',
      firstBrokenId: 10,
      actual: null,
    });
    // without an anchor the remaining chain is still internally consistent: that is why anchors exist
    db.exec('DELETE FROM audit_anchor');
    expect((await verifyChain(db)).valid).toBe(true);
  });

  it('a fully recomputed chain is caught by an earlier anchor', async () => {
    const db = chain(5);
    writeAnchor(db);
    unlock(db);
    db.exec('DELETE FROM audit_log');
    for (let i = 1; i <= 5; i++) appendAudit(db, 'system', 'DEVICE_EVENT', { i, temp: 0 }, 1_000 + i); // rewritten history
    expect(await verifyChain(db)).toMatchObject({
      valid: false,
      reason: 'ANCHOR_MISMATCH',
      firstBrokenId: 5,
    });
  });

  it('partial verification from an id', async () => {
    const db = chain(20);
    expect(await verifyChain(db, { fromId: 11 })).toMatchObject({ valid: true, checked: 10, headId: 20 });
    unlock(db);
    db.prepare("UPDATE audit_log SET actor = 'x' WHERE id = 15").run();
    expect(await verifyChain(db, { fromId: 11 })).toMatchObject({ valid: false, firstBrokenId: 15 });
  });

  it('keeps a single valid chain under 100 parallel appends, also across two connections', async () => {
    const audit = new AuditLog(openDb(':memory:'));
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Promise.resolve().then(() =>
          i % 2
            ? audit.append('system', 'DEVICE_EVENT', { i })
            : audit.enqueue('system', 'DEVICE_EVENT', { i }),
        ),
      ),
    );
    audit.flush();
    const db = (audit as unknown as { db: Db }).db;
    expect(await verifyChain(db)).toMatchObject({ valid: true, checked: 100 });

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'a.db');
    const a = openDb(file);
    const b = new Database(file);
    b.pragma('busy_timeout = 5000');
    for (let i = 0; i < 100; i++) appendAudit(i % 2 ? a : b, i % 2 ? 'a' : 'b', 'DEVICE_EVENT', { i });
    expect(await verifyChain(a)).toMatchObject({ valid: true, checked: 100 });
    a.close();
    b.close();
  });

  it('verifies 100k rows in under 3 s without blocking the event loop', async () => {
    const db = openDb(':memory:');
    appendEntries(
      db,
      Array.from({ length: 100_000 }, (_, i) => ({
        actor: 'system',
        type: 'DEVICE_EVENT' as const,
        payload: { i, t: i % 97 },
        ts: i,
      })),
    );
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 0);
    const started = performance.now();
    const result = await verifyChain(db);
    const ms = performance.now() - started;
    clearInterval(timer);
    expect(result).toMatchObject({ valid: true, checked: 100_000 });
    expect(ms).toBeLessThan(3000);
    expect(ticks).toBeGreaterThan(5); // other work ran between chunks
  }, 30_000);
});

describe('telemetry checkpoints', () => {
  function withReadings(n: number) {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO fridges (id, name, capacity, created_at) VALUES ('fridge-01', 'A', 20, 0)").run();
    db.prepare(
      "INSERT INTO devices (device_id, fridge_id, secret_enc, created_at) VALUES ('fridge-01', 'fridge-01', 'x', 0)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO readings (device_id, fridge_id, seq, ts, temp, door, comp, power, batt, state, exp_s, latch, mode, reason, received_at)
       VALUES ('fridge-01', 'fridge-01', ?, ?, ?, 0, 1, 'MAINS', 100, 'SAFE', 0, 0, 'model', 'periodic', 0)`,
    );
    const add = (from: number, count: number) => {
      for (let s = from; s < from + count; s++) insert.run(s, 1_767_225_600 + s * 5, 4 + (s % 30) / 10);
    };
    add(1, n);
    return { db, add };
  }

  it('writes one checkpoint per 100 readings and verifies them against the readings table', async () => {
    const { db, add } = withReadings(250);
    expect(checkpointReadings(db, 'fridge-01')).toBe(2);
    expect(checkpointReadings(db, 'fridge-01')).toBe(0); // the 50 left over wait for a full block
    const cp = JSON.parse(row(db, 1).payload);
    expect(cp).toMatchObject({
      fridge_id: 'fridge-01',
      from_id: 1,
      to_id: 100,
      from_seq: 1,
      to_seq: 100,
      count: 100,
    });
    add(1000, 60); // late synced rows get new ids: they never land inside a checkpointed range
    expect(checkpointReadings(db, 'fridge-01')).toBe(1);
    expect(await verifyChain(db)).toMatchObject({ valid: true, checkpoints: 3 });
  });

  it('an edited or deleted stored reading breaks verification', async () => {
    const { db } = withReadings(200);
    checkpointReadings(db, 'fridge-01');
    db.prepare('UPDATE readings SET temp = 9.9 WHERE seq = 150').run();
    expect(await verifyChain(db)).toMatchObject({
      valid: false,
      reason: 'READINGS_TAMPERED',
      firstBrokenId: 2,
    });
    const { db: db2 } = withReadings(200);
    checkpointReadings(db2, 'fridge-01');
    db2.prepare('DELETE FROM readings WHERE seq = 42').run();
    expect(await verifyChain(db2)).toMatchObject({
      valid: false,
      reason: 'READINGS_TAMPERED',
      firstBrokenId: 1,
    });
  });
});

describe('audit service', () => {
  it('coalesces security rejects to one entry per device + reason per minute, with a count', () => {
    const db = openDb(':memory:');
    const audit = new AuditLog(db);
    const t0 = 1_000_000;
    for (let i = 0; i < 250; i++) audit.securityReject('fridge-01', 'BAD_SIG', undefined, t0 + i * 20); // 50/s for 5 s
    audit.securityReject('fridge-01', 'REPLAY', undefined, t0);
    audit.securityReject('fridge-01', 'BAD_SIG', undefined, t0 + REJECT_WINDOW_MS + 1); // next window
    audit.flushRejects(t0 + 3 * REJECT_WINDOW_MS, true);
    audit.flush();
    const rows = db
      .prepare("SELECT payload FROM audit_log WHERE event_type = 'SECURITY_REJECT' ORDER BY id")
      .pluck()
      .all() as string[];
    expect(rows.map((p) => JSON.parse(p)).map((p) => [p.reason, p.count])).toEqual([
      ['BAD_SIG', 250],
      ['REPLAY', 1],
      ['BAD_SIG', 1],
    ]);
  });

  it('the async queue is bounded', () => {
    const audit = new AuditLog(openDb(':memory:'), 10);
    for (let i = 0; i < 15; i++) audit.enqueue('system', 'DEVICE_EVENT', { i });
    expect(audit.dropped).toBe(5);
    expect(audit.flush()).toBe(10);
  });
});

describe('audit API', () => {
  it('logs logins, failures and user changes; reads paginated, newest first, with hashes', async () => {
    const t = makeApp();
    const admin = await addUser(t, 'ADMIN');
    await t.http().post('/api/auth/login').send({ email: admin.email, password: PASSWORD });
    await t.http().post('/api/auth/login').send({ email: admin.email, password: 'wrong-wrong-1' });
    const auth = bearer(tokenFor(t, admin));
    await t
      .http()
      .post('/api/users')
      .set(auth)
      .send({ email: 'n@test.local', name: 'N', role: 'INSPECTOR', password: 'Strong-Pass-42' });

    const all = await t.http().get('/api/audit').set(auth);
    expect(all.status).toBe(200);
    expect(all.body.entries.map((e: AuditRow) => e.event_type)).toEqual([
      'USER_CREATED',
      'AUTH_FAIL',
      'AUTH_LOGIN',
    ]);
    expect(all.body.entries[0]).toMatchObject({
      actor: `user:${admin.id}`,
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      prev_hash: expect.any(String),
    });
    expect(JSON.stringify(all.body)).not.toContain(PASSWORD);
    const page = await t.http().get('/api/audit?type=AUTH_FAIL&page=1&pageSize=1').set(auth);
    expect(page.body).toMatchObject({ total: 1, page: 1, pageSize: 1 });
    expect(page.body.entries[0].payload).toMatchObject({ email: admin.email, reason: 'BAD_CREDENTIALS' });

    // actor filter is a case-insensitive substring: a partial or differently-cased actor still matches
    const exact = (await t.http().get(`/api/audit?actor=user:${admin.id}`).set(auth)).body.total;
    expect(exact).toBeGreaterThan(0);
    expect((await t.http().get(`/api/audit?actor=USER:${admin.id}`).set(auth)).body.total).toBe(exact);
    expect((await t.http().get('/api/audit?actor=user').set(auth)).body.total).toBe(exact);
    expect((await t.http().get('/api/audit?actor=nobody').set(auth)).body.total).toBe(0);
  });

  it('verify returns valid for a clean log, logs itself without breaking the next check, and detects tampering', async () => {
    const t = makeApp();
    const auth = bearer(tokenFor(t, await addUser(t, 'INSPECTOR')));
    appendAudit(t.db, 'system', 'DEVICE_EVENT', { x: 1 });
    const first = await t.http().get('/api/audit/verify').set(auth);
    expect(first.body).toMatchObject({ valid: true, checked: 1 });
    const second = await t.http().get('/api/audit/verify').set(auth);
    expect(second.body).toMatchObject({ valid: true, checked: 2 }); // includes the first AUDIT_VERIFY row
    unlock(t.db);
    t.db.prepare(`UPDATE audit_log SET payload = '{"x":2}' WHERE id = 1`).run();
    expect((await t.http().get('/api/audit/verify').set(auth)).body).toMatchObject({
      valid: false,
      reason: 'HASH_MISMATCH',
      firstBrokenId: 1,
    });
  });

  it('lists a row whose payload is no longer JSON (edited outside the app) as raw text, never a 500', async () => {
    const t = makeApp();
    const auth = bearer(tokenFor(t, await addUser(t, 'INSPECTOR')));
    appendAudit(t.db, 'system', 'DEVICE_EVENT', { x: 1 });
    unlock(t.db);
    t.db.prepare(`UPDATE audit_log SET payload = '{"x":1} [tampered]' WHERE id = 1`).run(); // as tamper.py does
    const res = await t.http().get('/api/audit').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.entries.at(-1)).toMatchObject({
      id: 1,
      payload: '{"x":1} [tampered]',
      payload_invalid: true,
    });
    const byBatch = await t.http().get('/api/audit?batch_id=3').set(auth); // json_extract must not raise
    expect(byBatch.status).toBe(200);
    expect((await t.http().get('/api/audit/verify').set(auth)).body).toMatchObject({
      valid: false,
      firstBrokenId: 1,
    });
  });

  it('streams progress as NDJSON', async () => {
    const t = makeApp();
    appendEntries(
      t.db,
      Array.from({ length: 12_000 }, (_, i) => ({
        actor: 'system',
        type: 'DEVICE_EVENT' as const,
        payload: { i },
      })),
    );
    const res = await t
      .http()
      .get('/api/audit/verify?stream=1')
      .set(bearer(tokenFor(t, await addUser(t, 'PHARMACIST'))));
    const lines = res.text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(res.headers['content-type']).toMatch(/ndjson/);
    expect(lines.filter((l) => l.progress).length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1).result).toMatchObject({ valid: true, checked: 12_000 });
  });
});
