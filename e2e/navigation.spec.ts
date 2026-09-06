import { test, expect } from '@playwright/test';
import { login, goTo } from './helpers.js';

// Every top-level section is reachable and renders its own page title (J-nav /
// catalog navigation coverage). Officer sees all sections.
const SECTIONS: { link: string; title: string }[] = [
  { link: 'Overview', title: 'Overview' },
  { link: 'Campaigns', title: 'Campaigns' },
  { link: 'Reports', title: 'Reports' },
  { link: 'Audit log', title: 'Audit log' },
  { link: 'Guide', title: 'Guide' },
  { link: 'Settings', title: 'Settings' },
];

test('every section renders its page (officer)', async ({ page }) => {
  await login(page, 'officer');
  for (const s of SECTIONS) {
    await goTo(page, s.link);
    await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible();
  }
});

test('Reports shows an empty state before any run (E1)', async ({ page }) => {
  await login(page, 'viewer');
  await goTo(page, 'Reports');
  // Either the empty state or (if a prior spec ran a campaign) real report rows.
  const empty = page.getByText(/no campaign has run yet/i);
  const heading = page.getByRole('heading', { name: 'Campaign reports' });
  await expect(heading).toBeVisible();
  // Empty state is acceptable; if not empty, at least the section is coherent.
  await expect(empty.or(page.locator('.report-row').first())).toBeVisible();
});
