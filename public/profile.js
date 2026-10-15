(() => {
  const get = id => document.getElementById(id);
  const bio = get('profile-bio-result');
  const copy = get('profile-copy-bio');
  const count = get('profile-bio-count');
  const setStatus = (kind, message, error = false) => {
    const status = get(`profile-${kind}-status`);
    status.textContent = message;
    status.classList.toggle('error', error);
  };
  const updateCount = () => {
    const length = Array.from(bio.value).length;
    count.textContent = `${length} / 150`;
    count.classList.toggle('over-limit', length > 150);
    bio.setAttribute('aria-invalid', String(length > 150));
    copy.disabled = !bio.value.trim() || length > 150;
  };
  bio.addEventListener('input', updateCount);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(bio.value);
      setStatus('bio', 'Copied. Paste this into your Instagram profile and save.');
    } catch {
      bio.focus();
      bio.select();
      setStatus('bio', 'Clipboard unavailable. Your bio is selected; copy it manually.', true);
    }
  });
  for (const kind of ['bio', 'picture']) {
    const form = get(`profile-${kind}-form`);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const prompt = get(`profile-${kind}-prompt`).value.trim();
      const button = form.querySelector('button');
      if (button.disabled) return;
      if (!prompt) {
        setStatus(kind, 'Enter your instructions first.', true);
        return;
      }
      button.disabled = true;
      const label = button.textContent;
      button.textContent = 'Generating…';
      form.setAttribute('aria-busy', 'true');
      setStatus(kind, kind === 'picture' ? 'Creating your picture. This may take a minute.' : 'Writing your bio…');
      try {
        const response = await fetch(`/api/profile/${kind}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Generation failed. Please try again.');
        if (kind === 'bio') {
          if (typeof result.bio !== 'string' || !result.bio.trim()) throw new Error('No bio returned. Please try again.');
          bio.value = result.bio;
          updateCount();
          setStatus(kind, Array.from(bio.value).length > 150 ? 'Trim your draft to 150 characters before copying.' : 'Draft ready. Edit it to make it yours, then copy it.');
        } else {
          if (typeof result.imageUrl !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=\s]+$/.test(result.imageUrl)) throw new Error('No valid picture returned. Please try again.');
          get('profile-picture-result').src = result.imageUrl;
          get('profile-picture-result').hidden = false;
          get('profile-picture-empty').hidden = true;
          get('profile-download-picture').href = result.imageUrl;
          get('profile-download-picture').hidden = false;
          setStatus(kind, 'Picture ready. Download it, then upload it in Instagram’s Edit profile.');
        }
      } catch (error) {
        setStatus(kind, error.message || 'Could not connect. Please try again.', true);
      } finally {
        button.disabled = false;
        button.textContent = label;
        form.setAttribute('aria-busy', 'false');
      }
    });
  }
})();
