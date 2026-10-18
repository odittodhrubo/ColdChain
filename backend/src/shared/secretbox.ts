import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Device secrets at rest: AES-256-GCM with APP_SECRET_KEY (64 hex = 32 bytes). Format v1:<iv>:<tag>:<ciphertext>.
// The tag authenticates the ciphertext, so a modified value fails to decrypt instead of yielding a wrong secret.

function key(appSecretKey: string): Buffer {
  const k = Buffer.from(appSecretKey, 'hex');
  if (k.length !== 32) throw new Error('APP_SECRET_KEY must be 32 bytes of hex');
  return k;
}

export function encryptSecret(plain: string, appSecretKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(appSecretKey), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}

export function decryptSecret(stored: string, appSecretKey: string): string {
  const [version, iv, tag, ct] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(appSecretKey), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'hex')), decipher.final()]).toString('utf8');
}
