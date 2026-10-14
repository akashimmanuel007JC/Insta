import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { extname, join, basename } from 'node:path';
import { readJSON, writeJSON, safeError } from './src/util.js';
import { fetchCandidates } from './src/sources/index.js';
import { script } from './src/script.js';
import { images } from './src/images.js';
import { compose } from './src/compose.js';
import { publish, graph } from './src/publish.js';
import { loadLogs, saveLogs, storyId } from './src/log.js';
import { getSlot } from './src/schedule.js';

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

async function handleApi(req, res, url) {
  const config = await readJSON('config.json');

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
    if (activePublishJob && activePublishJob.status === 'processing') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'A publishing job is already in progress.' }));
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const candidate = payload.candidate;
        const category = payload.category || 'Tech';

        if (!candidate || !candidate.title || !candidate.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid candidate article payload' }));
        }

        if (activePublishJob?.status === 'processing' || submittedStories.has(storyId(candidate))) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'A job is already running or this story was already submitted.' }));
        }
        const id = storyId(candidate);
        submittedStories.add(id);
        activePublishJob = { status: 'processing', title: candidate.title, stage: 'Starting...', progress: 0 };
        try {
          await writeJSON('logs/studio-submitted.json', [...submittedStories]);
        } catch (error) {
          submittedStories.delete(id);
          activePublishJob = null;
          throw error;
        }

        activePublishJob = {
          status: 'processing',
          stage: 'Generating post copy with Azure GPT-4o...',
          title: candidate.title,
          category,
          progress: 20
        };

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Publishing job started', story_id: storyId(candidate) }));

        // Run async background processing
        (async () => {
          const id = storyId(candidate);
          const dir = `output/${id}`;
          try {
            activePublishJob.stage = 'Writing Instagram post copy...';
            activePublishJob.progress = 30;
            const copy = await script(candidate, category, config);

            activePublishJob.stage = 'Generating a high-res image...';
            activePublishJob.progress = 55;
            const buffers = await images(copy, config);

            activePublishJob.stage = 'Compositing image & typography...';
            activePublishJob.progress = 75;
            const paths = await compose(buffers, copy, config, dir);

            const igToken = process.env.IG_ACCESS_TOKEN;
            const igUser = process.env.IG_USER_ID;

            let igMediaId = null;
            let finalStatus = 'generated'; // fallback if no Instagram credentials

            if (igToken && igUser) {
              activePublishJob.stage = 'Resolving public image URLs for Instagram...';
              activePublishJob.progress = 80;

              // Resolve a publicly accessible base URL so Instagram can fetch images.
              // Set PUBLIC_URL=https://your-ngrok-url in .env, or install ngrok for auto-tunnel.
              const publicBase = await getPublicUrl(PORT);

              if (publicBase) {
                // Build publicly accessible URLs for each composed image
                const imageUrls = paths.map(p => `${publicBase}/${p}`);

                activePublishJob.stage = 'Publishing image to @info_crasher...';
                activePublishJob.progress = 90;

                const api = graph(config, igToken);
                igMediaId = await publish(imageUrls, copy, api, {
                  user: igUser,
                  persist: async patch => { Object.assign(activePublishJob, { igPatch: patch }); }
                });
                finalStatus = 'published';
                console.log(`✅ Published to Instagram, media_id=${igMediaId}`);

                // Clean up local output folder after successful publish
                await rm(dir, { recursive: true, force: true }).catch(() => {});
              } else {
                // No public URL available — images generated but not posted
                finalStatus = 'generated';
                console.warn('⚠️  No PUBLIC_URL or ngrok found. Images generated locally but NOT posted to Instagram.');
                console.warn('   Set PUBLIC_URL=https://your-tunnel.ngrok.io in .env and restart.');
              }
            }

            const logs = await loadLogs('logs').catch(() => ({ posts: [], used: [] }));
            logs.posts.push({
              timestamp: new Date().toISOString(),
              story_id: id,
              category,
              source: { name: candidate.source, url: candidate.url },
              headline: candidate.title,
              status: finalStatus,
              ig_media_id: igMediaId
            });
            await saveLogs(logs, 'logs').catch(() => {});

            const stageMsg = finalStatus === 'published'
              ? '✅ Post published to @info_crasher!'
              : '⚠️  Images generated locally — set PUBLIC_URL in .env to post to Instagram.';

            activePublishJob = {
              status: finalStatus === 'published' ? 'success' : 'no_tunnel',
              stage: stageMsg,
              title: candidate.title,
              paths: paths.map(p => `/${p}`),
              ig_media_id: igMediaId,
              progress: 100
            };
            // Reset to idle after 15s so the next poll cleanly stops
            setTimeout(() => { activePublishJob = null; }, 15000);
          } catch (err) {
            console.error('Publishing failed:', err);
            activePublishJob = {
              status: 'failed',
              error: safeError(err),
              stage: 'Failed',
              progress: 0
            };
          }
        })();

      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: safeError(err) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }

  // Serve static files from public/ or output/
  let filePath = join(process.cwd(), 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (url.pathname.startsWith('/output/')) {
    filePath = join(process.cwd(), url.pathname);
  }

  if (existsSync(filePath)) {
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 News Carousel Studio running at http://localhost:${PORT}`);
  console.log(`✨ Connected Instagram Account: @info_crasher`);
  console.log(`======================================================\n`);
});
