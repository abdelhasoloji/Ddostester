import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard, SELF } from './helpers.js';

// The adaptive feedback loop: a completed run's conclusions seed a follow-up
// campaign via "Replay accounting for countermeasures". Verifies the real
// outcome — the launch form is pre-filled from the prior run, not just that a
// button exists.

test('replay: a completed run seeds a follow-up campaign from its conclusions', async ({
  browser,
}) => {
  const name = `replay-${Date.now()}`;

  const engCtx = await browser.newContext();
  const eng = await engCtx.newPage();
  await login(eng, 'engineer');
  await createCampaign(eng, { name, target: SELF, probe: SELF, maxRps: 5, durationSec: 2 });

  const cisoCtx = await browser.newContext();
  const ciso = await cisoCtx.newPage();
  await login(ciso, 'ciso');
  await goTo(ciso, 'Campaigns');
  await (await openCard(ciso, name)).getByRole('button', { name: 'Approve / Reject' }).click();
  await ciso.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ciso, name).getByText('Approved')).toBeVisible();

  // Engineer runs it to completion.
  await eng.reload();
  await goTo(eng, 'Campaigns');
  await (await openCard(eng, name)).getByRole('button', { name: 'Run', exact: true }).click();
  await eng.getByRole('button', { name: 'Launch campaign' }).click();
  await expect(eng).toHaveURL(/\/theater/);

  // Back on Campaigns, wait for the run to settle (its report becomes reachable),
  // then open the run's detail drawer.
  await goTo(eng, 'Campaigns');
  const cardDetail = await openCard(eng, name);
  await expect(cardDetail.getByRole('link', { name: /Report/ })).toBeVisible({ timeout: 20_000 });
  await cardDetail.getByRole('button', { name: 'Details' }).click();
  const drawer = eng.locator('aside.drawer');
  await expect(drawer).toBeVisible();

  // The replay CTA is present on the completed run; expand it and compose.
  const cta = drawer.getByRole('button', { name: /Replay accounting for countermeasures/i });
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(drawer.getByText(/replay|escalate|ramp|tarpit|posture/i).first()).toBeVisible();
  await drawer.getByRole('button', { name: /Compose this follow-up/i }).click();

  // The follow-up form opens on the Launch surface, pre-filled from the prior run:
  // the name carries "· replay" and the target is the same host.
  await expect(eng.getByRole('heading', { name: 'New campaign' })).toBeVisible();
  const nameInput = eng.locator('form.grid .field', { hasText: 'Name' }).locator('input');
  await expect(nameInput).toHaveValue(new RegExp(`${name} · replay`));
  const targetInput = eng.locator('form.grid .field', { hasText: 'Target (URL)' }).locator('input');
  await expect(targetInput).toHaveValue(/127\.0\.0\.1/);

  await engCtx.close();
  await cisoCtx.close();
});
