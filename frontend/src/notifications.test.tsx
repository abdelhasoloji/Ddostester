import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { makeApp, renderWithRouter } from './test-utils.js';
import type { Alert, Campaign } from './api.js';

let currentApp: ReturnType<typeof makeApp>;

vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});

const { NotificationsBell } = await import('./pages.js');

function alert(over: Partial<Alert> = {}): Alert {
  return {
    severity: 'warning',
    key: `k${Math.random().toString(36).slice(2)}`,
    kind: 'low-wrs',
    title: 'Low WRS 41 (D)',
    detail: 'WEDOS Resilience Score 41 is below target',
    runId: 'run-1',
    target: 'bank.cz',
    at: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe('NotificationsBell', () => {
  it('shows an unread badge and no panel until clicked', () => {
    currentApp = makeApp({ alerts: [alert({ key: 'a' }), alert({ key: 'b' })] });
    renderWithRouter(<NotificationsBell />);
    expect(screen.getByLabelText(/2 unread/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the panel listing every alert', () => {
    currentApp = makeApp({ alerts: [alert({ key: 'a', title: 'Tarpit detected' })] });
    renderWithRouter(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Tarpit detected')).toBeInTheDocument();
  });

  it('clicking an alert opens the owning campaign and closes the panel', () => {
    const c = { id: 'c1', name: 'Soak' } as Campaign;
    currentApp = makeApp({
      alerts: [alert({ key: 'a', title: 'Auto-killed', campaignId: 'c1' })],
      campaigns: [c],
    });
    renderWithRouter(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    fireEvent.click(screen.getByText('Auto-killed'));
    expect(currentApp.openDetail).toHaveBeenCalledWith(c);
    expect(screen.queryByRole('dialog')).toBeNull(); // panel closed
  });

  it('"Mark all read" clears the unread badge', () => {
    currentApp = makeApp({ alerts: [alert({ key: 'a' }), alert({ key: 'b' })] });
    renderWithRouter(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: /Notifications/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(screen.queryByLabelText(/unread/)).toBeNull();
    // Bell still present, just without the unread count.
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('renders an all-clear empty state when there are no alerts', () => {
    currentApp = makeApp({ alerts: [] });
    renderWithRouter(<NotificationsBell />);
    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText(/All clear/)).toBeInTheDocument();
  });
});
