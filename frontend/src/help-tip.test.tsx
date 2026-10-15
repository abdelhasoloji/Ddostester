import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect } from 'vitest';
import { HelpTip } from './help-tip.js';
it('offers guidance through keyboard, touch and hover without permanent explanatory text', () => {
  render(<HelpTip label="Simulation">Virtual events only</HelpTip>);
  const button = screen.getByRole('button', { name: 'Help: Simulation' });
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.focus(button);
  expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.click(button);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Virtual events only');
  fireEvent.blur(button);
  fireEvent.mouseEnter(button.parentElement!);
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  fireEvent.mouseLeave(button.parentElement!);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
