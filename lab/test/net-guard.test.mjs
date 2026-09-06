import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLabAddress, assertLabAddress, assertLabAddressInPrefix } from '../lib/net-guard.mjs';

test('accepts RFC1918 and loopback addresses', () => {
  for (const ip of ['10.0.0.1', '172.16.5.9', '172.31.255.254', '192.168.100.50', '127.0.0.1']) {
    assert.equal(isLabAddress(ip), true, `${ip} should be a lab address`);
  }
});

test('rejects public, invalid and non-IPv4 inputs', () => {
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '',
    '::1',
    'nope',
    undefined,
  ]) {
    assert.equal(isLabAddress(ip), false, `${ip} should NOT be a lab address`);
  }
});

test('assertLabAddress throws for public addresses', () => {
  assert.throws(() => assertLabAddress('8.8.8.8', 'TARGET'), /private\/loopback IPv4/);
  assert.doesNotThrow(() => assertLabAddress('10.1.2.3'));
});

test('an empty/absent prefix never widens the hard gate', () => {
  assert.throws(() => assertLabAddressInPrefix('8.8.8.8', ''), /private\/loopback IPv4/);
  assert.throws(() => assertLabAddressInPrefix('8.8.8.8', undefined), /private\/loopback IPv4/);
  // A prefix can only narrow within the private range.
  assert.doesNotThrow(() => assertLabAddressInPrefix('192.168.100.5', '192.168.100.'));
  assert.throws(
    () => assertLabAddressInPrefix('10.0.0.5', '192.168.100.'),
    /outside the configured lab prefix/,
  );
});
