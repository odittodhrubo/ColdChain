import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config';

// RFC 6238 TOTP, as an authenticator app computes it from the key the page shows
function totp(keyB32: string, step: number): string {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of keyB32.replace(/\s/g, '')) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 1000 / 30);

test('an Admin-made account: choose your own password, turn on two-factor, sign in with a code', async ({
  page,
  request,
}) => {
  const email = `nurse${Date.now() % 1_000_000}@coldchain.local`;
  const login = await request.post('/api/auth/login', {
    data: E2E_ADMIN,
    headers: { 'X-Auth-Mode': 'token' },
  });
  const { token } = (await login.json()) as { token: string };
  const created = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${token}` },
    data: { email, name: 'Night Nurse', role: 'PHARMACIST', password: 'Temp-Pass-1234' },
  });
  expect(created.status()).toBe(201);

  // first sign-in with a password someone else set: the gate comes first
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Temp-Pass-1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
  await page.getByLabel('Current password').fill('Temp-Pass-1234');
  await page.getByLabel('New password', { exact: true }).fill('Night-Shift-Pass-9');
  await page.getByLabel('Repeat the new password').fill('Night-Shift-Pass-9');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  // the session is an HttpOnly cookie: nothing a script could read holds a token
  expect(await page.evaluate(() => document.cookie)).not.toContain('cc_session');
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toMatch(/eyJ/);

  // two-factor from the Account page
  await page.getByRole('button', { name: /Night Nurse/ }).click();
  await page.getByRole('menuitem', { name: 'Account and security' }).click();
  await page.getByRole('button', { name: 'Set up two-factor sign-in' }).click();
  await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
  const key = (await page.locator('code').first().innerText()).trim();
  const confirmStep = stepNow();
  await page.getByLabel('Code from the authenticator app').fill(totp(key, confirmStep));
  await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
  await expect(page.getByText('Save these recovery codes now.')).toBeVisible();
  await page.getByRole('button', { name: 'I saved them' }).click();
  await expect(page.getByText(/On: signing in needs your password/)).toBeVisible();

  // sign out, then the password alone is not enough
  await page.getByRole('button', { name: /Night Nurse/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Night-Shift-Pass-9');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-factor sign-in' })).toBeVisible();
  // the confirm used its step: the next one is inside the ±1 window and has not been used
  await page.getByLabel('Code').fill(totp(key, Math.max(stepNow(), confirmStep + 1)));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  // back where they were when they signed out
  await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
  await expect(page.getByText(/On: signing in needs your password/)).toBeVisible();
});
