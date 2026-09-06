import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, card, SELF } from './helpers.js';

// The core end-to-end journey and its coherence across pages (catalog B/C/D/E/J).

test('full lifecycle: engineer creates → officer approves → run completes → shows in Reports', async ({
  browser,
}) => {
  const name = `lifecycle-${Date.now()}`;

  // Author: engineer (separation of duties needs a different approver).
  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  await createCampaign(eng, { name, target: SELF, probe: SELF, maxRps: 5, durationSec: 2 });
  await expect(card(eng, name).getByText('Pending')).toBeVisible();

  // Approver + operator: officer (≠ author, so SoD is satisfied).
  const offCtx = await browser.newContext();
  const off = await offCtx.newPage();
  await login(off, 'officer');
  await goTo(off, 'Campaigns');
  await expect(card(off, name)).toBeVisible();

  // Approve (author is the engineer → allowed).
  await card(off, name).getByRole('button', { name: 'Approve / Reject' }).click();
  const approve = off.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(card(off, name).getByText('Approved')).toBeVisible();

  // Run it (bounded), confirm the modal, wait for completion. Finishing a run
  // auto-opens the detail drawer with the result.
  await card(off, name).getByRole('button', { name: 'Run' }).click();
  await off.getByRole('button', { name: 'Launch campaign' }).click();
  await expect(off.getByText('Completed').first()).toBeVisible({ timeout: 20_000 });

  // Close the detail drawer before navigating away.
  await off.getByRole('button', { name: 'Close' }).click();

  // Coherence J1: the completed run now surfaces in Reports.
  await goTo(off, 'Reports');
  await expect(off.locator('.report-row', { hasText: name })).toBeVisible();

  await engCtx.close();
  await offCtx.close();
});

test('off-allowlist target is flagged in the form before submit (B3)', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();
  await page
    .locator('.field:has(label:text-is("Target (URL)")) input')
    .fill('http://evil.example.com/');
  await expect(page.getByText(/not in allowlist/i).first()).toBeVisible();
});
