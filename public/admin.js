(() => {
  const view = document.getElementById('view');
  const nav = document.getElementById('admin-nav');
  let meta = null; // { admin, apartments, freeCancellationDays }

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const euro = (n) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n || 0);
  const fmt = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtTime = (ts) => (ts ? new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const STATUS = { confirmed: 'Confirmed', pending_payment: 'Awaiting payment', cancelled: 'Cancelled', expired: 'Expired' };
  const PAY = { unpaid: 'Unpaid', paid: 'Paid', partially_refunded: 'Part refunded', refunded: 'Refunded' };
  const badge = (s) => `<span class="badge ${esc(s)}">${esc(STATUS[s] || s)}</span>`;
  const aptOptions = (selected) => meta.apartments.map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)} (max ${a.guests}, ${euro(a.price)}/night)</option>`).join('');
  const today = () => new Date().toISOString().slice(0, 10);

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login')) {
      meta = null;
      renderLogin();
      throw new Error('Please sign in.');
    }
    if (!res.ok) throw new Error(data.error || (data.errors && Object.values(data.errors)[0]) || 'Something went wrong.');
    return data;
  }

  function msg(el, text, ok = false) {
    el.textContent = text;
    el.className = `form-msg ${ok ? 'ok' : 'err'}`;
  }

  function route() {
    const [path, query] = (location.hash.slice(1) || '/').split('?');
    return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query || '') };
  }

  function setActive() {
    const first = route().parts[0] || '';
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#/${first}`));
  }

  // ---------- Login ----------
  function renderLogin() {
    nav.hidden = true;
    view.innerHTML = `
      <section class="card" style="max-width:440px;margin:40px auto">
        <p class="eyebrow">Staff only</p>
        <h1>Sign in</h1>
        <form id="login" class="stack" novalidate>
          <div class="field"><label for="l-email">Email</label><input id="l-email" type="email" autocomplete="username" required></div>
          <div class="field"><label for="l-pass">Password</label><input id="l-pass" type="password" autocomplete="current-password" required></div>
          <p class="form-msg" id="l-msg"></p>
          <button class="btn btn-primary" type="submit">Sign in</button>
        </form>
      </section>`;
    document.getElementById('login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/admin/login', { email: document.getElementById('l-email').value, password: document.getElementById('l-pass').value });
        await boot();
      } catch (err) {
        msg(document.getElementById('l-msg'), err.message);
      }
    });
  }

  // ---------- Dashboard ----------
  async function renderDashboard() {
    const s = await api('GET', '/api/admin/summary');
    view.innerHTML = `
      <h1>Today, ${fmt(s.today)}</h1>
      <div class="stats">
        <div class="stat"><strong>${s.arrivalsToday}</strong><span>arrivals today</span></div>
        <div class="stat"><strong>${s.departuresToday}</strong><span>departures today</span></div>
        <div class="stat"><strong>${s.inHouse}</strong><span>apartments occupied tonight</span></div>
        <div class="stat"><strong>${s.arrivalsNext7Days}</strong><span>arrivals in the next 7 days</span></div>
        <div class="stat"><strong>${euro(s.revenueThisMonth)}</strong><span>net revenue booked this month</span></div>
      </div>
      <h2>Next arrivals</h2>
      ${s.nextArrivals.length ? table(['Arrival', 'Departure', 'Apartment', 'Guest', 'Guests', 'Arrival time'], s.nextArrivals.map((b) => ({ href: `#/bookings/${b.id}`, cells: [fmt(b.check_in), fmt(b.check_out), esc(b.apartmentName), esc(b.guest_name), b.guests_count, esc(b.arrival_time || '—')] }))) : '<p class="muted">No upcoming arrivals.</p>'}`;
  }

  function table(headers, rows) {
    return `<div class="table-wrap"><table class="data"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr class="${r.href ? 'clickable' : ''}" ${r.href ? `data-href="${r.href}"` : ''}>${r.cells.map((c, i) => `<td class="${r.num?.includes(i) ? 'num' : ''}">${c}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`;
  }
  view.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a,button')) location.hash = row.dataset.href;
  });

  // ---------- Bookings ----------
  async function renderBookings(params) {
    const v = params.get('view') || 'upcoming';
    const qs = new URLSearchParams(params);
    if (v !== 'all') qs.set('view', v);
    else qs.delete('view');
    const data = await api('GET', `/api/admin/bookings?${qs}`);
    const tab = (key, label) => `<a href="#/bookings?view=${key}" class="${v === key ? 'active' : ''}">${label}</a>`;
    view.innerHTML = `
      <h1>Bookings</h1>
      <div class="tabs">${tab('upcoming', 'Upcoming &amp; in-house')}${tab('past', 'Past')}${tab('all', 'All activity')}</div>
      <form class="toolbar" id="filters">
        <div class="field"><label>Search</label><input name="q" placeholder="Reference, name or email" value="${esc(params.get('q') || '')}"></div>
        <div class="field"><label>Apartment</label><select name="apartment"><option value="">All</option>${meta.apartments.map((a) => `<option value="${a.id}" ${params.get('apartment') === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
        ${v === 'all' ? `<div class="field"><label>Status</label><select name="status"><option value="">Any (except expired)</option>${Object.entries(STATUS).map(([k, l]) => `<option value="${k}" ${params.get('status') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
        <button class="btn btn-ghost" type="submit">Filter</button>
      </form>
      ${data.bookings.length ? table(
        ['Ref.', 'Status', 'Apartment', 'Guest', 'Check-in', 'Check-out', 'Total', 'Payment'],
        data.bookings.map((b) => ({ href: `#/bookings/${b.id}`, num: [6], cells: [esc(b.reference), badge(b.status), esc(b.apartmentName), `${esc(b.guestName)}<br><span class="small muted">${esc(b.guestEmail || '')}</span>`, fmt(b.checkIn), fmt(b.checkOut), euro(b.total), `${PAY[b.paymentStatus]}${b.paymentMethod === 'offline' ? ' (offline)' : ''}`] }))
      ) : '<p class="muted">No bookings match.</p>'}
      ${data.hasMore ? `<p><a class="btn btn-ghost" href="#/bookings?${new URLSearchParams({ ...Object.fromEntries(params), page: data.page + 1 })}">Next page</a></p>` : ''}`;
    document.getElementById('filters').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new URLSearchParams(new FormData(e.target));
      f.set('view', v);
      for (const [k, val] of [...f]) if (!val) f.delete(k);
      location.hash = `#/bookings?${f}`;
    });
  }

  async function renderBooking(id) {
    const { booking: b, history } = await api('GET', `/api/admin/bookings/${id}`);
    const active = ['confirmed', 'pending_payment'].includes(b.status);
    const refundable = Math.max(0, b.paid - b.refunded);
    view.innerHTML = `
      <p><a href="#/bookings">← Bookings</a></p>
      <h1>${esc(b.reference)} ${badge(b.status)}</h1>
      <div class="detail-grid">
        <div>
          <section class="card">
            <h2>Stay</h2>
            <form id="edit" class="grid-2" novalidate>
              <div class="field full"><label>Apartment</label><select name="apartment">${aptOptions(b.apartment)}</select></div>
              <div class="field"><label>Check-in</label><input type="date" name="checkIn" value="${b.checkIn}"></div>
              <div class="field"><label>Check-out</label><input type="date" name="checkOut" value="${b.checkOut}"></div>
              <div class="field"><label>Guests</label><input type="number" name="guests" min="1" value="${b.guests}"></div>
              <div class="field"><label>Total (€)</label><input type="number" step="0.01" min="0" name="total" value="${b.total}"></div>
              <div class="field"><label>Arrival time</label><input name="arrivalTime" value="${esc(b.arrivalTime || '')}"></div>
              <div class="field full"><label>Guest requests</label><textarea name="specialRequests" rows="2">${esc(b.specialRequests || '')}</textarea></div>
              <div class="field full"><label>Internal notes (staff only)</label><textarea name="adminNotes" rows="3">${esc(b.adminNotes || '')}</textarea></div>
              <div class="full"><button class="btn btn-primary" type="submit">Save changes</button> <button class="link-btn" type="button" id="recalc">Recalculate total from nightly price</button><p class="form-msg" id="edit-msg"></p></div>
            </form>
            <p class="small muted">Changing dates or the apartment checks availability. Changing the total doesn't charge or refund the guest; use the payment actions for that.</p>
          </section>
          <section class="card">
            <h2>Payment</h2>
            <dl class="kv">
              <dt>Status</dt><dd>${PAY[b.paymentStatus]}</dd>
              <dt>Method</dt><dd>${b.paymentMethod === 'offline' ? 'Offline (cash/bank transfer)' : 'Card via Stripe'}</dd>
              <dt>Total</dt><dd>${euro(b.total)}</dd>
              <dt>Paid</dt><dd>${euro(b.paid)}</dd>
              <dt>Refunded</dt><dd>${euro(b.refunded)}</dd>
              ${b.status === 'pending_payment' ? `<dt>Hold expires</dt><dd>${fmtTime(b.holdExpiresAt)}</dd>` : ''}
            </dl>
            <div class="actions" style="margin-top:18px">
              ${b.status === 'pending_payment' ? '<button class="btn btn-ghost" data-act="mark-paid">Mark as paid offline</button>' : ''}
              ${b.status === 'confirmed' ? '<button class="btn btn-ghost" data-act="resend">Resend confirmation email</button>' : ''}
            </div>
            ${refundable > 0 ? `
            <form id="refund" class="form-row" style="margin-top:18px">
              <div class="field"><label>Refund amount (€), up to ${euro(refundable)}</label><input type="number" step="0.01" min="0.01" max="${refundable}" name="amount"></div>
              <button class="btn btn-ghost" type="submit">Refund</button>
            </form>` : ''}
            <p class="form-msg" id="pay-msg"></p>
          </section>
          ${active ? `
          <section class="card">
            <h2>Cancel booking</h2>
            <form id="cancel" class="stack">
              <div class="form-row">
                <div class="field"><label>Refund with cancellation (€)</label><input type="number" step="0.01" min="0" max="${refundable}" name="refund" value="${refundable}"></div>
                <div class="field"><label>Reason (shown in history)</label><input name="reason" placeholder="e.g. guest asked by phone"></div>
              </div>
              <label class="check"><input type="checkbox" name="notify" checked><span>Email the guest about the cancellation</span></label>
              <button class="btn btn-danger" type="submit">Cancel booking</button>
              <p class="form-msg" id="cancel-msg"></p>
            </form>
          </section>` : b.cancelledAt ? `<section class="card"><h2>Cancelled</h2><p>${fmtTime(b.cancelledAt)} by ${esc(b.cancelledBy)}. ${esc(b.cancelReason || '')}</p></section>` : ''}
        </div>
        <div>
          <section class="card">
            <h2>Guest</h2>
            <dl class="kv">
              <dt>Name</dt><dd><a href="#/guests/${b.guestId}">${esc(b.guestName)}</a></dd>
              <dt>Email</dt><dd>${b.guestEmail ? `<a href="mailto:${esc(b.guestEmail)}">${esc(b.guestEmail)}</a>` : '<span class="muted">erased</span>'}</dd>
              <dt>Phone</dt><dd>${b.guestPhone ? `<a href="tel:${esc(b.guestPhone)}">${esc(b.guestPhone)}</a>` : '—'}</dd>
              <dt>Booked</dt><dd>${fmtTime(b.createdAt)} (${b.source === 'admin' ? 'by staff' : 'online'})</dd>
            </dl>
          </section>
          <section class="card">
            <h2>History</h2>
            <ul class="history">${history.map((h) => `<li><time>${fmtTime(h.at)}</time>${esc(h.action.replace('booking.', '').replace(/_/g, ' '))} · ${esc(h.by)}${h.details?.amountCents ? ` · ${euro(h.details.amountCents / 100)}` : ''}${h.details?.fields ? ` · ${esc(h.details.fields.join(', '))}` : ''}</li>`).join('') || '<li class="muted">No history yet.</li>'}</ul>
          </section>
        </div>
      </div>`;

    const edit = document.getElementById('edit');
    document.getElementById('recalc').addEventListener('click', () => {
      const apt = meta.apartments.find((a) => a.id === edit.apartment.value);
      const nights = Math.round((new Date(edit.checkOut.value) - new Date(edit.checkIn.value)) / 86400000);
      if (apt && nights > 0) edit.total.value = (apt.price * nights).toFixed(2);
    });
    edit.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(edit));
      f.guests = Number(f.guests);
      try {
        await api('PATCH', `/api/admin/bookings/${id}`, f);
        msg(document.getElementById('edit-msg'), 'Saved.', true);
        setTimeout(() => renderBooking(id), 700);
      } catch (err) {
        msg(document.getElementById('edit-msg'), err.message);
      }
    });
    view.querySelectorAll('[data-act]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        if (act === 'mark-paid' && !confirm('Confirm this booking as paid offline (cash or bank transfer)? The guest will get a confirmation email.')) return;
        try {
          await api('POST', `/api/admin/bookings/${id}/${act}`);
          msg(document.getElementById('pay-msg'), act === 'resend' ? 'Confirmation email sent.' : 'Done.', true);
          if (act !== 'resend') setTimeout(() => renderBooking(id), 700);
        } catch (err) {
          msg(document.getElementById('pay-msg'), err.message);
        }
      })
    );
    document.getElementById('refund')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const amount = e.target.amount.value;
      if (!amount || !confirm(`Refund ${euro(Number(amount))} to the guest?`)) return;
      try {
        await api('POST', `/api/admin/bookings/${id}/refund`, { amount });
        renderBooking(id);
      } catch (err) {
        msg(document.getElementById('pay-msg'), err.message);
      }
    });
    document.getElementById('cancel')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      if (!confirm(`Cancel ${b.reference}${Number(f.refund.value) ? ` and refund ${euro(Number(f.refund.value))}` : ' without a refund'}?`)) return;
      try {
        await api('POST', `/api/admin/bookings/${id}/cancel`, { refund: f.refund.value, reason: f.reason.value, notify: f.notify.checked });
        renderBooking(id);
      } catch (err) {
        msg(document.getElementById('cancel-msg'), err.message);
      }
    });
  }

  // ---------- New booking ----------
  function renderNew() {
    view.innerHTML = `
      <h1>New booking</h1>
      <p class="muted">For bookings taken by phone or email. Availability is checked before saving.</p>
      <section class="card">
        <form id="new" class="grid-2" novalidate>
          <div class="field full"><label>Apartment</label><select name="apartment" required><option value="">Choose…</option>${aptOptions()}</select></div>
          <div class="field"><label>Check-in</label><input type="date" name="checkIn" min="${today()}" required></div>
          <div class="field"><label>Check-out</label><input type="date" name="checkOut" min="${today()}" required></div>
          <div class="field"><label>Guests</label><input type="number" name="guests" min="1" value="2" required></div>
          <div class="field"><label>Total (€), blank for standard price</label><input type="number" step="0.01" min="0" name="total"></div>
          <div class="field"><label>Guest name</label><input name="name" required></div>
          <div class="field"><label>Guest email</label><input type="email" name="email" required></div>
          <div class="field"><label>Phone</label><input type="tel" name="phone"></div>
          <div class="field"><label>Arrival time</label><input name="arrivalTime"></div>
          <div class="field full"><label>Guest requests</label><textarea name="notes" rows="2"></textarea></div>
          <div class="field full"><label>Internal notes</label><textarea name="adminNotes" rows="2"></textarea></div>
          <div class="field full">
            <label>Payment</label>
            <label class="check"><input type="radio" name="payment" value="link" checked><span>Email the guest a secure payment link (Stripe, valid 23 hours). Dates are held meanwhile.</span></label>
            <label class="check"><input type="radio" name="payment" value="offline"><span>Already paid offline (cash or bank transfer): confirm now.</span></label>
          </div>
          <div class="full"><button class="btn btn-primary" type="submit">Create booking</button><p class="form-msg" id="new-msg"></p></div>
        </form>
      </section>`;
    document.getElementById('new').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      f.guests = Number(f.guests);
      try {
        const r = await api('POST', '/api/admin/bookings', f);
        location.hash = `#/bookings/${r.id}`;
      } catch (err) {
        msg(document.getElementById('new-msg'), err.message);
      }
    });
  }

  // ---------- Calendar ----------
  async function renderCalendar(params) {
    const month = params.get('month') || today().slice(0, 7);
    const data = await api('GET', `/api/admin/calendar?month=${month}`);
    const days = [];
    for (let d = new Date(`${data.from}T00:00:00Z`); d.toISOString().slice(0, 10) < data.to; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
    const shift = (n) => {
      const d = new Date(`${month}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + n);
      return d.toISOString().slice(0, 7);
    };
    const col = (date) => Math.max(0, days.indexOf(date) === -1 ? (date < data.from ? 0 : days.length) : days.indexOf(date));
    const t = today();
    const cells = [];
    cells.push('<div class="cell head"></div>');
    for (const d of days) {
      const dt = new Date(`${d}T00:00:00Z`);
      const wd = dt.getUTCDay();
      cells.push(`<div class="cell head ${wd === 0 || wd === 6 ? 'weekend' : ''} ${d === t ? 'today' : ''}"><span>${'SMTWTFS'[wd]}</span><span>${dt.getUTCDate()}</span></div>`);
    }
    for (const a of data.apartments) {
      cells.push(`<div class="cell apt">${esc(a.name)}</div>`);
      days.forEach((d, i) => {
        const bars = [];
        for (const b of data.bookings.filter((x) => x.apartment === a.id && (x.checkIn === d || (i === 0 && x.checkIn < d)))) {
          const span = col(b.checkOut) - i;
          const cont = i === 0 && b.checkIn < d; // started last month
          bars.push(`<a class="bar ${b.status}" href="#/bookings/${b.id}" style="left:${cont ? 0 : 50}%;width:calc(${span * 100}% ${cont ? '+ 50%' : ''})" title="${esc(b.reference)} · ${esc(b.guestName)}">${esc(b.guestName)}</a>`);
        }
        for (const k of data.blocks.filter((x) => x.apartment === a.id && (x.start === d || (i === 0 && x.start < d)))) {
          const span = col(k.end) - i;
          const cont = i === 0 && k.start < d;
          bars.push(`<span class="bar block" style="left:${cont ? 0 : 50}%;width:calc(${span * 100}% ${cont ? '+ 50%' : ''})" title="${esc(k.reason || 'Closed')}">${esc(k.reason || 'Closed')} <button class="link-btn" data-unblock="${k.id}" title="Remove">×</button></span>`);
        }
        cells.push(`<div class="cell">${bars.join('')}</div>`);
      });
    }
    const label = new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    view.innerHTML = `
      <div class="toolbar" style="justify-content:space-between">
        <h1 style="margin:0">${label}</h1>
        <div class="actions"><a class="btn btn-ghost" href="#/calendar?month=${shift(-1)}">←</a><a class="btn btn-ghost" href="#/calendar">Today</a><a class="btn btn-ghost" href="#/calendar?month=${shift(1)}">→</a></div>
      </div>
      <div class="cal-wrap"><div class="cal" style="grid-template-columns:170px repeat(${days.length}, minmax(28px, 1fr))">${cells.join('')}</div></div>
      <p class="legend"><span><i style="background:var(--olive)"></i>Confirmed</span><span><i style="background:#c9a227"></i>Awaiting payment</span><span><i style="background:#b9b5a3"></i>Closed</span><span>Bars run from the afternoon of arrival to the morning of departure.</span></p>
      <section class="card" style="margin-top:24px">
        <h2>Close dates</h2>
        <p class="muted small">Block an apartment for maintenance or private use. Guests can't book closed dates.</p>
        <form id="block" class="form-row">
          <div class="field"><label>Apartment</label><select name="apartment">${aptOptions()}</select></div>
          <div class="field"><label>From (first night)</label><input type="date" name="start" required></div>
          <div class="field"><label>Until (day after last night)</label><input type="date" name="end" required></div>
          <div class="field"><label>Reason</label><input name="reason" placeholder="e.g. Maintenance"></div>
          <button class="btn btn-ghost" type="submit">Close dates</button>
        </form>
        <p class="form-msg" id="block-msg"></p>
      </section>`;
    document.getElementById('block').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/admin/blocks', Object.fromEntries(new FormData(e.target)));
        renderCalendar(params);
      } catch (err) {
        msg(document.getElementById('block-msg'), err.message);
      }
    });
    view.querySelectorAll('[data-unblock]').forEach((b) =>
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('Reopen these dates for booking?')) return;
        await api('DELETE', `/api/admin/blocks/${b.dataset.unblock}`);
        renderCalendar(params);
      })
    );
  }

  // ---------- Guests ----------
  async function renderGuests(params) {
    const data = await api('GET', `/api/admin/guests?${params}`);
    view.innerHTML = `
      <h1>Guests</h1>
      <form class="toolbar" id="gsearch"><div class="field"><label>Search</label><input name="q" value="${esc(params.get('q') || '')}" placeholder="Name or email"></div><button class="btn btn-ghost">Search</button></form>
      ${table(
        ['Name', 'Email', 'Phone', 'Stays', 'Last stay', 'Marketing'],
        data.guests.map((g) => ({ href: `#/guests/${g.id}`, cells: [esc(g.name), g.email ? esc(g.email) : '<span class="muted">erased</span>', esc(g.phone || '—'), g.stays, fmt(g.lastStay), g.marketing_opt_in ? 'Opted in' : '—'] }))
      )}`;
    document.getElementById('gsearch').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = `#/guests?${new URLSearchParams(new FormData(e.target))}`;
    });
  }

  async function renderGuest(id) {
    const { guest: g, bookings } = await api('GET', `/api/admin/guests/${id}`);
    view.innerHTML = `
      <p><a href="#/guests">← Guests</a></p>
      <h1>${esc(g.name)}</h1>
      <div class="detail-grid">
        <div>
          <section class="card">
            <h2>Bookings</h2>
            ${bookings.length ? table(['Ref.', 'Status', 'Apartment', 'Dates', 'Total'], bookings.map((b) => ({ href: `#/bookings/${b.id}`, cells: [esc(b.reference), badge(b.status), esc(b.apartmentName), `${fmt(b.checkIn)} → ${fmt(b.checkOut)}`, euro(b.total)] }))) : '<p class="muted">No bookings.</p>'}
          </section>
        </div>
        <div>
          <section class="card">
            <h2>Details</h2>
            ${g.erasedAt ? `<p class="notice">Personal data erased on ${fmtTime(g.erasedAt)}. Booking records are kept only for legal retention.</p>` : `
            <form id="gedit" class="stack">
              <div class="field"><label>Name</label><input name="name" value="${esc(g.name)}"></div>
              <div class="field"><label>Email</label><input name="email" type="email" value="${esc(g.email)}"></div>
              <div class="field"><label>Phone</label><input name="phone" value="${esc(g.phone || '')}"></div>
              <button class="btn btn-primary">Save</button><p class="form-msg" id="gedit-msg"></p>
            </form>`}
            <dl class="kv" style="margin-top:16px">
              <dt>Created</dt><dd>${fmtTime(g.createdAt)}</dd>
              <dt>Last sign-in</dt><dd>${fmtTime(g.lastLoginAt)}</dd>
              <dt>Privacy policy</dt><dd>${g.privacyAck ? `Acknowledged v${esc(g.privacyAck)}, ${fmtTime(g.privacyAckAt)}` : '—'}</dd>
              <dt>Marketing</dt><dd>${g.marketing ? `Opted in ${fmtTime(g.marketingAt)}` : 'No consent'}</dd>
            </dl>
          </section>
          <section class="card">
            <h2>GDPR</h2>
            <p class="small muted">Use these when a guest asks for a copy of their data or to be forgotten.</p>
            <div class="actions">
              <a class="btn btn-ghost" href="/api/admin/guests/${g.id}/export" download>Export data (JSON)</a>
              ${g.erasedAt ? '' : '<button class="btn btn-danger" id="erase" type="button">Erase personal data</button>'}
            </div>
            <p class="form-msg" id="erase-msg"></p>
          </section>
        </div>
      </div>`;
    document.getElementById('gedit')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('PATCH', `/api/admin/guests/${id}`, Object.fromEntries(new FormData(e.target)));
        msg(document.getElementById('gedit-msg'), 'Saved.', true);
      } catch (err) {
        msg(document.getElementById('gedit-msg'), err.message);
      }
    });
    document.getElementById('erase')?.addEventListener('click', async () => {
      if (!confirm(`Erase ${g.name}'s personal data? Contact details and notes are deleted now; paid booking records keep only the name until the legal retention period ends. This cannot be undone.`)) return;
      try {
        await api('POST', `/api/admin/guests/${id}/erase`);
        renderGuest(id);
      } catch (err) {
        msg(document.getElementById('erase-msg'), err.message);
      }
    });
  }

  // ---------- Activity & settings ----------
  async function renderAudit() {
    const { entries } = await api('GET', '/api/admin/audit');
    view.innerHTML = `<h1>Activity</h1><p class="muted">Who did what, most recent first. Kept for 2 years.</p>
      ${table(['When', 'Who', 'Action', 'Record'], entries.map((e) => ({ href: e.entity === 'booking' ? `#/bookings/${e.entityId}` : e.entity === 'guest' ? `#/guests/${e.entityId}` : null, cells: [fmtTime(e.at), esc(e.actor), esc(e.action), e.entity ? `${esc(e.entity)} #${esc(e.entityId)}` : '—'] })))}`;
  }

  function renderSettings() {
    view.innerHTML = `
      <h1>Account</h1>
      <section class="card" style="max-width:520px">
        <p>Signed in as <strong>${esc(meta.admin.name)}</strong> (${esc(meta.admin.email)}).</p>
        <h2>Change password</h2>
        <form id="pw" class="stack">
          <div class="field"><label>Current password</label><input type="password" name="current" autocomplete="current-password"></div>
          <div class="field"><label>New password (at least 12 characters)</label><input type="password" name="next" autocomplete="new-password" minlength="12"></div>
          <button class="btn btn-primary">Change password</button><p class="form-msg" id="pw-msg"></p>
        </form>
        <p class="small muted">Changing your password signs you out on every device. New staff accounts are added by your developer with <code>npm run create-admin</code>.</p>
      </section>`;
    document.getElementById('pw').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/admin/me/password', Object.fromEntries(new FormData(e.target)));
        renderLogin();
      } catch (err) {
        msg(document.getElementById('pw-msg'), err.message);
      }
    });
  }

  // ---------- Router ----------
  async function render() {
    if (!meta) return;
    setActive();
    const { parts, params } = route();
    view.innerHTML = '<p class="muted">Loading…</p>';
    try {
      if (!parts.length) await renderDashboard();
      else if (parts[0] === 'bookings' && parts[1]) await renderBooking(parts[1]);
      else if (parts[0] === 'bookings') await renderBookings(params);
      else if (parts[0] === 'new') renderNew();
      else if (parts[0] === 'calendar') await renderCalendar(params);
      else if (parts[0] === 'guests' && parts[1]) await renderGuest(parts[1]);
      else if (parts[0] === 'guests') await renderGuests(params);
      else if (parts[0] === 'audit') await renderAudit();
      else if (parts[0] === 'settings') renderSettings();
      else view.innerHTML = '<h1>Not found</h1>';
      window.scrollTo(0, 0);
    } catch (err) {
      if (meta) view.innerHTML = `<section class="card"><h1>Something went wrong</h1><p class="muted">${esc(err.message)}</p></section>`;
    }
  }

  async function boot() {
    try {
      meta = await api('GET', '/api/admin/me');
    } catch {
      return;
    }
    nav.hidden = false;
    render();
  }

  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    meta = null;
    renderLogin();
  });
  window.addEventListener('hashchange', render);
  boot();
})();
