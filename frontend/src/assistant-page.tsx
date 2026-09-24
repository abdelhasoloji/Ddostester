import { useEffect, useRef, useState } from 'react';
import { api, getToken, type PodState } from './api.js';
import { useApp, canDo } from './context.js';
import { PageHead } from './pages.js';
import { renderMarkdown } from './markdown.js';
import { extractActions } from './assistant-action.js';
import { AssistantActionCard } from './assistant-action-card.js';

/**
 * Assistant — an interactive conversational panel over the self-hosted LLM (Qwen).
 *
 * SAFETY / GOVERNANCE: the chat prepares actionable cards that the operator
 * completes inline (see assistant-action-card). Every step is governed and
 * server-enforced — RBAC gates each control, the approver differs from the
 * author (and the CISO co-signer from both), the frozen HARD_CAPS ceiling
 * clamps the bounds, and the kill switch stays live while a campaign runs.
 * The chat route itself stays a read-only text proxy.
 *
 * The GPU pod that serves Qwen bills per hour, so operators can power it on/off
 * from here (RunPod stop/resume, `assistant:manage`, audited). Chat is enabled
 * only while the pod is running.
 */

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

type Status = 'checking' | 'ready' | 'not_configured';

const POD_LABEL: Record<PodState, string> = {
  RUNNING: 'On',
  STARTING: 'Starting…',
  STOPPED: 'Off',
  UNKNOWN: 'Unknown',
};

/** Defensive-framed starter prompts, offered in the empty state. */
const STARTERS: string[] = [
  'Explain a bounded breakpoint controller (gradual ramp + back-off under distress).',
  'What are the best practices to harden an HTTP endpoint against amplification?',
  'Prepare a conservative resilience test against my authorized staging target.',
  'Help me register a new authorized target and propose tighter caps for it.',
];

