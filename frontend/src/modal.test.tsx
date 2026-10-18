import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './modal.js';
import { HelpTip } from './interface-kit.js';

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

it('keeps keyboard focus inside the dialog and restores its trigger on close', () => {
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  const before = document.body.style.overflow;
  const view = render(
    <Modal label="Focus" onClose={() => {}}>
      <button>First</button>
      <button>Last</button>
    </Modal>,
  );
  const first = screen.getByRole('button', { name: 'First' });
  const last = screen.getByRole('button', { name: 'Last' });
  expect(first).toHaveFocus();
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
  expect(last).toHaveFocus();
  fireEvent.keyDown(last, { key: 'Tab' });
  expect(first).toHaveFocus();
  view.unmount();
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).toBe(before);
  trigger.remove();
});

it('focuses a dialog with no controls', () => {
  render(
    <Modal label="Information" onClose={() => {}}>
      <p>Message</p>
    </Modal>,
  );
  expect(screen.getByRole('dialog')).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
  expect(screen.getByRole('dialog')).toHaveFocus();
});

it('focuses the action instead of opening incidental help when a dialog mounts', () => {
  render(
    <Modal label="Generator" onClose={() => {}}>
      <HelpTip text="Help" />
      <button>Create</button>
    </Modal>,
  );
  expect(screen.getByRole('button', { name: 'Create' })).toHaveFocus();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
