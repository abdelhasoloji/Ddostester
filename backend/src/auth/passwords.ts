import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing via scrypt (built into Node, no dependency).
 * Stored format: scrypt$<saltHex>$<hashHex>.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Async scrypt with a bounded shared work queue. Sync helpers are CLI/test-only. */
let active = 0;
const waiting: (() => void)[] = [];
async function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  if (active >= 4) {
    if (waiting.length >= 32) throw new Error('Password verification capacity exhausted');
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(password, salt, length, (err, key) => (err ? reject(err) : resolve(key))),
    );
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt, 32)).toString('hex')}`;
}
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (
    scheme !== 'scrypt' ||
    !/^[a-f0-9]{32}$/i.test(saltHex ?? '') ||
    !/^[a-f0-9]{64}$/i.test(hashHex ?? '')
  )
    return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(password, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(expected, actual);
}
