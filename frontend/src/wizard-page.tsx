import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type DrsCapacityView, type DrsClientView } from './api.js';
import { useApp } from './context.js';
import { LineIcon } from './interface-kit.js';

type Mode = 'measured' | 'synthetic-lab';

interface Draft {
  clientId: string;
  target: string;
  probeUrl: string;
  mode: Mode;
  maxLevel: number;
  exposureSec: number;
  baselineSec: number;
  maxRps: number;
  assertion: string;
  rationale: string;
  authorized: boolean;
}

const STEPS = ['Client & target', 'Mode', 'Level & exposure', 'Authorise'] as const;

/**
 * Campaign wizard. The mode is the second step on purpose: it decides what the campaign can
 * prove, so it must be chosen with the target in view, before any budget is typed.
 */
export function WizardPage() {
  const app = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [clients, setClients] = useState<DrsClientView[]>([]);
  const [capacity, setCapacity] = useState<DrsCapacityView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({
    clientId: '',
    target: '',
    probeUrl: '',
    mode: 'measured',
    maxLevel: 1,
    exposureSec: 60,
    baselineSec: 300,
    maxRps: 50,
    assertion: '',
    rationale: '',
    authorized: false,
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.drsClients(), api.drsCapacity()])
      .then(([c, k]) => {
        if (cancelled) return;
        setClients(c.clients.filter((x) => x.registered));
        setCapacity(k);
        const first = c.clients.find((x) => x.registered);
        if (first?.scope?.targets[0])
          setDraft((d) =>
            d.clientId ? d : { ...d, clientId: first.id ?? '', target: first.scope!.targets[0] },
          );
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const client = useMemo(
    () => clients.find((c) => c.id === draft.clientId) ?? null,
    [clients, draft.clientId],
  );

  const envelope = capacity?.envelope;
  const scopedRps = Math.min(
    draft.maxRps,
    client?.scope?.maxRps ?? Number.POSITIVE_INFINITY,
    envelope?.maxRps && envelope.maxRps > 0 ? envelope.maxRps : Number.POSITIVE_INFINITY,
  );

  const canContinue = (() => {
    if (step === 0) return draft.target.trim().length > 0;
    if (step === 1) return true;
    if (step === 2) return draft.exposureSec >= 10 && draft.rationale.trim().length >= 10;
    return draft.authorized;
  })();

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createDrsPlan({
        clientId: draft.clientId || undefined,
        target: draft.target.trim(),
        probeUrl: draft.probeUrl.trim() || undefined,
        mode: draft.mode,
        maxLevel: draft.maxLevel,
        exposureSec: draft.exposureSec,
        baselineSec: draft.baselineSec,
        maxRps: scopedRps,
        functionalAssertion: draft.assertion.trim() || undefined,
        rationale: draft.rationale.trim(),
        authorized: draft.authorized,
      });
      app.push('success', `Campaign ${created.name} created.`);
      await app.refresh();
      navigate('/drs');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>New campaign</h1>
          <p className="hint">
            Four steps, one frozen plan. The mode you pick decides what the campaign can prove.
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="campaigns" />
        </span>
      </div>

      <ol className="wizard-steps" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'on' : i < step ? 'done' : ''}>
            {i + 1} · {label}
          </li>
        ))}
      </ol>

      {error && <p role="alert">{error}</p>}

      {step === 0 && (
        <section className="card">
          <label className="field">
            Client dossier
            <select
              value={draft.clientId}
              onChange={(e) => {
                const next = clients.find((c) => c.id === e.target.value);
                setDraft({
                  ...draft,
                  clientId: e.target.value,
                  target: next?.scope?.targets[0] ?? draft.target,
                });
              }}
            >
              <option value="">— no dossier (legacy target) —</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id ?? ''}>
                  {c.client}
                </option>
              ))}
            </select>
          </label>

          {client ? (
            <label className="field">
              Authorised target
              <select
                value={draft.target}
                onChange={(e) => setDraft({ ...draft, target: e.target.value })}
              >
                {(client.scope?.targets ?? []).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field">
              Target
              <input
                value={draft.target}
                onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                placeholder="https://staging.example.com/"
              />
            </label>
          )}

          {client && (
            <p className="hint">
              Signed scope {client.scope?.reference} · ceiling{' '}
              {client.scope?.maxRps.toLocaleString()} rps
            </p>
          )}
        </section>
      )}

      {step === 1 && (
        <div className="grid2">
          <button
            type="button"
            className={`card choice${draft.mode === 'measured' ? ' sel' : ''}`}
            onClick={() => setDraft({ ...draft, mode: 'measured' })}
          >
            <h2 style={{ marginTop: 0 }}>Full campaign · measured</h2>
            <p className="hint">
              Real traffic to the target, entry and origin observed when a witness exists, a sealed
              proof and an opposable verdict.
            </p>
            <ul className="hint">
              <li>Traffic bounded by the envelope and the signed scope</li>
              <li>Verdict PARTIAL / FAIL / PASS — never “certified”</li>
            </ul>
          </button>
          <button
            type="button"
            className={`card choice${draft.mode === 'synthetic-lab' ? ' sel' : ''}`}
            onClick={() => setDraft({ ...draft, mode: 'synthetic-lab' })}
          >
            <h2 style={{ marginTop: 0 }}>Synthetic amplifier · non-certifying</h2>
            <p className="hint">
              Validates the measurement chain and the sizing without touching the target. No traffic
              is emitted and no verdict is produced.
            </p>
            <ul className="hint">
              <li>Amplifier fidelity: claimed rate versus produced rate</li>
              <li>Plan integrity and motivated exclusions</li>
            </ul>
          </button>
        </div>
      )}

      {step === 2 && (
        <section className="card">
          <div className="grid2">
            <label className="field">
              DRS level
              <select
                value={draft.maxLevel}
                onChange={(e) => setDraft({ ...draft, maxLevel: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 7].map((l) => (
                  <option key={l} value={l}>
                    DRS {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Exposure (s)
              <input
                type="number"
                min={10}
                value={draft.exposureSec}
                onChange={(e) => setDraft({ ...draft, exposureSec: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Baseline (s)
              <input
                type="number"
                min={5}
                value={draft.baselineSec}
                onChange={(e) => setDraft({ ...draft, baselineSec: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              Requested rate (rps)
              <input
                type="number"
                min={1}
                value={draft.maxRps}
                onChange={(e) => setDraft({ ...draft, maxRps: Number(e.target.value) })}
              />
            </label>
          </div>
          <label className="field">
            Functional assertion
            <input
              value={draft.assertion}
              onChange={(e) => setDraft({ ...draft, assertion: e.target.value })}
              placeholder="status 200 and body contains 'ok'"
            />
          </label>
          <label className="field">
            Rationale
            <input
              value={draft.rationale}
              onChange={(e) => setDraft({ ...draft, rationale: e.target.value })}
              placeholder="why this level and this exposure"
            />
          </label>
          <p className="hint">
            Envelope applied: <b>{scopedRps.toLocaleString()} rps</b>
            {envelope
              ? ` · ${envelope.agents} admitted agent(s) · bounded by ${envelope.limitedBy.rps}`
              : ''}
          </p>
        </section>
      )}

      {step === 3 && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Summary</h2>
          <table className="campaign-table">
            <tbody>
              <tr>
                <td>Client</td>
                <td>{client?.client ?? 'no dossier'}</td>
              </tr>
              <tr>
                <td>Target</td>
                <td>{draft.target}</td>
              </tr>
              <tr>
                <td>Mode</td>
                <td>{draft.mode === 'measured' ? 'measured' : 'synthetic amplifier'}</td>
              </tr>
              <tr>
                <td>Level · exposure</td>
                <td>
                  DRS {draft.maxLevel} · {draft.exposureSec}s (baseline {draft.baselineSec}s)
                </td>
              </tr>
              <tr>
                <td>Rate</td>
                <td>{scopedRps.toLocaleString()} rps</td>
              </tr>
            </tbody>
          </table>
          <label className="field" style={{ marginTop: '1rem' }}>
            <input
              type="checkbox"
              checked={draft.authorized}
              onChange={(e) => setDraft({ ...draft, authorized: e.target.checked })}
            />{' '}
            I attest that this target is authorised for testing and that the scope above is the
            signed one.
          </label>
        </section>
      )}

      <p className="row" style={{ marginTop: '1rem' }}>
        <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </button>
        {step < 3 ? (
          <button className="btn primary" disabled={!canContinue} onClick={() => setStep(step + 1)}>
            Continue
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={!draft.authorized || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Creating…' : 'Freeze the plan'}
          </button>
        )}
      </p>
    </>
  );
}
