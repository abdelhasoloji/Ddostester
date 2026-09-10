import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, setToken, getToken, DEFAULT_CAPS } from './api.js';
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

export interface Identity {
  email: string;
  role: Role;
}
export type Perm =
  'create' | 'approve' | 'cisoApprove' | 'execute' | 'kill' | 'manage' | 'limits' | 'bench';
const PERMS: Record<Role, Perm[]> = {
  officer: ['create', 'approve', 'execute', 'kill', 'manage'],
  engineer: ['create', 'execute', 'kill'],
  viewer: ['kill'],
  // CISO: governance only — reads everything, emergency-kills, sets the
  // operational limits ('limits'), governs the class-C network bench ('bench'),
  // and gives the mandatory dual-control sign-off ('cisoApprove'). Not an operator.
  ciso: ['kill', 'limits', 'bench', 'cisoApprove'],
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
  expanded: string | null;
  operator: string;
  confirmExec: Campaign | null;
  approveFor: Campaign | null;
  toasts: Toast[];
  /** A preset queued (e.g. from the Guide) for the new-campaign form to apply. */
  draftPreset: Preset | null;
  applyPreset: (p: Preset) => void;
  clearDraftPreset: () => void;
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
  cisoApprove: (c: Campaign) => Promise<void>;
  toggleDetails: (c: Campaign) => Promise<void>;
  openDetail: (c: Campaign) => Promise<void>;
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
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [operator, setOperator] = useState(() => localStorage.getItem('operator') ?? '');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<Record<string, CampaignRun>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmExec, setConfirmExec] = useState<Campaign | null>(null);
  const [approveFor, setApproveFor] = useState<Campaign | null>(null);
  const [auditRows, setAuditRows] = useState<AuditEntry[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [wrsSeries, setWrsSeries] = useState<WrsSeries[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [draftPreset, setDraftPreset] = useState<Preset | null>(null);

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
        setAgentName(h.agent ?? '');
        setServerVersion(h.version ?? null);
        setRequireCisoApproval(h.requireCisoApproval ?? false);
        setNotifications(h.notifications ?? []);
        setProtection(h.protection ?? false);
        setTlsInsecure(h.tlsInsecure ?? false);
        setAuthRequired(h.authRequired);
        if (h.authRequired && getToken()) {
          try {
            const me = await api.me();
            if (me.email && me.role) setIdentity({ email: me.email, role: me.role });
            else setToken(null);
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

  useEffect(() => localStorage.setItem('operator', operator), [operator]);

  const setBusyFor = (id: string, v: boolean) => setBusy((b) => ({ ...b, [id]: v }));

  const applyPreset = useCallback((p: Preset) => setDraftPreset(p), []);
  const clearDraftPreset = useCallback(() => setDraftPreset(null), []);
  const applyEffectiveCaps = useCallback((caps: HardCaps) => setHardCaps(caps), []);

  const login = async (email: string, password: string) => {
    const r = await api.login(email, password);
    setToken(r.token);
    setIdentity({ email: r.email, role: r.role });
  };
  const logout = () => {
    setToken(null);
    setIdentity(null);
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
    // Open the drawer immediately so the live progress bar (elapsed time + probe
    // health) is front-and-centre for the whole run, not just a thin bar on the
    // card. The run request below blocks until the campaign finishes.
    setExpanded(c.id);
    try {
      const run = await api.execute(c.id);
      setRuns((r) => ({ ...r, [c.id]: run }));
      setExpanded(c.id);
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
    try {
      await api.kill(c.id);
      push('info', 'Kill switch triggered.');
      refresh();
    } catch (err) {
      push('error', (err as Error).message);
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
    role,
    ready,
    anyRunning,
    campaigns,
    runs,
    wrsSeries,
    auditRows,
    alerts,
    busy,
    expanded,
    operator,
    confirmExec,
    approveFor,
    toasts,
    draftPreset,
    applyPreset,
    clearDraftPreset,
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
    logout,
    createCampaign,
    approve,
    execute,
    kill,
    cancel,
    cisoApprove,
    toggleDetails,
    openDetail,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
