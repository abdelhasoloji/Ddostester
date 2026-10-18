import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HelpTip } from './interface-kit.js';

describe('HelpTip', () => {
  it('opens outside clipping containers on keyboard focus and dismisses on Escape', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden' }}>
        <HelpTip text="Explanation" label="Help" />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'Help' });
    fireEvent.focus(trigger);
    const tooltip = screen.getByRole('tooltip');
    expect(container).not.toContainElement(tooltip);
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
  it('opens on pointer or touch activation and closes on blur', () => {
    render(<HelpTip text="Details" />);
    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Details');
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
