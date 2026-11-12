(() => {
  const toast = document.querySelector('#toast');
  let toastTimer;
  const notify = (message) => {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  };

  document.querySelectorAll('.js-copy-link').forEach(button => {
    button.addEventListener('click', async () => {
      const link = new URL(button.dataset.copyUrl, window.location.origin).href;
      try {
        await navigator.clipboard.writeText(link);
        notify('Link copied to clipboard');
      } catch {
        const field = document.createElement('input');
        field.value = link;
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        notify(copied ? 'Link copied to clipboard' : `Share this link: ${link}`);
      }
    });
  });

  document.querySelectorAll('.js-confirm-delete').forEach(form => {
    form.addEventListener('submit', event => {
      if (!window.confirm('Delete this poll and all of its votes?')) event.preventDefault();
    });
  });

  const pollType = document.querySelector('[data-poll-type]');
  if (pollType) {
    const refreshType = () => {
      document.querySelectorAll('.type-dependent').forEach(group => {
        group.hidden = !group.dataset.types.split(' ').includes(pollType.value);
      });
    };
    pollType.addEventListener('change', refreshType);
    refreshType();

    const list = document.querySelector('#option-list');
    const refreshOptions = () => {
      list.querySelectorAll('.option-row').forEach((row, index) => {
        row.querySelector('input').setAttribute('aria-label', `Option ${index + 1}`);
        row.querySelector('input').placeholder = `Option ${index + 1}`;
        row.querySelector('.js-move-up').disabled = index === 0;
        row.querySelector('.js-move-down').disabled = index === list.children.length - 1;
      });
    };
    document.querySelector('#add-option')?.addEventListener('click', () => {
      if (list.children.length >= 50) return;
      const row = list.firstElementChild.cloneNode(true);
      row.querySelector('input').value = '';
      list.appendChild(row);
      refreshOptions();
      row.querySelector('input').focus();
    });
    list?.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      const row = button.closest('.option-row');
      if (button.classList.contains('js-remove-option')) {
        if (list.children.length > 2) row.remove();
        else row.querySelector('input').value = '';
      } else if (button.classList.contains('js-move-up') && row.previousElementSibling) {
        list.insertBefore(row, row.previousElementSibling);
      } else if (button.classList.contains('js-move-down') && row.nextElementSibling) {
        list.insertBefore(row.nextElementSibling, row);
      }
      refreshOptions();
    });
    if (list) refreshOptions();
  }

  const rankList = document.querySelector('#ranking-list');
  if (rankList) {
    const refreshRanks = () => rankList.querySelectorAll('.ranking-item').forEach((item, index) => {
      item.querySelector('.ranking-number').textContent = index + 1;
      item.querySelector('.js-rank-up').disabled = index === 0;
      item.querySelector('.js-rank-down').disabled = index === rankList.children.length - 1;
    });
    rankList.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      const row = button.closest('.ranking-item');
      if (button.classList.contains('js-rank-up') && row.previousElementSibling) rankList.insertBefore(row, row.previousElementSibling);
      if (button.classList.contains('js-rank-down') && row.nextElementSibling) rankList.insertBefore(row.nextElementSibling, row);
      refreshRanks();
    });
    refreshRanks();
  }

  const guestField = document.querySelector('#guest-field');
  if (guestField) {
    const refreshGuests = () => {
      const going = document.querySelector('input[name="answer"][value="Going"]:checked');
      guestField.hidden = !going;
      if (!going) guestField.querySelector('input').value = '0';
    };
    document.querySelectorAll('input[name="answer"]').forEach(input => input.addEventListener('change', refreshGuests));
    refreshGuests();
  }

  const voteForm = document.querySelector('#vote-form');
  const cappedList = voteForm?.querySelector('[data-max-selections]');
  if (cappedList) {
    cappedList.addEventListener('change', event => {
      const max = Number(cappedList.dataset.maxSelections);
      const checked = cappedList.querySelectorAll('input:checked');
      if (checked.length > max) {
        event.target.checked = false;
        window.alert(`Choose up to ${max} options.`);
      }
    });
  }
})();
