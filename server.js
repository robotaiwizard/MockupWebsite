const { config, assertProductionConfig } = require('./src/config');
assertProductionConfig();

const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const { migrate } = require('./src/db');
const { syncApartments } = require('./src/apartments');
const { sameOriginOnly } = require('./src/auth');
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

async function start() {
  await migrate();
  await syncApartments();
  const tick = (fn, label) => fn().catch((err) => console.error(`${label} failed:`, err.message));
  tick(expireStaleHolds, 'Expiring holds');
  tick(runRetention, 'Retention clean-up');
  setInterval(() => tick(expireStaleHolds, 'Expiring holds'), 5 * 60e3).unref();
  setInterval(() => tick(runRetention, 'Retention clean-up'), 24 * 3600e3).unref();
  app.listen(config.port, () => console.log(`Unleash Athens is open at ${config.baseUrl} (database: ${config.db.client})`));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start };
