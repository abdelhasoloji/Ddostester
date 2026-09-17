import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { defaultTargetUrl } from './target-url.js';
import type { Playbook, BenchCatalogue } from './api.js';
import { useApp, canDo } from './context.js';
import { hostOf } from './ui.js';
import { PageHead } from './pages.js';

/**
 * Campaign templates (assessment playbooks) — reorganized.
 *
 * The catalogue used to be one long, fully-expanded list buried in Settings.
 * Here it is its own page: a compact launch bar, a search + category filter,
 * playbooks grouped by category, and each one a collapsed row (name, DRS, step
 * count, one-line summary) that expands on demand for its steps and threat
 * context. Scannable instead of a ten-metre scroll.
 */

/** Preferred category order; anything else falls after these, alphabetically. */
const CATEGORY_ORDER = ['Readiness', 'Capacity', 'Endurance', 'Threat-informed', 'Custom'];

function categoryRank(cat: string): number {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/** Human labels for a template's target requirements (Playbook.requires). A
 *  template shows these so a benign result on a target that lacks the feature
 *  reads as "not applicable here", not "the target resisted". */
const REQ_LABEL: Record<string, string> = {
  h2: 'HTTP/2',
  waf: 'WAF',
  cache: 'edge cache',
  dynamic: 'dynamic endpoint',
};

/** Local date (day only) for display, or '' when absent/unparseable. */
function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/** Sort key: newest createdAt first, then name. Missing dates sort last. */
function byRecent(a: Playbook, b: Playbook): number {
  const ta = a.createdAt ? Date.parse(a.createdAt) : -Infinity;
  const tb = b.createdAt ? Date.parse(b.createdAt) : -Infinity;
  return tb - ta || a.name.localeCompare(b.name);
}

function PlaybookRow({
  pb,
  canCreate,
  busy,
  launchable,
  isNew,
  selected,
  onToggleSelect,
  onLaunch,
  onDelete,
  canBench,
  benchDispatch,
  ladderBusy,
  onRequestLadder,
}: {
  pb: Playbook;
  canCreate: boolean;
  busy: boolean;
  launchable: boolean;
  isNew: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onLaunch: () => void;
  onDelete: () => void;
  canBench: boolean;
  benchDispatch: boolean;
  ladderBusy: string | null;
  onRequestLadder: (ladderId: string) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <details className={`tpl-row${selected ? ' is-selected' : ''}`}>
      <summary className="tpl-summary">
        {canCreate && (
          // Selection for composing several templates into one campaign. The
          // click must not toggle the <details> open/close, hence the guards.
          <input
            type="checkbox"
            className="tpl-pick"
            checked={selected}
            aria-label={`Select "${pb.name}" to compose`}
            title="Select to compose several templates into one campaign"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              e.stopPropagation();
              onToggleSelect();
            }}
          />
        )}
        <span className="tpl-name">{pb.name}</span>
        {isNew && (
          <span className="engine-badge ok" title="Recently added template">
            🆕 new
          </span>
        )}
        {pb.drsLevel != null && <span className="engine-badge">DRS {pb.drsLevel}</span>}
        {pb.requires?.map((r) => (
          <span
            key={r}
            className="engine-badge req"
            title={`Needs a target with ${REQ_LABEL[r] ?? r} — against a target without it this line is not applicable (a benign result is N/A, not resistance).`}
          >
            needs {REQ_LABEL[r] ?? r}
          </span>
        ))}
        {pb.custom && <span className="engine-badge ok">custom</span>}
        <span className="tpl-steps-count">
          {pb.steps.length} step{pb.steps.length === 1 ? '' : 's'}
        </span>
        {pb.createdAt && (
          <span
            className="tpl-created"
            title={`Template created ${new Date(pb.createdAt).toLocaleString()}`}
          >
            📅 {fmtDate(pb.createdAt)}
          </span>
        )}
        <span className="tpl-oneline">{pb.summary}</span>
      </summary>
      <div className="tpl-detail">
        {pb.when && <p className="preset-when">{pb.when}</p>}
        <ol className="playbook-steps">
          {pb.steps.map((s, i) => (
            <li key={i}>
              <b>{s.name}</b> — {s.maxRps} rps · {s.maxDurationSec}s · {s.profile}
              {s.vector === 'http-post' ? ' · POST' : ''}
              {s.paths?.length ? ` · ${s.paths.length} endpoints` : ''}
              {s.rotateUa ? ' · UA rotation' : ''}
              {s.headers ? ` · ${Object.keys(s.headers).length} headers` : ''}
            </li>
          ))}
        </ol>
        {pb.threat && (
          <div className="threat-box">
            <div className="threat-title">
              Threat-informed <span className="threat-ref">{pb.threat.reference}</span>
              {pb.threat.source && (
                <a
                  className="threat-source"
                  href={pb.threat.source}
                  target="_blank"
                  rel="noreferrer"
                  title={pb.threat.source}
                >
                  Source ↗
                </a>
              )}
            </div>
            <div className="threat-line">
              <span className="k">Profile</span> {pb.threat.technique}
            </div>
            <div className="threat-line">
              <span className="k">Measures</span> {pb.threat.measures}
            </div>
            <div className="threat-line threat-excluded">
              <span className="k">Not reproduced</span> {pb.threat.notReproduced}
            </div>
          </div>
        )}
        {pb.companionBench && (
          <div className="xlayer-box" title={pb.companionBench.note}>
            <span className="xlayer-badge">⇄ Cross-layer</span>
            <div className="xlayer-body">
              <span className="xlayer-text">
                Class-C network companion (<code>{pb.companionBench.ladder}</code>) — synthetic,
                no-spoof, run on the isolated bench; its verdicts fuse into the WRS read-only.
              </span>
              {canBench &&
                (benchDispatch ? (
                  <button
                    className="btn btn-sm"
                    disabled={ladderBusy === pb.companionBench.ladder}
                    onClick={() => onRequestLadder(pb.companionBench!.ladder)}
                    title="Queue the class-C ladder's bench runs — the isolated lab runner executes them and posts read-only verdicts"
                  >
                    {ladderBusy === pb.companionBench.ladder ? <span className="spin" /> : null}⇄
                    Request class-C ladder
                  </button>
                ) : (
                  <span className="hint">
                    Enable the lab runner (LAB_TARGETS + BENCH_RUNNER_TOKEN) to launch the class-C
                    ladder from here.
                  </span>
                ))}
            </div>
          </div>
        )}
        {canCreate && (
          <div className="btn-row">
            <button
              className="btn btn-primary btn-sm"
              disabled={!launchable || busy}
              onClick={onLaunch}
            >
              {busy
                ? 'Creating…'
                : pb.steps.length === 1
                  ? 'Create campaign →'
                  : `Create assessment (${pb.steps.length}) →`}
            </button>
            {pb.custom &&
              (confirmingDelete ? (
                <span className="row" style={{ gap: '.4rem', alignItems: 'center' }}>
                  <span className="hint">Delete this template?</span>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      setConfirmingDelete(false);
                      onDelete();
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirmingDelete(true)}>
                  Delete
                </button>
              ))}
          </div>
        )}
      </div>
    </details>
  );
}

