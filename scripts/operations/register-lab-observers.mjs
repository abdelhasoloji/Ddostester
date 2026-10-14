// Operator-only bootstrap. No user session or password is copied to an agent.
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [release, directory] = process.argv.slice(2);
if (!release || !directory || (await lstat(directory)).mode & 0o077)
  throw new Error('Use a private operation directory');
for (const line of (await readFile('/etc/ddostester.env', 'utf8')).split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 1) throw new Error('Malformed environment file');
  const key = line.slice(0, i).trim();
  let value = line.slice(i + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  )
    value = value.slice(1, -1);
  process.env[key] = value;
}
const addresses = JSON.parse(await readFile(directory + '/addresses.json', 'utf8'));
if (
  addresses.length !== 3 ||
  new Set(addresses.map((p) => p.name)).size !== 3 ||
  new Set(addresses.map((p) => p.privateIp)).size !== 3 ||
  addresses.some(
    (p) =>
      !/^lab-iot-0[1-3]$/.test(p.name) ||
      !/^10\.247\.\d{1,3}\.\d{1,3}$/.test(p.privateIp) ||
      !/^[a-f0-9-]{36}$/.test(p.uid),
  )
)
  throw new Error('Invalid lab identities');
const { createStore } = await import(pathToFileURL(release + '/backend/dist/store/index.js'));
const { deviceInput, fleetDeviceView } = await import(
  pathToFileURL(release + '/backend/dist/modules/fleet/devices.js')
);
const store = await createStore();
const accountDigest = async () =>
  createHash('sha256')
    .update(
      JSON.stringify(
        (await store.listUsers())
          .map((u) => ({
            email: u.email,
            role: u.role,
            passwordHash: u.passwordHash,
            status: u.status ?? 'active',
            tokenVersion: u.tokenVersion ?? 0,
          }))
          .sort((a, b) => a.email.localeCompare(b.email)),
      ),
    )
    .digest('hex');
try {
  const before = await accountDigest();
  const receipt = await store.transaction(async (tx) => {
    const existing = await tx.listFleetDevices();
    if (
      existing.length + 3 > 1000 ||
      addresses.some((p) =>
        existing.some((d) => d.agentId === p.name || d.privateIp === p.privateIp),
      )
    )
      throw new Error('Inventory collision; existing devices preserved');
    const configs = [];
    const devices = [];
    const at = new Date().toISOString();
    for (const address of addresses) {
      const index = Number(address.name.slice(-2));
      const profile = ['sensor', 'camera', 'gateway'][index - 1];
      const input = deviceInput.parse({
        agentId: address.name,
        name: `VPS Lab ${profile} ${index}`,
        group: 'VPS Lab',
        profile,
        privateIp: address.privateIp,
        notes: `Managed Kubernetes heartbeat observer; pod UID ${address.uid}; operation fleet-observers-20261014-01. No campaign traffic.`,
      });
      const token = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + 7 * 86400_000;
      const device = {
        ...input,
        id: randomUUID(),
        createdAt: at,
        updatedAt: at,
        credential: { hash: createHash('sha256').update(token).digest('hex'), expiresAt },
        enrollmentRevoked: false,
      };
      await tx.saveFleetDevice(device);
      await tx.saveAudit({
        id: randomUUID(),
        at,
        actor: 'operations:lab-fleet-deploy',
        action: 'store.mutate',
        detail: `fleet.lab.provision id=${device.id} agent=${device.agentId} podUid=${address.uid}`,
      });
      configs.push({
        schema: 'ddostester.fleet.enrollment/v1',
        deviceId: device.id,
        agentId: device.agentId,
        privateIp: device.privateIp,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        controlUrl: 'https://31.31.74.228',
      });
      devices.push(fleetDeviceView(device));
    }
    await writeFile(directory + '/enrollments.json', JSON.stringify(configs), {
      flag: 'wx',
      mode: 0o600,
    });
    return { devices, existingPreserved: existing.length };
  });
  if (before !== (await accountDigest())) throw new Error('Account fingerprint changed');
  await writeFile(
    directory + '/registration-receipt.json',
    JSON.stringify(
      { ...receipt, accountsPreserved: true, actor: 'operations:lab-fleet-deploy' },
      null,
      2,
    ),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      registered: receipt.devices.length,
      existingDevicesPreserved: receipt.existingPreserved,
      accountsPreserved: true,
    }),
  );
} finally {
  await store.close();
}
