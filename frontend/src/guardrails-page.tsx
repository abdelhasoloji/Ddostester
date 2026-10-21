import { useEffect, useState } from 'react';
import { api } from './api.js';
import { LineIcon } from './interface-kit.js';

type Guardrails = Awaited<ReturnType<typeof api.drsGuardrails>>;

/**
 * The limits, where an operator can read them. These are not settings of convenience: they are
 * what the platform refuses to do, and the page says so rather than hiding them in a file.
 */
export function GuardrailsPage() {
  const [view, setView] = useState<Guardrails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .drsGuardrails()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!view) return <p className="hint">Loading guardrails…</p>;

  return (
    <>
      <div className="page-head page-head--icon">
        <div>
          <h1>Authorisation &amp; limits</h1>
          <p className="hint">
            The bounds a campaign cannot cross. The hard caps are immutable; the service ceiling and
            the baseline floor are configuration, and the page reports what is applied.
          </p>
        </div>
        <span className="page-head-icon" aria-hidden="true">
          <LineIcon name="settings" />
        </span>
      </div>

      <table className="campaign-table">
        <thead>
          <tr>
            <th>Guardrail</th>
            <th>Applied value</th>
            <th>Effect</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Hard caps</td>
            <td>
              {view.hardCaps.maxRps.toLocaleString()} rps · {view.hardCaps.maxConcurrency} conc ·{' '}
              {view.hardCaps.maxDurationSec}s
            </td>
            <td className="hint">immutable; no configuration can raise them</td>
          </tr>
          <tr>
            <td>Service ceiling</td>
            <td>
              {view.serviceCeiling.maxRps.toLocaleString()} rps ·{' '}
              {view.serviceCeiling.maxConcurrency} conc · {view.serviceCeiling.maxAgents} agents
            </td>
            <td className="hint">derived from the fleet, clamped by the hard caps</td>
          </tr>
          <tr>
            <td>Baseline floor</td>
            <td>{view.baselineFloorSec}s</td>
            <td className="hint">below it a plan is refused, not silently shortened</td>
          </tr>
          <tr>
            <td>Allowlist</td>
            <td>{view.allowlist.length} target(s)</td>
            <td className="hint">{view.allowlist.slice(0, 6).join(', ') || 'empty'}</td>
          </tr>
          <tr>
            <td>Witnesses</td>
            <td>
              edge {view.witnesses.entry ? 'configured' : 'none'} · origin{' '}
              {view.witnesses.origin ? 'configured' : 'none'}
            </td>
            <td className="hint">
              per-campaign witnesses take precedence; private addresses{' '}
              {view.witnesses.privateAllowed ? 'allowed' : 'refused'}
            </td>
          </tr>
          <tr>
            <td>Kill switch</td>
            <td>{view.killSwitch ? 'available' : 'unavailable'}</td>
            <td className="hint">aborts a running exposure and finalizes what was measured</td>
          </tr>
          <tr>
            <td>Certification</td>
            <td>{view.certification ? 'claimed' : 'never claimed'}</td>
            <td className="hint">a verdict is an assessment, not a certification</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
