import { expect, test } from '@playwright/test';
import { E2E_ADMIN } from '../playwright.config';

test('login, then the dashboard shows both fridge cards', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(E2E_ADMIN.email);
  await page.getByLabel('Password', { exact: true }).fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Vaccine Fridge A');
  await expect(cards.nth(1)).toContainText('Vaccine Fridge B');
  await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible();
});
