import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

test('deployment loads the exact CI commit script instead of the old checkout and preserves dirty work', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shieldtester-deploy-bootstrap-'));
  const origin = join(dir, 'origin');
  const checkout = join(dir, 'checkout');
  const receipt = join(dir, 'receipt');
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(origin);
    git(origin, 'init', '-b', 'main');
    git(origin, 'config', 'user.email', 'fixture@example.invalid');
    git(origin, 'config', 'user.name', 'Deployment fixture');
    mkdirSync(join(origin, 'deploy'));
    writeFileSync(join(origin, 'deploy/update.sh'), 'echo old > "$BOOTSTRAP_TEST_RECEIPT"\n');
    git(origin, 'add', '.');
    git(origin, 'commit', '-m', 'old deployer');
    git(dir, 'clone', origin, checkout);
    const before = git(checkout, 'rev-parse', 'HEAD');
    writeFileSync(
      join(origin, 'deploy/update.sh'),
      'printf "%s\\n" "verified:$DEPLOY_EXPECTED_COMMIT:$DEPLOY_SOURCE_REPO" > "$BOOTSTRAP_TEST_RECEIPT"\n',
    );
    git(origin, 'add', '.');
    git(origin, 'commit', '-m', 'verified deployer');
    const verified = git(origin, 'rev-parse', 'HEAD');
    const workflow = yaml.load(readFileSync(resolve('.github/workflows/deploy.yml'), 'utf8'));
    const script = workflow.jobs.deploy.steps.at(-1).run;
    const env = {
      ...process.env,
      DDOSTESTER_DIR: checkout,
      DEPLOY_BRANCH: 'main',
      DEPLOY_EXPECTED_COMMIT: verified,
      BOOTSTRAP_TEST_RECEIPT: receipt,
    };
    const result = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(receipt, 'utf8').trim(), `verified:${verified}:${checkout}`);
    assert.equal(
      git(checkout, 'rev-parse', 'HEAD'),
      before,
      'bootstrap must not reset or update the source checkout',
    );
    writeFileSync(join(checkout, 'local-work.txt'), 'preserve this work');
    writeFileSync(receipt, 'untouched');
    const refused = spawnSync('bash', ['-c', script], { env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout, /contains local work/);
    assert.equal(readFileSync(receipt, 'utf8'), 'untouched');
    assert.equal(readFileSync(join(checkout, 'local-work.txt'), 'utf8'), 'preserve this work');
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
