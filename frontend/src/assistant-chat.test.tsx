import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { makeApp, makeApi } from './test-utils.js';

let currentApp: ReturnType<typeof makeApp>;
const fakeApi = makeApi({
  assistantStatus: vi
    .fn()
    .mockResolvedValue({ configured: true, model: 'qwen', podManaged: false }),
});

vi.mock('./context.js', async (orig) => {
  const actual = await orig<typeof import('./context.js')>();
  return { ...actual, useApp: () => currentApp };
});
vi.mock('./api.js', async (orig) => {
  const actual = await orig<typeof import('./api.js')>();
  return { ...actual, api: fakeApi };
});

const { AssistantChat } = await import('./assistant-chat.js');

const CONVOS_KEY = 'assistantConvos';

/** A fresh minimal SSE Response streaming the given chunks once per call. */
function sse(chunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            return i < chunks.length
              ? Promise.resolve({ value: enc.encode(chunks[i++]), done: false })
              : Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  } as unknown as Response;
}
function mockFetch(text: string) {
  global.fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(sse([`event: delta\ndata: ${JSON.stringify({ content: text })}\n\n`])),
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  currentApp = makeApp({ role: 'engineer', authRequired: false });
  fakeApi.assistantStatus = vi
    .fn()
    .mockResolvedValue({ configured: true, model: 'qwen', podManaged: false });
});

async function waitReady() {
  const box = (await screen.findByPlaceholderText(/Write your message/)) as HTMLTextAreaElement;
  await waitFor(() => expect(box).not.toBeDisabled());
  return box;
}

describe('AssistantChat — conversation history', () => {
  it('keeps response provenance through streamed text without inventing billed usage', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sse([
        `event: provenance\ndata: ${JSON.stringify({
          model: 'verified-model',
          budget: {
            schemaVersion: 'ddostester.assistant.budget/v1',
            reservedUnits: 1200,
            persistence: 'postgres',
            providerTokens: null,
            cost: null,
          },
        })}\n\n`,
        'event: delta\ndata: {"content":"A bounded proposal"}\n\n',
      ]),
    );
    render(<AssistantChat variant="page" />);
    const box = await waitReady();
    fireEvent.change(box, { target: { value: 'Help me review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('A bounded proposal');
    expect(screen.getByText('verified-model')).toBeInTheDocument();
    expect(
      screen.getByText(/budget units reserved.*usage and cost unavailable/),
    ).toBeInTheDocument();
  });

  it('saves a finished turn and lists / reopens it from the History panel', async () => {
    mockFetch('Hello operator');
    render(<AssistantChat variant="page" />);
    const box = await waitReady();

    fireEvent.change(box, { target: { value: 'What are my caps?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('Hello operator');
    await waitFor(() => {
      const raw = localStorage.getItem(CONVOS_KEY);
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw as string)).toHaveLength(1);
    });

    const historyBtn = await screen.findByRole('button', {
      name: /^History \(1\)$/,
    });
    fireEvent.click(historyBtn);
    expect(await screen.findByText('Conversations')).toBeInTheDocument();
    fireEvent.click(screen.getByText('What are my caps?'));
    expect(await screen.findByText('Hello operator')).toBeInTheDocument();
  });

  it('loads saved conversations on mount, ignores malformed ones, and deletes on request', async () => {
    localStorage.setItem(
      CONVOS_KEY,
      JSON.stringify([
        {
          id: 'a1',
          title: 'Prior chat',
          createdAt: Date.now() - 1000,
          updatedAt: Date.now(),
          messages: [
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
          ],
        },
        { id: 'bad', messages: 'not-an-array' },
      ]),
    );
    render(<AssistantChat variant="page" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^History \(1\)$/ })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /^History \(1\)$/ }));
    expect(await screen.findByText('Prior chat')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }));
    await waitFor(() => {
      const raw = localStorage.getItem(CONVOS_KEY);
      expect(JSON.parse(raw as string)).toHaveLength(0);
    });
    expect(screen.getByText(/No saved conversations yet/)).toBeInTheDocument();
  });
});