export function TemplatesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const app = useApp();
  const navigate = useNavigate();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [target, setTarget] = useState('');
  const [recurMin, setRecurMin] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [composeName, setComposeName] = useState('');
  const [composing, setComposing] = useState(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('all');
  const [sort, setSort] = useState<'category' | 'recent'>('category');
  const [showNew, setShowNew] = useState(false);
  const emptyNew = { name: '', category: 'Custom', summary: '', when: '', stepsJson: '' };
  const [newPb, setNewPb] = useState({ ...emptyNew });

  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'error'>('loading');
  const load = () => {
    setLoadState('loading');
    api
      .playbooks()
      .then((p) => {
        setPlaybooks(p);
        setLoadState('ok');
      })
      .catch(() => setLoadState('error'));
  };
  useEffect(load, []);

  // Class-C bench catalogue (for launching a template's companion ladder). Only a
  // CISO with the lab runner configured can dispatch — others just see the note.
  const canBench = canDo(app.role, 'bench', app.authRequired);
  const [benchCat, setBenchCat] = useState<BenchCatalogue | null>(null);
  const [ladderBusy, setLadderBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!canBench) return;
    api
      .benchScenarios()
      .then(setBenchCat)
      .catch(() => undefined);
  }, [canBench]);

  const requestLadder = async (ladderId: string) => {
    const ladder = benchCat?.ladders?.find((l) => l.id === ladderId);
    if (!ladder) return;
    setLadderBusy(ladderId);
    try {
      const dispatchable = new Set(
        (benchCat?.scenarios ?? []).filter((s) => s.reproducible).map((s) => s.id),
      );
      const eligible = ladder.scenarios.filter((s) => dispatchable.has(s));
      let queued = 0;
      let failed = 0;
      for (const scenario of eligible) {
        try {
          await api.createBenchRun(scenario);
          queued++;
        } catch {
          failed++;
        }
      }
      if (eligible.length === 0) {
        app.push('error', 'No reproducible vector in this ladder is dispatchable to the lab.');
      } else if (queued === 0) {
        app.push('error', `The lab refused all ${failed} class-C bench run(s) — none were queued.`);
      } else {
        const tail = failed > 0 ? ` (${failed} refused)` : '';
        app.push(
          'success',
          `Queued ${queued} class-C bench run(s)${tail} — track them in Settings › Network bench.`,
        );
      }
    } finally {
      setLadderBusy(null);
    }
  };

  const canCreate = canDo(app.role, 'create', app.authRequired);
  const targetHost = hostOf(target);
  const targetAllowed = targetHost !== null && app.allowed.includes(targetHost);

  const categories = useMemo(() => {
    const set = [...new Set(playbooks.map((p) => p.category))];
    return set.sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b));
  }, [playbooks]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return playbooks.filter((p) => {
      if (cat !== 'all' && p.category !== cat) return false;
      if (!needle) return true;
      return (
        p.name.toLowerCase().includes(needle) ||
        p.summary.toLowerCase().includes(needle) ||
        p.category.toLowerCase().includes(needle)
      );
    });
  }, [playbooks, q, cat]);

  const grouped = useMemo(() => {
    const map = new Map<string, Playbook[]>();
    for (const p of filtered) {
      const arr = map.get(p.category) ?? [];
      arr.push(p);
      map.set(p.category, arr);
    }
    // Within a category, newest templates first so recent ones lead.
    for (const arr of map.values()) arr.sort(byRecent);
    return [...map.entries()].sort(
      ([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b),
    );
  }, [filtered]);

  /** Flat catalogue, newest first — the "launch recent in priority" view. */
  const recentList = useMemo(() => [...filtered].sort(byRecent), [filtered]);

  /** Newest template date present — used to flag the freshest cohort as "new". */
  const newestTs = useMemo(() => {
    let max = -Infinity;
    for (const p of playbooks) if (p.createdAt) max = Math.max(max, Date.parse(p.createdAt));
    return max;
  }, [playbooks]);
  const isNewPb = (p: Playbook): boolean =>
    p.createdAt != null && Date.parse(p.createdAt) === newestTs;

  const createPlaybook = async () => {
    try {
      const steps = JSON.parse(newPb.stepsJson || '[]');
      await api.createPlaybook({
        name: newPb.name,
        category: newPb.category,
        summary: newPb.summary,
        when: newPb.when,
        steps,
      });
      app.push('success', `Playbook "${newPb.name}" created.`);
      setNewPb({ ...emptyNew });
      setShowNew(false);
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };
  const removePlaybook = async (pb: Playbook) => {
    try {
      await api.deletePlaybook(pb.id);
      app.push('success', `Playbook "${pb.name}" deleted.`);
      load();
    } catch (err) {
      app.push('error', (err as Error).message);
    }
  };
  const launch = async (pb: Playbook) => {
    if (!targetAllowed) return;
    setBusy(pb.id);
    try {
      const r = await api.instantiatePlaybook(pb.id, {
        target,
        recurrenceMin: recurMin ? Number(recurMin) : undefined,
      });
      app.push(
        'success',
        `${r.campaigns.length === 1 ? 'Campaign' : 'Assessment'} "${pb.name}" created — ${r.campaigns.length} step${r.campaigns.length === 1 ? '' : 's'} (pending approval).`,
      );
      // Recon-seeding is systematic: tell the operator what it found (or warn).
      if (r.recon?.seeded) {
        app.push(
          'info',
          `Endpoints seeded from recon: ${r.recon.suggestedPaths?.length ?? 0} real path(s)` +
            `${r.recon.loginPath ? `, login ${r.recon.loginPath}` : ''}` +
            `${r.recon.go === false ? ' · ⚠ preflight NO-GO — review before approving' : ''}.`,
        );
      } else if (r.recon) {
        app.push(
          'info',
          'Recon unavailable — using template paths (verify endpoints before approving).',
        );
      }
      await app.refresh();
      navigate('/campaigns');
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // ── Composing several templates into one campaign (suite) ──────────────────
  // Mirrors backend MAX_COMPOSITE_STEPS (config/limits.ts); the server enforces
  // it authoritatively, this only gives early feedback.
  const MAX_COMPOSITE_STEPS = 200;
  const toggleSelect = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  // Selected templates in click order, so the composed sequence is predictable.
  const selectedPlaybooks = useMemo(
    () =>
      selected
        .map((id) => playbooks.find((p) => p.id === id))
        .filter((p): p is Playbook => p != null),
    [selected, playbooks],
  );
  const selectedSteps = useMemo(
    () => selectedPlaybooks.reduce((n, p) => n + p.steps.length, 0),
    [selectedPlaybooks],
  );
  const overCap = selectedSteps > MAX_COMPOSITE_STEPS;
  const compose = async () => {
    if (selectedPlaybooks.length < 1 || !targetAllowed || overCap) return;
    setComposing(true);
    try {
      const r = await api.composeSuite({
        playbookIds: selectedPlaybooks.map((p) => p.id),
        name: composeName.trim() || undefined,
        target,
        recurrenceMin: recurMin ? Number(recurMin) : undefined,
      });
      app.push(
        'success',
        `Assessment created — ${r.campaigns.length} steps from ${selectedPlaybooks.length} template${selectedPlaybooks.length === 1 ? '' : 's'} (pending approval).`,
      );
      if (r.recon?.seeded) {
        app.push(
          'info',
          `Endpoints seeded from recon: ${r.recon.suggestedPaths?.length ?? 0} real path(s)` +
            `${r.recon.go === false ? ' · ⚠ preflight NO-GO — review before approving' : ''}.`,
        );
      }
      setSelected([]);
      setComposeName('');
      await app.refresh();
      navigate('/campaigns');
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setComposing(false);
    }
  };

  return (
    <>
      {!embedded && (
        <PageHead
          title="Campaign templates"
          sub="One-click curated sequences of bounded campaigns. Pick a target, launch, and the whole assessment is created — each campaign still goes through approval before it runs."
        />
      )}

      {/* Launch context: target + optional recurrence. */}
      <div className="card tpl-launchbar">
        <div className="field">
          <label>Target for the assessment</label>
          <div className={`recon-target-bar${target && !targetAllowed ? ' invalid' : ''}`}>
            <span className="recon-target-icon" aria-hidden="true">
              🎯
            </span>
            <input
              className="recon-target-url"
              placeholder="https://staging.example.com/"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            {targetAllowed && (
              <span className="recon-target-ok" title="On the allowlist" aria-label="allowed">
                ✓
              </span>
            )}
          </div>
          {app.allowed.length > 0 && (
            <div className="recon-allowed">
              <span className="recon-allowed-label">Allowed</span>
              {app.allowed.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`recon-host-chip${targetHost === h ? ' on' : ''}`}
                  onClick={() => setTarget(defaultTargetUrl(h))}
                >
                  {h}
                </button>
              ))}
            </div>
          )}
          {target && !targetAllowed && (
            <span className="hint">Host is not in the allowlist — pick one above.</span>
          )}
        </div>
        <div className="field">
          <label>Repeat (optional)</label>
          <select value={recurMin} onChange={(e) => setRecurMin(e.target.value)}>
            <option value="">Run once</option>
            <option value="60">Every hour</option>
            <option value="360">Every 6 hours</option>
            <option value="720">Every 12 hours</option>
          </select>
        </div>
      </div>

      {/* Search + category filter. */}
      <div className="tpl-toolbar">
        <input
          className="tpl-search"
          aria-label="Search templates"
          placeholder="Search templates…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="tpl-cats">
          <button
            className={`chip-xs${cat === 'all' ? ' active' : ''}`}
            onClick={() => setCat('all')}
          >
            All ({playbooks.length})
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={`chip-xs${cat === c ? ' active' : ''}`}
              onClick={() => setCat(c)}
            >
              {c} ({playbooks.filter((p) => p.category === c).length})
            </button>
          ))}
        </div>
        <div className="tpl-sort" role="group" aria-label="Sort templates">
          <button
            className={`chip-xs${sort === 'category' ? ' active' : ''}`}
            onClick={() => setSort('category')}
            title="Group by category"
          >
            By category
          </button>
          <button
            className={`chip-xs${sort === 'recent' ? ' active' : ''}`}
            onClick={() => setSort('recent')}
            title="Flat list, newest templates first — launch the recent ones in priority"
          >
            🆕 Recent first
          </button>
        </div>
      </div>

      {loadState === 'loading' ? (
        <p className="hint" style={{ marginTop: '1rem' }}>
          <span className="spin" /> Loading templates…
        </p>
      ) : loadState === 'error' ? (
        <div className="empty" style={{ marginTop: '1rem' }}>
          Couldn't load templates.{' '}
          <button className="btn btn-sm" onClick={load}>
            Retry
          </button>
        </div>
      ) : recentList.length === 0 ? (
        <p className="hint" style={{ marginTop: '1rem' }}>
          {playbooks.length === 0 ? 'No templates available.' : 'No template matches your search.'}
        </p>
      ) : sort === 'recent' ? (
        <section className="tpl-group">
          <h2 className="section-title tpl-group-title">
            Recent first <span className="tpl-group-count">{recentList.length}</span>
          </h2>
          <div className="tpl-list">
            {recentList.map((pb) => (
              <PlaybookRow
                key={pb.id}
                pb={pb}
                canCreate={canCreate}
                busy={busy === pb.id}
                launchable={targetAllowed}
                isNew={isNewPb(pb)}
                selected={selected.includes(pb.id)}
                onToggleSelect={() => toggleSelect(pb.id)}
                onLaunch={() => launch(pb)}
                onDelete={() => removePlaybook(pb)}
                canBench={canBench}
                benchDispatch={benchCat?.dispatchEnabled ?? false}
                ladderBusy={ladderBusy}
                onRequestLadder={requestLadder}
              />
            ))}
          </div>
        </section>
      ) : (
        grouped.map(([category, items]) => (
          <section key={category} className="tpl-group">
            <h2 className="section-title tpl-group-title">
              {category} <span className="tpl-group-count">{items.length}</span>
            </h2>
            <div className="tpl-list">
              {items.map((pb) => (
                <PlaybookRow
                  key={pb.id}
                  pb={pb}
                  canCreate={canCreate}
                  busy={busy === pb.id}
                  launchable={targetAllowed}
                  isNew={isNewPb(pb)}
                  selected={selected.includes(pb.id)}
                  onToggleSelect={() => toggleSelect(pb.id)}
                  onLaunch={() => launch(pb)}
                  onDelete={() => removePlaybook(pb)}
                  canBench={canBench}
                  benchDispatch={benchCat?.dispatchEnabled ?? false}
                  ladderBusy={ladderBusy}
                  onRequestLadder={requestLadder}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {canCreate && (
        <div className="card" style={{ marginTop: '1.25rem' }}>
          <div className="card-head">
            <h2>Custom template</h2>
            <button className="btn btn-sm" onClick={() => setShowNew((v) => !v)}>
              {showNew ? 'Cancel' : '＋ New template'}
            </button>
          </div>
          {showNew && (
            <div className="grid">
              <div className="field">
                <label>Name</label>
                <input
                  value={newPb.name}
                  onChange={(e) => setNewPb({ ...newPb, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Category</label>
                <input
                  value={newPb.category}
                  onChange={(e) => setNewPb({ ...newPb, category: e.target.value })}
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Summary</label>
                <input
                  value={newPb.summary}
                  onChange={(e) => setNewPb({ ...newPb, summary: e.target.value })}
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Steps (JSON)</label>
                <textarea
                  rows={7}
                  placeholder={
                    '[\n  {"name":"Baseline","maxRps":100,"concurrency":20,"maxDurationSec":120,"profile":"constant","agent":"vegeta"},\n  {"name":"Ramp","maxRps":300,"concurrency":50,"maxDurationSec":180,"profile":"ramp","agent":"k6"}\n]'
                  }
                  value={newPb.stepsJson}
                  onChange={(e) => setNewPb({ ...newPb, stepsJson: e.target.value })}
                  style={{ fontFamily: 'var(--mono, monospace)' }}
                />
                <span className="hint">
                  Each step: <code>name, maxRps, concurrency, maxDurationSec, profile</code>{' '}
                  (constant/ramp/wave), optional <code>agent</code>. All within the caps.
                </span>
              </div>
              <div className="field" style={{ alignSelf: 'end' }}>
                <button
                  className="btn btn-primary"
                  disabled={!newPb.name.trim() || !newPb.stepsJson.trim()}
                  onClick={createPlaybook}
                >
                  Save template
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Compose basket: assemble several templates into one campaign (suite). */}
      {canCreate && selected.length > 0 && (
        <div className="tpl-compose-bar">
          <div className="tcb-main">
            <div className="tcb-head">
              <strong>
                Compose {selected.length} template{selected.length === 1 ? '' : 's'}
              </strong>
              <span className={`tcb-steps${overCap ? ' over' : ''}`}>
                {selectedSteps} step{selectedSteps === 1 ? '' : 's'} · max {MAX_COMPOSITE_STEPS}
              </span>
              <button className="btn btn-sm btn-ghost" onClick={() => setSelected([])}>
                Clear
              </button>
            </div>
            <div className="tcb-chips">
              {selectedPlaybooks.map((p, i) => (
                <span key={p.id} className="tcb-chip" title={`${p.steps.length} steps`}>
                  <span className="tcb-order">{i + 1}</span> {p.name}
                  <button
                    type="button"
                    className="tcb-x"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => toggleSelect(p.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="tcb-actions">
            <input
              className="tcb-name"
              placeholder="Name (optional)"
              value={composeName}
              onChange={(e) => setComposeName(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={selected.length < 1 || !targetAllowed || overCap || composing}
              onClick={compose}
              title={
                !targetAllowed
                  ? 'Pick an allowlisted target above first'
                  : overCap
                    ? `Too many steps (${selectedSteps} > ${MAX_COMPOSITE_STEPS})`
                    : 'Create one governed assessment from the selected template(s), in order'
              }
            >
              {composing ? 'Creating…' : `Create assessment (${selectedSteps}) →`}
            </button>
          </div>
          {!targetAllowed && (
            <span className="tcb-hint">Pick an allowlisted target in the bar above.</span>
          )}
          {overCap && (
            <span className="tcb-hint over">
              {selectedSteps} steps exceeds the {MAX_COMPOSITE_STEPS}-step limit — remove a
              template.
            </span>
          )}
        </div>
      )}
    </>
  );
}
