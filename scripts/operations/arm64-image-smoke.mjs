import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function requireArm64(engine, image, runtime) {
  if (!/^linux\/(arm64|aarch64)$/.test(engine))
    throw new Error(
      'A Linux ARM64 Docker engine is required; cross-ISA execution is not native proof',
    );
  if (image.Os !== 'linux' || image.Architecture !== 'arm64')
    throw new Error('The image must be Linux ARM64');
  if (runtime && (runtime.platform !== 'linux' || runtime.arch !== 'arm64'))
    throw new Error('The running process must be Linux ARM64');
}

export async function smoke(imageRef, expectedCommit, output) {
  if (!imageRef || imageRef.startsWith('-') || !/^[a-f0-9]{40}$/.test(expectedCommit ?? ''))
    throw new Error('Image and full expected source commit are required');
  const docker = (...args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const engine = docker('info', '--format', '{{.OSType}}/{{.Architecture}}');
  const image = JSON.parse(docker('image', 'inspect', imageRef))[0];
  requireArm64(engine, image);
  const name = `shieldtest-arm64-smoke-${randomUUID()}`;
  let started = false;
  let report;
  let cleanupError;
  try {
    docker(
      'run',
      '--detach',
      '--name',
      name,
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:rw,nosuid,noexec,size=16777216',
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--pids-limit',
      '64',
      '-e',
      'USER_MODE=team',
      '-e',
      'HOST=127.0.0.1',
      '-e',
      'ALLOWED_TARGETS=127.0.0.1',
      '-e',
      'AGENT=builtin',
      '-e',
      'FLEET_ENABLED=0',
      '-e',
      'FLEET_MISSIONS_ENABLED=0',
      image.Id,
    );
    started = true;
    const runtime = JSON.parse(
      docker(
        'exec',
        name,
        'node',
        '-e',
        'console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version}))',
      ),
    );
    requireArm64(engine, image, runtime);
    const deadline = Date.now() + 30000;
    let health;
    while (Date.now() < deadline) {
      try {
        const state = JSON.parse(
          docker(
            'exec',
            name,
            'node',
            '--input-type=module',
            '-e',
            "const base='http://127.0.0.1:8080';const h=await(await fetch(base+'/health',{signal:AbortSignal.timeout(2000)})).json();const r=await(await fetch(base+'/ready',{signal:AbortSignal.timeout(2000)})).json();console.log(JSON.stringify({health:h,ready:r.ready}));",
          ),
        );
        if (state.ready) {
          health = state.health;
          break;
        }
      } catch {
        /* Startup is allowed only within this fixed observation window. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!health) throw new Error('Isolated image did not become ready within 30 seconds');
    if (
      health.version?.commit !== expectedCommit ||
      health.userMode !== 'team' ||
      health.storage !== 'memory'
    )
      throw new Error('Unexpected source identity or isolated fixture configuration');
    docker('exec', name, 'node', 'scripts/verify-release.mjs', 'release-manifest.json');
    docker(
      'exec',
      name,
      'node',
      '--input-type=module',
      '-e',
      "const worker=await import('/app/backend/dist/modules/fleet/agent.js');const adapter=await import('/app/backend/dist/agents/persistent-fleet.js');if(typeof worker.runFleetAssignment!=='function'||typeof adapter.PersistentFleetHttpAgent!=='function')throw Error('Missing worker modules');",
    );
    report = {
      schema: 'shieldtester.arm64-image-smoke/v1',
      observedAt: new Date().toISOString(),
      sourceCommit: expectedCommit,
      imageId: image.Id,
      dockerEngine: engine,
      runtime,
      apiReady: true,
      servedUiAssetsVerified: true,
      workerModulesImported: true,
      isolatedFixture: { userMode: 'team', storage: 'memory', network: 'none', publishedPorts: 0 },
      campaignsStarted: 0,
      productionModeQualified: false,
      hpeHardwareQualified: false,
    };
  } finally {
    try {
      docker('rm', '--force', name);
    } catch (error) {
      if (started) cleanupError = error;
    }
  }
  if (cleanupError) throw new Error('Smoke container cleanup failed', { cause: cleanupError });
  report.containerRemoved = true;
  if (output)
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [image, commit, output] = process.argv.slice(2);
  console.log(JSON.stringify(await smoke(image, commit, output), null, 2));
}
