// End-to-end test of the booking system: `npm test`.
// Starts its own server on a spare port with a throwaway SQLite database in test mode
// (test checkout, emails printed to the console), then drives the public, guest and admin APIs.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const port = 3900 + Math.floor(Math.random() * 90);
const base = `http://localhost:${port}`;
const dbFile = path.join(os.tmpdir(), `unleash-test-${process.pid}.sqlite3`);
const env = { ...process.env, DEV_MODE: 'true', NODE_ENV: 'test', PORT: String(port), BASE_URL: base, DB_CLIENT: 'sqlite', SQLITE_FILE: dbFile, SMTP_HOST: '', STRIPE_SECRET_KEY: '', ADMIN_PASSWORD: 'correct horse battery staple' };

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures++;
};

let output = '';
let server;
const jars = {};

async function call(jar, method, url, body, headers = {}) {
  const h = { Origin: base, ...headers };
  if (jars[jar]) h.Cookie = jars[jar];
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    if (pair.endsWith('=')) delete jars[jar];
    else jars[jar] = pair;
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, location: res.headers.get('location') };
}

const lastMagicLink = (email) => {
  const block = output.split('[dev mail]').filter((b) => b.includes(`To: ${email}`)).at(-1);
  return block?.match(/http:\/\/\S+\/auth\/magic\?token=\S+/)?.[0];
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  execFileSync(process.execPath, ['scripts/create-admin.js', 'admin@unleashathens.com', 'Test Admin'], { cwd: root, env, stdio: 'ignore' });
  server = spawn(process.execPath, ['server.js'], { cwd: root, env });
  server.stdout.on('data', (d) => (output += d));
  server.stderr.on('data', (d) => (output += d));
  for (let i = 0; i < 50 && !output.includes('Booking system is on'); i++) await wait(100);
  if (!output.includes('Booking system is on')) throw new Error(`Server did not start:\n${output}`);
}

