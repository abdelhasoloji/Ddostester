import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp } from './test-utils.js';

let currentApp: ReturnType<typeof makeApp>;
vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});

const { Login } = await import('./ui.js');

beforeEach(() => {
  currentApp = makeApp();
});

// Labels are not `for`-associated, so select by role/type instead.
function fields() {
  const email = screen.getByRole('textbox');
  const password = document.querySelector('input[type="password"]') as HTMLInputElement;
  return { email, password };
}

describe('Login', () => {
  it('keeps the button disabled until both fields are filled', () => {
    render(<Login />);
    const button = screen.getByRole('button', { name: /Sign in/ });
    const { email, password } = fields();
    expect(button).toBeDisabled();
    fireEvent.change(email, { target: { value: 'a@b' } });
    expect(button).toBeDisabled();
    fireEvent.change(password, { target: { value: 'pw' } });
    expect(button).toBeEnabled();
  });

  it('submits the credentials through the context', async () => {
    render(<Login />);
    const { email, password } = fields();
    fireEvent.change(email, { target: { value: 'off@wedos' } });
    fireEvent.change(password, { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(currentApp.login).toHaveBeenCalledWith('off@wedos', 'secret'));
  });

  it('shows the error message when login fails', async () => {
    currentApp = makeApp({ login: vi.fn().mockRejectedValue(new Error('invalid credentials')) });
    render(<Login />);
    const { email, password } = fields();
    fireEvent.change(email, { target: { value: 'off@wedos' } });
    fireEvent.change(password, { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(screen.getByText('invalid credentials')).toBeInTheDocument());
  });
});
