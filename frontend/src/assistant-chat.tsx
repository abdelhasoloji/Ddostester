import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, getToken, type PodState } from './api.js';
import { useApp, canDo } from './context.js';
import { renderMarkdown } from './markdown.js';
import { extractActions } from './assistant-action.js';
import { AssistantActionCard } from './assistant-action-card.js';
import { lsGet, lsSet } from './storage.js';
import { WedosMascot, type MascotState } from './wedos-mascot.js';
import { describeZoneAt, type ZoneInfo } from './assistant-zones.js';
import { onAiSupport } from './assistant-bus.js';

/**
 * AssistantChat — the conversational panel over the self-hosted LLM (Qwen),
 * reused in two places: the full-page Assistant route (`variant="page"`) and the
 * always-on docked column mounted in the app shell (`variant="dock"`).
 *
 * SAFETY / GOVERNANCE: the chat prepares actionable cards that the operator
 * completes inline (see assistant-action-card). Every step is governed and
 * server-enforced — RBAC gates each control, the approver differs from the
 * author (and the CISO co-signer from both), the frozen HARD_CAPS ceiling
 * clamps the bounds, and the kill switch stays live while a campaign runs. The
 * chat route itself is a read-only text proxy; the server injects live platform
 * context (targets, recent campaigns, caps) so answers reflect real state.
 *
 * PROACTIVITY: the panel watches live app state (campaign lifecycle + WRS
 * reports, newly authorized targets, effective caps, alerts). When something
 * changes and the GPU is on, it feeds Qwen a concise summary of the change and
 * asks for the most relevant NEXT actions — surfaced as the same governed cards.
 * This never runs anything on its own and never powers the pod on by itself; it
 * only proposes. A "Suggest" button triggers the same on demand, and an Auto
 * toggle (persisted) turns the automatic behavior off.
 *
 * HISTORY: conversations are saved per-browser (localStorage, via storage.ts —
 * no server store, so nothing leaves the operator's machine). Each finished turn
 * upserts the current conversation; the History panel reopens or deletes past
 * ones.
 *
 * The GPU pod that serves Qwen bills per hour, so operators can power it on/off
 * from here (RunPod stop/resume, `assistant:manage`, audited). Chat and proactive
 * suggestions are enabled only while the pod is running.
 */

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  /** True for a synthesized turn (proactive event or a manual "suggest"). */
  auto?: boolean;
  /** Friendly one-liner shown in place of the raw prompt for `auto` turns. */
  label?: string;
}

interface Convo {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Msg[];
}

type Status = 'checking' | 'ready' | 'not_configured';

/** Defensive-framed starter prompts, offered in the empty state. */
const STARTERS: string[] = [
  'What are my authorized targets and current caps?',
  'How did my most recent campaigns do (status + WRS)?',
  'Prepare a conservative resilience test against my authorized staging target.',
  'What are the best practices to harden an HTTP endpoint against amplification?',
];

const CONVOS_KEY = 'assistantConvos';
const AUTO_KEY = 'assistantAutoSuggest';
const FLOAT_KEY = 'assistantFloating';
const FLOATPOS_KEY = 'assistantFloatPos';
const MAX_CONVOS = 50;
/** Minimum gap between two automatic suggestions (debounce bursts). */
const PROACTIVE_MIN_MS = 15000;

/** Floating-companion window footprint (px), used for drag clamping. */
const FLOAT_W = 300;
const FLOAT_H = 320;
/** How long the zone explanation lingers (and the mascot keeps "speaking") after a drop. */
const EXPLAIN_MS = 7000;

function loadFloatPos(): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const fallback = { x: Math.max(8, vw - FLOAT_W - 24), y: Math.max(8, vh - FLOAT_H - 40) };
  try {
    const raw = lsGet(FLOATPOS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as { x?: number; y?: number };
    if (typeof p.x !== 'number' || typeof p.y !== 'number') return fallback;
    return {
      x: Math.min(Math.max(4, p.x), Math.max(4, vw - 80)),
      y: Math.min(Math.max(4, p.y), Math.max(4, vh - 80)),
    };
  } catch {
    return fallback;
  }
}

function isMsg(v: unknown): v is Msg {
  return (
    !!v &&
    typeof v === 'object' &&
    ((v as Msg).role === 'user' || (v as Msg).role === 'assistant') &&
    typeof (v as Msg).content === 'string'
  );
}

