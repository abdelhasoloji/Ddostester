import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { PassivePrototypePanel } from './passive-prototype-panel.js';
import { passivePrototypeCheckpoint } from '../../backend/src/modules/infrastructure/passive-prototype.js';
it('never turns staged artifacts or local samples into a live Ready count', () => {
  render(<PassivePrototypePanel checkpoint={passivePrototypeCheckpoint()} />);
  expect(screen.getByRole('region', { name: 'Passive PoP prototype' })).toBeInTheDocument();
  expect(screen.getByText('Unknown')).toBeInTheDocument();
  expect(screen.getByText(/no live Kubernetes observation/)).toBeInTheDocument();
  expect(screen.getByText(/No apply or live Pod observation recorded/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /deploy|launch|migrate/i })).not.toBeInTheDocument();
});
