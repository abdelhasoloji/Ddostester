import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AiSupportButton } from './ui.js';
import { onAiSupport } from './assistant-bus.js';

describe('AiSupportButton', () => {
  it('publishes the block context to the assistant bus on click', () => {
    let got: { title: string; context: string } | null = null;
    const off = onAiSupport((r) => (got = r));
    render(<AiSupportButton title="Active alerts" context="recent alerts" />);
    fireEvent.click(screen.getByRole('button', { name: /AI support/ }));
    off();
    expect(got).toEqual({ title: 'Active alerts', context: 'recent alerts' });
  });
});
