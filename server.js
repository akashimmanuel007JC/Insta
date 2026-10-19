import http from 'node:http';
import {generateBio, generateProfilePicture, profilePrompt} from './src/profile.js';
import { readFile, rm } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJSON, writeJSON, safeError } from './src/util.js';
import { fetchCandidates } from './src/sources/index.js';
import { script } from './src/script.js';
import { images } from './src/images.js';
import { compose } from './src/compose.js';
import { publish, graph } from './src/publish.js';
import { dedupe, loadLogs, locked, saveLogs, storyId, storyLocked, relatedToPostHistory } from './src/log.js';
import { getSlot, scheduleOverview } from './src/schedule.js';
import { selectByIntensity } from './src/intensity.js';
import {
  ADMIN_USERNAME, COOKIE_NAME, clearSessionCookie, constantTimeEqual, createRateLimiter,
  createSessionToken, isSameOrigin, parseCookies, requestIsSecure, sessionCookie, verifySessionToken
} from './src/auth.js';

// ── Public URL resolution ──────────────────────────────────────────────────
// Priority: PUBLIC_URL env var > ngrok auto-tunnel > null (log-only mode)
let _publicUrl = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : null;

async function getPublicUrl(port) {
  if (_publicUrl) return _publicUrl;
  try {
    // Try ngrok if installed
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    await exec('ngrok', ['http', String(port), '--log=stdout', '--log-level=error'], { timeout: 500 }).catch(() => {});
    // Give ngrok 2s to start, then query its local API
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch('http://127.0.0.1:4040/api/tunnels').catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      const tunnel = data.tunnels?.find(t => t.proto === 'https');
      if (tunnel) { _publicUrl = tunnel.public_url.replace(/\/$/, ''); return _publicUrl; }
    }
  } catch {}
  return null;
}

const PORT = process.env.PORT || 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

let activePublishJob = null;
const submittedStories = new Set(await readJSON('logs/studio-submitted.json', []));
const attemptedAutomaticSlots = new Set();
const automaticPublishingEnabled = process.env.AUTO_PUBLISH_ENABLED === 'true' || (process.env.RENDER === 'true' && process.env.AUTO_PUBLISH_ENABLED !== 'false');

export async function selectAutomaticCandidate(config, logs, now = new Date(), fetcher = fetchCandidates) {
  const pool = [];
  const warnings = [];
  for (const category of config.categories) {
    try {
      const result = await fetcher(category, config, { now });
      pool.push(...(result.candidates || []).map(candidate => ({ ...candidate, category })));
      warnings.push(...(result.warnings || []).map(warning => `${category}: ${warning}`));
    } catch (error) {
      warnings.push(`${category}: ${safeError(error)}`);
    }
  }
  const candidates = dedupe(
    pool.filter(candidate => !submittedStories.has(storyId(candidate))),
    logs.used,
    config,
    now
  ).filter(candidate => !storyLocked(logs, candidate)
    && !relatedToPostHistory(candidate, logs.posts, config.historySimilarity));
  if (!candidates.length) throw new Error(`No unused or sufficiently distinct candidates available. ${warnings.join('; ')}`.trim());
  return { candidate: selectByIntensity(candidates, pool, config, now), warnings };
}

