(() => {
  const form = document.getElementById('booking-form');
  const select = document.getElementById('apartment');
  const checkIn = document.getElementById('checkIn');
  const checkOut = document.getElementById('checkOut');
  const guests = document.getElementById('guests');
  const estimate = document.getElementById('estimate');
  let apartments = [];

  document.getElementById('year').textContent = new Date().getFullYear();

  // Respect reduced-motion: show the house video's first frame instead of playing it.
  const introVideo = document.querySelector('.intro-video');
  if (introVideo && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    introVideo.removeAttribute('autoplay');
    introVideo.pause();
    introVideo.controls = true;
  }

  // Mobile navigation
  const toggle = document.querySelector('.nav-toggle');
  const links = document.getElementById('nav-links');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    links.classList.toggle('is-open', !open);
  });
  links.addEventListener('click', (e) => {
    if (e.target.tagName === 'A') {
      toggle.setAttribute('aria-expanded', 'false');
      links.classList.remove('is-open');
    }
  });

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const euro = (n) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);

  function renderApartments() {
    const grid = document.getElementById('apartment-grid');
    grid.innerHTML = apartments
      .map(
        (a) => `
        <article class="apartment" id="apt-${a.id}">
          <figure class="apartment-photo">
            <img src="${escapeHtml(a.photo.src)}" alt="${escapeHtml(a.photo.alt)}" loading="lazy">
            <span class="floor-tag">${escapeHtml(a.floor)}</span>
            <figcaption class="photo-caption">${escapeHtml(a.photoCaption)}</figcaption>
          </figure>
          <div class="apartment-body">
            <h3>${escapeHtml(a.name)}</h3>
            <div class="apartment-meta">
              <span>${a.size} m²</span>
              <span>Up to ${a.guests} guests</span>
              <span>${escapeHtml(a.beds)}</span>
            </div>
            <p class="apartment-summary">${escapeHtml(a.summary)}</p>
            <p class="apartment-description">${escapeHtml(a.description)}</p>
            <dl class="old-new">
              <div><dt>Kept</dt><dd>${escapeHtml(a.original)}</dd></div>
              <div><dt>Added</dt><dd>${escapeHtml(a.new)}</dd></div>
            </dl>
            <ul class="features">${a.features.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
            <div class="apartment-footer">
              <span class="price">${euro(a.price)} <small>/ night</small></span>
              <a href="#book" class="btn btn-primary" data-book="${a.id}">Book this</a>
            </div>
          </div>
        </article>`
      )
      .join('');

    select.insertAdjacentHTML(
      'beforeend',
      apartments
        .map((a) => `<option value="${a.id}">${escapeHtml(a.name)} · up to ${a.guests} guests · ${euro(a.price)}/night</option>`)
        .join('')
    );

    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-book]');
      if (!btn) return;
      select.value = btn.dataset.book;
      select.dispatchEvent(new Event('change'));
    });
  }

  fetch('/api/apartments')
    .then((r) => r.json())
    .then((data) => {
      apartments = data;
      renderApartments();
    })
    .catch(() => {
      document.getElementById('apartment-grid').innerHTML =
        '<p class="loading">We couldn\'t load the apartments right now. Please refresh the page.</p>';
    });

  // Things-to-do filters
  const chips = document.querySelectorAll('.chip');
  const cards = document.querySelectorAll('.explore-card');
  chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      const filter = chip.dataset.filter;
      chips.forEach((c) => {
        c.classList.toggle('is-active', c === chip);
        c.setAttribute('aria-pressed', String(c === chip));
      });
      cards.forEach((card) => {
        card.hidden = filter !== 'all' && !card.dataset.tags.split(' ').includes(filter);
      });
    })
  );

  // Map: only load Google's embed after the visitor asks for it (no data to Google by default).
  document.getElementById('load-map')?.addEventListener('click', () => {
    const frame = document.createElement('iframe');
    frame.title = 'Map showing Unleash Athens at Koumarianou 23, Athens';
    frame.src = 'https://maps.google.com/maps?q=Koumarianou%2023%2C%20Athens%2C%20Greece&z=16&output=embed';
    frame.referrerPolicy = 'no-referrer';
    document.getElementById('map-consent').replaceWith(frame);
  });

  // Booking form: date limits, live estimate and availability, then on to secure payment.
  const availability = document.getElementById('availability');
  const isoDate = (d) => {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };
  const addDays = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const today = isoDate(new Date());
  checkIn.min = today;
  checkOut.min = addDays(today, 1);

  checkIn.addEventListener('change', () => {
    if (!checkIn.value) return;
    checkOut.min = addDays(checkIn.value, 1);
    if (!checkOut.value || checkOut.value <= checkIn.value) checkOut.value = addDays(checkIn.value, 3);
    update();
  });
  checkOut.addEventListener('change', update);
  select.addEventListener('change', () => {
    const apt = apartments.find((a) => a.id === select.value);
    if (apt) {
      guests.max = apt.guests;
      if (Number(guests.value) > apt.guests) guests.value = apt.guests;
    }
    update();
  });

  function update() {
    updateEstimate();
    checkAvailability();
  }

  function updateEstimate() {
    const apt = apartments.find((a) => a.id === select.value);
    const nights = checkIn.value && checkOut.value
      ? Math.round((new Date(checkOut.value) - new Date(checkIn.value)) / 86400000)
      : 0;
    if (!apt || nights < 1) {
      estimate.hidden = true;
      return;
    }
    document.getElementById('estimate-label').textContent =
      `${apt.name}, ${nights} night${nights > 1 ? 's' : ''} × ${euro(apt.price)}`;
    document.getElementById('estimate-total').textContent = euro(nights * apt.price);
    estimate.hidden = false;
  }

  let availabilityRequest = 0;
  async function checkAvailability() {
    const apt = select.value, from = checkIn.value, to = checkOut.value;
    if (!apt || !from || !to || to <= from) {
      availability.hidden = true;
      return;
    }
    const id = ++availabilityRequest;
    try {
      const res = await fetch(`/api/availability?apartment=${encodeURIComponent(apt)}&from=${from}&to=${to}`);
      const data = await res.json();
      if (id !== availabilityRequest || !res.ok) return;
      const free = data.unavailable.length === 0;
      availability.hidden = false;
      availability.classList.toggle('is-free', free);
      availability.textContent = free
        ? '✓ Available for your dates'
        : 'Sorry, these dates are not available for this apartment. Please try other dates or another apartment.';
    } catch {
      availability.hidden = true;
    }
  }

  function showErrors(errors) {
    form.querySelectorAll('[data-error-for]').forEach((el) => {
      const msg = errors[el.dataset.errorFor] || '';
      el.textContent = msg;
      el.closest('.field')?.classList.toggle('has-error', Boolean(msg));
    });
    const firstKey = Object.keys(errors).find((k) => form.elements[k]);
    if (firstKey) form.elements[firstKey].focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const payload = Object.fromEntries(new FormData(form));
    payload.privacy = document.getElementById('privacy').checked;
    payload.marketing = document.getElementById('marketing').checked;
    showErrors({});
    button.disabled = true;
    button.textContent = 'Reserving your dates…';

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        showErrors(data.errors || { form: 'Something went wrong. Please try again.' });
        button.disabled = false;
        button.textContent = 'Continue to secure payment';
        return;
      }
      window.location.assign(data.checkoutUrl); // Stripe Checkout
    } catch {
      showErrors({ form: 'We couldn\'t reach the server. Please check your connection and try again.' });
      button.disabled = false;
      button.textContent = 'Continue to secure payment';
    }
  });
})();
