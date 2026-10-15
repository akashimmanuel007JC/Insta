(() => {
  const detail = document.getElementById('schedule-next-detail');
  const countdown = document.getElementById('schedule-countdown');
  const list = document.getElementById('schedule-slots');
  const status = document.getElementById('schedule-status');
  const dateLabel = day => {
    const date = new Date(`${day}T12:00:00+05:30`);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(date);
  };
  const labels = { upcoming: 'Upcoming', elapsed: 'No result recorded', published: 'Published', failed: 'Failed', posting: 'Posting', uncertain: 'Result uncertain', preparing: 'Preparing' };
  let current = null;
  let receivedAt = 0;
  let serverNow = 0;
  let refreshing = false;
  let expiredRefreshId = null;
  const renderCountdown = () => {
    if (!current?.next) return;
    const remaining = Date.parse(current.next.id) - (serverNow + performance.now() - receivedAt);
    if (remaining <= 0) {
      countdown.textContent = 'Planned time reached';
      if (expiredRefreshId !== current.next.id) {
        expiredRefreshId = current.next.id;
        void refresh();
      }
      return;
    }
    const seconds = Math.ceil(remaining / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    countdown.textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  };
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const response = await fetch('/api/schedule');
      if (!response.ok) throw new Error('Schedule unavailable');
      const data = await response.json();
      if (!Array.isArray(data.slots) || !Number.isFinite(Date.parse(data.now))) throw new Error('Invalid schedule');
      current = data;
      serverNow = Date.parse(data.now);
      receivedAt = performance.now();
      status.classList.remove('error');
      list.replaceChildren();
      const today = data.slots.filter(slot => slot.day === data.localDate);
      document.getElementById('schedule-today-title').textContent = `Today · ${dateLabel(data.localDate)} · IST`;
      for (const slot of today) {
        const item = document.createElement('li');
        item.className = 'schedule-slot';
        item.dataset.status = slot.status;
        const time = document.createElement('time');
        time.dateTime = slot.id;
        time.textContent = slot.time;
        const topic = document.createElement('span');
        topic.className = 'schedule-slot-topic';
        topic.textContent = slot.category;
        const state = document.createElement('span');
        state.className = 'schedule-slot-status';
        state.textContent = labels[slot.status] || 'Unknown';
        item.append(time, topic, state);
        list.append(item);
      }
      status.textContent = today.length ? 'Outcomes come from local logs, not live GitHub status. No result recorded means the planned time passed without a recorded outcome.' : 'No slots planned for today.';
      if (data.next) {
        detail.textContent = `${dateLabel(data.next.day)} · ${data.next.time} IST · ${data.next.category}`;
        renderCountdown();
      } else {
        detail.textContent = 'No upcoming slots in the current schedule.';
        countdown.textContent = '—';
      }
    } catch {
      current = null;
      detail.textContent = 'Schedule temporarily unavailable';
      countdown.textContent = '—';
      list.replaceChildren();
      status.classList.add('error');
      status.textContent = 'Could not refresh planned times. Retrying automatically in one minute.';
    } finally {
      refreshing = false;
    }
  }
  void refresh();
  setInterval(refresh, 60000);
  setInterval(renderCountdown, 1000);
})();