function isConvo(v: unknown): v is Convo {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Convo).id === 'string' &&
    Array.isArray((v as Convo).messages) &&
    (v as Convo).messages.every(isMsg)
  );
}

/** Loads saved conversations, tolerating any malformed / disabled store. */
function loadConvos(): Convo[] {
  try {
    const raw = lsGet(CONVOS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isConvo);
  } catch {
    return [];
  }
}

function saveConvos(list: Convo[]): void {
  lsSet(CONVOS_KEY, JSON.stringify(list.slice(0, MAX_CONVOS)));
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** First real (non-auto) user line, else an auto label — condensed to a title. */
function deriveTitle(messages: Msg[]): string {
  const typed = messages.find((m) => m.role === 'user' && !m.auto && m.content.trim());
  const auto = messages.find((m) => m.role === 'user' && m.auto);
  const raw = (typed?.content ?? auto?.label ?? '').trim().replace(/\s+/g, ' ');
  if (!raw) return 'New conversation';
  return raw.length > 60 ? raw.slice(0, 57) + '…' : raw;
}

/** Trailing empty assistant placeholder (aborted before any delta) — drop it. */
function trimTrailing(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  return last && last.role === 'assistant' && last.content === ''
    ? messages.slice(0, -1)
    : messages;
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

export function AssistantChat({
  variant = 'page',
  onCollapse,
}: {
  variant?: 'page' | 'dock';
  onCollapse?: () => void;
}) {
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
  const [inputFocused, setInputFocused] = useState(false);

  // A card's "AI support" button pre-loads that block's context into the
  // composer for an interactive exchange (the Layout opens the dock).
  useEffect(
    () =>
      onAiSupport((req) => {
        setInput(
          `About "${req.title}": ${req.context}\n\nHelp me interpret this and suggest the next actions.`,
        );
      }),
    [],
  );

  const [convos, setConvos] = useState<Convo[]>(() => loadConvos());
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [autoSuggest, setAutoSuggest] = useState<boolean>(() => lsGet(AUTO_KEY) !== '0');

  // Floating companion: detach the assistant into a draggable window that
  // explains whatever zone it is dropped on. Only the always-on dock owns it.
  const canFloat = variant === 'dock';
  const [floating, setFloating] = useState<boolean>(() => canFloat && lsGet(FLOAT_KEY) === '1');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => loadFloatPos());
  const [dragging, setDragging] = useState(false);
  const [zone, setZone] = useState<ZoneInfo | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const explainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Proactive-observer baselines (see the effect below).
  const initedRef = useRef(false);
  const prevCampaignsRef = useRef<Map<string, string>>(new Map());
  const prevWrsRef = useRef<Map<string, number>>(new Map());
  const prevAllowedRef = useRef<Set<string>>(new Set());
  const prevCapsRef = useRef<string>('');
  const prevAlertsRef = useRef<Set<string>>(new Set());
  const lastProactiveRef = useRef<number>(0);
  // send() is redefined each render; the observer reads it through this ref.
  const sendRef = useRef<(t: string, o?: { auto?: boolean; label?: string }) => void>(() => {});

  const chatReady = status === 'ready' && (!podManaged || podState === 'RUNNING');

  // Map live assistant activity onto the mascot's animation state. Priority:
  // being dragged (shaken) > explaining a zone (speaking) > chatting > listening.
  const lastMsg = messages[messages.length - 1];
  const explaining = zone !== null && !dragging;
  const mascotState: MascotState = dragging
    ? 'shaken'
    : explaining
      ? 'speaking'
      : chatReady && busy
        ? lastMsg?.role === 'assistant' && lastMsg.content.length > 0
          ? 'speaking'
          : 'thinking'
        : chatReady && inputFocused
          ? 'listening'
          : 'idle';
  const podOff = podManaged && podState !== 'RUNNING';
  const statePillLabel = dragging
    ? 'Moving'
    : explaining
      ? 'Explaining'
      : podOff
        ? 'Off'
        : status !== 'ready'
          ? '…'
          : mascotState === 'thinking'
            ? 'Thinking'
            : mascotState === 'speaking'
              ? 'Speaking'
              : mascotState === 'listening'
                ? 'Listening'
                : 'Ready';
  const statePillCls =
    dragging || explaining
      ? 'busy'
      : podOff || status !== 'ready'
        ? 'off'
        : mascotState === 'idle'
          ? 'ready'
          : 'busy';

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
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    lsSet(AUTO_KEY, autoSuggest ? '1' : '0');
  }, [autoSuggest]);

  useEffect(() => {
    if (canFloat) lsSet(FLOAT_KEY, floating ? '1' : '0');
  }, [floating, canFloat]);

  useEffect(() => {
    lsSet(FLOATPOS_KEY, JSON.stringify(pos));
  }, [pos]);

  // Clear the pending zone-explanation timer if the component unmounts.
  useEffect(
    () => () => {
      if (explainTimerRef.current) clearTimeout(explainTimerRef.current);
    },
    [],
  );

  /**
   * Persist the current conversation once a turn settles (never mid-stream, so
   * we don't write per token). Assigns an id lazily on the first saved turn.
   */
  useEffect(() => {
    if (busy) return;
    const clean = trimTrailing(messages);
    if (clean.length === 0) return;
    let id = currentId;
    if (!id) {
      id = genId();
      setCurrentId(id);
    }
    const cid = id;
    const now = Date.now();
    const title = deriveTitle(clean);
    setConvos((prev) => {
      const existing = prev.find((c) => c.id === cid);
      const convo: Convo = {
        id: cid,
        title,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        messages: clean,
      };
      const next = [convo, ...prev.filter((c) => c.id !== cid)].slice(0, MAX_CONVOS);
      saveConvos(next);
      return next;
    });
  }, [messages, busy]);

  /**
   * Proactive observer. Diffs live app state against the last snapshot; on a
   * meaningful change it feeds Qwen a concise event summary and asks for the
   * next actions. Guards: only when Auto is on, the pod is ready, we aren't
   * mid-stream, and not more often than PROACTIVE_MIN_MS. It NEVER powers the
   * pod on — if the GPU is off the change is simply consumed (baseline resync)
   * so turning the pod on later doesn't replay a backlog.
   */
  useEffect(() => {
    const campaignsArr = app.campaigns ?? [];
    const alertsArr = app.alerts ?? [];
    const allowedArr = app.allowed ?? [];
    const snapCampaigns = new Map(campaignsArr.map((c) => [c.id, c.status]));
    const snapWrs = new Map<string, number>();
    for (const c of campaignsArr) if (c.wrs) snapWrs.set(c.id, c.wrs.wrs);
    const snapAllowed = new Set(allowedArr);
    const snapCaps = JSON.stringify(app.hardCaps);
    const snapAlerts = new Set(alertsArr.map((a) => a.key));

    const resync = () => {
      prevCampaignsRef.current = snapCampaigns;
      prevWrsRef.current = snapWrs;
      prevAllowedRef.current = snapAllowed;
      prevCapsRef.current = snapCaps;
      prevAlertsRef.current = snapAlerts;
    };

    if (!initedRef.current) {
      initedRef.current = true;
      resync();
      return;
    }

    const events: string[] = [];
    const nameById = new Map(campaignsArr.map((c) => [c.id, c.name]));

    for (const c of campaignsArr) {
      const prev = prevCampaignsRef.current.get(c.id);
      if (prev === undefined) {
        events.push(
          `New campaign "${c.name}" was created (status ${c.status}, target ${c.target}).`,
        );
      } else if (prev !== c.status) {
        const wrs = c.wrs ? ` — WRS ${c.wrs.wrs} (${c.wrs.level})` : '';
        events.push(`Campaign "${c.name}" changed ${prev} → ${c.status}${wrs}.`);
      }
    }
    for (const c of campaignsArr) {
      if (!c.wrs) continue;
      const prevWrs = prevWrsRef.current.get(c.id);
      const known = prevCampaignsRef.current.has(c.id);
      // Report arriving for a campaign whose status did not itself change.
      if (known && prevWrs === undefined && prevCampaignsRef.current.get(c.id) === c.status) {
        events.push(`Report ready for "${c.name}": WRS ${c.wrs.wrs} (${c.wrs.level}).`);
      }
    }
    for (const host of snapAllowed) {
      if (!prevAllowedRef.current.has(host)) {
        events.push(`Target "${host}" is now authorized.`);
      }
    }
    if (prevCapsRef.current && prevCapsRef.current !== snapCaps) {
      events.push(`Effective operational caps changed to ${snapCaps}.`);
    }
    for (const a of alertsArr) {
      if (!prevAlertsRef.current.has(a.key)) {
        const who = a.campaignId ? nameById.get(a.campaignId) : a.target;
        events.push(
          `New ${a.severity} alert (${a.kind}) — ${a.title}${who ? ` [${who}]` : ''}: ${a.detail}`,
        );
      }
    }

    if (events.length === 0) {
      resync();
      return;
    }

    const canFire =
      autoSuggest && chatReady && !busy && Date.now() - lastProactiveRef.current > PROACTIVE_MIN_MS;

    if (canFire) {
      lastProactiveRef.current = Date.now();
      resync();
      const summary = events.slice(0, 6).join(' ');
      const label =
        events.length === 1 ? events[0] : `${events.length} platform changes just occurred`;
      const prompt =
        `[Automatic platform event] ${summary}\n\n` +
        'Given this change and my live platform context, briefly say what it means and ' +
        'prepare the most relevant next action(s) as governed action cards where warranted. ' +
        'Stay conservative and defensive; only target already-authorized hosts; do not repeat ' +
        'my whole context back to me. If nothing is needed, say so in one line.';
      sendRef.current(prompt, { auto: true, label });
    } else if (autoSuggest && chatReady && busy) {
      // Defer: keep the delta so it fires once the current stream settles.
      return;
    } else {
      // Auto off, pod off, or throttled → consume so we don't replay later.
      resync();
    }
  }, [app.campaigns, app.alerts, app.allowed, app.hardCaps, autoSuggest, chatReady, busy]);

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

  async function send(text: string, opts?: { auto?: boolean; label?: string }) {
    const body = text.trim();
    if (!body || busy || !chatReady) return;
    setError(null);
    const userMsg: Msg = {
      role: 'user',
      content: body,
      auto: opts?.auto,
      label: opts?.label,
    };
    const history: Msg[] = [...messages, userMsg];
    setMessages([...history, { role: 'assistant', content: '' }]);
    if (!opts?.auto) setInput('');
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
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
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
  sendRef.current = send;

  function sendInput() {
    void send(input);
  }

  /** Manual, on-demand "what next?" — same governed suggestion path. */
  function suggestNow() {
    void send(
      'Given my current platform state (authorized targets, recent campaigns and their WRS, ' +
        'effective caps, and any active alerts), what are the most relevant next actions right now? ' +
        'Prepare governed action cards where warranted. Be concise.',
      { auto: true, label: 'Requested next-action suggestions' },
    );
  }

  function stop() {
    abortRef.current?.abort();
  }

  /** Start a fresh conversation. The previous one is already saved in `convos`. */
  function resetConversation() {
    abortRef.current?.abort();
    setMessages([]);
    setCurrentId(null);
    setError(null);
    setInput('');
    setShowHistory(false);
  }

  /** Reopen a saved conversation from the history panel. */
  function openConvo(id: string) {
    abortRef.current?.abort();
    const c = convos.find((x) => x.id === id);
    if (!c) return;
    setMessages(c.messages);
    setCurrentId(id);
    setError(null);
    setInput('');
    setShowHistory(false);
  }

  function deleteConvo(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setConvos((prev) => {
      const next = prev.filter((c) => c.id !== id);
      saveConvos(next);
      return next;
    });
    if (id === currentId) {
      setMessages([]);
      setCurrentId(null);
      setInput('');
    }
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
      sendInput();
    }
  }

  function sampleZone(): ZoneInfo | null {
    const el = floatRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return describeZoneAt(r.left + r.width / 2, r.top + r.height / 2);
  }

  function onFloatDragStart(e: React.PointerEvent) {
    if (e.button != null && e.button !== 0) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    setDragging(true);
    if (explainTimerRef.current) {
      clearTimeout(explainTimerRef.current);
      explainTimerRef.current = null;
    }
    setZone(null);
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / unsupported */
    }
  }

  function onFloatDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.min(Math.max(4, e.clientX - d.dx), Math.max(4, vw - 60));
    const y = Math.min(Math.max(4, e.clientY - d.dy), Math.max(4, vh - 60));
    setPos({ x, y });
  }

  function onFloatDragEnd(e: React.PointerEvent) {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    try {
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    // Explain whatever the window now sits over; keep "speaking" briefly.
    const z = sampleZone();
    if (z) {
      setZone(z);
      if (explainTimerRef.current) clearTimeout(explainTimerRef.current);
      explainTimerRef.current = setTimeout(() => setZone(null), EXPLAIN_MS);
    }
  }

  function toggleFloat() {
    setFloating((v) => {
      const next = !v;
      if (next) setPos(loadFloatPos());
      return next;
    });
  }

  const placeholder = !chatReady
    ? podManaged && podState !== 'RUNNING'
      ? 'Power Qwen on to chat…'
      : 'Assistant unavailable'
    : 'Write your message… (Enter to send)';

  // Compact power control replacing the old banner: one on/off pill.
  const podToggle = podManaged ? (
    <button
      type="button"
      className={`assistant-pod-btn assistant-pod-${podState.toLowerCase()}`}
      onClick={() => (podState === 'RUNNING' ? void powerOff() : void powerOn())}
      disabled={!canManage || podBusy || podState === 'STARTING'}
      title={
        !canManage
          ? 'Power control is limited to operators'
          : podState === 'RUNNING'
            ? `Qwen GPU is on${
                podUptime ? ` (up ${Math.round(podUptime / 60)} min)` : ''
              } — click to power off (~$0.60/h while on)`
            : podState === 'STARTING'
              ? 'Starting the GPU (30–90 s)…'
              : 'Power the Qwen GPU on (~$0.60/h)'
      }
      aria-pressed={podState === 'RUNNING'}
      aria-label={`Qwen ${podState === 'RUNNING' ? 'on, click to power off' : 'off, click to power on'}`}
    >
      <span className="assistant-pod-dot" aria-hidden="true" />
      Qwen {podState === 'RUNNING' ? 'on' : podState === 'STARTING' ? '…' : 'off'}
    </button>
  ) : null;

  const detachBtn = canFloat ? (
    <button
      type="button"
      className="btn btn-ghost assistant-detach"
      onClick={toggleFloat}
      title="Detach the assistant into a floating window you can drag anywhere"
      aria-pressed={floating}
    >
      ⤢ Float
    </button>
  ) : null;

  // The message composer, shared verbatim by the panel and the floating window.
  const composer = (cls: string) => (
    <div className={`assistant-input${cls ? ' ' + cls : ''}`}>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        onFocus={() => setInputFocused(true)}
        onBlur={() => setInputFocused(false)}
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
          onClick={sendInput}
          disabled={!chatReady || !input.trim()}
        >
          Send
        </button>
      )}
    </div>
  );

  // What the floating mascot "says": the zone it was dropped on wins; otherwise
  // its latest answer, so a live reply is still readable in the compact window.
  const floatBubble = zone
    ? { title: zone.title, body: zone.text }
    : lastMsg?.role === 'assistant' && lastMsg.content.trim()
      ? { title: model, body: extractActions(lastMsg.content).text || lastMsg.content }
      : null;

  const floatWindow =
    canFloat && floating && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={floatRef}
            data-assistant-float=""
            className={`assistant-chat-root assistant-chat-float${dragging ? ' is-dragging' : ''}`}
            style={{ left: pos.x, top: pos.y, width: FLOAT_W }}
          >
            {floatBubble && (
              <div className="assistant-float-bubble">
                <span className="assistant-float-bubble-title">{floatBubble.title}</span>
                <span className="assistant-float-bubble-body">{floatBubble.body}</span>
              </div>
            )}
            <div
              className="assistant-float-handle"
              onPointerDown={onFloatDragStart}
              onPointerMove={onFloatDragMove}
              onPointerUp={onFloatDragEnd}
              onPointerCancel={onFloatDragEnd}
              role="button"
              tabIndex={0}
              aria-label="Drag the assistant — drop it on a panel to have it explained"
              title="Drag me onto any panel and I’ll explain it"
            >
              <WedosMascot state={mascotState} width={110} height={140} />
              <span className={`assistant-statepill assistant-statepill-${statePillCls}`}>
                {statePillLabel}
              </span>
            </div>
            {composer('assistant-float-input')}
            <div className="assistant-float-bar">
              {podToggle}
              <button
                type="button"
                className="btn btn-ghost assistant-suggest"
                onClick={suggestNow}
                disabled={!chatReady || busy}
                title={!chatReady ? 'Power Qwen on to get suggestions' : 'Suggest next actions'}
              >
                Suggest
              </button>
              <button
                type="button"
                className="btn btn-ghost assistant-detach"
                onClick={toggleFloat}
                title="Dock the assistant back"
              >
                ⤡ Dock
              </button>
            </div>
          </div>,
          document.body,
        )
      : null;

  // When floating, the dock column steps aside to a small "docked away" note and
  // the real UI lives in the portal window above.
  if (canFloat && floating) {
    return (
      <>
        <div className="assistant-chat-root assistant-chat-dock assistant-docked-away">
          <p className="hint assistant-docked-note">
            🛰 The assistant is floating — drag it over any panel for an explanation.{' '}
            <button type="button" className="btn btn-ghost" onClick={toggleFloat}>
              ⤡ Dock it back
            </button>
          </p>
        </div>
        {floatWindow}
      </>
    );
  }

  return (
    <div className={`assistant-chat-root assistant-chat-${variant}`}>
      <div className="assistant-hero">
        <WedosMascot
          state={mascotState}
          width={variant === 'dock' ? 96 : 150}
          height={variant === 'dock' ? 126 : 196}
        />
        <span className={`assistant-statepill assistant-statepill-${statePillCls}`}>
          {statePillLabel}
        </span>
      </div>
      {variant === 'dock' && (
        <div className="assistant-dock-head">
          <strong>WEDOS AI Assistant</strong>
          <span className="hint">context-aware · governed</span>
          {onCollapse && (
            <button
              type="button"
              className="assistant-dock-collapse"
              onClick={onCollapse}
              title="Collapse the assistant"
              aria-label="Collapse the assistant"
            >
              ⟩
            </button>
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
          <div className="assistant-head-actions">
            {podToggle}
            {detachBtn}
            <label
              className="assistant-auto-toggle"
              title="When on, Qwen proactively suggests next actions after platform changes (only while the pod is running)."
            >
              <input
                type="checkbox"
                checked={autoSuggest}
                onChange={(e) => setAutoSuggest(e.target.checked)}
              />
              Auto
            </label>
            <button
              type="button"
              className="btn btn-ghost assistant-suggest"
              onClick={suggestNow}
              disabled={!chatReady || busy}
              title={!chatReady ? 'Power Qwen on to get suggestions' : 'Suggest next actions'}
            >
              Suggest
            </button>
            <button
              type="button"
              className={`btn btn-ghost assistant-history-toggle${showHistory ? ' is-active' : ''}`}
              onClick={() => setShowHistory((v) => !v)}
              aria-pressed={showHistory}
            >
              History{convos.length ? ` (${convos.length})` : ''}
            </button>
            {messages.length > 0 && (
              <button className="btn btn-ghost assistant-new" onClick={resetConversation}>
                New conversation
              </button>
            )}
          </div>
        </div>

        {showHistory ? (
          <div className="assistant-history">
            <div className="assistant-history-head">
              <strong>Conversations</strong>
              <button type="button" className="btn btn-ghost" onClick={() => setShowHistory(false)}>
                ⟨ Back
              </button>
            </div>
            {convos.length === 0 ? (
              <p className="hint assistant-history-empty">
                No saved conversations yet. Conversations are kept in this browser only.
              </p>
            ) : (
              <ul className="assistant-history-list">
                {convos.map((c) => (
                  <li
                    key={c.id}
                    className={`assistant-history-item${c.id === currentId ? ' is-current' : ''}`}
                  >
                    <button
                      type="button"
                      className="assistant-history-open"
                      onClick={() => openConvo(c.id)}
                    >
                      <span className="assistant-history-title">{c.title}</span>
                      <span className="hint assistant-history-meta">
                        {fmtWhen(c.updatedAt)} ·{' '}
                        {c.messages.filter((m) => m.role === 'user').length} message
                        {c.messages.filter((m) => m.role === 'user').length === 1 ? '' : 's'}
                        {c.id === currentId ? ' · current' : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="assistant-history-del"
                      onClick={(e) => deleteConvo(c.id, e)}
                      aria-label="Delete conversation"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <div className="assistant-log" ref={scrollRef} onClick={onLogClick}>
              {messages.length === 0 && (
                <div className="assistant-empty">
                  <p className="hint">
                    Ask about platform state, resilience, or code security. The assistant sees your
                    live context (authorized targets, recent campaigns, caps) and, with Auto on,
                    proposes next actions after platform changes — a test, a target, tighter caps —
                    that you complete right here, through governance (approval · HARD_CAPS · kill
                    switch).
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
                  if (m.auto) {
                    return (
                      <div key={i} className="assistant-auto-note" title={m.content}>
                        <span className="assistant-auto-badge">⚡ Auto</span>
                        <span className="assistant-auto-text">
                          {m.label || 'Next-action check'}
                        </span>
                      </div>
                    );
                  }
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
                        dangerouslySetInnerHTML={{
                          __html: renderMarkdown(text),
                        }}
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

            {composer('')}
          </>
        )}
      </div>
    </div>
  );
}
