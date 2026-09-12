import { test, expect } from '@playwright/test';
import { login, goTo } from './helpers.js';

// Every top-level section is reachable and renders its own page title (J-nav /
// catalog navigation coverage). Officer sees all sections.
// v2 nav: the resilience spine (Command Center / Campaigns / Run Theater /
// Results / Assurance) plus the secondary "More" group. `link` is the nav label
// and `title` the page's own <h1> — kept in step so the two never diverge.
const SECTIONS: { link: string; title: string }[] = [
  { link: 'Command Center', title: 'Command Center' },
  { link: 'Campaigns', title: 'Campaigns' },
  { link: 'Run Theater', title: 'Run Theater' },
  { link: 'Results', title: 'Results' },
  { link: 'Assurance', title: 'Assurance' },
  { link: 'Settings', title: 'Settings' },
];

test('every section renders its page (officer)', async ({ page }) => {
  await login(page, 'officer');
  for (const s of SECTIONS) {
    await goTo(page, s.link);
    await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible();
  }
});

test('the Campaigns workspace exposes its tabs and switches surfaces', async ({ page }) => {
  await login(page, 'officer');
  await goTo(page, 'Campaigns');
  // The four workspace tabs (Templates + Plan + Guide are folded in here now).
  for (const t of ['Launch', 'Templates', 'Plan', 'How it works']) {
    await expect(page.getByRole('tab', { name: t })).toBeVisible();
  }
  // Switching tabs swaps the surface without leaving the workspace.
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expect(page.getByPlaceholder('Search templates…')).toBeVisible();
  await page.getByRole('tab', { name: 'How it works' }).click();
  await expect(page.getByRole('heading', { name: 'Reading the score (WRS)' })).toBeVisible();
});

test('Reports shows an empty state before any run (E1)', async ({ page }) => {
  await login(page, 'viewer');
  await goTo(page, 'Results');
  // Either the empty state or (if a prior spec ran a campaign) real report rows.
  const empty = page.getByText(/no campaign has run yet/i);
  const heading = page.getByRole('heading', { name: 'Measured runs' });
  await expect(heading).toBeVisible();
  // Empty state is acceptable; if not empty, at least the section is coherent.
  await expect(empty.or(page.locator('.report-row').first())).toBeVisible();
});
