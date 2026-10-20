import { describe, expect, it, vi } from 'vitest';
import { anchorAudit } from '../src/jobs';
import { appendAudit, verifyChain } from '../src/modules/audit/chain';
import { anchorDigest, replyStatus, timestampRequest } from '../src/modules/audit/tsa';
import type { AppContext } from '../src/shared/http';
import { makeApp } from './helpers';

const GRANTED = Buffer.from('3005300302010000', 'hex').subarray(0, 7); // TimeStampResp { { status 0 } }

describe('RFC 3161 audit anchor timestamp (S8)', () => {
  it('builds a DER TimeStampReq: version 1, sha256 imprint, positive nonce, certReq', () => {
    const digest = Buffer.alloc(32, 0xab);
    const req = timestampRequest(digest, Buffer.from('ff00112233445566', 'hex'));
    expect(req.toString('hex')).toBe(
      '3043' + // TimeStampReq, 67 bytes
        '020101' + // version 1
        '3031' +
        '300d06096086480165030402010500' +
        '0420' +
        'ab'.repeat(32) + // messageImprint
        '02087f00112233445566' + // nonce, high bit cleared: positive
        '0101ff', // certReq TRUE
    );
  });

  it('reads the reply status, also with long-form lengths', () => {
    expect(replyStatus(GRANTED)).toBe(0);
    expect(replyStatus(Buffer.from('30053003020102', 'hex'))).toBe(2); // rejection
    const long = Buffer.concat([Buffer.from('30820005', 'hex'), Buffer.from('3003020101', 'hex')]);
    expect(replyStatus(long)).toBe(1); // granted with modifications
    expect(() => replyStatus(Buffer.from('0403616263', 'hex'))).toThrow();
  });

  it('timestamps the anchor when ANCHOR_TSA_URL is set; a failing TSA never fails the anchor', async () => {
    const t = makeApp({ ANCHOR_TSA_URL: 'https://tsa.example/tsr' });
    const ctx = t.app.locals.ctx as AppContext;
    appendAudit(t.db, 'system', 'DEVICE_EVENT', { x: 1 });
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ 'Content-Type': 'application/timestamp-query' });
      expect(
        Buffer.from(init.body as Uint8Array)
          .subarray(0, 2)
          .toString('hex'),
      ).toBe('3043');
      return new Response(new Uint8Array(GRANTED), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const a = await anchorAudit(ctx);
      expect(fetchMock).toHaveBeenCalledOnce();
      const row = t.db
        .prepare('SELECT tsa_url, tsa_reply FROM audit_anchor ORDER BY id DESC LIMIT 1')
        .get() as {
        tsa_url: string;
        tsa_reply: string;
      };
      expect(row.tsa_url).toBe('https://tsa.example/tsr');
      expect(Buffer.from(row.tsa_reply, 'base64').equals(GRANTED)).toBe(true);
      expect(anchorDigest(a)).toHaveLength(32);
      expect((await verifyChain(t.db)).externalAnchor).toMatchObject({
        headId: a.head_id,
        url: 'https://tsa.example/tsr',
      });

      fetchMock.mockImplementationOnce(async () => new Response('busy', { status: 503 }));
      const before = t.db.prepare('SELECT COUNT(*) FROM audit_anchor').pluck().get() as number;
      await anchorAudit(ctx); // resolves: logged, not thrown
      expect(t.db.prepare('SELECT COUNT(*) FROM audit_anchor').pluck().get()).toBe(before + 1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends nothing when no TSA is configured', async () => {
    const t = makeApp();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await anchorAudit(t.app.locals.ctx as AppContext);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
