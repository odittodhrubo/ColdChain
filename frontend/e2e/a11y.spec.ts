import { expect, test } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config';
import { expectNoA11yViolations } from './a11y';

// P5: sweep the main authenticated pages for serious/critical accessibility violations.
test('no serious accessibility violations on the main pages', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByLabel('Email').fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  const pages: [string, string, RegExp][] = [
    ['/fridges', 'fridges', /Fridges/],
    ['/fridges/fridge-01', 'fridge detail', /Vaccine Fridge A/],
    ['/inventory', 'inventory', /Inventory/],
    ['/alerts', 'alerts', /Alerts/],
    ['/audit', 'audit', /Audit/],
    ['/users', 'users', /Users/],
  ];
  for (const [path, where, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await expectNoA11yViolations(page, where);
  }
});
