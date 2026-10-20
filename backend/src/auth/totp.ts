// TOTP two-factor sign-in (S3): RFC 6238 over RFC 4226 HOTP, HMAC-SHA1, 30 s steps, 6 digits, the format
// every authenticator app reads. node:crypto only.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1; // accept the previous and the next step too (clock drift, slow typing)

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('not base32');
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP: dynamic truncation of HMAC-SHA1(secret, 8-byte big-endian counter). */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, '0');
}

export const totpStep = (unixS: number) => Math.floor(unixS / TOTP_STEP_S);

/**
 * The step of a code valid now (±TOTP_WINDOW), or null. A step at or below lastStep is refused, so an observed
 * code cannot be replayed even inside its 30 s.
 */
export function verifyTotp(secret: Buffer, code: string, unixS: number, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(unixS);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = now + d;
    if (step <= lastStep) continue;
    const want = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(want, Buffer.from(code))) return step;
  }
  return null;
}

export const newTotpSecret = () => randomBytes(20); // 160 bits, as RFC 4226 recommends

export function otpauthUri(secretB32: string, account: string, issuer = 'ColdChain'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/** Ten one-time recovery codes like "k7q2-9xwm-3fdp" (12 of 31 symbols: about 59 bits each). */
export function newRecoveryCodes(n = 10): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
  return Array.from({ length: n }, () => {
    const chars = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join(''); // unbiased
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}
