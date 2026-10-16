// Central configuration, read once from environment variables (.env locally, hPanel in production).
try {
  process.loadEnvFile();
} catch {}

const env = process.env;
const isProduction = env.NODE_ENV === 'production';
const int = (v, fallback) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : fallback);

const config = {
  isProduction,
  // Local test mode (fake checkout page, emails printed to the console). Must be switched on
  // explicitly with DEV_MODE=true and can never be active in production.
  devMode: env.DEV_MODE === 'true' && !isProduction,
  port: int(env.PORT, 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${int(env.PORT, 3000)}`).replace(/\/$/, ''),

  db: {
    client: env.DB_CLIENT || (isProduction || env.DB_HOST ? 'mysql' : 'sqlite'),
    host: env.DB_HOST || '127.0.0.1',
    port: int(env.DB_PORT, 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    sqliteFile: env.SQLITE_FILE || 'data/dev.sqlite3',
  },

  mail: {
    to: env.BOOKING_EMAIL_TO || 'info@unleashathens.com',
    smtpHost: env.SMTP_HOST,
    smtpPort: int(env.SMTP_PORT, 587),
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpUser: env.SMTP_USER,
    smtpPass: env.SMTP_PASS,
    from: env.MAIL_FROM,
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  },

  booking: {
    currency: 'eur',
    holdMinutes: 35, // dates are held while the guest is on Stripe Checkout (session lasts 30 min)
    freeCancellationDays: int(env.FREE_CANCELLATION_DAYS, 7),
    maxNights: 30,
    maxAdvanceDays: 540,
  },

  gdpr: {
    // How long booking records are kept after checkout for tax/accounting duties.
    // Confirm the right period with your accountant.
    retentionYears: int(env.RETENTION_YEARS, 6),
    abandonedDays: 30, // unpaid/expired checkouts are deleted after this
    auditLogDays: int(env.AUDIT_LOG_DAYS, 730),
    privacyPolicyVersion: '2026-10-11',
  },

  sessions: {
    adminHours: 12,
    guestDays: 30,
    magicLinkMinutes: 20,
  },
};

// Names (never values) of settings the live booking system still needs. The public website
// always runs; booking features switch themselves off until these are provided.
function missingSettings() {
  if (config.devMode) return [];
  const missing = [];
  if (!env.BASE_URL) missing.push('BASE_URL');
  if (config.db.client === 'mysql') for (const k of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) if (!env[k]) missing.push(k);
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) if (!env[k]) missing.push(k);
  return missing;
}

module.exports = { config, missingSettings };
