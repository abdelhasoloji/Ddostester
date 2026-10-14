import { createHmac, timingSafeEqual } from 'node:crypto';

/** New authenticated sessions require reauthentication after one hour. */
export const SESSION_TTL_SECONDS = 3600;

/** Minimal, self-contained HS256 JWT (no dependency). */
export interface JwtPayload {
  sub: string; // email
  role: string;
  /** Token version for session revocation (absent = 0). */
  ver?: number;
  iat: number;
  exp: number;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSec = SESSION_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat: now, exp: now + ttlSec };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(full));
  const sig = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = sign(`${header}.${body}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload;
    const metadata = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (metadata.alg !== 'HS256' || metadata.typ !== 'JWT') return null;
    if (
      !payload ||
      typeof payload.sub !== 'string' ||
      !payload.sub ||
      typeof payload.role !== 'string' ||
      !Number.isInteger(payload.exp) ||
      !Number.isInteger(payload.iat)
    )
      return null;
    if (payload.ver !== undefined && (!Number.isInteger(payload.ver) || payload.ver < 0))
      return null;
    if (
      payload.exp <= Math.floor(Date.now() / 1000) ||
      payload.iat > Math.floor(Date.now() / 1000) + 30
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}
