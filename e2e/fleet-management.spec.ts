import { test, expect } from '@playwright/test';
import { login, goTo } from './helpers.js';
test('fleet inventory can be registered, edited, filtered and removed through the UI', async ({
  page,
}) => {
  await login(page, 'admin');
  await goTo(page, 'Fleet');
  await expect(page.getByRole('heading', { name: 'Fleet management' })).toBeVisible();
  await page.getByRole('button', { name: 'Register device', exact: true }).click();
  await page.getByLabel('Device name', { exact: true }).fill('Lab sensor');
  await page.getByLabel('Agent ID', { exact: true }).fill('browser-iot-01');
  await page.getByLabel('Device group', { exact: true }).fill('Sensors');
  await page.getByLabel('Private IPv4 address', { exact: true }).fill('10.247.0.101');
  await page.getByRole('button', { name: 'Save device' }).click();
  await expect(page.getByText('Device registered.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('browser-iot-01', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Lab sensor' }).click();
  await page.getByLabel('Device name', { exact: true }).fill('Renamed sensor');
  await page.getByRole('button', { name: 'Save device' }).click();
  await expect(page.getByRole('button', { name: 'Edit Renamed sensor' })).toBeVisible();
  await page.getByLabel('Search devices').fill('missing-device');
  await expect(page.getByText('No devices match your filters.')).toBeVisible();
  await page.getByLabel('Search devices').fill('');
  await page.getByRole('button', { name: 'Remove Renamed sensor' }).click();
  await page.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(page.getByText('Device removed from inventory.')).toBeVisible();
  await expect(page.getByText('browser-iot-01', { exact: true })).toHaveCount(0);
});

test('an enrolled real client becomes online and loses access after revocation', async ({
  page,
}) => {
  test.slow();
  const { mkdtemp, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'ddostester-browser-agent-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await login(page, 'admin');
    await goTo(page, 'Fleet');
    await page.getByRole('button', { name: 'Register device', exact: true }).click();
    await page.getByLabel('Device name', { exact: true }).fill('Connected sensor');
    await page.getByLabel('Agent ID', { exact: true }).fill('browser-connected-01');
    await page.getByLabel('Private IPv4 address', { exact: true }).fill('10.247.0.102');
    await page.getByRole('button', { name: 'Save device' }).click();
    await page.getByRole('button', { name: 'Enroll Connected sensor', exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download enrollment' }).click();
    const file = join(directory, 'enrollment.json');
    await (await download).saveAs(file);
    await chmod(file, 0o600);
    const clientDownload = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download agent client' }).click();
    const clientFile = join(directory, 'heartbeat-agent.mjs');
    await (await clientDownload).saveAs(clientFile);
    child = spawn(process.execPath, [clientFile, file, '25'], {
      stdio: 'ignore',
    });
    const done = new Promise<number | null>((resolveDone, reject) => {
      child!.once('close', resolveDone);
      child!.once('error', reject);
    });
    const row = page.getByRole('row').filter({ hasText: 'browser-connected-01' });
    await expect(row.getByRole('cell', { name: /^online / })).toBeVisible({ timeout: 12000 });
    await expect(row.getByText('inventory-heartbeat/v1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close enrollment' }).click();
    await page.getByRole('button', { name: 'Revoke Connected sensor', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm revocation' }).click();
    await expect(row.getByRole('cell', { name: /^revoked / })).toBeVisible();
    expect(await done).toBe(1);
    await page.getByRole('button', { name: 'Remove Connected sensor', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm removal' }).click();
  } finally {
    child?.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
});
