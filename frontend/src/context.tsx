import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, setToken, getToken } from './api.js';
import type { AgentInfo, Campaign, CampaignRun, Role, AuditEntry, WrsSeries } from './api.js';
import type { Preset } from './presets.js';

export interface Identity {
  email: string;
  role: Role;
}
export type Perm = 'create' | 'approve' | 'execute' | 'kill' | 'manage';
const PERMS: Record<Role, Perm[]> = {
  officer: ['create', 'approve', 'execute', 'kill', 'manage'],
  engineer: ['create', 'execute', 'kill'],
  viewer: ['kill'],
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
  agentName: string;
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
  setOperator: (v: string) => void;
  setExpanded: (id: string | null) => void;
  setConfirmExec: (c: Campaign | null) => void;
  setApproveFor: (c: Campaign | null) => void;
  push: (kind: Toast['kind'], msg: string) => void;
  refresh: () => void;
  loadHistory: () => void;
  loadAudit: () => void;
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
  const [agentName, setAgentName] = useState('');
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

  useEffect(() => {
    api
      .health()
      .then(async (h) => {
        setAllowed(h.allowedTargets);
        setAgentName(h.agent ?? '');
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
    }
  }, [ready, refresh, loadHistory]);

  const anyRunning = campaigns.some((c) => c.status === 'RUNNING');
  useEffect(() => {
    if (!anyRunning || !ready) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [anyRunning, ready, refresh]);

  useEffect(() => localStorage.setItem('operator', operator), [operator]);

  const setBusyFor = (id: string, v: boolean) => setBusy((b) => ({ ...b, [id]: v }));

  const applyPreset = useCallback((p: Preset) => setDraftPreset(p), []);
  const clearDraftPreset = useCallback(() => setDraftPreset(null), []);

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
    agentName,
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
    busy,
    expanded,
    operator,
    confirmExec,
    approveFor,
    toasts,
    draftPreset,
    applyPreset,
    clearDraftPreset,
    setOperator,
    setExpanded,
    setConfirmExec,
    setApproveFor,
    push,
    refresh,
    loadHistory,
    loadAudit,
    login,
    logout,
    createCampaign,
    approve,
    execute,
    kill,
    toggleDetails,
    openDetail,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
