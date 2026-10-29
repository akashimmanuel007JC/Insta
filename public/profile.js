(() => {
  const get = id => document.getElementById(id);
  const setStatus = (id, message, error = false) => {
    const status = get(id);
    status.textContent = message;
    status.classList.toggle('error', error);
  };

  const bio = get('profile-bio-result');
  const copy = get('profile-copy-bio');
  const count = get('profile-bio-count');
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
      setStatus('profile-bio-status', 'Copied. Paste this into your Instagram profile and save.');
    } catch {
      bio.focus();
      bio.select();
      setStatus('profile-bio-status', 'Clipboard unavailable. Your bio is selected; copy it manually.', true);
    }
  });
  get('profile-bio-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const prompt = get('profile-bio-prompt').value.trim();
    const button = form.querySelector('button');
    if (!prompt || button.disabled) {
      if (!prompt) setStatus('profile-bio-status', 'Enter your instructions first.', true);
      return;
    }
    button.disabled = true;
    button.textContent = 'Generating…';
    form.setAttribute('aria-busy', 'true');
    setStatus('profile-bio-status', 'Writing your bio…');
    try {
      const response = await fetch('/api/profile/bio', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Generation failed. Please try again.');
      if (typeof result.bio !== 'string' || !result.bio.trim()) throw new Error('No bio returned. Please try again.');
      bio.value = result.bio;
      updateCount();
      setStatus('profile-bio-status', Array.from(bio.value).length > 150 ? 'Trim your draft to 150 characters before copying.' : 'Draft ready. Edit it to make it yours, then copy it.');
    } catch (error) {
      setStatus('profile-bio-status', error.message || 'Could not connect. Please try again.', true);
    } finally {
      button.disabled = false;
      button.textContent = 'Generate bio';
      form.setAttribute('aria-busy', 'false');
    }
  });

  const form = get('image-redesign-form');
  const input = get('image-source-input');
  const dropZone = get('image-drop-zone');
  const sourcePreview = get('image-source-preview');
  const sourceEmpty = get('image-source-empty');
  const removeButton = get('image-remove-button');
  const output = get('image-redesign-output');
  let sourceImage = '';

  const clearSource = () => {
    sourceImage = '';
    input.value = '';
    sourcePreview.removeAttribute('src');
    sourcePreview.hidden = true;
    sourceEmpty.hidden = false;
    removeButton.hidden = true;
    output.hidden = true;
    setStatus('image-redesign-status', '');
  };
  const loadImage = file => {
    if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setStatus('image-redesign-status', 'Use a PNG, JPEG, or WebP image.', true);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus('image-redesign-status', 'Keep the source image under 10 MB.', true);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setStatus('image-redesign-status', 'Could not read that image. Try another file.', true);
    reader.onload = () => {
      sourceImage = String(reader.result);
      sourcePreview.src = sourceImage;
      sourcePreview.hidden = false;
      sourceEmpty.hidden = true;
      removeButton.hidden = false;
      output.hidden = true;
      setStatus('image-redesign-status', 'Image ready. Describe the changes you want.');
    };
    reader.readAsDataURL(file);
  };

  get('image-choose-button').addEventListener('click', () => input.click());
  removeButton.addEventListener('click', clearSource);
  input.addEventListener('change', () => loadImage(input.files?.[0]));
  dropZone.addEventListener('click', () => input.click());
  dropZone.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });
  for (const name of ['dragenter', 'dragover']) dropZone.addEventListener(name, event => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
  for (const name of ['dragleave', 'drop']) dropZone.addEventListener(name, event => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
  dropZone.addEventListener('drop', event => loadImage(event.dataTransfer?.files?.[0]));
  document.addEventListener('paste', event => {
    const file = Array.from(event.clipboardData?.files || []).find(item => item.type.startsWith('image/'));
    if (file) { event.preventDefault(); loadImage(file); }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const prompt = get('image-redesign-prompt').value.trim();
    const button = get('image-redesign-button');
    if (!sourceImage) {
      setStatus('image-redesign-status', 'Paste, drop, or choose an image first.', true);
      return;
    }
    if (!prompt) {
      setStatus('image-redesign-status', 'Describe what you want to change.', true);
      return;
    }
    button.disabled = true;
    button.textContent = 'Redesigning…';
    form.setAttribute('aria-busy', 'true');
    output.hidden = true;
    setStatus('image-redesign-status', 'Redesigning your image. This may take a minute.');
    try {
      const response = await fetch('/api/image/redesign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, image: sourceImage })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Redesign failed. Please try again.');
      if (typeof result.imageUrl !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=\s]+$/.test(result.imageUrl)) throw new Error('No valid image returned. Please try again.');
      get('image-redesign-result').src = result.imageUrl;
      get('image-redesign-download').href = result.imageUrl;
      sourceImage = result.imageUrl;
      sourcePreview.src = result.imageUrl;
      input.value = '';
      output.hidden = false;
      setStatus('image-redesign-status', 'Redesign ready at the source dimensions. It is now the source for your next change.');
    } catch (error) {
      setStatus('image-redesign-status', error.message || 'Could not connect. Please try again.', true);
    } finally {
      button.disabled = false;
      button.textContent = 'Redesign image';
      form.setAttribute('aria-busy', 'false');
    }
  });
})();
