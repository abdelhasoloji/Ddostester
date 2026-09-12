/**
 * One password policy, shared by every path that sets a password (admin create,
 * admin reset, self-service change). Deliberately dependency-free: a length
 * floor plus a few cheap sanity checks (not a common password, not built from
 * the account's own email). Keep the rules here so create/reset/change can never
 * drift apart.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * A small set of obviously-weak passwords. Not a substitute for a breach-corpus
 * check, but it blocks the worst offenders at zero cost. Compared case-folded.
 */
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'administrator',
  'changeme',
  'iloveyou',
  'qwerty',
  'qwertyuiop',
  'azerty',
  'azertyuiop',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '12345678901',
  '123456789012',
  'motdepasse',
  'wedos',
  'wedos123',
  'shieldtest',
]);

/**
 * Returns a human-readable problem with the password, or null when it passes.
 * `email` is optional context so the password can be rejected when it merely
 * decorates the account's own email name.
 */
export function passwordProblem(password: string, email?: string): string | null {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return 'Password is too common — choose a stronger one.';
  }
  if (email) {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 3 && lower.includes(local)) {
      return 'Password must not contain your email name.';
    }
  }
  return null;
}
