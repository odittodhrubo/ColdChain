import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// P5: fail an e2e flow on any serious or critical accessibility violation on the page as it stands. Lesser
// issues (minor/moderate) are reported in the message but do not fail, so the gate catches real regressions
// without churning on cosmetic warnings.
export async function expectNoA11yViolations(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const describe = blocking.map((v) => `${v.id} [${v.impact}] ×${v.nodes.length}: ${v.help}`).join('\n');
  expect(blocking, `${where} — accessibility violations:\n${describe}`).toEqual([]);
}
