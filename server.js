const { config, missingSettings } = require('./src/config');

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { migrate } = require('./src/db');
const { syncApartments } = require('./src/apartments');
const { sameOriginOnly } = require('./src/auth');
const payments = require('./src/payments');
const { isMailConfigured } = require('./src/mailer');
const { expireStaleHolds } = require('./src/bookings');
const { runRetention } = require('./src/gdpr');
const publicRoutes = require('./src/routes/public');
const guestRoutes = require('./src/routes/guest');
const adminRoutes = require('./src/routes/admin');

const app = express();
app.set('trust proxy', 1); // Hostinger terminates HTTPS in front of the app
app.disable('x-powered-by');

// Security headers. Everything (fonts, images) is self-hosted; the only third parties are
// Stripe (we redirect to its checkout page) and the Google map, which loads only on click.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameSrc: ['https://www.google.com', 'https://maps.google.com'],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ---------- Pages ----------

const photos = require('./data/photos.json');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fill <img data-photo="key"> slots and the photo credits from data/photos.json, once at startup.
function renderIndex() {
  const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const credits = [...new Map(Object.values(photos).filter((p) => p.page).map((p) => [p.page, p])).values()]
    .map(
      (p) =>
        `<li><a href="${escapeHtml(p.page)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a> by ${escapeHtml(p.author)}, ` +
        (p.licenseUrl ? `<a href="${escapeHtml(p.licenseUrl)}" target="_blank" rel="noopener">${escapeHtml(p.license)}</a>` : escapeHtml(p.license)) +
        '</li>'
    )
    .join('\n        ');
  return html
    .replace(/data-photo="([^"]+)"/g, (_, key) => {
      const photo = photos[key];
      if (!photo) throw new Error(`Unknown photo "${key}" in index.html`);
      return `src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.alt)}"`;
    })
    .replace('{{credits}}', credits);
}
const indexHtml = renderIndex();
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get(['/', '/index.html'], (req, res) => res.type('html').send(indexHtml));
app.get('/account', page('account.html'));
app.get(
  '/admin',
  (req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  },
  page('admin.html')
);
app.get('/privacy', page('privacy.html'));
app.get(['/booking/success', '/booking/cancelled'], page('booking-result.html'));

// Self-hosted fonts (no requests to Google from visitors' browsers).
app.use('/fonts/cormorant', express.static(path.join(__dirname, 'node_modules/@fontsource/cormorant-garamond/files'), { maxAge: '365d', immutable: true }));
app.use('/fonts/jost', express.static(path.join(__dirname, 'node_modules/@fontsource/jost/files'), { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ---------- Setup status ----------
// The website itself never depends on the booking system: if the database or booking settings
// aren't ready, pages still load and booking features answer with a friendly message.

const state = { dbReady: false, dbError: null };
const missing = missingSettings();
const paymentsReady = () => payments.isStripe || payments.useTestCheckout;
const mailReady = () => isMailConfigured || config.devMode;
const unavailable = (res, what) => {
  const message = `${what} is temporarily unavailable. Please email us at info@unleashathens.com and we'll help straight away.`;
  res.status(503).json({ error: message, errors: { form: message } });
};

// Status page for whoever runs the site: what's connected and which settings are missing (names only).
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    website: 'ok',
    database: state.dbReady ? 'connected' : `not connected${state.dbError ? `: ${state.dbError}` : ''}`,
    payments: payments.isStripe ? 'stripe' : payments.useTestCheckout ? 'test mode' : 'not configured',
    email: isMailConfigured ? 'smtp' : config.devMode ? 'test mode (console)' : 'not configured',
    missingSettings: missing,
  });
});

const BOOKING_PATHS = /^\/(api\/(bookings|availability|checkout|guest|admin)|auth\/magic|webhooks\/stripe|dev\/)/;
app.use((req, res, next) => {
  if (!BOOKING_PATHS.test(req.path)) return next();
  if (!state.dbReady) return unavailable(res, req.path.startsWith('/api/admin') ? 'The admin area' : 'Online booking');
  if (req.method === 'POST' && req.path === '/api/bookings' && (!paymentsReady() || !mailReady())) return unavailable(res, 'Online booking');
  if (req.path === '/api/guest/login' && !mailReady()) return unavailable(res, 'Signing in');
  next();
});

// ---------- API ----------

app.use(publicRoutes.webhook); // raw body: must come before express.json()
app.use(express.json({ limit: '50kb' }));
app.use('/api', sameOriginOnly);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(publicRoutes.router);
app.use(publicRoutes.dev);
app.use(guestRoutes);
app.use(adminRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  const message = 'Something went wrong on our side. Please try again or email info@unleashathens.com.';
  res.status(500).json({ error: message, errors: { form: message } });
});

// ---------- Start ----------

// Connect the database in the background, retrying every minute, so a database problem
// never takes the website offline.
async function connectDatabase() {
  try {
    await migrate();
    await syncApartments();
    state.dbReady = true;
    state.dbError = null;
    console.log(`Database connected (${config.db.client}). Booking system is on.`);
    const tick = (fn, label) => fn().catch((err) => console.error(`${label} failed:`, err.message));
    tick(expireStaleHolds, 'Expiring holds');
    tick(runRetention, 'Retention clean-up');
    setInterval(() => tick(expireStaleHolds, 'Expiring holds'), 5 * 60e3).unref();
    setInterval(() => tick(runRetention, 'Retention clean-up'), 24 * 3600e3).unref();
  } catch (err) {
    state.dbError = err.code || err.message.split('\n')[0].slice(0, 120);
    console.error(`Database unavailable (${config.db.client}): ${err.message.split('\n')[0].replace(/\.$/, '')}. Retrying in 60 seconds.`);
    setTimeout(connectDatabase, 60e3).unref();
  }
}

function start() {
  app.listen(config.port, () => {
    console.log(`Unleash Athens is open at ${config.baseUrl} (port ${config.port})`);
    if (missing.length) console.warn(`Booking system settings missing: ${missing.join(', ')}. The website runs; booking stays off until these are set (see .env.example).`);
    connectDatabase();
  });
}

if (require.main === module) start();

module.exports = { app, start };
