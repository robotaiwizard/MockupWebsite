(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const euro = (n) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || (data.errors && Object.values(data.errors)[0]) || 'Something went wrong.'), { status: res.status, data });
    return data;
  }

  // ---------- Sign in ----------
  function showSignIn() {
    $('signin').hidden = false;
    $('dashboard').hidden = true;
    $('logout').hidden = true;
    $('link-invalid').hidden = new URLSearchParams(location.search).get('link') !== 'invalid';
  }

  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('signin-error').textContent = '';
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/guest/login', { email: $('signin-email').value });
      $('signin-sent').textContent = r.message;
      $('signin-sent').hidden = false;
    } catch (err) {
      $('signin-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- Dashboard ----------
  async function load() {
    let me;
    try {
      me = await api('GET', '/api/guest/me');
    } catch (err) {
      if (err.status === 401) return showSignIn();
      throw err;
    }
    history.replaceState(null, '', '/account');
    $('signin').hidden = true;
    $('dashboard').hidden = false;
    $('logout').hidden = false;
    $('hello').textContent = `Hello, ${me.profile.name.split(' ')[0]}`;
    $('p-name').value = me.profile.name;
    $('p-phone').value = me.profile.phone || '';
    $('p-email').textContent = me.profile.email;
    $('p-marketing').checked = me.profile.marketing;
    renderStays(me.bookings);
  }

  function renderStays(bookings) {
    const box = $('stays');
    if (!bookings.length) {
      box.innerHTML = '<p class="muted">You have no bookings yet. <a href="/#book">Book a stay</a>.</p>';
      return;
    }
    box.innerHTML = bookings
      .map((b) => {
        const label = b.status === 'cancelled' ? 'Cancelled' : b.upcoming ? 'Confirmed' : 'Past stay';
        const cls = b.status === 'cancelled' ? 'cancelled' : b.upcoming ? 'confirmed' : 'past';
        const money = b.refunded ? `Paid ${euro(b.paid)} · refunded ${euro(b.refunded)}` : `Paid ${euro(b.paid)}`;
        return `
        <article class="stay" data-ref="${esc(b.reference)}">
          <img src="${esc(b.photo)}" alt="">
          <div>
            <span class="badge ${cls}">${label}</span>
            <h3>${esc(b.apartmentName)}</h3>
            <p class="muted small">Ref. ${esc(b.reference)} · ${b.guests} guest${b.guests > 1 ? 's' : ''}</p>
            <p>${fmt(b.checkIn)} → ${fmt(b.checkOut)} · ${b.nights} night${b.nights > 1 ? 's' : ''}<br><span class="small muted">${money}</span></p>
            ${b.canEdit ? `
            <details class="edit">
              <summary>Arrival time &amp; requests</summary>
              <form class="stack edit-form" novalidate>
                <div class="form-row">
                  <div class="field"><label>Estimated arrival</label><input type="time" name="arrivalTime" value="${esc(b.arrivalTime || '')}"></div>
                </div>
                <div class="field"><label>Requests</label><textarea name="specialRequests" rows="2">${esc(b.specialRequests || '')}</textarea></div>
                <button class="btn btn-primary" type="submit">Save</button> <span class="small muted saved" hidden>Saved.</span>
              </form>
            </details>` : ''}
            ${b.cancelNote ? `<p class="small muted">${esc(b.cancelNote)}</p>` : ''}
            ${b.canCancel ? `<div class="stay-actions"><button class="btn btn-danger cancel-btn" type="button">Cancel booking</button></div>` : ''}
            <p class="error"></p>
          </div>
        </article>`;
      })
      .join('');
  }

  $('stays').addEventListener('submit', async (e) => {
    if (!e.target.classList.contains('edit-form')) return;
    e.preventDefault();
    const ref = e.target.closest('.stay').dataset.ref;
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await api('PATCH', `/api/guest/bookings/${encodeURIComponent(ref)}`, data);
      e.target.querySelector('.saved').hidden = false;
    } catch (err) {
      e.target.closest('.stay').querySelector('.error').textContent = err.message;
    }
  });

  $('stays').addEventListener('click', async (e) => {
    if (!e.target.classList.contains('cancel-btn')) return;
    const stay = e.target.closest('.stay');
    if (!confirm('Cancel this booking? Your payment will be refunded in full to your original payment method.')) return;
    e.target.disabled = true;
    try {
      await api('POST', `/api/guest/bookings/${encodeURIComponent(stay.dataset.ref)}/cancel`);
      await load();
    } catch (err) {
      stay.querySelector('.error').textContent = err.message;
      e.target.disabled = false;
    }
  });

  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('profile-error').textContent = '';
    try {
      await api('PATCH', '/api/guest/me', { name: $('p-name').value, phone: $('p-phone').value, marketing: $('p-marketing').checked });
      $('profile-saved').hidden = false;
      setTimeout(() => ($('profile-saved').hidden = true), 2500);
    } catch (err) {
      $('profile-error').textContent = err.message;
    }
  });

  $('delete-account').addEventListener('click', async () => {
    if (!confirm('Delete your account? Your contact details and notes will be erased. Records of paid stays are kept only as long as tax law requires, then anonymised. This cannot be undone.')) return;
    $('delete-error').textContent = '';
    try {
      await api('POST', '/api/guest/delete');
      document.getElementById('app').innerHTML = '<section class="card"><h1>Your account has been deleted</h1><p class="muted">Thank you for staying with us. <a href="/">Back to the website</a></p></section>';
      $('logout')?.setAttribute('hidden', '');
    } catch (err) {
      $('delete-error').textContent = err.message;
    }
  });

  $('logout').addEventListener('click', async () => {
    await api('POST', '/api/guest/logout').catch(() => {});
    location.href = '/account';
  });

  load().catch(() => {
    document.getElementById('app').innerHTML = '<section class="card"><h1>Something went wrong</h1><p class="muted">Please refresh the page or email info@unleashathens.com.</p></section>';
  });
})();