export function AssistantPage() {
  const app = useApp();
  const canManage = canDo(app.role, 'assistantManage', app.authRequired);

  const [status, setStatus] = useState<Status>('checking');
  const [model, setModel] = useState('qwen');
  const [podManaged, setPodManaged] = useState(false);
  const [podState, setPodState] = useState<PodState>('UNKNOWN');
  const [podUptime, setPodUptime] = useState<number | undefined>(undefined);
  const [podBusy, setPodBusy] = useState(false);
  const [podError, setPodError] = useState<string | null>(null);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const chatReady = status === 'ready' && (!podManaged || podState === 'RUNNING');

  async function refreshPod() {
    try {
      const p = await api.assistantPod();
      setPodState(p.state);
      setPodUptime(p.uptimeSec);
      if (p.error) setPodError(p.error);
      return p.state;
    } catch {
      return 'UNKNOWN' as PodState;
    }
  }

  useEffect(() => {
    api
      .assistantStatus()
      .then((s) => {
        setStatus(s.configured ? 'ready' : 'not_configured');
        if (s.model) setModel(s.model);
        setPodManaged(s.podManaged);
        if (s.podManaged) void refreshPod();
      })
      .catch(() => setStatus('not_configured'));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (podManaged && podState === 'STARTING') {
      if (!pollRef.current) {
        pollRef.current = setInterval(() => void refreshPod(), 5000);
      }
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [podManaged, podState]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function powerOn() {
    setPodBusy(true);
    setPodError(null);
    setPodState('STARTING');
    try {
      const s = await api.assistantPodStart();
      setPodState(s.state === 'STOPPED' ? 'STARTING' : s.state);
    } catch (e) {
      setPodError(e instanceof Error ? e.message : 'Failed to start the pod.');
      void refreshPod();
    } finally {
      setPodBusy(false);
    }
  }

  async function powerOff() {
    setPodBusy(true);
    setPodError(null);
    try {
      const s = await api.assistantPodStop();
      setPodState(s.state === 'RUNNING' ? 'STOPPED' : s.state);
      setPodUptime(undefined);
    } catch (e) {
      setPodError(e instanceof Error ? e.message : 'Failed to stop the pod.');
      void refreshPod();
    } finally {
      setPodBusy(false);
    }
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || busy || !chatReady) return;
    setError(null);
    const history: Msg[] = [...messages, { role: 'user', content: text }];
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setBusy(true);

    const ac = new AbortController();
    abortRef.current = ac;
    const token = getToken();
    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ messages: history }),
      });
      if (!res.ok || !res.body) {
        throw new Error(
          res.status === 503 ? 'Assistant is not configured on the server.' : `Error ${res.status}`,
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let event = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const j = JSON.parse(payload);
              if (event === 'delta' && j.content) {
                setMessages((prev) => {
                  const next = prev.slice();
                  next[next.length - 1] = {
                    role: 'assistant',
                    content: next[next.length - 1].content + j.content,
                  };
                  return next;
                });
              } else if (event === 'error') {
                setError(j.message || 'Generation error.');
              }
            } catch {
              /* ignore keepalive / partial */
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : 'Request failed.');
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function resetConversation() {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setInput('');
  }

  function copyMsg(idx: number, text: string) {
    const done = () => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((v) => (v === idx ? null : v)), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {
        /* clipboard blocked — no-op */
      });
    }
  }

  /** Delegated copy for code blocks rendered inside assistant markdown. */
  function onLogClick(e: React.MouseEvent<HTMLDivElement>) {
    const btn = (e.target as HTMLElement).closest('.md-copy') as HTMLElement | null;
    if (!btn) return;
    const code = btn.closest('pre')?.querySelector('code')?.textContent ?? '';
    if (!code || !navigator.clipboard?.writeText) return;
    const label = btn.textContent;
    navigator.clipboard.writeText(code).then(
      () => {
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = label;
        }, 1200);
      },
      () => {
        /* clipboard blocked — no-op */
      },
    );
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const placeholder = !chatReady
    ? podManaged && podState !== 'RUNNING'
      ? 'Power Qwen on to chat…'
      : 'Assistant unavailable'
    : 'Write your message… (Enter to send)';

  return (
    <div className="assistant-page">
      <PageHead
        title="Assistant"
        sub="Conversational copilot — it reasons and runs actions inline, through governance: approval, HARD_CAPS and the kill switch still apply."
      />

      {podManaged && (
        <div className="card assistant-power">
          <div className={`assistant-power-state assistant-power-${podState.toLowerCase()}`}>
            <span className="assistant-power-dot" aria-hidden="true" />
            <div>
              <strong>Qwen&nbsp;·&nbsp;{POD_LABEL[podState]}</strong>
              <span className="hint assistant-power-sub">
                {podState === 'RUNNING'
                  ? `GPU running — remember to power off after use (~$0.60/h)${
                      podUptime ? ` · up ${Math.round(podUptime / 60)} min` : ''
                    }`
                  : podState === 'STARTING'
                    ? 'Starting the GPU (30–90 s)…'
                    : 'GPU off — no billing.'}
              </span>
            </div>
          </div>
          {canManage ? (
            <div className="assistant-power-actions">
              {podState === 'RUNNING' ? (
                <button
                  className="btn btn-ghost"
                  onClick={() => void powerOff()}
                  disabled={podBusy}
                >
                  Power off
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => void powerOn()}
                  disabled={podBusy || podState === 'STARTING'}
                >
                  {podState === 'STARTING' ? 'Starting…' : 'Power on'}
                </button>
              )}
            </div>
          ) : (
            <span className="hint">Power control is limited to operators.</span>
          )}
        </div>
      )}

      {podError && <p className="hint assistant-error">⚠ {podError}</p>}

      {status === 'not_configured' && !podManaged && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <p className="hint">
            The assistant is not configured on the server. Set <code>ASSISTANT_ENDPOINT</code> (and{' '}
            <code>ASSISTANT_API_KEY</code>) — or <code>RUNPOD_API_KEY</code> +{' '}
            <code>RUNPOD_POD_ID</code> for pod power control — on the API to enable it.
          </p>
        </div>
      )}

      <div className="card assistant-chat">
        <div className="assistant-chat-head">
          <span className="hint">
            {model}
            {busy ? ' · generating…' : ''}
          </span>
          {messages.length > 0 && (
            <button className="btn btn-ghost assistant-new" onClick={resetConversation}>
              New conversation
            </button>
          )}
        </div>

        <div className="assistant-log" ref={scrollRef} onClick={onLogClick}>
          {messages.length === 0 && (
            <div className="assistant-empty">
              <p className="hint">
                Ask about platform state, resilience, or code security. The assistant replies and
                can prepare actions — a test, a target, tighter caps — that you complete right here,
                through governance (approval · HARD_CAPS · kill switch).
              </p>
              <div className="assistant-starters">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="assistant-chip"
                    onClick={() => void send(s)}
                    disabled={!chatReady}
                    title={!chatReady ? 'Assistant unavailable' : undefined}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            if (m.role === 'user') {
              return (
                <div key={i} className="assistant-msg assistant-msg-user">
                  <div className="assistant-msg-head">
                    <span className="assistant-msg-role">You</span>
                    {m.content !== '' && (
                      <button
                        type="button"
                        className="assistant-copy"
                        onClick={() => copyMsg(i, m.content)}
                        aria-label="Copy message"
                        title="Copy"
                      >
                        {copiedIdx === i ? '✓ Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                  <div className="assistant-msg-body">{m.content}</div>
                </div>
              );
            }
            const { text, actions } = extractActions(m.content);
            return (
              <div key={i} className="assistant-msg assistant-msg-assistant">
                <div className="assistant-msg-head">
                  <span className="assistant-msg-role">{model}</span>
                  {m.content !== '' && (
                    <button
                      type="button"
                      className="assistant-copy"
                      onClick={() => copyMsg(i, m.content)}
                      aria-label="Copy message"
                      title="Copy"
                    >
                      {copiedIdx === i ? '✓ Copied' : 'Copy'}
                    </button>
                  )}
                </div>
                {text && (
                  <div
                    className="assistant-msg-body md"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
                  />
                )}
                {!text && m.content === '' && (
                  <div className="assistant-msg-body">{busy && isLast ? '…' : ''}</div>
                )}
                {actions.map((a, ai) => (
                  <AssistantActionCard key={ai} action={a} />
                ))}
              </div>
            );
          })}
        </div>

        {error && <p className="hint assistant-error">⚠ {error}</p>}

        <div className="assistant-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder}
            disabled={!chatReady || busy}
            rows={2}
          />
          {busy ? (
            <button className="btn btn-ghost" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => void send()}
              disabled={!chatReady || !input.trim()}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
