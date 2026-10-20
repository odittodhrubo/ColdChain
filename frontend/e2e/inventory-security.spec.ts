import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { E2E_ADMIN, E2E_DB, E2E_INSPECTOR, E2E_PHARMACIST } from '../playwright.config';

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

test('pharmacist adds a batch, moves it, opens its QR; the public page says SAFE', async ({ page }) => {
  const lot = `E2E-${Date.now()}`;
  await signIn(page, E2E_PHARMACIST);
  await page.goto('/inventory');
  await page.getByRole('button', { name: 'Add batch' }).click();
  const form = page.getByRole('dialog', { name: 'Add batch' });
  await form.getByLabel('Product name').fill('E2E Polio');
  await form.getByLabel('Manufacturer').fill('Bharat Biotech');
  await form.getByLabel('Lot number').fill(lot);
  await form.getByLabel('Quantity (doses)').fill('25');
  await form.getByLabel('Expiry date').fill('2030-06-30');
  await form.getByLabel('Fridge').selectOption('fridge-01');
  await form.getByRole('button', { name: 'Add batch' }).click();
  await expect(form).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: lot });
  await expect(row).toContainText('Vaccine Fridge A');
  await row.getByRole('button', { name: 'Move E2E Polio' }).click();
  const move = page.getByRole('dialog', { name: 'Move E2E Polio' });
  await move.getByRole('radio', { name: /Vaccine Fridge B/ }).check();
  await move.getByRole('button', { name: 'Move batch' }).click();
  await expect(move).toBeHidden();
  await expect(row).toContainText('Vaccine Fridge B');

  await row.getByRole('button', { name: 'QR label for E2E Polio' }).click();
  const qr = page.getByRole('dialog', { name: 'QR label · E2E Polio' });
  await expect(qr.getByRole('img', { name: /QR code for E2E Polio/ })).toBeVisible();
  const link = await qr.getByText(/\/check\//).textContent();
  const { pathname } = new URL(link!.trim());

  await page.goto(pathname); // the public page, signed in or not, shows only the whitelist
  await expect(page.getByRole('heading', { level: 1, name: 'SAFE' })).toBeVisible();
  await expect(page.getByText(lot)).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
});

test('inspector sees no add or move buttons, and the API refuses the write too', async ({
  page,
  request,
}) => {
  await signIn(page, E2E_INSPECTOR);
  await page.goto('/inventory');
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add batch' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Move / })).toHaveCount(0);

  const login = await request.post('/api/auth/login', {
    data: E2E_INSPECTOR,
    headers: { 'X-Auth-Mode': 'token' },
  });
  const { token } = (await login.json()) as { token: string };
  const res = await request.post('/api/batches', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: 'x',
      manufacturer: 'x',
      lot_number: 'x',
      quantity: 1,
      expiry_date: '2030-01-01',
      fridge_id: 'fridge-01',
    },
  });
  expect(res.status()).toBe(403);
});

test('Verify Integrity is green, then red at the record edited in the database', async ({ page }) => {
  const python = path.resolve('../.venv/Scripts/python.exe');
  const tamper = (...args: string[]) =>
    execFileSync(
      existsSync(python) ? python : 'python',
      ['-m', 'coldchain_tools.tamper', '--db', E2E_DB!, ...args],
      {
        cwd: path.resolve('../tools'),
      },
    );

  await signIn(page, E2E_ADMIN);
  await page.goto('/audit');
  await page.getByRole('button', { name: 'Verify Integrity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Chain intact' })).toBeVisible();

  tamper('--audit-id', '2', '--field', 'payload');
  try {
    await page.getByRole('button', { name: 'Verify Integrity' }).click();
    await expect(page.getByRole('alert')).toContainText('Tampering detected at record #2');
    const broken = page.locator('tr[aria-current="true"]');
    await expect(broken).toHaveCount(1);
    await expect(broken.getByRole('cell').first()).toHaveText('2');
  } finally {
    tamper('--restore');
  }
});
