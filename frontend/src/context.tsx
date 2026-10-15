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

/** A target-onboarding draft queued from the assistant to pre-fill the
 *  Protected Zones "Add target" form. Governance is unchanged: registering a
 *  target here is metadata only; authorization is a separate, gated step. */
export interface DraftTarget {
  host?: string;
  displayName?: string;
  owner?: string;
  notes?: string;
}
import { lsGet, lsSet } from './storage.js';

export interface Identity {
  email: string;
  role: Role;
}
export type Perm =
  | 'create'
  | 'approve'
  | 'cisoApprove'
  | 'execute'
  | 'kill'
  | 'manage'
  | 'limits'
  | 'bench'
  | 'assistantManage'
  | 'targetManage'
  | 'targetAuthorize';
/** Presentation aliases for capabilities supplied by /api/auth/me. */
const CAPABILITY: Record<Perm, string> = {
  create: 'campaign:create',
  approve: 'campaign:approve',
  cisoApprove: 'campaign:ciso-approve',
  execute: 'campaign:execute',
  kill: 'campaign:kill',
  manage: 'user:manage',
  limits: 'limits:manage',
  bench: 'bench:read',
  assistantManage: 'assistant:manage',
  targetManage: 'target:manage',
  targetAuthorize: 'target:authorize',
};
export function canDo(
  role: Role | null,
  perm: Perm,
  authRequired: boolean,
  userMode: 'team' | 'single' = 'team',
  capabilities: readonly string[] = [],
): boolean {
  void userMode;
  if (!authRequired) return true;
  return role !== null && capabilities.includes(CAPABILITY[perm]);
}

