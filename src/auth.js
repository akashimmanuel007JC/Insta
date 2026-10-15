import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ADMIN_USERNAME = 'akashimmanuel';
export const COOKIE_NAME = 'studio_session';
export const SESSION_SECONDS = 60 * 60 * 24 * 400;

function asBuffer(value) {
  return Buffer.from(String(value), 'utf8');
}

export function constantTimeEqual(left, right) {
  const a = asBuffer(left);
  const b = asBuffer(right);
  const length = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(length);
  const paddedB = Buffer.alloc(length);
  a.copy(paddedA);
  b.copy(paddedB);
  return timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    sub: ADMIN_USERNAME,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_SECONDS,
    nonce: randomBytes(16).toString('base64url')
  })).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const [payload, suppliedSignature, extra] = token.split('.');
  if (!payload || !suppliedSignature || extra || !constantTimeEqual(suppliedSignature, signature(payload, secret))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.sub === ADMIN_USERNAME && Number.isInteger(data.exp) && data.exp > Math.floor(now / 1000);
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(value => value.trim()).filter(Boolean).map(value => {
    const separator = value.indexOf('=');
    if (separator === -1) return [value, ''];
    let decoded = '';
    try { decoded = decodeURIComponent(value.slice(separator + 1)); } catch {}
    return [value.slice(0, separator), decoded];
  }));
}

export function sessionCookie(token, secure) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure) {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function requestIsSecure(req) {
  return Boolean(req.socket?.encrypted) || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

export function requestOrigin(req) {
  const protocol = requestIsSecure(req) ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${protocol}://${host}` : '';
}

export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) return constantTimeEqual(origin.replace(/\/$/, ''), requestOrigin(req));
  return req.headers['sec-fetch-site'] === 'same-origin';
}

export function createRateLimiter({ maxAttempts = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return {
    check(ip, now = Date.now()) {
      const entry = attempts.get(ip);
      if (!entry || entry.resetAt <= now) return { allowed: true, retryAfter: 0 };
      return { allowed: entry.count < maxAttempts, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    },
    fail(ip, now = Date.now()) {
      const entry = attempts.get(ip);
      if (!entry || entry.resetAt <= now) attempts.set(ip, { count: 1, resetAt: now + windowMs });
      else entry.count += 1;
    },
    clear(ip) { attempts.delete(ip); }
  };
}
