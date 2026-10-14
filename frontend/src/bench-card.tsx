import { useEffect, useState } from 'react';
import { useApp, canDo } from './context.js';
import { api, RECORDABLE_METHODS } from './api.js';
import type {
  AttestationChecklist,
  BenchCatalogue,
  BenchCoverage,
  BenchRun,
  CoverageMethod,
} from './api.js';

/** SCREAMING_SNAKE_CASE → "Sentence case", so bench pills read like the rest of
 *  the UI (Completed / Not mitigated) instead of shouting raw enum values. */
function humanizeEnum(v: string): string {
  const s = v.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function benchStatusPill(status: BenchRun['status']) {
  const color =
    status === 'COMPLETED'
      ? 'var(--success)'
      : status === 'FAILED'
        ? 'var(--danger)'
        : status === 'CLAIMED'
          ? 'var(--brand)'
          : 'var(--warning)';
  return (
    <span className="badge" style={{ background: 'var(--surface-2)', color, borderColor: color }}>
      {humanizeEnum(status)}
    </span>
  );
}

function outcomePill(outcome?: string) {
  if (!outcome) return <span className="hint">—</span>;
  const color =
    outcome === 'MITIGATED'
      ? 'var(--success)'
      : outcome === 'NOT_MITIGATED'
        ? 'var(--danger)'
        : outcome === 'MITIGATED_WITH_COLLATERAL'
          ? 'var(--warning)'
          : 'var(--muted)';
  return (
    <span className="badge" style={{ background: 'var(--surface-2)', color, borderColor: color }}>
      {humanizeEnum(outcome)}
    </span>
  );
}

const METHOD_COLOR: Record<CoverageMethod, string> = {
  MEASURED_LAB: 'var(--success)',
  INGESTED_EXTERNAL: 'var(--brand)',
  ATTESTED: 'var(--warning)',
  MODELLED: 'var(--muted)',
  REPLAY: 'var(--brand)',
};
function methodPill(m?: CoverageMethod) {
  if (!m) return <span className="hint">not covered</span>;
  const c = METHOD_COLOR[m];
  return (
    <span className="badge" style={{ background: 'var(--surface-2)', color: c, borderColor: c }}>
      {humanizeEnum(m)}
    </span>
  );
}

export function BenchCard() {
  const app = useApp();
  const canBench = canDo(app.role, 'bench', app.authRequired, app.userMode, app.capabilities);
  const [cat, setCat] = useState<BenchCatalogue | null>(null);
  const [runs, setRuns] = useState<BenchRun[]>([]);
  const [coverage, setCoverage] = useState<BenchCoverage[]>([]);
  const [scenario, setScenario] = useState('');
  const [busy, setBusy] = useState(false);
  const [recVector, setRecVector] = useState('');
  const [recMethod, setRecMethod] = useState<CoverageMethod>('ATTESTED');
  const [recOutcome, setRecOutcome] = useState('');
  const [recSummary, setRecSummary] = useState('');
  const [recSource, setRecSource] = useState('');
  const [recOpen, setRecOpen] = useState(false);
  const [checklists, setChecklists] = useState<AttestationChecklist[]>([]);
  const [attId, setAttId] = useState('');
  const [attChecked, setAttChecked] = useState<Set<string>>(new Set());
  const [attNote, setAttNote] = useState('');
  const [attOpen, setAttOpen] = useState(false);
  const [impOpen, setImpOpen] = useState(false);
  const [impFormat, setImpFormat] = useState<'json' | 'csv'>('csv');
  const [impData, setImpData] = useState('');
  const [impSource, setImpSource] = useState('');
  const [impErrors, setImpErrors] = useState<{ row: number; error: string }[]>([]);

  const refreshRuns = async () => {
    try {
      setRuns((await api.benchRuns()).runs);
    } catch {
      /* transient — leave the last view in place */
    }
  };
  const refreshCoverage = async () => {
    try {
      setCoverage((await api.benchCoverage()).coverage);
    } catch {
      /* transient */
    }
  };

  useEffect(() => {
    if (!canBench) return;
    let alive = true;
    (async () => {
      try {
        const c = await api.benchScenarios();
        if (!alive) return;
        setCat(c);
        setScenario(c.scenarios.find((s) => s.reproducible)?.id ?? '');
        setRecVector(c.scenarios.find((s) => !s.reproducible)?.id ?? c.scenarios[0]?.id ?? '');
      } catch {
        /* no access / not configured */
      }
      try {
        const cl = (await api.benchAttestations()).checklists;
        if (alive) {
          setChecklists(cl);
          setAttId(cl[0]?.id ?? '');
        }
      } catch {
        /* no access */
      }
      await refreshRuns();
      await refreshCoverage();
    })();
    return () => {
      alive = false;
    };
  }, [canBench]);

  // Poll while a run is still in flight, so the runner's verdict lands in view.
  const pending = runs.some((r) => r.status === 'REQUESTED' || r.status === 'CLAIMED');
  useEffect(() => {
    if (!canBench || !pending) return;
    const t = setInterval(refreshRuns, 4000);
    return () => clearInterval(t);
  }, [canBench, pending]);

  if (!canBench) return null;

  const dispatch = async () => {
    if (!scenario) return;
    setBusy(true);
    try {
      await api.createBenchRun(scenario);
      app.push('success', `Bench run requested (${scenario}) — awaiting the isolated runner.`);
      await refreshRuns();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recordCoverage = async () => {
    if (!recVector || !recSummary.trim()) return;
    setBusy(true);
    try {
      await api.recordBenchCoverage({
        vector: recVector,
        method: recMethod,
        outcome: recOutcome.trim() || undefined,
        summary: recSummary.trim(),
        source: recSource.trim() || undefined,
      });
      app.push('success', `Coverage recorded for ${recVector} (${recMethod}).`);
      setRecSummary('');
      setRecOutcome('');
      setRecOpen(false);
      await refreshCoverage();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeChecklist = checklists.find((c) => c.id === attId) ?? null;
  const toggleAtt = (itemId: string) =>
    setAttChecked((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  const submitAttestation = async () => {
    if (!activeChecklist) return;
    setBusy(true);
    try {
      const rec = await api.submitAttestation({
        checklistId: activeChecklist.id,
        checkedItems: [...attChecked],
        note: attNote.trim() || undefined,
      });
      app.push('success', `Attestation recorded for ${rec.vector} → ${rec.outcome ?? 'recorded'}.`);
      setAttChecked(new Set());
      setAttNote('');
      setAttOpen(false);
      await refreshCoverage();
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importCoverage = async () => {
    if (!impData.trim()) return;
    setBusy(true);
    setImpErrors([]);
    try {
      const res = await api.importBenchCoverage(
        impFormat,
        impData.trim(),
        impSource.trim() || undefined,
      );
      setImpErrors(res.errors);
      if (res.imported > 0) {
        app.push(
          'success',
          `Imported ${res.imported} external verdict(s)${res.errors.length ? `, ${res.errors.length} row(s) skipped` : ''}.`,
        );
        setImpData('');
        if (res.errors.length === 0) setImpOpen(false);
        await refreshCoverage();
      } else {
        app.push('error', `No rows imported (${res.errors.length} invalid).`);
      }
    } catch (err) {
      app.push('error', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dispatchEnabled = cat?.dispatchEnabled ?? false;
  const scenarios = cat?.scenarios ?? [];
  const runnable = scenarios.filter((s) => s.reproducible);
  const selected = scenarios.find((s) => s.id === scenario);
  // Coverage is newest-first from the API → the first hit per vector is latest.
  const latestByVector = new Map<string, BenchCoverage>();
  for (const c of coverage) if (!latestByVector.has(c.vector)) latestByVector.set(c.vector, c);

  return (
    <div className="card">
      <h2>Network bench — advanced · class C (CISO)</h2>
      <p className="hint" style={{ marginBottom: '.75rem' }}>
        The <b>DRS Volumetric</b> matrix (report P25-20300). Launch a bounded synthetic realization
        of a UDP amplification/rate vector on the isolated lab and read its verdict here. The
        control plane <b>records and governs</b> the run — it never emits the traffic. An isolated
        external runner claims the request, executes it off the control plane, and posts back a
        read-only class-C verdict. Every request and verdict is audited.
      </p>

      {!dispatchEnabled && (
        <div className="attest" style={{ marginBottom: '.75rem' }}>
          <span>
            Dispatch is <b>disabled</b>. Configure an isolated <code>LAB_TARGETS</code> host and a{' '}
            <code>BENCH_RUNNER_TOKEN</code> on the server to enable governed runs. The catalogue and
            past verdicts below remain visible.
          </span>
        </div>
      )}

      <div className="btn-row" style={{ marginBottom: '1rem' }}>
        <div className="field" style={{ flex: 1, minWidth: 260 }}>
          <label htmlFor="bench-scenario">Reproducible vector</label>
          <select
            id="bench-scenario"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            {runnable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id} — DRS {s.drs}
              </option>
            ))}
          </select>
          <span className="hint">{selected?.note ?? ''}</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={dispatch}
          disabled={!dispatchEnabled || busy || !scenario}
        >
          {busy ? 'Requesting…' : '▶ Request run'}
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="hint">No bench runs yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="bench-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Status</th>
                <th>Outcome</th>
                <th style={{ textAlign: 'right' }}>Amplification</th>
                <th style={{ textAlign: 'right' }}>Collateral</th>
                <th>Requested</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.scenario}</code>
                  </td>
                  <td>{benchStatusPill(r.status)}</td>
                  <td>
                    {r.status === 'FAILED' ? (
                      <span className="hint">{r.error}</span>
                    ) : (
                      outcomePill(r.verdict?.outcome)
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    {r.verdict?.connections
                      ? `${r.verdict.connections.saturationPct ?? 0}% sat`
                      : r.verdict?.amplificationFactor != null
                        ? `${r.verdict.amplificationFactor}×`
                        : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
                    {r.verdict?.mitigation?.collateralPct != null
                      ? `${r.verdict.mitigation.collateralPct}%`
                      : '—'}
                  </td>
                  <td className="hint">{new Date(r.requestedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {scenarios.length > 0 && (
        <>
          <h3 style={{ fontSize: '.92rem', margin: '1.25rem 0 .5rem' }}>DRS Volumetric coverage</h3>
          <div
            className="hint"
            style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0 0 .6rem' }}
          >
            <span>
              <b style={{ color: 'var(--text)' }}>{scenarios.length}</b> vectors
            </span>
            <span>
              <b style={{ color: 'var(--success)' }}>
                {
                  scenarios.filter((s) => latestByVector.get(s.id)?.method === 'MEASURED_LAB')
                    .length
                }
              </b>{' '}
              measured (lab)
            </span>
            <span>
              <b style={{ color: 'var(--text)' }}>
                {scenarios.filter((s) => latestByVector.has(s.id)).length}
              </b>{' '}
              covered (any method)
            </span>
            <span>
              <b style={{ color: 'var(--text)' }}>
                {scenarios.filter((s) => !s.reproducible).length}
              </b>{' '}
              never emitted
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="bench-table">
              <thead>
                <tr>
                  <th>Vector</th>
                  <th>Proto</th>
                  <th>DRS</th>
                  <th>Bench</th>
                  <th>Coverage</th>
                  <th style={{ whiteSpace: 'normal' }}>Latest evidence</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((s) => {
                  const cov = latestByVector.get(s.id);
                  return (
                    <tr key={s.id}>
                      <td>
                        <code>{s.id}</code>
                      </td>
                      <td>{s.proto}</td>
                      <td className="num">{s.drs}</td>
                      <td>
                        {s.reproducible ? (
                          <span
                            className="badge"
                            style={{
                              background: 'var(--surface-2)',
                              color: 'var(--success)',
                              borderColor: 'var(--success)',
                            }}
                          >
                            reproducible
                          </span>
                        ) : (
                          <span
                            className="badge"
                            style={{
                              background: 'var(--surface-2)',
                              color: 'var(--muted)',
                              borderColor: 'var(--border)',
                            }}
                          >
                            out of model
                          </span>
                        )}
                      </td>
                      <td>{methodPill(cov?.method)}</td>
                      <td className="hint" style={{ whiteSpace: 'normal' }}>
                        {cov ? (
                          <>
                            {cov.outcome ? <b>{cov.outcome}</b> : null} {cov.summary}{' '}
                            <span style={{ opacity: 0.7 }}>· {cov.source}</span>
                          </>
                        ) : (
                          s.note
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: '1rem' }}>
            <button className="btn btn-sm" onClick={() => setRecOpen((v) => !v)}>
              {recOpen ? 'Cancel' : '+ Record coverage evidence'}
            </button>
            {recOpen && (
              <div
                className="attest"
                style={{ display: 'block', marginTop: '.6rem', background: 'var(--surface-2)' }}
              >
                <p className="hint" style={{ margin: '0 0 .6rem' }}>
                  Attach non-run evidence to any vector — an external bench verdict, a control
                  attestation (e.g. BCP38/uRPF), a modelled or replay judgement. No traffic is
                  emitted; this is read-only assurance, audited.
                </p>
                <div className="grid">
                  <div className="field">
                    <label>Vector</label>
                    <select value={recVector} onChange={(e) => setRecVector(e.target.value)}>
                      {scenarios.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Method</label>
                    <select
                      value={recMethod}
                      onChange={(e) => setRecMethod(e.target.value as CoverageMethod)}
                    >
                      {RECORDABLE_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m.replace('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>
                      Outcome <span className="hint">(optional, e.g. PASS / MITIGATED)</span>
                    </label>
                    <input value={recOutcome} onChange={(e) => setRecOutcome(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>
                      Source <span className="hint">(e.g. network-team-bench)</span>
                    </label>
                    <input value={recSource} onChange={(e) => setRecSource(e.target.value)} />
                  </div>
                  <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <label>Evidence / rationale</label>
                    <input
                      value={recSummary}
                      onChange={(e) => setRecSummary(e.target.value)}
                      placeholder="e.g. Edge enforces BCP38/uRPF; spoofed sources dropped."
                    />
                  </div>
                </div>
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: '.6rem' }}
                  onClick={recordCoverage}
                  disabled={busy || !recVector || !recSummary.trim()}
                >
                  {busy ? 'Recording…' : 'Record coverage'}
                </button>
              </div>
            )}
          </div>

          {checklists.length > 0 && (
            <div style={{ marginTop: '.75rem' }}>
              <button className="btn btn-sm" onClick={() => setAttOpen((v) => !v)}>
                {attOpen ? 'Cancel' : '+ Attestation checklist'}
              </button>
              {attOpen && (
                <div
                  className="attest"
                  style={{ display: 'block', marginTop: '.6rem', background: 'var(--surface-2)' }}
                >
                  <p className="hint" style={{ margin: '0 0 .6rem' }}>
                    Structured control attestation for out-of-model vectors. Tick the controls
                    actually enforced at the edge; the bench derives a deterministic{' '}
                    <b>PASS / PARTIAL / FAIL</b> outcome and records it as <b>ATTESTED</b> coverage.
                    No traffic is emitted.
                  </p>
                  <div className="field" style={{ marginBottom: '.6rem' }}>
                    <label>Checklist</label>
                    <select
                      value={attId}
                      onChange={(e) => {
                        setAttId(e.target.value);
                        setAttChecked(new Set());
                      }}
                    >
                      {checklists.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.title} → {c.vector}
                        </option>
                      ))}
                    </select>
                  </div>
                  {activeChecklist && (
                    <>
                      <p className="hint" style={{ margin: '0 0 .5rem' }}>
                        <b>{activeChecklist.standard}</b> — {activeChecklist.guidance}
                      </p>
                      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 .5rem' }}>
                        {activeChecklist.items.map((it) => (
                          <li key={it.id} style={{ padding: '.15rem 0' }}>
                            <label
                              style={{
                                display: 'flex',
                                gap: '.5rem',
                                alignItems: 'flex-start',
                                cursor: 'pointer',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={attChecked.has(it.id)}
                                onChange={() => toggleAtt(it.id)}
                                style={{ marginTop: '.2rem' }}
                              />
                              <span>
                                {it.label}
                                {it.required ? (
                                  <span style={{ color: 'var(--danger)' }}> *</span>
                                ) : (
                                  <span className="hint"> (optional)</span>
                                )}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <p className="hint" style={{ margin: '0 0 .5rem' }}>
                        Preview:{' '}
                        <b>
                          {attChecked.size === 0
                            ? 'FAIL'
                            : activeChecklist.items
                                  .filter((i) => i.required)
                                  .every((i) => attChecked.has(i.id))
                              ? 'PASS'
                              : 'PARTIAL'}
                        </b>{' '}
                        · {attChecked.size}/{activeChecklist.items.length} controls
                      </p>
                      <div className="field" style={{ marginBottom: '.6rem' }}>
                        <label>
                          Note <span className="hint">(optional)</span>
                        </label>
                        <input
                          value={attNote}
                          onChange={(e) => setAttNote(e.target.value)}
                          placeholder="e.g. verified against edge running-config 2026-09-01"
                        />
                      </div>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={submitAttestation}
                        disabled={busy}
                      >
                        {busy ? 'Recording…' : 'Record attestation'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: '.75rem' }}>
            <button className="btn btn-sm" onClick={() => setImpOpen((v) => !v)}>
              {impOpen ? 'Cancel' : '+ Import external verdicts'}
            </button>
            {impOpen && (
              <div
                className="attest"
                style={{ display: 'block', marginTop: '.6rem', background: 'var(--surface-2)' }}
              >
                <p className="hint" style={{ margin: '0 0 .6rem' }}>
                  Bulk-import the network team&apos;s real L3/4 bench results as read-only{' '}
                  <b>INGESTED_EXTERNAL</b> coverage — the honest source for the out-of-model vectors
                  they own. Nothing is executed or emitted; invalid rows are reported, not dropped.
                </p>
                <div className="btn-row" style={{ marginBottom: '.6rem' }}>
                  <div className="field" style={{ minWidth: 120 }}>
                    <label>Format</label>
                    <select
                      value={impFormat}
                      onChange={(e) => setImpFormat(e.target.value as 'json' | 'csv')}
                    >
                      <option value="csv">CSV</option>
                      <option value="json">JSON</option>
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1, minWidth: 200 }}>
                    <label>
                      Source <span className="hint">(default: network-team-bench)</span>
                    </label>
                    <input value={impSource} onChange={(e) => setImpSource(e.target.value)} />
                  </div>
                </div>
                <div className="field">
                  <label>
                    {impFormat === 'csv'
                      ? 'CSV — header: vector,outcome,drs,summary,source'
                      : 'JSON — array of { vector, outcome?, drs?, summary, source? }'}
                  </label>
                  <textarea
                    value={impData}
                    onChange={(e) => setImpData(e.target.value)}
                    rows={6}
                    style={{ fontFamily: 'var(--mono)', fontSize: '.82rem' }}
                    placeholder={
                      impFormat === 'csv'
                        ? 'vector,outcome,drs,summary,source\nip_spoofing,MITIGATED,4,"BCP38 upstream, spoofed sources dropped",acme-scrubbing'
                        : '[{"vector":"gre_packets","outcome":"MITIGATED","drs":5,"summary":"GRE dropped at edge","source":"acme-scrubbing"}]'
                    }
                  />
                </div>
                {impErrors.length > 0 && (
                  <ul className="hint" style={{ margin: '.3rem 0', color: 'var(--danger)' }}>
                    {impErrors.slice(0, 10).map((e) => (
                      <li key={e.row}>
                        row {e.row}: {e.error}
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  className="btn btn-primary btn-sm"
                  style={{ marginTop: '.6rem' }}
                  onClick={importCoverage}
                  disabled={busy || !impData.trim()}
                >
                  {busy ? 'Importing…' : 'Import verdicts'}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <p className="hint" style={{ marginTop: '.75rem' }}>
        Mapped to DRS report <b>P25-20300</b> (Volumetric section). Out-of-model vectors (TCP/GRE
        stateful floods, IP spoofing, fragmentation) are shown for coverage but can never be
        dispatched — spoofing is never permitted here by construction. The report&apos;s Layer-7
        vectors live in the control plane&apos;s playbooks. These verdicts are class C, read-only
        evidence — not the class-A/B DRS validations recorded via <code>/api/drs-validations</code>.
      </p>
    </div>
  );
}