async function startPublishJob(candidate, category, { slot = null, warnings = [], trigger = 'manual' } = {}) {
  if (activePublishJob?.status === 'processing') throw Object.assign(new Error('A publishing job is already in progress.'), { statusCode: 409 });
  if (!candidate?.title || !candidate?.text || !candidate?.url) throw Object.assign(new Error('Invalid candidate article payload'), { statusCode: 400 });

  const id = storyId(candidate);
  if (submittedStories.has(id)) throw Object.assign(new Error('This story was already submitted.'), { statusCode: 409 });
  activePublishJob = { status: 'processing', title: candidate.title, category, trigger, stage: 'Starting...', progress: 0 };
  let config;
  try { config = await readJSON('config.json'); }
  catch (error) { activePublishJob = null; throw error; }
  submittedStories.add(id);
  try {
    await writeJSON('logs/studio-submitted.json', [...submittedStories]);
  } catch (error) {
    submittedStories.delete(id);
    activePublishJob = null;
    throw error;
  }

  const logs = await loadLogs('logs').catch(() => ({ posts: [], used: [] }));
  const record = {
    timestamp: new Date().toISOString(),
    ...(slot ? { slot: slot.id } : {}),
    story_id: id,
    category,
    source: { name: candidate.source, url: candidate.url },
    headline: candidate.title,
    status: 'preparing',
    ig_media_id: null,
    trigger,
    ...(warnings.length ? { warnings } : {})
  };
  logs.posts.push(record);
  logs.used.push({ url: candidate.url, title: candidate.title, timestamp: record.timestamp });
  try {
    await saveLogs(logs, 'logs');
  } catch (error) {
    submittedStories.delete(id);
    activePublishJob = null;
    throw error;
  }
  void (async () => {
    const dir = `output/${id}`;
    try {
      activePublishJob.stage = 'Writing Instagram post copy...';
      activePublishJob.progress = 30;
      const copy = await script(candidate, category, config);
      record.caption = copy.caption;
      await saveLogs(logs, 'logs');

      activePublishJob.stage = 'Generating a high-res image...';
      activePublishJob.progress = 55;
      const buffers = await images(copy, config);

      activePublishJob.stage = 'Compositing image & typography...';
      activePublishJob.progress = 75;
      const paths = await compose(buffers, copy, config, dir);
      const igToken = process.env.IG_ACCESS_TOKEN;
      const igUser = process.env.IG_USER_ID;
      if (!igToken || !igUser) throw new Error('Missing IG_ACCESS_TOKEN or IG_USER_ID');

      activePublishJob.stage = 'Resolving public image URL for Instagram...';
      activePublishJob.progress = 80;
      const publicBase = await getPublicUrl(PORT);
      if (!publicBase) throw new Error('Missing PUBLIC_URL; Instagram cannot fetch the generated image');
      const imageUrls = paths.map(path => `${publicBase}/${path}`);

      activePublishJob.stage = 'Publishing image to @info_crasher...';
      activePublishJob.progress = 90;
      const igMediaId = await publish(imageUrls, copy, graph(config, igToken), {
        user: igUser,
        persist: async patch => { Object.assign(record, patch); await saveLogs(logs, 'logs'); }
      });

      record.status = 'published';
      record.ig_media_id = igMediaId;
      record.timestamp = new Date().toISOString();
      await saveLogs(logs, 'logs');
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      console.log(`Published ${trigger} Instagram post, media_id=${igMediaId}`);
      activePublishJob = {
        status: 'success', stage: 'Post published to @info_crasher!', title: candidate.title,
        paths: paths.map(path => `/${path}`), ig_media_id: igMediaId, trigger, progress: 100
      };
      setTimeout(() => { if (activePublishJob?.ig_media_id === igMediaId) activePublishJob = null; }, 15000);
    } catch (error) {
      record.status = record.publish_requested_at ? 'uncertain' : 'failed';
      record.error = safeError(error);
      await saveLogs(logs, 'logs').catch(() => {});
      console.error(`${trigger} publishing failed:`, safeError(error));
      activePublishJob = { status: 'failed', error: safeError(error), stage: 'Failed', title: candidate.title, trigger, progress: 0 };
    }
  })();
  return { story_id: id };
}

