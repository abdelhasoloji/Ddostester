import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { signWitness, verifyWitnesses } from './proof.mjs';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const checkpoint = (head, previous = 'GENESIS') => ({
  schemaVersion: 1,
  verified: true,
  at: new Date().toISOString(),
  count: 2,
  headHash: head.repeat(64),
  previousAuditHead: previous,
});
test('independent signatures bind consecutive audit heads', () => {
  const first = signWitness(checkpoint('a'), undefined, privateKey);
  const second = signWitness(checkpoint('b', first.content.headHash), first, privateKey);
  assert.equal(verifyWitnesses([first, second], publicKey).auditHead, 'b'.repeat(64));
});
test('rewritten heads and removed records are rejected', () => {
  const first = signWitness(checkpoint('a'), undefined, privateKey);
  const second = signWitness(checkpoint('b', first.content.headHash), first, privateKey);
  assert.throws(() =>
    verifyWitnesses([{ ...first, content: { ...first.content, count: 99 } }, second], publicKey),
  );
  assert.throws(() => verifyWitnesses([second], publicKey));
  assert.throws(() => signWitness(checkpoint('c', 'd'.repeat(64)), second, privateKey));
});
