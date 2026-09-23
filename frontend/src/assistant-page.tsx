import { useEffect, useRef, useState } from 'react';
import { api, getToken, type PodState } from './api.js';
import { useApp, canDo } from './context.js';
import { PageHead } from './pages.js';
import { renderMarkdown } from './markdown.js';

/**
 * Assistant — a read-only conversational panel over the self-hosted LLM (Qwen).
 *
 * SAFETY: this screen only talks. It cannot launch campaigns or run anything;
 * the backend route is a text-only streaming proxy gated by `campaign:read`.
 * Any future action ("propose a bounded breakpoint campaign") must surface as a
 * proposal the operator approves through the existing governance, never fire
 * from here directly.
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
  RUNNING: 'Allumé',
  STARTING: 'Démarrage…',
  STOPPED: 'Éteint',
  UNKNOWN: 'Indéterminé',
};

/** Defensive-framed starter prompts, offered in the empty state. */
const STARTERS: string[] = [
  'Explique la logique d’un breakpoint controller borné (montée graduelle + back-off sous distress).',
  'Quelles bonnes pratiques pour durcir un endpoint HTTP contre l’amplification ?',
  'Comment interpréter TTD / TTM dans un test de mitigation défensif ?',
  'Relis ce plan de test de résilience : est-il borné, réversible et capé ?',
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
      setPodError(e instanceof Error ? e.message : 'Échec du démarrage.');
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
      setPodError(e instanceof Error ? e.message : "Échec de l'arrêt.");
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
          res.status === 503 ? 'Assistant non configuré côté serveur.' : `Erreur ${res.status}`,
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
                setError(j.message || 'Erreur de génération.');
              }
            } catch {
              /* ignore keepalive / partial */
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : 'Échec de la requête.');
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

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const placeholder = !chatReady
    ? podManaged && podState !== 'RUNNING'
      ? 'Allume Qwen pour discuter…'
      : 'Assistant indisponible'
    : 'Écris ton message… (Entrée pour envoyer)';

  return (
    <div className="assistant-page">
      <PageHead
        title="Assistant"
        sub="Copilote conversationnel — lecture & raisonnement uniquement (ne lance aucune campagne)."
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
                  ? `GPU actif — pense à éteindre après usage (~0,60 $/h)${
                      podUptime ? ` · up ${Math.round(podUptime / 60)} min` : ''
                    }`
                  : podState === 'STARTING'
                    ? 'Démarrage du GPU (30–90 s)…'
                    : 'GPU éteint — aucune facturation.'}
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
                  Éteindre
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => void powerOn()}
                  disabled={podBusy || podState === 'STARTING'}
                >
                  {podState === 'STARTING' ? 'Démarrage…' : 'Allumer'}
                </button>
              )}
            </div>
          ) : (
            <span className="hint">Alimentation réservée aux opérateurs.</span>
          )}
        </div>
      )}

      {podError && <p className="hint assistant-error">⚠ {podError}</p>}

      {status === 'not_configured' && !podManaged && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <p className="hint">
            L'assistant n'est pas configuré côté serveur. Définis <code>ASSISTANT_ENDPOINT</code>{' '}
            (et <code>ASSISTANT_API_KEY</code>) — ou <code>RUNPOD_API_KEY</code> +{' '}
            <code>RUNPOD_POD_ID</code> pour le pilotage du pod — sur l'API pour l'activer.
          </p>
        </div>
      )}

      <div className="card assistant-chat">
        <div className="assistant-chat-head">
          <span className="hint">
            {model}
            {busy ? ' · génère…' : ''}
          </span>
          {messages.length > 0 && (
            <button className="btn btn-ghost assistant-new" onClick={resetConversation}>
              Nouvelle conversation
            </button>
          )}
        </div>

        <div className="assistant-log" ref={scrollRef}>
          {messages.length === 0 && (
            <div className="assistant-empty">
              <p className="hint">
                Pose une question sur l'état de la plateforme, la résilience ou la sécurité du code.
                L'assistant répond, il n'exécute rien.
              </p>
              <div className="assistant-starters">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="assistant-chip"
                    onClick={() => void send(s)}
                    disabled={!chatReady}
                    title={!chatReady ? 'Assistant indisponible' : undefined}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const showMd = m.role === 'assistant' && m.content !== '';
            return (
              <div key={i} className={`assistant-msg assistant-msg-${m.role}`}>
                <div className="assistant-msg-head">
                  <span className="assistant-msg-role">{m.role === 'user' ? 'Vous' : model}</span>
                  {m.content !== '' && (
                    <button
                      type="button"
                      className="assistant-copy"
                      onClick={() => copyMsg(i, m.content)}
                      aria-label="Copier le message"
                      title="Copier"
                    >
                      {copiedIdx === i ? '✓ Copié' : 'Copier'}
                    </button>
                  )}
                </div>
                {showMd ? (
                  <div
                    className="assistant-msg-body md"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                  />
                ) : (
                  <div className="assistant-msg-body">
                    {m.content || (busy && isLast ? '…' : '')}
                  </div>
                )}
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
              Envoyer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