async function runAutomaticPublisher(now = new Date()) {
  if (!automaticPublishingEnabled || activePublishJob?.status === 'processing') return;
  const config = await readJSON('config.json');
  const slot = getSlot(config, now);
  if (!slot || attemptedAutomaticSlots.has(slot.id)) return;
  const logs = await loadLogs('logs').catch(() => ({ posts: [], used: [] }));
  const slotAlreadyAttempted = logs.posts.some(record => record.slot === slot.id
    && ['preparing', 'posting', 'published', 'failed', 'uncertain'].includes(record.status));
  if (slotAlreadyAttempted || locked(logs, slot)) { attemptedAutomaticSlots.add(slot.id); return; }

  attemptedAutomaticSlots.add(slot.id);
  try {
    const { candidate, warnings } = await selectAutomaticCandidate(config, logs, now);
    await startPublishJob(candidate, candidate.category, { slot, warnings, trigger: 'automatic' });
  } catch (error) {
    console.error(`Automatic slot ${slot.id} failed:`, safeError(error));
    const currentLogs = await loadLogs('logs').catch(() => logs);
    if (!locked(currentLogs, slot)) {
      currentLogs.posts.push({ timestamp: now.toISOString(), slot: slot.id, category: null, status: 'failed', trigger: 'automatic', error: safeError(error) });
      await saveLogs(currentLogs, 'logs').catch(() => {});
    }
  }
}