async function run() {
  const stay = { apartment: 'strefi-suite', checkIn: '2026-12-10', checkOut: '2026-12-13', guests: 2 };
  let r = await call('a', 'GET', '/');
  check('home page loads', r.status === 200);
  r = await call('a', 'GET', '/healthz');
  check('health check', r.json.database === 'connected' && r.json.payments === 'test mode');

  r = await call('a', 'POST', '/api/bookings', { ...stay, name: 'Ann Guest', email: 'ann@example.com' });
  check('privacy acknowledgement required', r.status === 400 && r.json.errors.privacy);
  r = await call('a', 'POST', '/api/bookings', { ...stay, name: 'Ann Guest', email: 'Ann@Example.com', privacy: true, notes: 'Late arrival' });
  check('booking starts checkout', r.status === 201 && /checkout/.test(r.json.checkoutUrl), r.json.reference);
  const sid = new URL(r.json.checkoutUrl).searchParams.get('session_id');
  r = await call('b', 'POST', '/api/bookings', { ...stay, checkIn: '2026-12-12', checkOut: '2026-12-14', name: 'Bob', email: 'bob@example.com', privacy: true });
  check('held dates cannot be double-booked', r.status === 409);
  r = await call('x', 'POST', '/api/bookings', {}, { Origin: 'https://evil.example' });
  check('cross-site POST blocked', r.status === 403);
  const paid = await fetch(`${base}/dev/checkout/complete`, { method: 'POST', body: new URLSearchParams({ session_id: sid, outcome: 'paid' }), redirect: 'manual' });
  check('test payment redirects to success', paid.status === 303);
  r = await call('a', 'GET', `/api/checkout/status?session_id=${sid}`);
  check('booking confirmed after payment', r.json.status === 'confirmed' && r.json.paid === 435);
  r = await call('a', 'GET', '/api/availability?apartment=strefi-suite&from=2026-12-01&to=2026-12-31');
  check('availability shows the stay', r.json.unavailable.length === 1 && r.json.unavailable[0].start === '2026-12-10');

  const racers = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      call(`r${i}`, 'POST', '/api/bookings', { apartment: 'courtyard-garden', checkIn: '2027-03-01', checkOut: '2027-03-04', guests: 2, name: `Racer ${i}`, email: `racer${i}@example.com`, privacy: true }, { 'X-Forwarded-For': `10.0.0.${i}` }).then((x) => x.status)
    )
  );
  check('simultaneous bookings: exactly one wins', racers.filter((s) => s === 201).length === 1);

  await call('g', 'POST', '/api/guest/login', { email: 'ann@example.com' });
  await wait(300);
  const link = lastMagicLink('ann@example.com');
  r = await call('g', 'GET', link.replace(base, ''));
  check('magic link signs in', r.status === 303 && r.location === '/account' && jars.g);
  r = await call('h', 'GET', link.replace(base, ''));
  check('magic link is single-use', r.location === '/account?link=invalid');
  r = await call('g', 'GET', '/api/guest/me');
  check('guest sees booking', r.json.bookings.length === 1 && r.json.bookings[0].canCancel);
  const ref = r.json.bookings[0].reference;
  r = await call('g', 'PATCH', `/api/guest/bookings/${ref}`, { arrivalTime: '21:30', specialRequests: 'Cot please' });
  check('guest updates arrival details', r.json.ok);
  r = await call('g', 'PATCH', '/api/guest/me', { name: 'Ann Guestly', phone: '+30 210 555 0000', marketing: true });
  check('guest updates profile', r.json.ok);
  r = await call('g', 'POST', '/api/guest/delete');
  check('cannot delete account with active stay', r.status === 400);
  r = await call('g', 'GET', '/api/guest/export');
  check('data export', r.json.profile.email === 'ann@example.com' && r.json.profile.marketingOptIn === true && r.json.bookings.length === 1);
  r = await call('g', 'POST', `/api/guest/bookings/${ref}/cancel`);
  check('free cancellation', r.json.ok);
  r = await call('g', 'GET', '/api/guest/me');
  check('refunded in full', r.json.bookings[0].status === 'cancelled' && r.json.bookings[0].refunded === 435);
  r = await call('g', 'POST', '/api/guest/delete');
  check('account deleted', r.json.ok);
  r = await call('g', 'GET', '/api/guest/me');
  check('signed out after deletion', r.status === 401);

  r = await call('ad', 'POST', '/api/admin/login', { email: 'admin@unleashathens.com', password: 'nope nope nope' });
  check('wrong admin password rejected', r.status === 401);
  r = await call('ad', 'POST', '/api/admin/login', { email: 'admin@unleashathens.com', password: env.ADMIN_PASSWORD });
  check('admin login', r.json.ok);
  r = await call('ad', 'POST', '/api/admin/bookings', { apartment: 'lycabettus-loft', checkIn: '2026-12-20', checkOut: '2026-12-24', guests: 2, name: 'Carla Phone', email: 'carla@example.com', phone: '+30 210 1234567', payment: 'offline' });
  check('admin creates offline booking', r.status === 201);
  const carlaId = r.json.id;
  r = await call('ad', 'POST', '/api/admin/bookings', { apartment: 'neapoli-studio', checkIn: '2027-01-05', checkOut: '2027-01-08', guests: 1, name: 'Dan Link', email: 'dan@example.com', payment: 'link', total: '300' });
  check('admin creates payment-link booking', r.status === 201 && r.json.checkoutUrl);
  r = await call('ad', 'POST', '/api/admin/blocks', { apartment: 'lycabettus-loft', start: '2026-12-22', end: '2026-12-26', reason: 'Painting' });
  check('closed dates refused over a booking', r.status === 409);
  r = await call('ad', 'POST', '/api/admin/blocks', { apartment: 'lycabettus-loft', start: '2027-02-01', end: '2027-02-05', reason: 'Painting' });
  check('closed dates created', r.status === 201);
  r = await call('ad', 'PATCH', `/api/admin/bookings/${carlaId}`, { checkIn: '2027-01-31', checkOut: '2027-02-03' });
  check('edit onto closed dates refused', r.status === 409);
  r = await call('ad', 'PATCH', `/api/admin/bookings/${carlaId}`, { checkIn: '2026-12-19', adminNotes: 'Moved a day earlier' });
  check('edit booking', r.json.ok);
  r = await call('ad', 'POST', `/api/admin/bookings/${carlaId}/refund`, { amount: '50' });
  check('partial refund', r.json.ok);
  r = await call('ad', 'GET', `/api/admin/bookings/${carlaId}`);
  check('booking detail', r.json.booking.nights === 5 && r.json.booking.refunded === 50 && r.json.booking.paymentStatus === 'partially_refunded');
  r = await call('ad', 'POST', `/api/admin/bookings/${carlaId}/cancel`, { refund: '100', reason: 'By phone' });
  check('admin cancel with refund', r.json.ok);
  r = await call('ad', 'GET', '/api/admin/bookings?q=carla');
  check('search bookings', r.json.bookings.length === 1 && r.json.bookings[0].refunded === 150);
  r = await call('ad', 'GET', '/api/admin/summary');
  check('summary', typeof r.json.revenueThisMonth === 'number');
  r = await call('ad', 'GET', '/api/admin/calendar?month=2027-01');
  check('calendar', r.json.bookings.length === 1 && r.json.blocks.length === 0);
  r = await call('ad', 'GET', '/api/admin/guests');
  const dan = r.json.guests.find((g) => g.email === 'dan@example.com');
  check('guests list', r.json.guests.length >= 3 && dan);
  r = await call('ad', 'GET', `/api/admin/guests/${dan.id}/export`);
  check('admin exports guest data', r.json.profile.name === 'Dan Link');
  r = await call('ad', 'POST', `/api/admin/guests/${dan.id}/erase`);
  check('erase blocked by pending booking', r.status === 400);
  r = await call('ad', 'GET', '/api/admin/audit');
  check('audit log has entries', r.json.entries.length > 10);
  r = await call('anon', 'GET', '/api/admin/bookings');
  check('admin API needs sign-in', r.status === 401);
}

startServer()
  .then(run)
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    server?.kill();
    for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    process.exitCode = failures ? 1 : 0;
  });
