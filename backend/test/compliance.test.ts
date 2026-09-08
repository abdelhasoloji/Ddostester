import { describe, expect, it } from 'vitest';
import { renderComplianceHtml } from '../src/modules/reports/compliance.js';
import type { Campaign } from '../src/modules/campaigns/model.js';
import type { CampaignRun } from '../src/modules/campaigns/runner.js';

// The report only reads a handful of fields; build compact fixtures for them.
function campaign(id: string, name: string, target: string, agent?: string): Campaign {
  return { id, name, target, agent } as unknown as Campaign;
}
function run(
  campaignId: string,
  o: {
    status: CampaignRun['status'];
    wrs: number;
    level: string;
    available: number;
    samples: number;
    rps?: number;
    statusDetail?: string;
    estimated?: boolean;
  },
): CampaignRun {
  return {
    campaignId,
    status: o.status,
    statusDetail: o.statusDetail,
    wrs: { wrs: o.wrs, level: o.level, estimated: o.estimated ?? false },
    probe: { samples: o.samples, available: o.available },
    generator: { actualRps: o.rps ?? 100, finishedAt: new Date().toISOString() },
  } as unknown as CampaignRun;
}

describe('compliance / resilience assessment report', () => {
  const campaigns = [
    campaign('c1', 'Baseline', 'https://127.0.0.1/', 'vegeta'),
    campaign('c2', 'Burst', 'https://127.0.0.1/', 'k6'),
    campaign('c3', 'Spike', 'https://127.0.0.1/', 'builtin'),
  ];
  const runs = [
    run('c1', { status: 'COMPLETED', wrs: 97, level: 'A+', available: 7, samples: 7 }),
    run('c2', { status: 'COMPLETED', wrs: 72, level: 'B', available: 95, samples: 100 }),
    run('c3', {
      status: 'KILLED_AUTO',
      wrs: 41,
      level: 'D',
      available: 0,
      samples: 7,
      statusDetail: 'Auto-killed: the legitimate probe found the target unavailable for ≥30 s.',
    }),
  ];
  const html = renderComplianceHtml(campaigns, runs);

  it('renders the assessment sections (scope, per-scenario, glossary, out-of-scope)', () => {
    expect(html).toContain('Resilience assessment');
    expect(html).toContain('Per-scenario results');
    expect(html).toContain('Glossary');
    expect(html).toContain('Volumetric / L3-L4 — class C, network bench');
    expect(html).toContain('DRS 4.5'); // customer-defined cap note
  });

  it('derives Held / Low for a clean high-WRS run', () => {
    expect(html).toContain('>Held<');
    expect(html).toContain('>Low<');
  });

  it('derives Partial / Medium for degraded availability', () => {
    expect(html).toContain('>Partial<');
    expect(html).toContain('>Medium<');
  });

  it('derives Failed / Critical for an auto-killed run and shows its reason', () => {
    expect(html).toContain('Failed (impact)');
    expect(html).toContain('>Critical<');
    expect(html).toContain('found the target unavailable');
  });

  it('renders the designed chrome: cover, management summary, gauge and distribution charts', () => {
    expect(html).toContain('Confidential — WEDOS internal');
    expect(html).toContain('class="lead"'); // management summary prose
    expect(html).toContain('bounded assessment'); // summary wording
    expect(html).toContain('chart-gauge'); // avg-WRS gauge
    expect(html).toContain('chart-hbars'); // distribution bars
    expect(html).toContain('At a glance');
    expect(html).not.toMatch(/NaN|undefined/);
  });

  it('handles an empty period without charts blowing up', () => {
    const empty = renderComplianceHtml([], [], {
      from: '2000-01-01T00:00:00Z',
      to: '2000-01-02T00:00:00Z',
    });
    expect(empty).toContain('No bounded assessments were recorded');
    expect(empty).not.toMatch(/NaN|undefined/);
  });

  it('renders the class-C bench coverage matrix + rollup when bench data is supplied', () => {
    const bench = {
      scenarios: [
        {
          id: 'udp_dns_reflection',
          title: 'UDP DNS Reflection',
          proto: 'UDP' as const,
          drs: 3,
          reproducible: true,
          note: 'x',
        },
        {
          id: 'ip_spoofing',
          title: 'IP Spoofing',
          proto: 'IP' as const,
          drs: 4,
          reproducible: false,
          note: 'spoofing never',
        },
      ],
      coverage: [
        {
          id: 'a',
          vector: 'udp_dns_reflection',
          method: 'MEASURED_LAB' as const,
          outcome: 'UNMITIGATED_BASELINE',
          summary: 'amp 40x',
          source: 'shieldtest-lab',
          recordedBy: 'runner',
          at: new Date().toISOString(),
        },
        {
          id: 'b',
          vector: 'ip_spoofing',
          method: 'ATTESTED' as const,
          outcome: 'PASS',
          summary: 'BCP38/uRPF enforced',
          source: 'edge-config',
          recordedBy: 'ciso@wedos',
          at: new Date().toISOString(),
        },
      ],
    };
    const html = renderComplianceHtml([], [], { bench });
    expect(html).toContain('zeroBS Volumetric coverage');
    expect(html).toContain('udp_dns_reflection');
    expect(html).toContain('MEASURED LAB');
    expect(html).toContain('ATTESTED');
    expect(html).toContain('BCP38/uRPF enforced');
    // Rollup: 1 measured, 2 covered, 1 never emitted (ip_spoofing).
    expect(html).toContain('Measured (lab)');
    expect(html).not.toMatch(/NaN|undefined/);
  });
});
