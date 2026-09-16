import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './modal.js';

describe('Modal', () => {
  it('renders its children in a labelled dialog', () => {
    render(
      <Modal label="Confirm run" onClose={() => {}}>
        <h3>Body</h3>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Confirm run' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'Body' })).toBeInTheDocument();
  });

  it('closes on overlay click but NOT on an inner click', () => {
    const onClose = vi.fn();
    render(
      <Modal label="X" onClose={onClose}>
        <button>Inner</button>
      </Modal>,
    );
    // Clicking inside the dialog box must not dismiss it.
    fireEvent.click(screen.getByRole('button', { name: 'Inner' }));
    expect(onClose).not.toHaveBeenCalled();
    // Clicking the dimmed overlay (the dialog's parent) dismisses it.
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal label="X" onClose={onClose}>
        <span>content</span>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
