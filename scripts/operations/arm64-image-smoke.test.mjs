import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireArm64, smoke } from './arm64-image-smoke.mjs';

test('a platform mismatch cannot be recorded as native ARM64 qualification', () => {
  const image = { Os: 'linux', Architecture: 'arm64' };
  assert.throws(() => requireArm64('linux/x86_64', image), /engine/);
  assert.throws(() => requireArm64('darwin/arm64', image), /engine/);
  assert.throws(() => requireArm64('linux/aarch64', { ...image, Architecture: 'amd64' }), /image/);
  assert.throws(
    () => requireArm64('linux/aarch64', image, { platform: 'linux', arch: 'x64' }),
    /process/,
  );
  requireArm64('linux/aarch64', image, { platform: 'linux', arch: 'arm64' });
});

test('invalid smoke arguments fail before accessing Docker', async () => {
  await assert.rejects(smoke('--help', 'a'.repeat(40)), /required/);
  await assert.rejects(smoke('example:image', 'short'), /required/);
});
