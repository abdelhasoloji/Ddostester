import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useApp } from './context.js';
import { reportUrl, getGrafanaBase, grafanaDashUrl } from './api.js';
import type { Alert } from './api.js';
import { hostOf } from './campaign-form.js';
import { lsGet, lsSet } from './storage.js';

// ---------- Notifications (the alerts, reworked into a bell + panel) ----------

const ALERT_ICON: Record<Alert['kind'], string> = {
  tarpit: '🕳',
  'low-wrs': '📉',
  degraded: '📡',
  'auto-killed': '🛑',
  'not-engaging': '🚱',
  'wrs-regression': '⤵',
  'protection-regression': '⤵',
};
function alertIcon(kind: Alert['kind']): string {
  return ALERT_ICON[kind] ?? '🔔';
}

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago"). */
function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const NOTIF_READ_KEY = 'shieldtest.notif.read';
function loadReadKeys(): Set<string> {
  const raw = lsGet(NOTIF_READ_KEY);
  try {
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveReadKeys(keys: Set<string>): void {
  lsSet(NOTIF_READ_KEY, JSON.stringify([...keys]));
}

/**
 * Navigate to what an alert is about: the owning campaign's detail drawer when
 * we still have it, otherwise the run's report. Shared by the bell panel and the
 * Command Center list so a notification is always actionable, never a dead line.
 */
export function useOpenAlert(): (a: Alert) => void {
  const app = useApp();
  const navigate = useNavigate();
  return useCallback(
    (a: Alert) => {
      const c = a.campaignId ? app.campaigns.find((x) => x.id === a.campaignId) : undefined;
      if (c) {
        navigate('/campaigns');
        void app.openDetail(c);
      } else if (a.runId) {
        window.open(reportUrl(a.runId), '_blank', 'noopener');
      }
    },
    [app, navigate],
  );
}

const alertWorst = (list: Alert[]): 'critical' | 'warning' | 'info' =>
  list.some((a) => a.severity === 'critical')
    ? 'critical'
    : list.some((a) => a.severity === 'warning')
      ? 'warning'
      : 'info';

/** A single actionable notification row (clickable body + mark-read ×). */
function NotificationRow({
  a,
  read,
  onOpen,
  onRead,
}: {
  a: Alert;
  read: boolean;
  onOpen: (a: Alert) => void;
  onRead: (key: string) => void;
}) {
  // Investigation links (E10): Grafana deep-linked to this run's exact window.
  const grafanaBase = getGrafanaBase();
  const finishedMs = a.at ? Date.parse(a.at) : NaN;
  const grafanaHref =
    grafanaBase && a.target && !Number.isNaN(finishedMs)
      ? grafanaDashUrl(grafanaBase, 'run', {
          target: hostOf(a.target) ?? a.target,
          fromMs: a.durationSec ? finishedMs - a.durationSec * 1000 - 60_000 : undefined,
          toMs: finishedMs + 60_000,
        })
      : null;
  const absTime = a.at && !Number.isNaN(finishedMs) ? new Date(finishedMs).toLocaleString() : '';
  return (
    <li className={`notif-item alert-${a.severity}${read ? ' is-read' : ''}`}>
      <button className="notif-item-main" onClick={() => onOpen(a)}>
        <span className="alert-dot" aria-hidden="true" />
        <span className="notif-item-body">
          <span className="notif-item-title">
            <span aria-hidden="true">{alertIcon(a.kind)}</span> {a.title}
          </span>
          <span className="notif-item-detail">{a.detail}</span>
          {(a.metric || a.engine || a.durationSec != null) && (
            <span className="notif-item-chips">
              {a.metric && (
                <span className="notif-chip notif-chip-metric">
                  {a.metric.label}: <b>{a.metric.value}</b>
                </span>
              )}
              {a.engine && <span className="notif-chip">⚙ {a.engine}</span>}
              {a.durationSec != null && <span className="notif-chip">⏱ {a.durationSec}s</span>}
            </span>
          )}
          <span className="notif-item-meta" title={absTime}>
            {a.target ? `${hostOf(a.target) ?? a.target} · ` : ''}
            {relTime(a.at)}
          </span>
        </span>
      </button>
      <div className="notif-item-links">
        {a.runId && (
          <a
            className="notif-link"
            href={reportUrl(a.runId)}
            target="_blank"
            rel="noreferrer"
            title="Open the run report in a new tab"
          >
            Report ↗
          </a>
        )}
        {grafanaHref && (
          <a
            className="notif-link"
            href={grafanaHref}
            target="_blank"
            rel="noreferrer"
            title="Open Grafana at this run's time window"
          >
            📊 Grafana ↗
          </a>
        )}
      </div>
      <button
        className="alert-x"
        aria-label="Mark as read"
        title="Mark as read"
        onClick={() => onRead(a.key)}
      >
        ×
      </button>
    </li>
  );
}

/**
 * Notifications bell — replaces the old always-on alerts banner. A discreet bell
 * in the sidebar with an unread badge; clicking opens a slide-over panel where
 * each alert (tarpit / low-WRS / regression / auto-killed …) is clickable
 * through to the campaign or run. Read-state is remembered per browser so the
 * badge only nags about what's new.
 */
export function NotificationsBell() {
  const app = useApp();
  const openAlert = useOpenAlert();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Set<string>>(loadReadKeys);
  const panelRef = useRef<HTMLDivElement>(null);

  const list = app.alerts ?? [];
  const unread = list.filter((a) => !read.has(a.key));
  const badge = unread.length;
  const worst = alertWorst(unread);

  // Close on Escape while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const markRead = (key: string) =>
    setRead((prev) => {
      const next = new Set(prev);
      next.add(key);
      saveReadKeys(next);
      return next;
    });
  const markAllRead = () => {
    const next = new Set(list.map((a) => a.key));
    setRead(next);
    saveReadKeys(next);
  };
  const onOpen = (a: Alert) => {
    markRead(a.key);
    setOpen(false);
    openAlert(a);
  };

  return (
    <div className="notif">
      <button
        type="button"
        className={`notif-bell${badge ? ' has-unread' : ''}`}
        aria-label={`Notifications${badge ? ` (${badge} unread)` : ''}`}
        aria-expanded={open}
        title="Notifications"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">🔔</span>
        {badge > 0 && (
          <span className={`notif-badge notif-${worst}`}>{badge > 9 ? '9+' : badge}</span>
        )}
      </button>
      {/* Portaled to <body>: the bell lives inside the sticky topbar, whose own
          stacking context would otherwise trap the fixed panel below sibling
          page content (the suite stepper bled through it). */}
      {open &&
        createPortal(
          <>
            <div className="notif-backdrop" onClick={() => setOpen(false)} />
            <div className="notif-panel" role="dialog" aria-label="Notifications" ref={panelRef}>
              <div className="notif-head">
                <b>Notifications</b>
                <div className="notif-head-actions">
                  {badge > 0 && (
                    <button className="btn btn-sm btn-ghost" onClick={markAllRead}>
                      Mark all read
                    </button>
                  )}
                  <button
                    type="button"
                    className="notif-close"
                    aria-label="Close notifications"
                    onClick={() => setOpen(false)}
                  >
                    ×
                  </button>
                </div>
              </div>
              {list.length === 0 ? (
                <div className="notif-empty">
                  <span aria-hidden="true">✓</span> All clear — nothing needs attention.
                </div>
              ) : (
                <ul className="notif-list">
                  {list.map((a) => (
                    <NotificationRow
                      key={a.key}
                      a={a}
                      read={read.has(a.key)}
                      onOpen={onOpen}
                      onRead={markRead}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
