let currentCategory = 'Tech';
let currentPage = 1;
let totalPages = 1;
let newsItems = [];

let breakingItems = [];

async function init() {
  document.getElementById('logout-button')?.addEventListener('click', logout);
  await loadConfig();
  await loadBreaking();
  await loadNews();
  await loadHistory();
  pollJobStatus();
}

async function logout() {
  const button = document.getElementById('logout-button');
  if (button) { button.disabled = true; button.textContent = 'Signing out…'; }
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Sign out failed');
    location.replace('/login');
  } catch {
    if (button) { button.disabled = false; button.textContent = 'Try sign out again'; }
  }
}

async function loadBreaking() {
  const loader = document.getElementById('breaking-loader');
  const list = document.getElementById('breaking-list');
  try {
    const res = await fetch('/api/breaking');
    const data = await res.json();
    breakingItems = data.breaking || [];

    renderBreakingCards();

    loader.style.display = 'none';
    list.style.display = 'flex';
  } catch (err) {
    loader.innerHTML = `<p style="color: #f87171; font-size: 0.8rem;">Could not load breaking news</p>`;
  }
}

function renderBreakingCards() {
  const list = document.getElementById('breaking-list');
    if (!breakingItems.length) {
      list.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-muted);">No breaking alerts at this moment.</p>`;
    } else {
      list.innerHTML = breakingItems.map((item, idx) => `
        <div class="breaking-card">
          <div class="breaking-top">
            <span class="breaking-cat">${escapeHtml(item.category)}</span>
            <span class="source-tag">${escapeHtml(item.source)}</span>
          </div>
          <h4 class="breaking-title">${escapeHtml(item.title)}</h4>
          <div class="breaking-actions">
            <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="source-link">Details ↗</a>
            <button class="add-insta-btn" style="padding: 6px 12px; font-size: 0.78rem;" onclick="publishBreaking(${idx})">
              <span>+</span> Add to Insta
            </button>
          </div>
        </div>
      `).join('');
    }

}

function removeSubmittedStory(candidate) {
  const matches = item => candidate.story_id && item.story_id === candidate.story_id || item.url === candidate.url;
  newsItems = newsItems.filter(item => !matches(item));
  breakingItems = breakingItems.filter(item => !matches(item));
  renderNewsCards(newsItems);
  renderBreakingCards();
  loadNews();
}

async function publishBreaking(idx) {
  const candidate = breakingItems[idx];
  if (!candidate) return;

  try {
    const res = await fetch('/api/publish-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate, category: candidate.category })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start publishing');
    removeSubmittedStory(candidate);
    pollJobStatus();
  } catch (err) {
    alert(`Could not publish: ${err.message}`);
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.instagramUser) {
      document.getElementById('account-name').textContent = data.instagramUser;
    }

    const pillsContainer = document.getElementById('category-pills');
    pillsContainer.innerHTML = '';
    (data.categories || []).forEach(cat => {
      const btn = document.createElement('button');
      btn.className = `cat-pill ${cat === currentCategory ? 'active' : ''}`;
      btn.textContent = cat;
      btn.onclick = () => {
        document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        currentCategory = cat;
        currentPage = 1;
        loadNews();
      };
      pillsContainer.appendChild(btn);
    });
  } catch (err) {
    console.error('Failed to load config:', err);
  }
}

async function loadNews() {
  const loader = document.getElementById('loading-indicator');
  const grid = document.getElementById('news-grid');
  const paginationBar = document.getElementById('pagination-bar');

  loader.style.display = 'block';
  grid.style.display = 'none';
  paginationBar.style.display = 'none';

  try {
    const res = await fetch(`/api/news?category=${encodeURIComponent(currentCategory)}&page=${currentPage}`);
    const data = await res.json();

    if (data.error) {
      grid.innerHTML = `<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #f87171;">${data.error}</div>`;
      loader.style.display = 'none';
      grid.style.display = 'grid';
      return;
    }

    newsItems = data.candidates || [];
    totalPages = data.totalPages || 1;
    currentPage = data.page || 1;

    renderNewsCards(newsItems);
    renderPagination(data.page, totalPages);

    loader.style.display = 'none';
    grid.style.display = 'grid';
    paginationBar.style.display = 'flex';
  } catch (err) {
    loader.innerHTML = `<p style="color: #f87171;">Failed to load news: ${err.message}</p>`;
  }
}

