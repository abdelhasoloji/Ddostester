import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, card, SELF } from './helpers.js';

// The core end-to-end journey and its coherence across pages (catalog B/C/D/E/J).

test('full lifecycle: engineer creates → officer approves → engineer runs → shows in Reports', async ({
  browser,
}) => {
  const name = `lifecycle-${Date.now()}`;

  // Author + operator: engineer. Approver: officer. Three distinct duties, and
  // the approver (officer) is NOT the executor (engineer) — SoD extended.
  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  await createCampaign(eng, { name, target: SELF, probe: SELF, maxRps: 5, durationSec: 2 });
  await expect(card(eng, name).getByText('Pending')).toBeVisible();

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

  // The officer may NOT execute what they approved: no Run action for them.
  await expect(card(off, name).getByRole('button', { name: 'Run' })).toHaveCount(0);

  // The engineer (≠ approver) runs it. Refresh to pick up the APPROVED status.
  await eng.reload();
  await goTo(eng, 'Campaigns');
  await card(eng, name).getByRole('button', { name: 'Run' }).click();
  await eng.getByRole('button', { name: 'Launch campaign' }).click();
  await expect(eng.getByText('Completed').first()).toBeVisible({ timeout: 20_000 });

  // Close the detail drawer (auto-opened at run end) before navigating away.
  await eng.getByRole('button', { name: 'Close' }).click();

  // Coherence J1: the completed run now surfaces in Reports.
  await goTo(eng, 'Reports');
  await expect(eng.locator('.report-row', { hasText: name })).toBeVisible();

  await engCtx.close();
  await offCtx.close();
});

test('off-allowlist target is flagged in the wizard before submit (B3)', async ({ page }) => {
  await login(page, 'engineer');
  await goTo(page, 'Campaigns');
  await page.getByRole('button', { name: /New campaign/ }).click();
  // The wizard's Target step validates the host against the allowlist live.
  await page.getByRole('button', { name: /Readiness/ }).click();
  await page
    .locator('.field:has(label:text-is("Target (URL)")) input')
    .fill('http://evil.example.com/');
  await expect(page.getByText(/not in the allowlist/i).first()).toBeVisible();
  // The step cannot advance with a non-allowlisted target.
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
});