describe('AssistantChat — proactive suggestions', () => {
  it('the Suggest button asks Qwen for next actions, shown as an Auto note', async () => {
    mockFetch('Consider a conservative baseline test.');
    render(<AssistantChat variant="page" />);
    await waitReady();

    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    await screen.findByText('Requested next-action suggestions');
    expect(await screen.findByText(/conservative baseline test/)).toBeInTheDocument();
    // The synthesized turn went to the chat endpoint.
    expect(global.fetch).toHaveBeenCalledWith('/api/assistant/chat', expect.anything());
  });

  it('fires automatically when a campaign completes with a WRS report (Auto on)', async () => {
    mockFetch('The report looks healthy; no further action needed.');
    currentApp = makeApp({
      role: 'engineer',
      authRequired: false,
      campaigns: [
        {
          id: 'c1',
          name: 'Baseline',
          target: 'http://127.0.0.1/',
          status: 'RUNNING',
        },
      ],
    });
    const { rerender } = render(<AssistantChat variant="page" />);
    await waitReady();

    // Campaign settles with a report → observer should feed Qwen.
    currentApp = makeApp({
      role: 'engineer',
      authRequired: false,
      campaigns: [
        {
          id: 'c1',
          name: 'Baseline',
          target: 'http://127.0.0.1/',
          status: 'COMPLETED',
          wrs: {
            detection: 1,
            mitigation: 1,
            availability: 1,
            collateral: 1,
            wrs: 99.4,
            level: 'A+',
          },
        },
      ],
    });
    rerender(<AssistantChat variant="page" />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/assistant/chat', expect.anything()),
    );
    expect(await screen.findByText(/Baseline.*COMPLETED|COMPLETED/)).toBeInTheDocument();
  });

  it('does not auto-fire when Auto is toggled off', async () => {
    mockFetch('unused');
    localStorage.setItem('assistantAutoSuggest', '0');
    currentApp = makeApp({
      role: 'engineer',
      authRequired: false,
      campaigns: [
        {
          id: 'c1',
          name: 'Baseline',
          target: 'http://127.0.0.1/',
          status: 'RUNNING',
        },
      ],
    });
    const { rerender } = render(<AssistantChat variant="page" />);
    await waitReady();
    expect((screen.getByLabelText('Auto') as HTMLInputElement).checked).toBe(false);

    currentApp = makeApp({
      role: 'engineer',
      authRequired: false,
      campaigns: [
        {
          id: 'c1',
          name: 'Baseline',
          target: 'http://127.0.0.1/',
          status: 'COMPLETED',
        },
      ],
    });
    rerender(<AssistantChat variant="page" />);

    // Give any (unwanted) async work a tick, then assert no chat call was made.
    await new Promise((r) => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalledWith('/api/assistant/chat', expect.anything());
  });
});

describe('AssistantChat — floating companion & pod control', () => {
  it('detaches into a floating window (portal) and docks back, persisting the choice', async () => {
    mockFetch('hi');
    render(<AssistantChat variant="dock" />);
    await screen.findByText('WEDOS AI Assistant');

    fireEvent.click(await screen.findByRole('button', { name: /Float/ }));

    // The real UI moves into a portal window with its own composer.
    await waitFor(() => expect(document.querySelector('[data-assistant-float]')).toBeTruthy());
    expect(document.querySelector('.assistant-float-input')).toBeTruthy();
    expect(localStorage.getItem('assistantFloating')).toBe('1');
    // The column steps aside to a docked-away note.
    expect(screen.getByText(/The assistant is floating/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Dock it back/ }));
    await waitFor(() => expect(document.querySelector('[data-assistant-float]')).toBeNull());
    expect(localStorage.getItem('assistantFloating')).toBe('0');
  });

  it('restores the floating window on mount when it was left floating', async () => {
    mockFetch('hi');
    localStorage.setItem('assistantFloating', '1');
    render(<AssistantChat variant="dock" />);
    await waitFor(() => expect(document.querySelector('[data-assistant-float]')).toBeTruthy());
  });

  it('does not offer floating on the full-page variant', async () => {
    mockFetch('hi');
    render(<AssistantChat variant="page" />);
    await waitReady();
    expect(screen.queryByRole('button', { name: /Float/ })).toBeNull();
  });

  it('shows a compact Qwen on/off pill when the pod is managed and powers it on', async () => {
    currentApp = makeApp({ role: 'admin', authRequired: false });
    fakeApi.assistantStatus = vi
      .fn()
      .mockResolvedValue({ configured: true, model: 'qwen', podManaged: true });
    fakeApi.assistantPod = vi.fn().mockResolvedValue({ configured: true, state: 'STOPPED' });
    render(<AssistantChat variant="dock" />);

    const pill = await screen.findByRole('button', { name: /Qwen off/ });
    fireEvent.click(pill);
    await waitFor(() => expect(fakeApi.assistantPodStart).toHaveBeenCalled());
  });
});
