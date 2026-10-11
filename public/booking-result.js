(() => {
  const box = document.getElementById('result');
  const params = new URLSearchParams(location.search);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const euro = (n) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });

  if (location.pathname.endsWith('/cancelled')) {
    box.innerHTML = `
      <p class="eyebrow">Payment not completed</p>
      <h1>No payment was taken</h1>
      <p class="muted">Your booking wasn't completed, so nothing has been charged. Your dates are held for a few more minutes if you'd like to try again.</p>
      <p><a class="btn btn-primary" href="/#book">Back to booking</a></p>`;
    return;
  }

  const sessionId = params.get('session_id');
  if (!sessionId) {
    box.innerHTML = '<h1>Booking not found</h1><p class="muted">Please check your confirmation email, or <a href="/account">sign in to your bookings</a>.</p>';
    return;
  }

  let tries = 0;
  async function poll() {
    try {
      const res = await fetch(`/api/checkout/status?session_id=${encodeURIComponent(sessionId)}`);
      const b = await res.json();
      if (!res.ok) throw new Error(b.error);
      if (b.status === 'confirmed') return show(b);
      if (b.status === 'cancelled') {
        box.innerHTML = `<p class="eyebrow">We're sorry</p><h1>These dates were just taken</h1>
          <p class="muted">Another booking for the same dates was completed while you were paying. Your payment has been refunded in full and you'll receive an email confirming this.</p>
          <p><a class="btn btn-primary" href="/#book">Choose other dates</a></p>`;
        return;
      }
    } catch {}
    if (++tries < 15) return setTimeout(poll, 2000);
    box.innerHTML = `<h1>Payment received?</h1><p class="muted">We're still waiting for confirmation from the payment provider. You'll receive a confirmation email as soon as it arrives. If you don't hear from us within an hour, please email <a href="mailto:info@unleashathens.com">info@unleashathens.com</a>.</p>`;
  }

  function show(b) {
    const name = /^the /i.test(b.apartmentName) ? b.apartmentName : `the ${b.apartmentName}`;
    box.innerHTML = `
      <p class="eyebrow"><span lang="el">Ευχαριστούμε</span> · Booking confirmed</p>
      <h1>See you in Athens!</h1>
      <p>Your stay in <strong>${esc(name)}</strong> is confirmed.</p>
      <dl class="summary">
        <div><dt>Reference</dt><dd>${esc(b.reference)}</dd></div>
        <div><dt>Check-in</dt><dd>${fmt(b.checkIn)}, from 15:00</dd></div>
        <div><dt>Check-out</dt><dd>${fmt(b.checkOut)}, by 11:00</dd></div>
        <div><dt>Nights</dt><dd>${b.nights}</dd></div>
        <div><dt>Paid</dt><dd>${euro(b.paid)}</dd></div>
      </dl>
      <p class="muted">A confirmation email is on its way with a link to manage your booking. You can also sign in any time from <a href="/account">My booking</a>.</p>
      <p><a class="btn btn-ghost" href="/">Back to the website</a></p>`;
  }

  poll();
})();
