import { test, expect, type Page } from '@playwright/test';
import { login, goTo } from './helpers.js';

// The class-C network bench governance (CISO-only, on Settings). The catalogue is
// static (BENCH_SCENARIOS), so the governance controls always render; dispatch is
// disabled without a runner. Drives the two pure governed writes — record coverage
// evidence and import external verdicts — plus the attestation checklist.

async function noError(page: Page): Promise<void> {
  await expect(page.locator('.toast.error, .toast-error')).toHaveCount(0);
}

async function openBench(page: Page) {
  await login(page, 'ciso');
  await goTo(page, 'Settings');
  const card = page.locator('.card', { hasText: 'Network bench — class C' });
  await expect(card.getByRole('heading', { name: /Network bench/ })).toBeVisible();
  return card;
}

test('bench: the card renders and Request run is disabled without a runner', async ({ page }) => {
  const card = await openBench(page);
  await expect(card.getByRole('button', { name: /Request run/ })).toBeDisabled();
  // The coverage matrix table is present.
  await expect(card.locator('table.bench-table').first()).toBeVisible();
  await noError(page);
});

test('bench: record coverage evidence (ATTESTED) for a vector', async ({ page }) => {
  const card = await openBench(page);
  await card.getByRole('button', { name: /Record coverage evidence/ }).click();
  await card
    .locator('.field:has(label:text-is("Evidence / rationale")) input')
    .fill('E2E: edge enforces BCP38/uRPF; spoofed sources dropped.');
  await card.getByRole('button', { name: /^Record coverage$/ }).click();
  await expect(page.getByText(/Coverage recorded for/)).toBeVisible();
  await noError(page);
});

test('bench: import external verdicts (CSV) as INGESTED_EXTERNAL coverage', async ({ page }) => {
  const card = await openBench(page);
  await card.getByRole('button', { name: /Import external verdicts/ }).click();
  // Format defaults to CSV. Provide one valid row against a real catalogue vector.
  const vector = await card
    .locator('.field:has(label:text-is("Reproducible vector")) select option')
    .first()
    .getAttribute('value');
  await card
    .locator('textarea')
    .fill(`vector,outcome,drs,summary,source\n${vector},MITIGATED,4,"E2E import",e2e-bench`);
  await card.getByRole('button', { name: /^Import verdicts$/ }).click();
  await expect(page.getByText(/Imported \d+ external verdict/)).toBeVisible();
  await noError(page);
});

test('bench: attestation checklist derives an outcome when a checklist exists', async ({
  page,
}) => {
  const card = await openBench(page);
  const openBtn = card.getByRole('button', { name: /Attestation checklist/ });
  if (!(await openBtn.count())) return; // no checklists configured — nothing to drive
  await openBtn.click();
  // Tick every control, then record.
  for (const cb of await card.locator('ul input[type="checkbox"]').all()) {
    await cb.check();
  }
  await card.getByRole('button', { name: /Record attestation/ }).click();
  await expect(page.getByText(/Attestation recorded for/)).toBeVisible();
  await noError(page);
});
