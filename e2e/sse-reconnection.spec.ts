import { test, expect } from '@playwright/test';
import { login, goTo, createCampaign, card, openCard } from './helpers.js';

test('live progress reconnects after a stream interruption without restarting the run', async ({
  browser,
}) => {
  test.slow();
  const operatorContext = await browser.newContext();
  const approverContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  const approver = await approverContext.newPage();
  try {
    await login(operator, 'engineer');
    const name = await createCampaign(operator, {
      name: `sse-reconnect-${Date.now()}`,
      durationSec: 12,
      maxRps: 2,
      concurrency: 2,
    });
    await login(approver, 'ciso');
    await goTo(approver, 'Campaigns');
    await (
      await openCard(approver, name)
    )
      .getByRole('button', { name: 'Approve / Reject' })
      .click();
    await approver.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(card(approver, name).getByText('Approved')).toBeVisible();
    await operator.reload();
    await goTo(operator, 'Campaigns');
    let connections = 0;
    let executions = 0;
    const streamUrls = new Set<string>();
    operator.on('request', (request) => {
      if (request.method() === 'POST' && /\/api\/campaigns\/[^/]+\/execute$/.test(request.url()))
        executions++;
    });
    operator.on('response', (response) => {
      if (/\/api\/campaigns\/[^/]+\/stream$/.test(response.url()) && response.status() === 200) {
        connections++;
        streamUrls.add(response.url());
      }
    });
    await (
      await openCard(operator, name)
    )
      .getByRole('button', { name: 'Run', exact: true })
      .click();
    await operator.getByRole('button', { name: 'Run now' }).click();
    await expect.poll(() => connections).toBeGreaterThan(0);
    const control = process.env.E2E_STREAM_CONTROL_TOKEN;
    if (!control) throw new Error('Missing test-only stream control token.');
    const interruption = await operator.request.post('/__e2e/interrupt-streams', {
      headers: { authorization: 'Bearer ' + control },
    });
    expect(interruption.ok()).toBe(true);
    expect((await interruption.json()).interrupted).toBeGreaterThan(0);
    await expect(operator.getByText(/Live updates interrupted/)).toBeVisible();
    await expect.poll(() => connections, { timeout: 10_000 }).toBeGreaterThan(1);
    await expect(operator.getByText(/Live updates interrupted/)).toHaveCount(0);
    await expect(operator.getByText(/Run complete/)).toBeVisible({ timeout: 25_000 });
    expect(executions).toBe(1);
    expect(streamUrls.size).toBe(1);
    await test.info().attach('reconnection-evidence', {
      body: JSON.stringify({ connections, executions, distinctCampaignStreams: streamUrls.size }),
      contentType: 'application/json',
    });
  } finally {
    await operatorContext.close();
    await approverContext.close();
  }
});
