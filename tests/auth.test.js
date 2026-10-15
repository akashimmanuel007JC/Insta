import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { createStudioServer } from '../server.js';

const PASSWORD = 'test-password-only';
const SECRET = 'test-secret-that-is-longer-than-thirty-two-characters';
const ORIGIN = 'http://studio.test';

class TestResponse extends Writable {
  constructor(resolve) { super(); this.statusCode = 200; this.headers = {}; this.chunks = []; this.once('finish', () => resolve(this)); }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); return this; }
  text() { return Buffer.concat(this.chunks).toString('utf8'); }
  json() { return JSON.parse(this.text()); }
}

function request(server, path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [body] : []);
    Object.assign(req, { method, url: path, headers: { host: 'studio.test', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const res = new TestResponse(resolve);
    res.once('error', reject);
    server.emit('request', req, res);
  });
}

function login(server, username = 'akashimmanuel', password = PASSWORD, headers = {}) {
  return request(server, '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify({ username, password })
  });
}

test('Studio refuses to start without both authentication secrets', () => {
  assert.throws(() => createStudioServer({ adminPassword: '', authSecret: SECRET }), /ADMIN_PASSWORD/);
  assert.throws(() => createStudioServer({ adminPassword: PASSWORD, authSecret: 'short' }), /AUTH_SECRET/);
});

test('health and JPEG output stay public while Studio pages and APIs are protected', async () => {
  const server = createStudioServer({ adminPassword: PASSWORD, authSecret: SECRET });
  await mkdir('output', { recursive: true });
  await writeFile('output/auth-public-test.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    const health = await request(server, '/health');
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok' });

    const page = await request(server, '/');
    assert.equal(page.statusCode, 302);
    assert.equal(page.getHeader('location'), '/login');

    const api = await request(server, '/api/config');
    assert.equal(api.statusCode, 401);
    assert.deepEqual(api.json(), { error: 'Authentication required.' });

    const image = await request(server, '/output/auth-public-test.jpg');
    assert.equal(image.statusCode, 200);
    assert.equal(image.getHeader('content-type'), 'image/jpeg');

    assert.equal((await request(server, '/output/not-an-image.txt')).statusCode, 404);
  } finally {
    await rm('output/auth-public-test.jpg', { force: true });
  }
});

test('login is generic on failure and creates a long-lived signed HttpOnly session on success', async () => {
  const server = createStudioServer({ adminPassword: PASSWORD, authSecret: SECRET });
  for (const credentials of [['wrong', PASSWORD], ['akashimmanuel', 'wrong']]) {
    const response = await login(server, ...credentials, { 'x-forwarded-for': credentials[0] });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Invalid credentials.' });
  }

  const response = await login(server);
  assert.equal(response.statusCode, 200);
  const cookie = response.getHeader('set-cookie');
  assert.match(cookie, /^studio_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=34560000/);
  assert.doesNotMatch(cookie, /Secure/);

  const cookiePair = cookie.split(';')[0];
  const page = await request(server, '/', { headers: { cookie: cookiePair } });
  assert.equal(page.statusCode, 200);
  assert.match(page.text(), /NEWS CAROUSEL STUDIO/);
  assert.equal(page.getHeader('cache-control'), 'no-store');
  assert.ok(page.getHeader('set-cookie'), 'authenticated use renews the session cookie');

  const separator = cookiePair.indexOf('=');
  const tampered = `${cookiePair.slice(0, separator + 1)}${cookiePair.slice(separator + 1, -1)}x`;
  assert.equal((await request(server, '/api/config', { headers: { cookie: tampered } })).statusCode, 401);
});

test('proxied HTTPS cookies are Secure, state changes require same origin, and logout clears the session', async () => {
  const server = createStudioServer({ adminPassword: PASSWORD, authSecret: SECRET });
  const secureLogin = await login(server, 'akashimmanuel', PASSWORD, { origin: 'https://studio.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'studio.example' });
  assert.equal(secureLogin.statusCode, 200);
  assert.match(secureLogin.getHeader('set-cookie'), /; Secure/);

  const response = await login(server);
  const cookie = response.getHeader('set-cookie').split(';')[0];
  const denied = await request(server, '/api/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(denied.statusCode, 403);

  const logout = await request(server, '/api/auth/logout', { method: 'POST', headers: { cookie, origin: ORIGIN } });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.getHeader('set-cookie'), /Max-Age=0/);
});

test('login rate limiting blocks repeated attempts by client IP', async () => {
  const server = createStudioServer({ adminPassword: PASSWORD, authSecret: SECRET });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await login(server, 'akashimmanuel', 'wrong-password', { 'x-forwarded-for': `203.0.113.${attempt + 1}` })).statusCode, 401);
  }
  const blocked = await login(server, 'akashimmanuel', PASSWORD, { 'x-forwarded-for': '203.0.113.99' });
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.getHeader('retry-after'));
});

test('malformed URLs and directory requests fail without crashing', async () => {
  const server = createStudioServer({ adminPassword: PASSWORD, authSecret: SECRET });
  const malformed = await request(server, '/', { headers: { host: '[' } });
  assert.equal(malformed.statusCode, 400);

  const response = await login(server);
  const cookie = response.getHeader('set-cookie').split(';')[0];
  const directory = await request(server, '/public/', { headers: { cookie } });
  assert.equal(directory.statusCode, 404);
});
