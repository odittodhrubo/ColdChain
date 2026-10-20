// RFC 3161 timestamp of the audit anchor (S8). Off unless ANCHOR_TSA_URL is set (e.g. https://freetsa.org/tsr).
// Only a SHA-256 of the anchor goes out, never audit content. Small DER by hand: the request has a fixed shape,
// and of the reply only the status is read here (the stored reply is verified with openssl, see docs/SECURITY.md).
import { createHash, randomBytes } from 'node:crypto';

const SHA256_ALG = Buffer.from('300d06096086480165030402010500', 'hex'); // AlgorithmIdentifier sha256, NULL params

const der = (tag: number, body: Buffer) => {
  if (body.length >= 128) throw new Error('DER: long form not needed here');
  return Buffer.concat([Buffer.from([tag, body.length]), body]);
};

/** What is timestamped: SHA-256 over "coldchain-anchor|<head_id>|<head_hash>|<count>". */
export const anchorDigest = (a: { head_id: number; head_hash: string; count: number }) =>
  createHash('sha256').update(`coldchain-anchor|${a.head_id}|${a.head_hash}|${a.count}`).digest();

/** TimeStampReq { version 1, messageImprint { sha256, digest }, nonce, certReq TRUE } in DER. */
export function timestampRequest(digest: Buffer, nonce = randomBytes(8)): Buffer {
  if (digest.length !== 32) throw new Error('SHA-256 digest expected');
  const n = Buffer.from(nonce);
  n[0] &= 0x7f; // a positive INTEGER
  const imprint = der(0x30, Buffer.concat([SHA256_ALG, der(0x04, digest)]));
  return der(
    0x30,
    Buffer.concat([der(0x02, Buffer.from([1])), imprint, der(0x02, n), der(0x01, Buffer.from([0xff]))]),
  );
}

/** One DER TLV at offset: [tag, value start, value end]. Long-form lengths supported (replies are large). */
function tlv(buf: Buffer, at: number): [number, number, number] {
  const tag = buf[at];
  let len = buf[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const bytes = len & 0x7f;
    if (bytes < 1 || bytes > 4) throw new Error('DER: bad length');
    len = 0;
    for (let i = 0; i < bytes; i++) len = len * 256 + buf[at + 2 + i];
    start += bytes;
  }
  if (start + len > buf.length) throw new Error('DER: truncated');
  return [tag, start, start + len];
}

/** PKIStatus of a TimeStampResp: 0 granted, 1 granted with modifications, 2+ refused. */
export function replyStatus(reply: Buffer): number {
  const [t0, s0] = tlv(reply, 0); // TimeStampResp SEQUENCE
  const [t1, s1] = tlv(reply, s0); // PKIStatusInfo SEQUENCE
  const [t2, s2, e2] = tlv(reply, s1); // status INTEGER
  if (t0 !== 0x30 || t1 !== 0x30 || t2 !== 0x02) throw new Error('not a TimeStampResp');
  return reply.subarray(s2, e2).reduce((v, b) => v * 256 + b, 0);
}

/** POSTs the request; the DER reply when granted, else throws. 10 s budget: never holds up the backend. */
export async function requestTimestamp(url: string, digest: Buffer): Promise<Buffer> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: new Uint8Array(timestampRequest(digest)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`TSA answered HTTP ${res.status}`);
  const reply = Buffer.from(await res.arrayBuffer());
  const status = replyStatus(reply);
  if (status > 1) throw new Error(`TSA refused the request (status ${status})`);
  return reply;
}
