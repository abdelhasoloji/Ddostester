import { test, expect, type Page } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard, SELF } from './helpers.js';

// Pushed, BEHAVIOURAL coverage of the Campaigns screen — it drives every list
// control (status chips + their counts, search, the sortable table headers, row
// expand/collapse, the archived toggle, the empty state) and asserts the rendered
// list actually changes, IN COMBINATION, never just that a control is clickable.
// This is the exhaustive companion to campaign-list-behavior.spec.ts.

/** Y-position of a campaign's row (for order assertions). */
async function yOf(page: Page, name: string): Promise<number> {
  const box = await card(page, name).boundingBox();
  return box ? box.y : Number.NaN;
}

/** The count badge on a status chip (e.g. Pending → "2"). */
function chipCount(page: Page, label: string) {
  return page
    .locator('button.chip', { hasText: new RegExp(`^${label}\\b`) })
    .locator('.chip-count');
}

async function clickFilter(page: Page, label: string) {
  await page
    .getByRole('button', { name: new RegExp(`^${label}\\b`) })
    .first()
    .click();
}

const header = (page: Page, name: RegExp) => page.getByRole('columnheader', { name });
const sortBy = (page: Page, name: RegExp) => header(page, name).getByRole('button', { name });

test('Campaigns screen: filters, search, column sort, expand and archive — all in combination', async ({
  browser,
}) => {
  test.slow(); // seeds several states incl. one real run for a "done" campaign

  const ts = Date.now();
  const alpha = `alpha-${ts}`; // pending (older)
  const beta = `beta-${ts}`; // pending (newer)
  const appr = `appr-${ts}`; // approved
  const rej = `rej-${ts}`; // rejected
  const done = `zdone-${ts}`; // completed (only one with a WRS)

  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');

  // Seed the five states (order matters for the "created" sort: alpha first, done last).
  await createCampaign(eng, { name: alpha, target: SELF, probe: SELF });
  await createCampaign(eng, { name: beta, target: SELF, probe: SELF });
  await createCampaign(eng, { name: appr, target: SELF, probe: SELF });
  await createCampaign(eng, { name: rej, target: SELF, probe: SELF });
  await createCampaign(eng, { name: done, target: SELF, probe: SELF, maxRps: 5, durationSec: 2 });

  await goTo(ciso, 'Campaigns');
  await ciso.reload();
  // Reject one.
  await (await openCard(ciso, rej)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('textbox').last().fill('e2e reject');
  await ciso.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(card(ciso, rej).getByText('Rejected')).toBeVisible();
  // Approve two (appr stays approved, done gets run).
  await (await openCard(ciso, appr)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ciso, appr).getByText('Approved')).toBeVisible();
  await (await openCard(ciso, done)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ciso, done).getByText('Approved')).toBeVisible();

  // Run "done" to completion.
  await eng.reload();
  await goTo(eng, 'Campaigns');
  await (await openCard(eng, done)).getByRole('button', { name: 'Run', exact: true }).click();
  await eng.getByRole('button', { name: 'Launch campaign' }).click();
  // Launching lands on Run Theater; wait for completion, then return to Campaigns
  // where the status chips/filters live.
  await expect(eng).toHaveURL(/\/theater/);
  await expect(eng.getByText(/Run COMPLETED/i)).toBeVisible({ timeout: 20_000 });
  await goTo(eng, 'Campaigns');

  const page = eng;

  // ── 1. Status chips isolate each state AND their count badges are right ──────
  await clickFilter(page, 'Pending');
  // The chip badge counts pending campaigns; in a shared store other specs may add
  // some, so assert it counts at least our two (never a fixed absolute).
  expect(Number(await chipCount(page, 'Pending').textContent())).toBeGreaterThanOrEqual(2);
  await expect(card(page, alpha)).toBeVisible();
  await expect(card(page, beta)).toBeVisible();
  await expect(card(page, appr)).toHaveCount(0);
  await expect(card(page, rej)).toHaveCount(0);
  await expect(card(page, done)).toHaveCount(0);

  await clickFilter(page, 'Rejected');
  await expect(card(page, rej)).toBeVisible();
  await expect(card(page, alpha)).toHaveCount(0);

  await clickFilter(page, 'Done');
  await expect(card(page, done)).toBeVisible();
  await expect(card(page, alpha)).toHaveCount(0);

  // ── 2. Search composes WITH the active filter, and drives the empty state ────
  await clickFilter(page, 'Pending'); // back to the 2 pendings
  const search = page.getByPlaceholder(/Search name/i);
  await search.fill('alpha');
  await expect(card(page, alpha)).toBeVisible();
  await expect(card(page, beta)).toHaveCount(0); // search narrowed within the filter
  await search.fill(`no-such-${ts}`);
  await expect(page.getByText('No campaigns match your filters')).toBeVisible();
  await search.fill(''); // restore
  await expect(card(page, alpha)).toBeVisible();
  await expect(card(page, beta)).toBeVisible();

  // ── 3. Column sort: each header reorders the rows AND toggles direction ──────
  await clickFilter(page, 'All');
  // Default is Created (newest first) → done (last created) is above alpha (first).
  expect(await yOf(page, done)).toBeLessThan(await yOf(page, alpha));

  // Name ascending → alpha above zdone; aria-sort reflects it.
  await sortBy(page, /Name/).click();
  await expect(header(page, /Name/)).toHaveAttribute('aria-sort', 'ascending');
  expect(await yOf(page, alpha)).toBeLessThan(await yOf(page, done));
  // Name again → descending, order flips.
  await sortBy(page, /Name/).click();
  await expect(header(page, /Name/)).toHaveAttribute('aria-sort', 'descending');
  expect(await yOf(page, done)).toBeLessThan(await yOf(page, alpha));

  // WRS (desc) → the only scored campaign (done) rises to the top; Name un-sorts.
  await sortBy(page, /WRS/).click();
  await expect(header(page, /WRS/)).toHaveAttribute('aria-sort', 'descending');
  await expect(header(page, /Name/)).toHaveAttribute('aria-sort', 'none');
  expect(await yOf(page, done)).toBeLessThan(await yOf(page, alpha));

  // ── 4. Rows expand to the full card on demand, independently ─────────────────
  const detail = (name: string) => page.locator('tr.ct-detail .campaign', { hasText: name });
  await expect(detail(alpha)).toHaveCount(0); // collapsed by default
  await card(page, alpha).click();
  await expect(detail(alpha)).toBeVisible(); // full card with its actions
  await card(page, beta).click();
  await expect(detail(alpha)).toBeVisible(); // first stays open…
  await expect(detail(beta)).toBeVisible(); // …and the second opens too
  await card(page, alpha).click(); // collapse the first
  await expect(detail(alpha)).toHaveCount(0);
  await expect(detail(beta)).toBeVisible();

  // ── 5. Archive via the row leaves the default list; the toggle brings it back ─
  await (await openCard(page, done)).getByRole('button', { name: 'Archive' }).click();
  await expect(card(page, done)).toHaveCount(0); // gone from the default (non-archived) list
  await page.locator('label.archived-toggle input[type="checkbox"]').check();
  await expect(card(page, done)).toBeVisible(); // revealed by the archived toggle
  await (await openCard(page, done)).getByRole('button', { name: 'Restore' }).click();
  await expect((await openCard(page, done)).getByRole('button', { name: 'Archive' })).toBeVisible();

  await engCtx.close();
  await cisoCtx.close();
});