function renderNewsCards(items) {
  const grid = document.getElementById('news-grid');
  if (!items.length) {
    grid.innerHTML = `<div style="grid-column: 1/-1; padding: 60px; text-align: center; color: var(--text-muted);">No fresh news found for ${currentCategory}.</div>`;
    return;
  }

  grid.innerHTML = items.map((item, index) => {
    const dateStr = item.published ? new Date(item.published).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Recent';
    return `
      <div class="news-card">
        <div>
          <div class="card-top">
            <span class="source-tag">${escapeHtml(item.source)}</span>
            <span class="card-date">${dateStr}</span>
          </div>
          <h3 class="card-headline">${escapeHtml(item.title)}</h3>
          <p class="card-body">${escapeHtml(item.text)}</p>
        </div>
        <div class="card-footer">
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="source-link">Read Source ↗</a>
          <button class="add-insta-btn" onclick="publishStory(${index})">
            <span>+</span> Add to Insta
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderPagination(page, total) {
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const indicator = document.getElementById('page-indicator');

  indicator.textContent = `Page ${page} of ${total}`;
  prevBtn.disabled = page <= 1;
  nextBtn.disabled = page >= total;

  prevBtn.onclick = () => {
    if (currentPage > 1) {
      currentPage--;
      loadNews();
    }
  };

  nextBtn.onclick = () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadNews();
    }
  };
}

async function publishStory(index) {
  const candidate = newsItems[index];
  if (!candidate) return;

  try {
    const res = await fetch('/api/publish-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate, category: currentCategory })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start publishing');
    removeSubmittedStory(candidate);

    // Trigger immediate poll update
    pollJobStatus();
  } catch (err) {
    alert(`Could not start publish: ${err.message}`);
  }
}

let pollInterval = null;
async function pollJobStatus() {
  if (pollInterval) clearInterval(pollInterval);

  pollInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/job-status');
      const job = await res.json();
      const banner = document.getElementById('live-progress-banner');
      const title = document.getElementById('progress-title');
      const stage = document.getElementById('progress-stage');
      const fill = document.getElementById('progress-fill');

      if (job.status === 'processing') {
        banner.style.display = 'block';
        banner.style.borderColor = '';
        fill.style.background = '';
        title.textContent = `Publishing: ${job.title || 'Breaking News'}`;
        stage.textContent = job.stage || 'Processing...';
        fill.style.width = `${job.progress || 20}%`;
      } else if (job.status === 'success') {
        banner.style.display = 'block';
        fill.style.background = '#22c55e';
        title.textContent = `Published to @info_crasher! 🎉`;
        stage.textContent = job.title;
        fill.style.width = '100%';
        clearInterval(pollInterval);
        pollInterval = null;
        setTimeout(() => { banner.style.display = 'none'; }, 8000);
        loadHistory();
      } else if (job.status === 'no_tunnel') {
        banner.style.display = 'block';
        fill.style.background = '#f59e0b';
        title.textContent = `⚠️ Images generated — but NOT posted to Instagram`;
        stage.textContent = `Add PUBLIC_URL=https://your-ngrok-url to .env, then restart the server.`;
        fill.style.width = '100%';
        clearInterval(pollInterval);
        pollInterval = null;
        setTimeout(() => { banner.style.display = 'none'; }, 12000);
        loadHistory();
      } else if (job.status === 'failed') {
        banner.style.display = 'block';
        fill.style.background = '#ef4444';
        title.textContent = `Publish failed`;
        stage.textContent = job.error || 'Something went wrong';
        fill.style.width = '100%';
        clearInterval(pollInterval);
        pollInterval = null;
      } else {
        // idle — stop polling
        banner.style.display = 'none';
        clearInterval(pollInterval);
        pollInterval = null;
      }
    } catch {}
  }, 2500);
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const posts = await res.json();
    const tbody = document.getElementById('history-tbody');

    if (!posts.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px; color: var(--text-muted);">No posts published yet</td></tr>`;
      return;
    }

    tbody.innerHTML = posts.map(p => {
      const date = new Date(p.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      return `
        <tr>
          <td>${date}</td>
          <td><span class="source-tag">${escapeHtml(p.category || 'News')}</span></td>
          <td style="font-weight: 500;">${escapeHtml(p.headline || 'Story')}</td>
          <td>${escapeHtml(p.source?.name || 'News Source')}</td>
          <td><span class="badge-published">${p.status}</span></td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

window.addEventListener('DOMContentLoaded', init);