function startAutomaticScheduler() {
  if (!automaticPublishingEnabled) {
    console.log('Automatic Render publishing is disabled. Set AUTO_PUBLISH_ENABLED=true to enable it.');
    return;
  }
  console.log('Automatic Render publishing is enabled.');
  setTimeout(() => void runAutomaticPublisher(), 5000);
  setInterval(() => void runAutomaticPublisher(), 60000);
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readRequestJson(req, limit = 16_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limit) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON request.'), { statusCode: 400 }); }
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function isFile(path) {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function sendFile(res, path, headers) {
  const stream = createReadStream(path);
  stream.once('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Unable to read file');
  });
  res.writeHead(200, headers);
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  const config = await readJSON('config.json');

  if (req.method === 'POST' && ['/api/profile/bio', '/api/profile/picture'].includes(url.pathname)) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16000) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Instructions are too large.' }));
        }
      }
      let prompt;
      try { prompt = profilePrompt(JSON.parse(body).prompt); }
      catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: error instanceof SyntaxError ? 'Invalid JSON request.' : safeError(error) }));
      }
      const result = url.pathname.endsWith('/bio')
        ? await generateBio(prompt, config)
        : await generateProfilePicture(prompt, config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: safeError(error) }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/schedule') {
    try {
      const logs = await loadLogs('logs');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(scheduleOverview(config, logs.posts, new Date(), {
        runner: automaticPublishingEnabled ? 'render' : 'disabled',
        localAutoPublishing: automaticPublishingEnabled
      })));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: safeError(error) }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      categories: config.categories,
      schedule: config.schedule,
      brand: config.brand,
      instagramUser: process.env.IG_USER_ID ? '@info_crasher' : null
    }));
  }

  if (req.method === 'GET' && url.pathname === '/api/breaking') {
    try {
      const breakingCats = ['World', 'Tech', 'Business'];
      const allResults = [];
      for (const cat of breakingCats) {
        try {
          const result = await fetchCandidates(cat, config);
          const candidates = result.candidates?.filter(c => !submittedStories.has(storyId(c)));
          if (candidates && candidates.length) {
            allResults.push({ ...candidates[0], category: cat, story_id: storyId(candidates[0]), isBreaking: true });
            if (candidates[1]) allResults.push({ ...candidates[1], category: cat, story_id: storyId(candidates[1]), isBreaking: true });
          }
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ breaking: allResults }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: safeError(e) }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/news') {
    const category = url.searchParams.get('category') || config.categories[0];
    let page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = 6;

    try {
      const result = await fetchCandidates(category, config);
      const warnings = result.warnings;
      const candidates = result.candidates.filter(c => !submittedStories.has(storyId(c)));
      const total = candidates.length;
      const totalPages = Math.ceil(total / pageSize) || 1;
      page = Math.min(page, totalPages);
      const start = (page - 1) * pageSize;
      const paginated = candidates.slice(start, start + pageSize);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        category,
        page,
        pageSize,
        total,
        totalPages,
        warnings,
        candidates: paginated.map(c => ({
          ...c,
          story_id: storyId(c)
        }))
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: safeError(e) }));
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    const logs = await loadLogs('logs').catch(() => ({ posts: [], used: [] }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(logs.posts.slice().reverse()));
  }

  if (req.method === 'GET' && url.pathname === '/api/job-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(activePublishJob || { status: 'idle' }));
  }

  if (req.method === 'POST' && url.pathname === '/api/publish-now') {
    try {
      const payload = await readRequestJson(req);
      const result = await startPublishJob(payload.candidate, payload.category || 'Tech');
      return json(res, 202, { message: 'Publishing job started', ...result });
    } catch (error) {
      return json(res, error.statusCode || 400, { error: safeError(error) });
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
}

export function createStudioServer({ adminPassword = process.env.ADMIN_PASSWORD, authSecret = process.env.AUTH_SECRET } = {}) {
  if (!adminPassword) throw new Error('Studio configuration error: ADMIN_PASSWORD is required.');
  if (!authSecret || Buffer.byteLength(authSecret) < 32) throw new Error('Studio configuration error: AUTH_SECRET is required and must be at least 32 characters.');
  const limiter = createRateLimiter();
  const globalLimiter = createRateLimiter();

  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return json(res, 400, { error: 'Invalid request URL.' }); }
    const secure = requestIsSecure(req);

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && url.pathname === '/login') {
      if (verifySessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME], authSecret)) {
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      const loginPath = join(process.cwd(), 'public', 'login.html');
      return sendFile(res, loginPath, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      if (!isSameOrigin(req)) return json(res, 403, { error: 'Request origin is not allowed.' });
      const ip = clientIp(req);
      const status = limiter.check(ip);
      const globalStatus = globalLimiter.check('all');
      if (!status.allowed || !globalStatus.allowed) {
        return json(res, 429, { error: 'Too many sign-in attempts. Try again later.' }, { 'Retry-After': String(Math.max(status.retryAfter, globalStatus.retryAfter)) });
      }
      try {
        const credentials = await readRequestJson(req, 4_096);
        const valid = constantTimeEqual(credentials.username || '', ADMIN_USERNAME) && constantTimeEqual(credentials.password || '', adminPassword);
        if (!valid) {
          limiter.fail(ip);
          globalLimiter.fail('all');
          return json(res, 401, { error: 'Invalid credentials.' });
        }
        limiter.clear(ip);
        globalLimiter.clear('all');
        return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(createSessionToken(authSecret), secure) });
      } catch (error) {
        return json(res, error.statusCode || 400, { error: error.message });
      }
    }

    const session = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const authenticated = verifySessionToken(session, authSecret);

    if (req.method === 'GET' && url.pathname.startsWith('/output/')) {
      const outputRoot = resolve(process.cwd(), 'output');
      const requested = resolve(outputRoot, `.${url.pathname.slice('/output'.length)}`);
      if (!requested.startsWith(`${outputRoot}${sep}`) || !/\.jpe?g$/i.test(requested) || !isFile(requested)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      return sendFile(res, requested, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
    }

    if (!authenticated) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Authentication required.' });
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
      return res.end();
    }

    // Sliding renewal: authenticated use receives a fresh signed 400-day cookie.
    res.setHeader('Set-Cookie', sessionCookie(createSessionToken(authSecret), secure));

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      if (!isSameOrigin(req)) return json(res, 403, { error: 'Request origin is not allowed.' });
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(secure) });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname.startsWith('/api/') && !isSameOrigin(req)) {
      return json(res, 403, { error: 'Request origin is not allowed.' });
    }

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

    const publicRoot = resolve(process.cwd(), 'public');
    const relativePath = url.pathname === '/' ? 'index.html' : `.${url.pathname}`;
    const filePath = resolve(publicRoot, relativePath);

    if (filePath.startsWith(`${publicRoot}${sep}`) && isFile(filePath)) {
      const ext = extname(filePath).toLowerCase();
      return sendFile(res, filePath, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let server;
  try { server = createStudioServer(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  server?.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 News Carousel Studio running at http://localhost:${PORT}`);
    console.log(`🔒 Private operator access enabled`);
    console.log(`======================================================\n`);
    startAutomaticScheduler();
  });
}
