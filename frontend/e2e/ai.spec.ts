import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { E2E_DB, E2E_PHARMACIST } from '../playwright.config';

// The AI loop end to end: a fridge with a weak compressor (simulator physics, readings written into the e2e DB),
// the real ML service, the backend scheduler (5 s here), the planner, and a pharmacist's one-click confirm.

const root = path.resolve(import.meta.dirname, '../..');
const python =
  [path.join(root, '.venv/Scripts/python.exe'), path.join(root, '.venv/bin/python')].find(existsSync) ??
  'python';
let feeder: ChildProcess | undefined;

test.afterAll(() => feeder?.kill());

test('weak compressor: health drops, a plan appears, the pharmacist confirms, inventory shows the moves', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  feeder = spawn(
    python,
    [path.join(import.meta.dirname, 'feed_readings.py'), '--db', E2E_DB!, '--seconds', '220'],
    {
      stdio: 'inherit',
    },
  );

  const { token } = (await (
    await request.post('/api/auth/login', { data: E2E_PHARMACIST, headers: { 'X-Auth-Mode': 'token' } })
  ).json()) as {
    token: string;
  };
  const names = [`AI-Measles-${Date.now() % 100000}`, `AI-Polio-${Date.now() % 100000}`];
  for (const name of names) {
    const res = await request.post('/api/batches', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name,
        manufacturer: 'SII',
        lot_number: name,
        quantity: 20,
        expiry_date: '2030-01-01',
        criticality: 3,
        fridge_id: 'fridge-01',
      },
    });
    expect(res.status()).toBe(201);
  }

  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_PHARMACIST.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_PHARMACIST.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  // health drops: the fridge page shows a weak score with the service banner
  await page.goto('/fridges/fridge-01');
  const gauge = page.getByRole('img', { name: /^Health \d+ of 100, (Weakening|Failing)$/ });
  await expect(gauge).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('Weakening compressor – service recommended')).toBeVisible();

  // a plan appears on the dashboard, naming the batches and the safe destination
  await page.goto('/');
  const plan = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Move batches out of Vaccine Fridge A' }) });
  await expect(plan).toBeVisible({ timeout: 90_000 });
  for (const name of names)
    await expect(plan.getByRole('row').filter({ hasText: name })).toContainText('Vaccine Fridge B');

  // One click confirms the plan on screen. Here the scheduler re-plans every 5 s: if the plan changed between
  // reading and clicking, the server refuses (409 PLAN_CHANGED), nothing moves, and the UI shows the updated
  // plan and says so. The pharmacist then confirms that one, exactly as a person would.
  const confirmed = page.getByText(/Relocation confirmed: \d+ batch/);
  for (let attempt = 1; ; attempt++) {
    await plan.getByRole('button', { name: 'Confirm relocation' }).click();
    try {
      await expect(confirmed).toBeVisible({ timeout: 10_000 });
      break;
    } catch (err) {
      if (attempt === 3 || !(await page.getByText(/The situation changed, so nothing was moved/).isVisible()))
        throw err;
    }
  }

  await page.goto('/inventory');
  for (const name of names)
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('Vaccine Fridge B');

  const audit = await request.get('/api/audit?type=RELOCATION_CONFIRMED', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(((await audit.json()) as { total: number }).total).toBeGreaterThanOrEqual(1);
});
