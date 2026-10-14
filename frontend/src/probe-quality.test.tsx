import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProbeQualityPanel } from './probe-quality.js';
import type { CampaignRun } from './api.js';

it('shows unavailable probe counters separately from measured zero throttling', () => {
  render(
    <ProbeQualityPanel
      probe={
        {
          quality: {
            measuredSamples: 3,
            totalSamples: 4,
            peakEventLoopDelayMs: null,
            peakThrottledFraction: 0,
          },
        } as CampaignRun['probe']
      }
    />,
  );
  expect(screen.getByText(/3\/4 measurements/)).toBeInTheDocument();
  expect(screen.getByText('0.0 %')).toBeInTheDocument();
  expect(screen.getAllByText('unknown')).toHaveLength(4);
});

it('labels recent process windows separately from per-request diagnostics', () => {
  render(
    <ProbeQualityPanel
      probe={
        {
          quality: {
            measuredSamples: 3,
            totalSamples: 3,
            peakEventLoopDelayMs: null,
            peakRecentEventLoopDelayMs: 175,
            peakThrottledFraction: 0,
          },
        } as CampaignRun['probe']
      }
    />,
  );
  expect(screen.getByText('Peak event-loop delay in recent process windows')).toBeInTheDocument();
  expect(screen.getByText('175.0 ms')).toBeInTheDocument();
  expect(screen.getAllByText('unknown')).toHaveLength(3);
});

it('separately labels baseline diagnostics', () => {
  render(
    <ProbeQualityPanel
      title="Remote baseline diagnostics"
      probe={{
        quality: {
          measuredSamples: 2,
          totalSamples: 3,
          peakEventLoopDelayMs: null,
          peakRecentEventLoopDelayMs: 175,
          peakThrottledFraction: 0,
        },
      }}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Remote baseline diagnostics' })).toBeInTheDocument();
  expect(screen.getByText(/2\/3 measurements/)).toBeInTheDocument();
});
