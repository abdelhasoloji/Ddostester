import { useEffect, useRef, useState } from 'react';
import { api, getToken } from './api.js';
import { PageHead } from './pages.js';

/**
 * Assistant — a read-only conversational panel over the self-hosted LLM (Qwen).
 *
 * SAFETY: this screen only talks. It cannot launch campaigns or run anything;
 * the backend route is a text-only streaming proxy gated by `campaign:read`.
 * Any future action ("propose a bounded breakpoint campaign") must surface as a
 * proposal the operator approves through the existing governance, never fire
 * from here directly.
 */

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

type Status = 'checking' | 'ready' | 'not_configured';

export function AssistantPage() {
  const [status, setStatus] = useState<Status>('checking');
  const [model, setModel] = useState('qwen');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .assistantStatus()
      .then((s) => {
        setStatus(s.configured ? 'ready' : 'not_configured');
        if (s.model) setModel(s.model);
      })
      .catch(() => setStatus('not_configured'));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
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

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="assistant-page">
      <PageHead
        title="Assistant"
        sub="Copilote conversationnel — lecture & raisonnement uniquement (ne lance aucune campagne)."
      />

      {status === 'not_configured' && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <p className="hint">
            L'assistant n'est pas configuré côté serveur. Définis <code>ASSISTANT_ENDPOINT</code>{' '}
            (et <code>ASSISTANT_API_KEY</code>) sur l'API pour l'activer.
          </p>
        </div>
      )}

      <div className="card assistant-chat">
        <div className="assistant-log" ref={scrollRef}>
          {messages.length === 0 && (
            <p className="hint">
              Pose une question sur l'état de la plateforme, la résilience, la sécurité du code…
              L'assistant répond, il n'exécute rien.
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`assistant-msg assistant-msg-${m.role}`}>
              <span className="assistant-msg-role">{m.role === 'user' ? 'Vous' : model}</span>
              <div className="assistant-msg-body">
                {m.content || (busy && i === messages.length - 1 ? '…' : '')}
              </div>
            </div>
          ))}
        </div>

        {error && <p className="hint assistant-error">⚠ {error}</p>}

        <div className="assistant-input">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              status === 'ready'
                ? 'Écris ton message… (Entrée pour envoyer)'
                : 'Assistant indisponible'
            }
            disabled={status !== 'ready' || busy}
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
              disabled={status !== 'ready' || !input.trim()}
            >
              Envoyer
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