/** Human-readable role names, shared across the settings, account and identity UI. */
export const roleLabel: Record<Role, string> = {
  engineer: 'Security Engineer',
  ciso: 'CISO',
  admin: 'Administrator',
  viewer: 'SOC / NOC',
};

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
  drsWorkflow?: boolean;
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
  /** Whether a remote read-only probe agent is configured (per-campaign probe vantage). */
  remoteProbe: boolean;
  tlsInsecure: boolean;
  agents: AgentInfo[];
  authRequired: boolean;
  userMode: 'team' | 'single';
  capabilities: string[];
  primaryAdminEmail: string | null;
  approvalPolicy: 'confirmation' | 'dual_control';
  revokeOwnSessions: () => Promise<void>;
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
  /** A target-onboarding draft queued from the assistant (pre-fills Zones). */
  draftTarget: DraftTarget | null;
  queueTarget: (t: DraftTarget) => void;
  clearDraftTarget: () => void;
  /** Update the effective caps in-app after the CISO saves new operational limits. */
  applyEffectiveCaps: (caps: HardCaps) => void;
  setOperator: (v: string) => void;
  setExpanded: (id: string | null) => void;
  setConfirmExec: (c: Campaign | null) => void;
  setApproveFor: (c: Campaign | null) => void;
  push: (kind: Toast['kind'], msg: string) => void;
  refresh: () => void;
  /** Re-fetch /health to refresh the effective allowlist and server posture. */
  refreshHealth: () => Promise<void>;
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
  const [remoteProbe, setRemoteProbe] = useState(false);
  const [tlsInsecure, setTlsInsecure] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [primaryAdminEmail, setPrimaryAdminEmail] = useState<string | null>(null);
  const [approvalPolicy, setApprovalPolicy] = useState<'confirmation' | 'dual_control'>(
    'dual_control',
  );
  const [drsWorkflow, setDrsWorkflow] = useState(false);
  const [userMode, setUserMode] = useState<'team' | 'single'>('team');
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
  const [draftTarget, setDraftTarget] = useState<DraftTarget | null>(null);

  const role = identity?.role ?? null;
  const applyAccess = (r: {
    capabilities?: string[];
    primaryAdminEmail?: string;
    approvalPolicy?: 'confirmation' | 'dual_control';
  }) => {
    setCapabilities(r.capabilities ?? []);
    setPrimaryAdminEmail(r.primaryAdminEmail ?? null);
    setApprovalPolicy(r.approvalPolicy ?? 'dual_control');
  };

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

  const applyHealthPosture = useCallback((h: Awaited<ReturnType<typeof api.health>>) => {
    setDrsWorkflow(h.drsWorkflow ?? false);
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
    setRemoteProbe(h.remoteProbe ?? false);
    setTlsInsecure(h.tlsInsecure ?? false);
    setAuthRequired(h.authRequired);
    setUserMode(h.userMode ?? 'team');
    // Seed the Grafana deep-link base from the server config when the browser
    // hasn't set one, so "Open in Grafana" works out of the box.
    if (h.metrics?.grafanaUrl && !getGrafanaBase()) setGrafanaBase(h.metrics.grafanaUrl);
  }, []);

  /**
   * Re-fetch /health and re-apply the server posture — notably the EFFECTIVE
   * allowlist (env allowlist + CISO-authorized targets). Called when the campaign
   * workspace mounts and right after a target is authorized/revoked, so a host
   * onboarded or authorized after the initial page load shows up in the target
   * picker without a full reload. Never touches auth / identity / token state.
   */
  const refreshHealth = useCallback(async () => {
    try {
      applyHealthPosture(await api.health());
    } catch {
      /* keep last-known posture on a transient failure */
    }
  }, [applyHealthPosture]);

  useEffect(() => {
    api
      .health()
      .then(async (h) => {
        applyHealthPosture(h);
        if (h.authRequired && getToken()) {
          try {
            const me = await api.me();
            if (me.email && me.role) {
              setIdentity({ email: me.email, role: me.role });
              setMustChangePassword(!!me.mustChangePassword);
              applyAccess(me);
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
  }, [applyHealthPosture]);

  useEffect(() => {
    const expired = () => {
      setIdentity(null);
      setCapabilities([]);
      setCampaigns([]);
      setMustChangePassword(false);
    };
    window.addEventListener('shieldtest:session-expired', expired);
    return () => window.removeEventListener('shieldtest:session-expired', expired);
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
  const queueTarget = useCallback((t: DraftTarget) => setDraftTarget(t), []);
  const clearDraftTarget = useCallback(() => setDraftTarget(null), []);
  const applyEffectiveCaps = useCallback((caps: HardCaps) => setHardCaps(caps), []);

  const login = async (email: string, password: string) => {
    const r = await api.login(email, password);
    setToken(r.token);
    setIdentity({ email: r.email, role: r.role });
    setMustChangePassword(!!r.mustChangePassword);
    applyAccess(r);
  };
  // Self-service password change. On success the server rotates the token (other
  // sessions are revoked) and clears any forced-change flag.
  const changeOwnPassword = async (currentPassword: string, newPassword: string) => {
    const r = await api.changePassword(currentPassword, newPassword);
    setToken(r.token);
    setIdentity({ email: r.email, role: r.role });
    setMustChangePassword(false);
    applyAccess(r);
  };
  const revokeOwnSessions = async () => {
    const r = await api.revokeOwnSessions();
    setToken(r.token);
    applyAccess(r);
    push('success', 'Other sessions revoked.');
  };
  const logout = () => {
    // Best-effort audit; the token is discarded regardless of the result.
    api.logout().catch(() => undefined);
    setToken(null);
    setIdentity(null);
    setCapabilities([]);
    setMustChangePassword(false);
    setCampaigns([]);
  };

  const createCampaign = async (payload: Record<string, unknown>) => {
    await api.createCampaign({
      ...payload,
      ...(userMode === 'single' ? { scheduledAt: undefined, recurrence: undefined } : {}),
      createdBy: authRequired ? identity?.email : operator,
    });
    push(
      'success',
      userMode === 'single'
        ? 'Campaign created — review and confirm before running.'
        : 'Campaign created — awaiting approval.',
    );
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
    // Start acknowledgement is independent of the baseline/exposure duration.
    // RUNNING is persisted before acknowledgement; normal polling/stream reconnects
    // recover the result even if this browser leaves or its connection is lost.
    try {
      await api.startExecution(c.id, approvalPolicy === 'confirmation');
      push('info', 'Campaign started — follow baseline and execution in Run Theater.');
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
    drsWorkflow,
    hardCaps,
    hardCapsCeiling,
    builtinCeilings,
    agentName,
    serverVersion,
    requireCisoApproval,
    notifications,
    protection,
    remoteProbe,
    tlsInsecure,
    agents,
    authRequired,
    userMode,
    capabilities,
    primaryAdminEmail,
    approvalPolicy,
    revokeOwnSessions,
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
    draftTarget,
    queueTarget,
    clearDraftTarget,
    applyEffectiveCaps,
    setOperator,
    setExpanded,
    setConfirmExec,
    setApproveFor,
    push,
    refresh,
    refreshHealth,
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
