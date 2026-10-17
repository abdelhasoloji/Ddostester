import type { PassivePrototypeCheckpoint } from './infrastructure-types.js';
export function PassivePrototypePanel({
  checkpoint: p,
}: {
  checkpoint: PassivePrototypeCheckpoint;
}) {
  return (
    <section aria-label="Passive PoP prototype">
      <h3>PoP prototype · awaiting Kubernetes access</h3>
      <p>Recorded {p.observedOn} · dated preparation checkpoint, no live Kubernetes observation.</p>
      <div className="fleet-summary">
        <span>
          <b>{p.host.name}</b>
          {p.host.architecture} · {p.host.virtualization}
        </span>
        <span>
          <b>{p.expectedPods}</b>planned telemetry Pods
        </span>
        <span>
          <b>{p.observedReadyPods ?? 'Unknown'}</b>observed Ready Pods
        </span>
      </div>
      <p>
        Namespace: <code>{p.namespace}</code>. {p.scope}
      </p>
      <table className="fleet-table">
        <caption>Preparation and deployment evidence</caption>
        <thead>
          <tr>
            <th>Step</th>
            <th>Status</th>
            <th>Evidence / remaining work</th>
          </tr>
        </thead>
        <tbody>
          {p.steps.map((s) => (
            <tr key={s.id}>
              <th>{s.id}</th>
              <td>{s.status}</td>
              <td>{s.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Proposed total requests: {p.resources.requestCpuMillicores}m CPU /{' '}
        {p.resources.requestMemoryMiB}Mi memory. Limits: {p.resources.limitCpuMillicores}m /{' '}
        {p.resources.limitMemoryMiB}Mi. Allocation remains to be confirmed.
      </p>
      <details>
        <summary>Staged manifest provenance</summary>
        <p>
          SHA-256: <code>{p.artifact.sha256}</code>
        </p>
        <p>
          <code>{p.artifact.stagedPath}</code>
        </p>
        <p>
          The recorded copy is not proof of a deployment. There is no traffic generator, Fleet
          enrollment or automatic deployment action in this view.
        </p>
      </details>
    </section>
  );
}
