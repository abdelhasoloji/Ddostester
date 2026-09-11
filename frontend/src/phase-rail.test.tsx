import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PhaseRail } from './phase-rail.js';
import { phaseForPath, PHASES } from './phases.js';

describe('phaseForPath', () => {
  it('maps routes to phases ("/" is Measure, the Campaigns workspace by tab)', () => {
    expect(phaseForPath('/prepare')?.id).toBe('recon');
    // Plan and Execute share the Campaigns workspace, disambiguated by the tab.
    expect(phaseForPath('/campaigns', '?tab=plan')?.id).toBe('plan');
    expect(phaseForPath('/campaigns')?.id).toBe('execute'); // default tab
    expect(phaseForPath('/campaigns/abc')?.id).toBe('execute');
    expect(phaseForPath('/')?.id).toBe('measure');
    expect(phaseForPath('/reports')?.id).toBe('report');
    expect(phaseForPath('/settings')).toBeUndefined(); // not a phase route
  });
});

describe('PhaseRail', () => {
  it('renders all five phases and marks the active one', () => {
    render(
      <MemoryRouter initialEntries={['/campaigns?tab=plan']}>
        <PhaseRail />
      </MemoryRouter>,
    );
    for (const p of PHASES) expect(screen.getByText(p.name)).toBeInTheDocument();
    const active = screen.getByText('Plan').closest('a');
    expect(active?.className).toContain('active');
    // A different phase is not active.
    expect(screen.getByText('Recon').closest('a')?.className).not.toContain('active');
  });
});
