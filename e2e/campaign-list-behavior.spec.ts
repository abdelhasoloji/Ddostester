import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard, SELF } from './helpers.js';

// BEHAVIOURAL coverage of the campaign list — it asserts the controls actually DO
// their job (the list changes), not merely that they're clickable. This is the
// class of test that catches "the filter/sort doesn't work" regressions.

test('status filter actually filters the list (pending / rejected / done are separated)', async ({
  browser,
}) => {
  test.slow(); // includes a real run for the "done" state
  const ts = Date.now();
  const pend = `pend-${ts}`;
  const rej = `rej-${ts}`;
  const done = `done-${ts}`;

  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');

  // pending (default), rejected, and done (approve + run).
  await createCampaign(eng, { name: pend, target: SELF, probe: SELF });
  await createCampaign(eng, { name: rej, target: SELF, probe: SELF });
  await createCampaign(eng, { name: done, target: SELF, probe: SELF, maxRps: 5, durationSec: 2 });

  await goTo(ciso, 'Campaigns');
  await ciso.reload();
  await (await openCard(ciso, rej)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('textbox').last().fill('e2e reject');
  await ciso.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(card(ciso, rej).getByText('Rejected')).toBeVisible();

  await (await openCard(ciso, done)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ciso, done).getByText('Approved')).toBeVisible();
  await eng.reload();
  await goTo(eng, 'Campaigns');
  await (await openCard(eng, done)).getByRole('button', { name: 'Run', exact: true }).click();
  await eng.getByRole('button', { name: 'Run now' }).click();
  // Launching lands on Run Theater; wait for completion, then return to Campaigns
  // where the status filters live.
  await expect(eng).toHaveURL(/\/theater/);
  await expect(eng.getByText(/Run COMPLETED/i)).toBeVisible({ timeout: 20_000 });
  await goTo(eng, 'Campaigns');

  const clickFilter = async (label: string) =>
    eng
      .getByRole('button', { name: new RegExp(`^${label}\\b`) })
      .first()
      .click();

  // Pending → only the pending one of ours is visible; the others are filtered out.
  await clickFilter('Pending');
  await expect(card(eng, pend)).toBeVisible();
  await expect(card(eng, rej)).toHaveCount(0);
  await expect(card(eng, done)).toHaveCount(0);

  // Rejected → only the rejected one.
  await clickFilter('Rejected');
  await expect(card(eng, rej)).toBeVisible();
  await expect(card(eng, pend)).toHaveCount(0);
  await expect(card(eng, done)).toHaveCount(0);

  // Done → only the completed one.
  await clickFilter('Done');
  await expect(card(eng, done)).toBeVisible();
  await expect(card(eng, pend)).toHaveCount(0);
  await expect(card(eng, rej)).toHaveCount(0);

  // All → all three back.
  await clickFilter('All');
  await expect(card(eng, pend)).toBeVisible();
  await expect(card(eng, rej)).toBeVisible();
  await expect(card(eng, done)).toBeVisible();

  await engCtx.close();
  await cisoCtx.close();
});

test('search actually filters by name', async ({ page }) => {
  const ts = Date.now();
  const mine = `srch-${ts}`;
  const other = `zzz-other-${ts}`;
  await login(page, 'engineer');
  await createCampaign(page, { name: mine, target: SELF, probe: SELF });
  await createCampaign(page, { name: other, target: SELF, probe: SELF });
  await goTo(page, 'Campaigns');

  const search = page.getByPlaceholder(/Search name/i);
  await search.fill(mine);
  await expect(card(page, mine)).toBeVisible();
  await expect(card(page, other)).toHaveCount(0);
  await search.fill('');
  await expect(card(page, other)).toBeVisible();
});

test('sort actually reorders the list (Name A–Z vs Most recent flips the order)', async ({
  page,
}) => {
  // The sort selection must actually reorder the cards, not just be clickable.
  // (The suite-group ordering that this control feeds is unit-tested in
  // campaigns-grouping.test.ts › sortSuiteGroups; here we assert the control's
  // end-to-end effect on the rendered list.)
  const ts = Date.now();
  const aaa = `aaa-sort-${ts}`;
  const zzz = `zzz-sort-${ts}`;
  await login(page, 'engineer');
  await createCampaign(page, { name: aaa, target: SELF, probe: SELF }); // created first
  await createCampaign(page, { name: zzz, target: SELF, probe: SELF }); // created second (newer)
  await goTo(page, 'Campaigns');

  const yOf = async (name: string): Promise<number> => {
    const box = await card(page, name).boundingBox();
    return box ? box.y : Number.NaN;
  };

  // Default sort is Created (newest first) → the newer campaign (zzz) is above aaa.
  await expect(card(page, zzz)).toBeVisible();
  expect(await yOf(zzz)).toBeLessThan(await yOf(aaa));

  // Clicking the "Name" column header sorts A→Z → aaa must now be above zzz — the
  // rendered order actually flips, not just a clickable header.
  await page.getByRole('button', { name: /Name/ }).click();
  expect(await yOf(aaa)).toBeLessThan(await yOf(zzz));

  // Clicking "Name" again toggles to Z→A → the order flips back.
  await page.getByRole('button', { name: /Name/ }).click();
  expect(await yOf(zzz)).toBeLessThan(await yOf(aaa));
});
