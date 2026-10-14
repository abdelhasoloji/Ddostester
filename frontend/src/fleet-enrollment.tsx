import { useState } from 'react';
import { api, type FleetDevice, type FleetEnrollment } from './api.js';

export function FleetEnrollmentControls({
  device,
  refresh,
}: {
  device: FleetDevice;
  refresh: () => Promise<void>;
}) {
  const [enrollment, setEnrollment] = useState<FleetEnrollment | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);
  const enrolled = !!device.enrollmentExpiresAt;
  const enroll = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.enrollFleetDevice(device.id);
      setEnrollment(result);
      setConfirm(null);
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    setBusy(true);
    setError('');
    try {
      await api.revokeFleetDevice(device.id);
      setEnrollment(null);
      setConfirm(null);
      await refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    if (!enrollment) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ ...enrollment, controlUrl: window.location.origin }, null, 2)], {
        type: 'application/json',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `fleet-${device.agentId}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div aria-label={`Connection for ${device.name}`}>
      {error && <p role="alert">{error}</p>}
      {enrollment ? (
        <>
          <p>Enrollment ready. Keep this file private; it authorizes this device only.</p>
          <p>
            Use Node.js 22+ on the agent host. Download the client and enrollment file, then run:
          </p>
          <code>
            chmod 600 fleet-{device.agentId}.json &amp;&amp; node heartbeat-agent.mjs fleet-
            {device.agentId}.json
          </code>
          <p>
            <a href="/api/fleet/agent-client.mjs" download="heartbeat-agent.mjs">
              Download agent client
            </a>
          </p>
          <button onClick={download}>Download enrollment</button>{' '}
          <button onClick={() => setEnrollment(null)}>Close enrollment</button>
        </>
      ) : (
        <button
          disabled={busy}
          aria-label={`Enroll ${device.name}`}
          onClick={() => (enrolled ? setConfirm('rotate') : void enroll())}
        >
          {enrolled ? 'Rotate enrollment' : 'Enroll agent'}
        </button>
      )}
      {enrolled && !enrollment && (
        <button
          disabled={busy}
          aria-label={`Revoke ${device.name}`}
          onClick={() => setConfirm('revoke')}
        >
          Revoke access
        </button>
      )}
      {confirm && (
        <>
          <p>
            {confirm === 'rotate'
              ? 'The previous enrollment will stop working.'
              : 'This agent will no longer be allowed to send heartbeats.'}
          </p>
          <button disabled={busy} onClick={() => void (confirm === 'rotate' ? enroll() : revoke())}>
            {confirm === 'rotate' ? 'Confirm rotation' : 'Confirm revocation'}
          </button>{' '}
          <button disabled={busy} onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
