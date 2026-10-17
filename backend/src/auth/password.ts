import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;

const classes = (pw: string) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;

// Length + at least three of: lowercase, uppercase, digit, symbol. bcrypt ignores bytes after 72.
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(72, 'must be at most 72 characters')
  .refine((pw) => classes(pw) >= 3, 'must mix at least three of: lowercase, uppercase, digits, symbols');

export function hashPassword(password: string, cost: number): Promise<string> {
  return bcrypt.hash(password, cost);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

const dummies = new Map<number, string>();

/** A real bcrypt hash of a random value: compared against when the user does not exist, so timing matches. */
export function dummyHash(cost: number): string {
  let h = dummies.get(cost);
  if (!h) {
    h = bcrypt.hashSync(randomBytes(18).toString('base64'), cost);
    dummies.set(cost, h);
  }
  return h;
}
