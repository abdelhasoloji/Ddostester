import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, setToken, getToken, DEFAULT_CAPS, getGrafanaBase, setGrafanaBase } from './api.js';
import type {
  AgentInfo,
  Campaign,
  CampaignRun,
  Role,
  AuditEntry,
  WrsSeries,
  HardCaps,
  Alert,
} from './api.js';
import type { Preset } from './presets.js';
import type { CampaignFormSeed } from './campaign-form.js';
import { lsGet, lsSet } from './storage.js';

export interface Identity {
  email: string;
  role: Role;
}
export type Perm =
  'create' | 'approve' | 'cisoApprove' | 'execute' | 'kill' | 'manage' | 'limits' | 'bench';
/**
 * Client-side UX gate only — the backend `MATRIX` in `backend/src/auth/rbac.ts`
 * is the authoritative enforcer (this just hides controls a role can't use).
 * These short aliases mirror the backend permissions (create ↔ campaign:create,
 * manage ↔ user:manage, limits ↔ limits:manage, bench ↔ bench:*). Keep the two
 * in step — `rbac-mirror.test.ts` locks this table so drift fails CI.
 */
const PERMS: Record<Role, Perm[]> = {
  // Operator: creates campaigns and launches approved ones.
  engineer: ['create', 'execute', 'kill'],
  // Validation/governance: the ONLY role that approves ('approve'), plus the
  // dual-control sign-off ('cisoApprove') and the class-C bench ('bench').
  ciso: ['approve', 'cisoApprove', 'kill', 'bench'],
  // Platform administration: users ('manage') + operational limits ('limits').
  admin: ['manage', 'limits', 'kill'],
  // Read-only (SOC/NOC).
  viewer: [],
};
export function canDo(role: Role | null, perm: Perm, authRequired: boolean): boolean {
  if (!authRequired) return true;
  return role ? PERMS[role].includes(perm) : false;
}

export interface Toast {
  id: number;
  kind: 'error' | 'success' | 'info';
  msg: string;
}
let toastSeq = 0;

interface Ctx {
  allowed: string[];
  labTargets: string[];
  /** Effective operational caps the server enforces; from /health, DEFAULT_CAPS until loaded. */
  hardCaps: HardCaps;
  /** Immutable absolute ceiling; the CISO can never set an operational cap above it. */
  hardCapsCeiling: HardCaps;
  /** Built-in engine performance ceilings (from /health): above either, a simple
   *  flood auto-routes to an out-of-process engine. Used for config-time hints. */
  builtinCeilings: { rps: number; concurrency: number };
  agentName: string;
  /** Build stamp of the running API server (from /health), for a mismatch check. */
  serverVersion: { version: string; build: string; commit: string; builtAt?: string } | null;
  /** Dual control: this deployment mandates a CISO sign-off on every campaign. */
  requireCisoApproval: boolean;
  notifications: string[];
  protection: boolean;
  tlsInsecure: boolean;
  agents: AgentInfo[];
  authRequired: boolean;
  authChecked: boolean;
  identity: Identity | null;
  mustChangePassword: boolean;
  role: Role | null;
  ready: boolean;
  anyRunning: boolean;
  campaigns: Campaign[];
  runs: Record<string, CampaignRun>;
  wrsSeries: WrsSeries[];
  auditRows: AuditEntry[] | null;
  /** In-app alerts derived from run history (tarpit / low-WRS / degraded / auto-killed). */
  alerts: Alert[];
  busy: Record<string, boolean>;
  /** Per-campaign "a kill request is in flight" — separate from `busy` so the kill
   *  switch stays clickable during a run (whose blocking execute holds `busy`). */
  killing: Record<string, boolean>;
  expanded: string | null;
  operator: string;
  confirmExec: Campaign | null;
  approveFor: Campaign | null;
  toasts: Toast[];
  /** A preset queued (e.g. from the Guide) for the new-campaign form to apply. */
  draftPreset: Preset | null;
  applyPreset: (p: Preset) => void;
  clearDraftPreset: () => void;
  /** A full form seed queued from a completed run's "replay accounting for
   *  countermeasures" — pre-fills the new-campaign form. */
  draftCampaign: Partial<CampaignFormSeed> | null;
  queueReplay: (seed: Partial<CampaignFormSeed>) => void;
  clearDraftCampaign: () => void;
  /** Update the effective caps in-app after the CISO saves new operational limits. */
  applyEffectiveCaps: (caps: HardCaps) => void;
  setOperator: (v: string) => void;
  setExpanded: (id: string | null) => void;
  setConfirmExec: (c: Campaign | null) => void;
  setApproveFor: (c: Campaign | null) => void;
  push: (kind: Toast['kind'], msg: string) => void;
  refresh: () => void;
  loadHistory: () => void;
  loadAudit: () => void;
  loadAlerts: () => void;
  login: (email: string, password: string) => Promise<void>;
  changeOwnPassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
  createCampaign: (payload: Record<string, unknown>) => Promise<void>;
  approve: (
    c: Campaign,
    approvedBy: string,
    decision: 'APPROVED' | 'REJECTED',
    reason: string,
  ) => Promise<void>;
  execute: (c: Campaign) => Promise<void>;
  kill: (c: Campaign) => Promise<void>;
  cancel: (c: Campaign) => Promise<void>;
  archive: (c: Campaign, archived: boolean) => Promise<void>;
  archiveSuite: (suiteId: string, name: string, archived: boolean) => Promise<void>;
  cisoApprove: (c: Campaign) => Promise<void>;
  toggleDetails: (c: Campaign) => Promise<void>;
  openDetail: (c: Campaign) => Promise<void>;
  /** Fetch a campaign's detailed run into `runs` (no drawer side effect). */
  fetchRun: (c: Campaign) => Promise<void>;
}

