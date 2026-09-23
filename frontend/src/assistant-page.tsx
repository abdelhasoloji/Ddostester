import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken, type PodState } from './api.js';
import { useApp, canDo } from './context.js';
import { PageHead } from './pages.js';
import { renderMarkdown } from './markdown.js';
import {
  extractProposals,
  proposalOverCaps,
  proposalToSeed,
  type AssistantProposal,
} from './assistant-proposal.js';

/**
 * Assistant — an interactive conversational panel over the self-hosted LLM (Qwen).
 *
 * SAFETY / GOVERNANCE: this screen talks and can surface ACTION PROPOSALS, but it
 * never executes anything. A proposal the operator validates is queued as a draft
 * campaign and opened in the existing recon-first create flow, where it still
 * needs operator review, CISO approval, the frozen HARD_CAPS ceiling (enforced
 * server-side) and the kill-switch. No campaign is ever launched from here.
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
  'How should I read TTD / TTM in a defensive mitigation test?',
  'Propose a conservative resilience test against my authorized staging target.',
];

export function AssistantPage() {
  const app = useApp();
  const navigate = useNavigate();
  const canManage = canDo(app.role, 'assistantManage', app.authRequired);
  const canCreate = canDo(app.role, 'create', app.authRequired);

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

  // Chat is usable when the endpoint is configured AND — if the pod is managed —
  // the pod is running.
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

  // While the pod is starting, poll until it settles.
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

  /**
   * Validate a proposed action: queue it as a draft campaign and open the
   * governed create flow. This NEVER launches — the operator reviews it there,
   * a CISO approves, and HARD_CAPS are enforced server-side.
   */
  function reviewProposal(p: AssistantProposal) {
    app.queueReplay(proposalToSeed(p));
    navigate('/campaigns');
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
        sub="Conversational copilot — it reasons and proposes; it never launches. You validate any action through governance."
      />

      {/* GPU pod power control — visible only when the pod is managed. */}
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

        <div className="assistant-log" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="assistant-empty">
              <p className="hint">
                Ask about platform state, resilience, or code security. The assistant replies and can
                propose a bounded test — it never runs anything itself.
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
            const { text, proposals } = extractProposals(m.content);
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
                {proposals.map((p, pi) => {
                  const over = proposalOverCaps(p);
                  return (
                    <div key={pi} className="assistant-proposal">
                      <div className="assistant-proposal-head">
                        <span className="assistant-proposal-tag">Proposed action</span>
                        <strong>{p.name}</strong>
                      </div>
                      <dl className="assistant-proposal-grid">
                        <div>
                          <dt>Target</dt>
                          <dd className="mono">{p.target}</dd>
                        </div>
                        <div>
                          <dt>Vector</dt>
                          <dd>{p.vector}</dd>
                        </div>
                        <div>
                          <dt>Max RPS</dt>
                          <dd className={over.includes('maxRps') ? 'over' : undefined}>{p.maxRps}</dd>
                        </div>
                        <div>
                          <dt>Concurrency</dt>
                          <dd className={over.includes('concurrency') ? 'over' : undefined}>
                            {p.concurrency}
                          </dd>
                        </div>
                        <div>
                          <dt>Duration</dt>
                          <dd className={over.includes('maxDurationSec') ? 'over' : undefined}>
                            {p.maxDurationSec}s
                          </dd>
                        </div>
                      </dl>
                      {p.rationale && <p className="assistant-proposal-why">{p.rationale}</p>}
                      {over.length > 0 && (
                        <p className="hint assistant-error">
                          ⚠ Above the safety ceiling ({over.join(', ')}) — it will be clamped on
                          review.
                        </p>
                      )}
                      <div className="assistant-proposal-actions">
                        {canCreate ? (
                          <button className="btn btn-primary" onClick={() => reviewProposal(p)}>
                            Review in campaign builder →
                          </button>
                        ) : (
                          <span className="hint">
                            An engineer configures and launches this; a CISO approves it.
                          </span>
                        )}
                      </div>
                      <p className="assistant-proposal-note">
                        A proposal only — nothing runs until you review it and it clears governance
                        (approval · HARD_CAPS · kill-switch).
                      </p>
                    </div>
                  );
                })}
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
