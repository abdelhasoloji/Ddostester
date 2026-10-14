import { test, expect } from '@playwright/test';
import { login, goTo } from './helpers.js';
import { ROLES } from './roles.js';
import { signJwt } from '../backend/src/auth/jwt.js';

test('an authentically signed expired session returns to sign-in and clears its token', async ({
  page,
}) => {
  const secret = process.env.E2E_TEST_SIGNING_SECRET;
  if (!secret) throw new Error('Missing isolated signing key.');
  const expired = signJwt({ sub: ROLES.admin.email, role: 'admin' }, secret, -1);
  await page.goto('/');
  await page.evaluate((token) => localStorage.setItem('token', token), expired);
  const denied = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/me') && response.status() === 401,
  );
  await page.reload();
  await denied;
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
});

for (const theme of ['Light', 'Dark']) {
  test(`navigation text meets 4.5:1 contrast in ${theme.toLowerCase()} theme`, async ({
    page,
  }, testInfo) => {
    await login(page, 'admin');
    await page.getByRole('button', { name: `Theme: ${theme}`, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation instanceof CSSTransition)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
    const measurements = await page.locator('nav.nav a').evaluateAll((elements) => {
      const rgba = (value: string) => {
        const channels = value.match(/[\d.]+/g)?.map(Number);
        if (!channels || channels.length < 3)
          throw new Error('Unsupported computed color: ' + value);
        const scale = value.startsWith('color(srgb ') ? 255 : value.startsWith('rgb') ? 1 : 0;
        if (!scale) throw new Error('Unsupported computed color space: ' + value);
        return [channels[0] * scale, channels[1] * scale, channels[2] * scale, channels[3] ?? 1];
      };
      const over = (foreground: number[], background: number[]) =>
        foreground
          .slice(0, 3)
          .map((value, i) => value * foreground[3] + background[i] * (1 - foreground[3]));
      const luminance = (color: number[]) =>
        color
          .map((value) => value / 255)
          .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
          .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
      return elements.map((element) => {
        const ancestors: Element[] = [];
        for (let parent: Element | null = element; parent; parent = parent.parentElement)
          ancestors.unshift(parent);
        let background = [255, 255, 255];
        for (const parent of ancestors) {
          const style = getComputedStyle(parent);
          if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1)
            throw new Error('Contrast sampling requires solid backgrounds and unit opacity.');
          background = over(rgba(style.backgroundColor), background);
        }
        const foreground = over(rgba(getComputedStyle(element).color), background);
        const first = luminance(foreground),
          second = luminance(background);
        return {
          label: element.textContent?.trim(),
          foreground,
          background,
          ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        };
      });
    });
    await testInfo.attach('computed-navigation-contrast', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
    expect(measurements.length).toBeGreaterThan(0);
    for (const measurement of measurements)
      expect(measurement.ratio, measurement.label).toBeGreaterThanOrEqual(4.5);
  });
}

for (const width of [320, 390]) {
  test(`owner navigation fits a ${width}px viewport without page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await login(page, 'admin');
    for (const section of ['Campaigns', 'Results', 'Settings', 'Command Center']) {
      await goTo(page, section);
      await expect(page.getByRole('heading', { level: 1, name: section })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${section} must not widen the document`).toBeLessThanOrEqual(1);
    }
  });
}

test('sign-in and campaign navigation work with the keyboard and visible focus', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email', exact: true }).focus();
  await page.keyboard.type(ROLES.admin.email);
  await page.keyboard.press('Tab');
  await expect(page.locator('input[type="password"]')).toBeFocused();
  await page.keyboard.type(ROLES.admin.password);
  await page.keyboard.press('Enter');
  const campaign = page.locator('nav.nav').getByRole('link', { name: 'Campaigns' });
  await expect(campaign).toBeVisible();
  for (
    let i = 0;
    i < 25 && !(await campaign.evaluate((element) => element === document.activeElement));
    i++
  )
    await page.keyboard.press('Tab');
  await expect(campaign).toBeFocused();
  const visible = await campaign.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none') ||
      style.boxShadow !== 'none'
    );
  });
  expect(visible).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/campaigns$/);
});
