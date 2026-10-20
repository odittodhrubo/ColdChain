import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ENVELOPE_VERSION } from '../shared/constants';

// Signed envelope (contract section 4). The body is a JSON string; the HMAC covers that exact string, so it is
// verified before the body is ever parsed.

export interface Envelope {
  v: number;
  device_id: string;
  kind: string;
  ts: number;
  nonce: string;
  body: string;
  sig: string;
}

/** HMAC key = UTF-8 bytes of the secret string as stored (the 64-char hex text, not hex-decoded). */
export function sign(
  secret: string,
  deviceId: string,
  kind: string,
  ts: number,
  nonce: string,
  body: string,
): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${deviceId}|${kind}|${ts}|${nonce}|${body}`, 'utf8')
    .digest('hex');
}

/** Constant-time comparison of two lowercase hex signatures; length is checked first (timingSafeEqual needs it). */
export function sigEqual(expected: string, actual: string): boolean {
  if (typeof actual !== 'string' || !/^[0-9a-f]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export const newNonce = () => randomBytes(8).toString('hex');

/** Server-to-device envelope (ack, cmd): fresh server nonce and current ts. */
export function buildEnvelope(
  secret: string,
  deviceId: string,
  kind: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
): string {
  const nonce = newNonce();
  const env: Envelope = {
    v: ENVELOPE_VERSION,
    device_id: deviceId,
    kind,
    ts,
    nonce,
    body,
    sig: sign(secret, deviceId, kind, ts, nonce, body),
  };
  return JSON.stringify(env);
}

/** Structural check only (types and formats); no secret involved. */
export function isEnvelope(x: unknown): x is Envelope {
  const e = x as Envelope;
  return (
    typeof e === 'object' &&
    e !== null &&
    e.v === ENVELOPE_VERSION &&
    typeof e.device_id === 'string' &&
    typeof e.kind === 'string' &&
    Number.isInteger(e.ts) &&
    typeof e.nonce === 'string' &&
    /^[0-9a-f]{16}$/.test(e.nonce) &&
    typeof e.body === 'string' &&
    typeof e.sig === 'string'
  );
}

/**
 * ROTATE_SECRET (S7): the new secret sealed under the current one, exactly as tools/gen_vectors.js rotateSeal and
 * the firmware's crypto::rotateOpen. pad = HMAC(old, "coldchain-rotate-pad|" + nonce) is used once (fresh nonce),
 * ct = hex(bytes(new) XOR pad), tag = HMAC(old, "coldchain-rotate-tag|" + nonce + "|" + ct). The command itself
 * is also signed with the old secret, like every command.
 */
export function rotateSeal(oldSecret: string, newSecret: string, nonce = randomBytes(16).toString('hex')) {
  const key = Buffer.from(oldSecret, 'utf8');
  const pad = createHmac('sha256', key).update(`coldchain-rotate-pad|${nonce}`, 'utf8').digest();
  const plain = Buffer.from(newSecret, 'hex');
  if (plain.length !== 32) throw new Error('the new secret must be 64 hex characters');
  const ct = Buffer.from(plain.map((b, i) => b ^ pad[i])).toString('hex');
  const tag = createHmac('sha256', key).update(`coldchain-rotate-tag|${nonce}|${ct}`, 'utf8').digest('hex');
  return { nonce, ct, tag };
}
