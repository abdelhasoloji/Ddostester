import { InfrastructureWorkspacePanel } from './infrastructure-workspace.js';
import { FleetSitesPanel } from './fleet-sites.js';
import { FleetMissions } from './fleet-missions.js';
import { useEffect, useState } from 'react';
import { api, type FleetDevice, type FleetDeviceInput } from './api.js';
import { useApp, canDo } from './context.js';
import { PageHead } from './pages.js';
import { FleetLivePanel } from './fleet-live.js';
import { FleetEnrollmentControls } from './fleet-enrollment.js';
import { FleetOperations } from './fleet-operations.js';

const blank: FleetDeviceInput = {
  agentId: '',
  name: '',
  group: 'Lab',
  profile: 'sensor',
  privateIp: '',
  notes: '',
};
export function FleetPage() {
  const app = useApp();
  const editable = canDo(app.role, 'manage', app.authRequired, app.userMode, app.capabilities);
  const [devices, setDevices] = useState<FleetDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [siteId, setSiteId] = useState('');
  const [sites, setSites] = useState<{ id: string; devices: number; online: number }[]>([]);
  const [group, setGroup] = useState('');
  const [draft, setDraft] = useState<FleetDeviceInput | null>(null);
  const [editing, setEditing] = useState<string | undefined>();
  const [removing, setRemoving] = useState<FleetDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () =>
      (app.drsWorkflow
        ? api.fleetDevices({ page, pageSize: 100, siteId, search: query })
        : api.fleetDevices()
      )
        .then((result) => {
          if (active) {
            setDevices(result.devices);
            setTotal(result.total ?? result.devices.length);
            setReadError('');
          }
        })
        .catch((reason) => {
          if (active) setReadError(reason.message);
        })
        .finally(() => {
          if (active) {
            setLoading(false);
            timer = setTimeout(poll, 5000);
          }
        });
    if (app.drsWorkflow)
      void api
        .fleetSites()
        .then((d) => {
          if (active) setSites(d.sites);
        })
        .catch(() => {});
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [app.drsWorkflow, page, siteId, query]);
  const reload = async () => {
    const result = await (app.drsWorkflow
      ? api.fleetDevices({ page, pageSize: 100, siteId, search: query })
      : api.fleetDevices());
    setDevices(result.devices);
    setTotal(result.total ?? result.devices.length);
    setReadError('');
  };
  const visible = devices.filter(
    (device) =>
      (!group || device.group === group) &&
      [device.name, device.agentId, device.privateIp, device.group].some((value) =>
        value.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.saveFleetDevice(draft, editing);
      await reload();
      setDraft(null);
      setMessage(editing ? 'Device updated.' : 'Device registered.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.removeFleetDevice(removing.id);
      await reload();
      setRemoving(null);
      setMessage('Device removed from inventory.');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHead
        title="Fleet management"
        sub="Prepare IoT agents for campaigns, follow assigned runs and manage enrollment."
      />
      {app.drsWorkflow && <FleetSitesPanel />}
      <InfrastructureWorkspacePanel editable={editable} />
      <FleetOperations editable={editable} />
      {error && <p role="alert">{error}</p>}
      {readError && (
        <p role="alert">
          Fleet refresh unavailable: {readError}. Connection state is unknown until refresh
          succeeds.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="card" aria-label="IoT device inventory">
        <div className="fleet-toolbar">
          <h2>IoT devices</h2>
          {editable && (
            <button
              onClick={() => {
                setEditing(undefined);
                setDraft({ ...blank });
                setMessage('');
              }}
            >
              Register device
            </button>
          )}
        </div>
        <p>
          {app.drsWorkflow ? total : devices.length}{' '}
          {app.drsWorkflow ? 'matching agents' : 'registered'} ·{' '}
          {readError ? '?' : devices.filter((d) => d.connection === 'online').length} online ·{' '}
          {new Set(devices.map((d) => d.group)).size} groups
        </p>
        <p className="hint">
          Online means an authenticated heartbeat was received within 30 seconds. The private IP is
          declared by the agent; it is not a network verification. Enrollment does not launch
          traffic.
        </p>
        <div className="fleet-toolbar">
          {app.drsWorkflow && (
            <>
              <label>
                Site{' '}
                <select
                  value={siteId}
                  onChange={(e) => {
                    setSiteId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">All sites</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Previous page
              </button>
              <span>Page {page}</span>
              <button disabled={page * 100 >= total} onClick={() => setPage((p) => p + 1)}>
                Next page
              </button>
            </>
          )}
          <label>
            Search devices
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Name, agent ID or private IP"
            />
          </label>
          <label>
            Group
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="">All groups</option>
              {[...new Set(devices.map((d) => d.group))].sort().map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || loading}
            onClick={() => {
              setError('');
              void reload().catch((reason) => setReadError(reason.message));
            }}
          >
            Refresh inventory
          </button>
        </div>
        {loading ? (
          <p role="status">Loading devices…</p>
        ) : !devices.length && readError ? (
          <p>Inventory unavailable. Retry when the connection is restored.</p>
        ) : !devices.length ? (
          <p>No devices registered. Register your first IoT device to build the inventory.</p>
        ) : !visible.length ? (
          <p>No devices match your filters.</p>
        ) : (
          <div className="fleet-table-scroll">
            <table className="fleet-table">
              <caption>Registered IoT devices</caption>
              <thead>
                <tr>
                  <th>Name / agent ID</th>
                  <th>Group</th>
                  <th>Profile</th>
                  <th>Private IP</th>
                  <th>Connection</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((device) => (
                  <tr key={device.id}>
                    <th scope="row">
                      {device.name}
                      <br />
                      <small>{device.agentId}</small>
                    </th>
                    <td>
                      {device.siteId ?? 'vps-lab'}
                      <br />
                      <small>{device.group}</small>
                    </td>
                    <td>{device.profile}</td>
                    <td>{device.privateIp}</td>
                    <td>
                      {readError ? 'unknown' : (device.connection ?? 'unenrolled')}
                      <br />
                      <small>
                        {device.lastSeenAt
                          ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                          : 'No heartbeat received'}
                      </small>
                      {device.agentVersion && (
                        <>
                          <br />
                          <small>{device.agentVersion}</small>
                        </>
                      )}
                    </td>
                    <td>
                      {editable ? (
                        <>
                          <button
                            aria-label={`Edit ${device.name}`}
                            onClick={() => {
                              setEditing(device.id);
                              setDraft({
                                siteId: device.siteId ?? 'vps-lab',
                                agentId: device.agentId,
                                name: device.name,
                                group: device.group,
                                profile: device.profile,
                                privateIp: device.privateIp,
                                notes: device.notes,
                              });
                            }}
                          >
                            Edit
                          </button>{' '}
                          <button
                            aria-label={`Remove ${device.name}`}
                            onClick={() => setRemoving(device)}
                          >
                            Remove
                          </button>
                          <FleetEnrollmentControls device={device} refresh={reload} />
                        </>
                      ) : (
                        'Read only'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {draft && (
        <section className="card" aria-label={editing ? 'Edit device' : 'Register device'}>
          <h2>{editing ? 'Edit device' : 'Register device'}</h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="fleet-form-grid">
              {(['name', 'agentId', 'siteId', 'group', 'privateIp'] as const).map((key) => (
                <label key={key}>
                  {
                    {
                      siteId: 'Site ID (stable)',
                      name: 'Device name',
                      agentId: 'Agent ID',
                      group: 'Device group',
                      privateIp: 'Private IPv4 address',
                    }[key]
                  }
                  <input
                    required={key !== 'siteId'}
                    maxLength={key === 'name' ? 100 : 64}
                    value={draft[key] ?? ''}
                    onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                  />
                </label>
              ))}
              <label>
                Device profile
                <select
                  value={draft.profile}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      profile: event.target.value as FleetDeviceInput['profile'],
                    })
                  }
                >
                  {['sensor', 'camera', 'gateway', 'generic'].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Notes
                <textarea
                  maxLength={1000}
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </label>
            </div>
            <button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save device'}
            </button>{' '}
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </form>
        </section>
      )}
      {removing && (
        <section className="card" aria-label="Confirm removal">
          <h2>Remove {removing.name}?</h2>
          <p>This removes the inventory record. It does not stop or delete a running agent.</p>
          <button disabled={busy} onClick={() => void remove()}>
            Confirm removal
          </button>{' '}
          <button disabled={busy} onClick={() => setRemoving(null)}>
            Cancel
          </button>
        </section>
      )}
      {!app.drsWorkflow && (
        <details className="card">
          <summary>Legacy private lab missions and coordinator diagnostics</summary>
          <FleetMissions devices={readError ? [] : devices} editable={editable} historyOnly />
          <FleetLivePanel />
        </details>
      )}
    </>
  );
}
