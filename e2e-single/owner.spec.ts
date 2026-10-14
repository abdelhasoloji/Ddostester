import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, openCard } from '../e2e/helpers.js';

test('single owner persists limits and executes only after explicit confirmation on PostgreSQL', async ({
  page,
}) => {
  await login(page, 'admin');
  await goTo(page, 'Settings');
  const limits = page.locator('.card', { hasText: 'Operational limits' });
  const duration = limits.locator('.field:has(label:has-text("Max duration")) input');
  await duration.fill('800');
  await limits.getByRole('button', { name: 'Save limits' }).click();
  await expect(page.getByText(/Operational limits updated/)).toBeVisible();
  await page.reload();
  await goTo(page, 'Settings');
  await expect(duration).toHaveValue('800');
  const name = await createCampaign(page, { durationSec: 2, maxRps: 2, concurrency: 2 });
  let executions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/campaigns\/[^/]+\/execute$/.test(request.url()))
      executions++;
  });
  const campaign = await openCard(page, name);
  await expect(campaign.getByRole('button', { name: 'Approve / Reject' })).toHaveCount(0);
  await campaign.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm run' });
  await expect(dialog).toBeVisible();
  expect(executions).toBe(0);
  await dialog.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText(/Run complete/)).toBeVisible({ timeout: 25_000 });
  expect(executions).toBe(1);
});