const AppCtx = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('useApp used outside provider');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [labTargets, setLabTargets] = useState<string[]>([]);
  const [hardCaps, setHardCaps] = useState<HardCaps>(DEFAULT_CAPS);
  const [hardCapsCeiling, setHardCapsCeiling] = useState<HardCaps>(DEFAULT_CAPS);
  const [builtinCeilings, setBuiltinCeilings] = useState<{ rps: number; concurrency: number }>({
    rps: 150,
    concurrency: 300,
  });
  const [agentName, setAgentName] = useState('');
  const [serverVersion, setServerVersion] = useState<Ctx['serverVersion']>(null);
  const [requireCisoApproval, setRequireCisoApproval] = useState(false);
  const [notifications, setNotifications] = useState<string[]>([]);
  const [protection, setProtection] = useState(false);
  const [tlsInsecure, setTlsInsecure] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [authRequired, setAuthRequired] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [operator, setOperator] = useState(() => lsGet('operator') ?? '');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [killing, setKilling] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<Record<string, CampaignRun>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmExec, setConfirmExec] = useState<Campaign | null>(null);
  const [approveFor, setApproveFor] = useState<Campaign | null>(null);
  const [auditRows, setAuditRows] = useState<AuditEntry[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [wrsSeries, setWrsSeries] = useState<WrsSeries[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [draftPreset, setDraftPreset] = useState<Preset | null>(null);
  const [draftCampaign, setDraftCampaign] = useState<Partial<CampaignFormSeed> | null>(null);

  const role = identity?.role ?? null;

  const push = useCallback((kind: Toast['kind'], msg: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, kind, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const refresh = useCallback(() => {
    api
      .listCampaigns()
      .then(setCampaigns)
      .catch((e) => push('error', e.message));
  }, [push]);
  const loadHistory = useCallback(() => {
    api
      .wrsHistory()
      .then(setWrsSeries)
      .catch(() => undefined);
  }, []);
  const loadAudit = useCallback(() => {
    api
      .audit(100)
      .then(setAuditRows)
      .catch((e) => push('error', e.message));
  }, [push]);
  const loadAlerts = useCallback(() => {
    api
      .alerts(50)
      .then(setAlerts)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    api
      .health()
      .then(async (h) => {
        setAllowed(h.allowedTargets);
        setLabTargets(h.labTargets ?? []);
        setHardCaps(h.hardCaps ?? DEFAULT_CAPS);
        setHardCapsCeiling(h.hardCapsCeiling ?? h.hardCaps ?? DEFAULT_CAPS);
        if (h.builtinCeilings) setBuiltinCeilings(h.builtinCeilings);
        setAgentName(h.agent ?? '');
        setServerVersion(h.version ?? null);
        setRequireCisoApproval(h.requireCisoApproval ?? false);
        setNotifications(h.notifications ?? []);
        setProtection(h.protection ?? false);
        setTlsInsecure(h.tlsInsecure ?? false);
        setAuthRequired(h.authRequired);
        // Seed the Grafana deep-link base from the server config when the browser
        // hasn't set one, so "Open in Grafana" works out of the box.
        if (h.metrics?.grafanaUrl && !getGrafanaBase()) setGrafanaBase(h.metrics.grafanaUrl);
        if (h.authRequired && getToken()) {
          try {
            const me = await api.me();
            if (me.email && me.role) {
              setIdentity({ email: me.email, role: me.role });
              setMustChangePassword(!!me.mustChangePassword);
            } else setToken(null);
          } catch {
            setToken(null);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => setAuthChecked(true));
    api
      .agents()
      .then((r) => setAgents(r.agents))
      .catch(() => undefined);
  }, []);

  const ready = authChecked && (!authRequired || identity !== null);
  useEffect(() => {
    if (ready) {
      refresh();
      loadHistory();
      loadAlerts();
    }
  }, [ready, refresh, loadHistory, loadAlerts]);

  const anyRunning = campaigns.some((c) => c.status === 'RUNNING');
  useEffect(() => {
    if (!anyRunning || !ready) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [anyRunning, ready, refresh]);

  // Refresh the in-app alerts feed periodically, and once more right after a run
  // finishes (a completed run may raise a new tarpit / low-WRS / degraded alert).
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(loadAlerts, 20000);
    return () => clearInterval(t);
  }, [ready, loadAlerts]);
  useEffect(() => {
    if (ready && !anyRunning) loadAlerts();
  }, [ready, anyRunning, loadAlerts]);

  useEffect(() => lsSet('operator', operator), [operator]);

  const setBusyFor = (id: string, v: boolean) => setBusy((b) => ({ ...b, [id]: v }));
  const setKillingFor = (id: string, v: boolean) => setKilling((k) => ({ ...k, [id]: v }));

  const applyPreset = useCallback((p: Preset) => setDraftPreset(p), []);
  const clearDraftPreset = useCallback(() => setDraftPreset(null), []);
  const queueReplay = useCallback((seed: Partial<CampaignFormSeed>) => setDraftCampaign(seed), []);
  const clearDraftCampaign = useCallback(() => setDraftCampaign(null), []);
  const applyEffectiveCaps = useCallback((caps: HardCaps) => setHardCaps(caps), []);

  const login = async (email: string, password: string) => {
    const r = await api.login(email, password);
    setToken(r.token);
    setIdentity({ email: r.email, role: r.role });
    setMustChangePassword(!!r.mustChangePassword);
  };
  // Self-service password change. On success the server rotates the token (other
  // sessions are revoked) and clears any forced-change flag.
  const changeOwnPassword = async (currentPassword: string, newPassword: string) => {
    const r = await api.changePassword(currentPassword, newPassword);
    setToken(r.token);
    setIdentity({ email: r.email, role: r.role });
    setMustChangePassword(false);
  };
  const logout = () => {
    // Best-effort audit; the token is discarded regardless of the result.
    api.logout().catch(() => undefined);
    setToken(null);
    setIdentity(null);
    setMustChangePassword(false);
    setCampaigns([]);
  };

  const createCampaign = async (payload: Record<string, unknown>) => {
    await api.createCampaign({ ...payload, createdBy: authRequired ? identity?.email : operator });
    push('success', 'Campaign created — awaiting approval.');
    refresh();
  };

  const approve = async (
    c: Campaign,
    approvedBy: string,
    decision: 'APPROVED' | 'REJECTED',
    reason: string,
  ) => {
    setApproveFor(null);
    setBusyFor(c.id, true);
    try {
      await api.approve(c.id, { approvedBy, decision, reason: reason || undefined });
      push('success', decision === 'APPROVED' ? 'Campaign approved.' : 'Campaign rejected.');
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setBusyFor(c.id, false);
    }
  };

  const execute = async (c: Campaign) => {
    setConfirmExec(null);
    setBusyFor(c.id, true);
    setCampaigns((list) => list.map((x) => (x.id === c.id ? { ...x, status: 'RUNNING' } : x)));
    // The launcher (ExecuteModal) sends the operator to Run Theater for the live
    // view, so we no longer auto-open the card drawer here. The run request below
    // blocks until the campaign finishes.
    try {
      const run = await api.execute(c.id);
      setRuns((r) => ({ ...r, [c.id]: run }));
      push(
        run.status === 'COMPLETED' ? 'success' : 'info',
        `Run ${run.status} — WRS ${run.wrs.wrs} (${run.wrs.level}).`,
      );
      refresh();
      loadHistory();
    } catch (err) {
      push('error', (err as Error).message);
      refresh();
    } finally {
      setBusyFor(c.id, false);
    }
  };

  const kill = async (c: Campaign) => {
    // Guard on a kill-specific flag, never on `busy`: a running campaign's blocking
    // execute holds `busy`, and the kill switch must stay live throughout the run.
    setKillingFor(c.id, true);
    try {
      await api.kill(c.id);
      push('info', 'Kill switch triggered.');
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setKillingFor(c.id, false);
    }
  };

  /** CISO dual-control sign-off on an officer-approved campaign. */
  const cisoApprove = async (c: Campaign) => {
    setBusyFor(c.id, true);
    try {
      await api.cisoApprove(c.id);
      push('success', `CISO sign-off recorded for "${c.name}".`);
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setBusyFor(c.id, false);
    }
  };

  /** Cancel an unrun (pending/approved) campaign before it executes. */
  const cancel = async (c: Campaign) => {
    setBusyFor(c.id, true);
    try {
      await api.cancelCampaign(c.id);
      push('info', `Campaign "${c.name}" cancelled.`);
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setBusyFor(c.id, false);
    }
  };

  /** Archive / un-archive a single campaign (hides it from the default view). */
  const archive = async (c: Campaign, archived: boolean) => {
    setBusyFor(c.id, true);
    try {
      await api.archiveCampaign(c.id, archived);
      push('info', `Campaign "${c.name}" ${archived ? 'archived' : 'restored'}.`);
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setBusyFor(c.id, false);
    }
  };

  /** Archive / un-archive every step of an assessment suite. */
  const archiveSuite = async (suiteId: string, name: string, archived: boolean) => {
    setBusyFor(suiteId, true);
    try {
      const res = await api.archiveSuite(suiteId, archived);
      push(
        'info',
        `Suite "${name}" ${archived ? 'archived' : 'restored'} · ${res.changed}/${res.total} step(s).`,
      );
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
    } finally {
      setBusyFor(suiteId, false);
    }
  };

  const fetchRun = async (c: Campaign) => {
    if (!runs[c.id] && c.runId) {
      try {
        const run = await api.getRun(c.runId);
        setRuns((r) => ({ ...r, [c.id]: run }));
      } catch {
        /* no detailed run available */
      }
    }
  };

  const toggleDetails = async (c: Campaign) => {
    if (expanded === c.id) {
      setExpanded(null);
      return;
    }
    setExpanded(c.id);
    await fetchRun(c);
  };

  /** Open the detail drawer for a campaign (always opens, never toggles). */
  const openDetail = async (c: Campaign) => {
    setExpanded(c.id);
    await fetchRun(c);
  };

  const value: Ctx = {
    allowed,
    labTargets,
    hardCaps,
    hardCapsCeiling,
    builtinCeilings,
    agentName,
    serverVersion,
    requireCisoApproval,
    notifications,
    protection,
    tlsInsecure,
    agents,
    authRequired,
    authChecked,
    identity,
    mustChangePassword,
    role,
    ready,
    anyRunning,
    campaigns,
    runs,
    wrsSeries,
    auditRows,
    alerts,
    busy,
    killing,
    expanded,
    operator,
    confirmExec,
    approveFor,
    toasts,
    draftPreset,
    applyPreset,
    clearDraftPreset,
    draftCampaign,
    queueReplay,
    clearDraftCampaign,
    applyEffectiveCaps,
    setOperator,
    setExpanded,
    setConfirmExec,
    setApproveFor,
    push,
    refresh,
    loadHistory,
    loadAudit,
    loadAlerts,
    login,
    changeOwnPassword,
    logout,
    createCampaign,
    approve,
    execute,
    archive,
    archiveSuite,
    kill,
    cancel,
    cisoApprove,
    toggleDetails,
    openDetail,
    fetchRun,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
