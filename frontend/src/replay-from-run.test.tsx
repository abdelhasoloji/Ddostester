import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { makeApp, renderWithRouter } from './test-utils.js';
import type { Campaign, CampaignRun } from './api.js';

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});

const { suggestFromRun, ReplayFromRun } = await import('./replay-from-run.js');

const campaign = (over: Partial<Campaign> = {}): Campaign =>
  ({
    id: 'c1',
    name: 'Capacity ceiling',
    target: 'https://bank.cz/',
    probeUrl: 'https://bank.cz/',
    vector: 'http-get',
    status: 'COMPLETED',
    createdBy: 'eng@wedos',
    maxRps: 800,
    concurrency: 150,
    maxDurationSec: 120,
    ...over,
  }) as unknown as Campaign;

const run = (over: Partial<CampaignRun> = {}): CampaignRun =>
  ({ generator: {}, ...over }) as unknown as CampaignRun;

const mech = (m: string, extra: Record<string, unknown> = {}) =>
  run({
    assessment: {
      verdict: 'partial',
      mechanism: m,
      observation: '',
      caveats: [],
      underDelivered: false,
      confident: true,
      deliveryRatio: 1,
      achievedRps: 800,
      configuredRps: 800,
      ...extra,
    },
  } as unknown as Partial<CampaignRun>);

describe('suggestFromRun (post-run → adaptive follow-up)', () => {
  it('carries the target/probe/vector/shape from the original campaign', () => {
    const { seed } = suggestFromRun(campaign(), mech('served'));
    expect(seed.target).toBe('https://bank.cz/');
    expect(seed.probeUrl).toBe('https://bank.cz/');
    expect(seed.vector).toBe('http-get');
    expect(seed.maxRps).toBe(800);
    expect(seed.name).toBe('Capacity ceiling · replay');
  });

  it('rejected → ramp to the knee, calibrated', () => {
    const { seed, levers, headline } = suggestFromRun(campaign(), mech('rejected'));
    expect(seed.profile).toBe('ramp');
    expect(seed.calibrate).toBe(true);
    expect(levers).toContain('calibrate');
    expect(headline).toMatch(/ramp/i);
  });

  it('tarpitted → halve concurrency and calibrate', () => {
    const { seed, rationale } = suggestFromRun(campaign({ concurrency: 150 }), mech('tarpitted'));
    expect(seed.concurrency).toBe(75); // 150 / 2
    expect(seed.profile).toBe('constant');
    expect(seed.calibrate).toBe(true);
    expect(rationale.join(' ')).toMatch(/tarpitted/i);
  });

  it('tarpitted never drops concurrency below the floor of 5', () => {
    const { seed } = suggestFromRun(campaign({ concurrency: 6 }), mech('tarpitted'));
    expect(seed.concurrency).toBe(5); // max(5, round(6/2)=3) = 5
  });

  it('blocked → rotate UA + cache-bust to vary the fingerprint', () => {
    const { seed, levers } = suggestFromRun(campaign(), mech('blocked'));
    expect(levers).toEqual(expect.arrayContaining(['rotateUa', 'cacheBust']));
    expect(seed.userAgents).not.toBe(''); // UA rotation populated the textarea
    expect(seed.cacheBust).toBe(true);
  });

  it('served → escalate via a ramp toward the peak', () => {
    const { seed, headline } = suggestFromRun(
      campaign(),
      mech('served', {}) as unknown as CampaignRun,
    );
    expect(seed.profile).toBe('ramp');
    expect(headline).toMatch(/escalate/i);
  });

  it('folds detected posture into the levers (CDN→cacheBust, rate-limiter→calibrate, WAF→UA)', () => {
    const r = run({
      posture: {
        waf: true,
        cdn: true,
        rateLimiting: true,
        loadBalancer: false,
        hsts: true,
        securityHeaders: [],
        signals: [],
      },
      assessment: {
        verdict: 'held',
        mechanism: 'served',
        observation: '',
        caveats: [],
        underDelivered: false,
        confident: true,
        deliveryRatio: 1,
        achievedRps: 800,
        configuredRps: 800,
      },
    } as unknown as Partial<CampaignRun>);
    const { seed, levers } = suggestFromRun(campaign(), r);
    expect(levers).toEqual(expect.arrayContaining(['cacheBust', 'calibrate', 'rotateUa']));
    expect(seed.cacheBust).toBe(true);
    expect(seed.calibrate).toBe(true);
    expect(seed.userAgents).not.toBe('');
  });

  it('under-delivery forces calibration regardless of mechanism', () => {
    const { seed, rationale } = suggestFromRun(
      campaign(),
      mech('served', { underDelivered: true, deliveryRatio: 0.4 }),
    );
    expect(seed.calibrate).toBe(true);
    expect(rationale.join(' ')).toMatch(/under-delivered/i);
  });

  it('an edge origin-error (502) drives a "confirm the breaking point" hold', () => {
    const r = run({
      assessment: {
        verdict: 'breached',
        mechanism: 'tarpitted',
        observation: '',
        caveats: [],
        underDelivered: false,
        confident: true,
        deliveryRatio: 1,
        achievedRps: 800,
        configuredRps: 800,
      },
      edgeErrors: [{ status: 502, layer: 'origin', vendor: 'WEDOS' }],
    } as unknown as Partial<CampaignRun>);
    const { seed, headline, rationale } = suggestFromRun(campaign(), r);
    expect(headline).toMatch(/breaking point/i);
    expect(seed.profile).toBe('constant'); // hold at this rate to confirm
    expect(rationale.join(' ')).toMatch(/origin buckled|origin-error/i);
    expect(rationale.join(' ')).toContain('WEDOS');
  });

  it('an edge rate-limit / challenge page reinforces the matching lever', () => {
    const r = run({
      edgeErrors: [
        { status: 429, layer: 'rate-limit' },
        { status: 403, layer: 'challenge' },
      ],
    } as unknown as Partial<CampaignRun>);
    const { levers } = suggestFromRun(campaign(), r);
    expect(levers).toEqual(expect.arrayContaining(['calibrate', 'rotateUa']));
  });

  it('is safe with no assessment and no posture (falls back to a plain replay)', () => {
    const { seed, headline, rationale } = suggestFromRun(campaign(), run());
    expect(seed.target).toBe('https://bank.cz/');
    expect(headline).toBeTruthy();
    expect(rationale.length).toBeGreaterThan(0);
  });
});

describe('ReplayFromRun (CTA on a completed run)', () => {
  it('expands to show the rationale, then queues the seed on compose', () => {
    currentApp = makeApp({});
    renderWithRouter(<ReplayFromRun campaign={campaign()} run={mech('rejected')} />);
    // Collapsed by default — expand it.
    const toggle = screen.getByRole('button', { name: /Replay accounting for countermeasures/i });
    fireEvent.click(toggle);
    expect(screen.getByText(/Ramp to the rejection knee/i)).toBeInTheDocument();
    // Compose queues the replay seed and clears the drawer.
    fireEvent.click(screen.getByRole('button', { name: /Compose this follow-up/i }));
    expect(currentApp.queueReplay).toHaveBeenCalledTimes(1);
    const seed = (currentApp.queueReplay as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(seed).toMatchObject({ target: 'https://bank.cz/', profile: 'ramp', calibrate: true });
    expect(currentApp.setExpanded).toHaveBeenCalledWith(null);
  });

  it('renders nothing when the run has neither an assessment nor posture', () => {
    currentApp = makeApp({});
    const { container } = renderWithRouter(<ReplayFromRun campaign={campaign()} run={run()} />);
    expect(container.querySelector('.replay-cta')).toBeNull();
  });
});
