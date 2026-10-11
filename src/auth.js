const crypto = require('crypto');
const { promisify } = require('util');
const { db, now } = require('./db');
const { config } = require('./config');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---------- Passwords (admins only; guests sign in with magic links) ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(actual, expected);
}

// A fixed hash to compare against when the email is unknown, so timing doesn't reveal which admins exist.
let dummyHash;
async function verifyAgainstDummy(password) {
  dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, dummyHash);
  return false;
}

// ---------- Sessions ----------

const COOKIE = { admin: 'ua_admin', guest: 'ua_guest' };

function cookieOptions(maxAgeMs) {
  return { httpOnly: true, secure: config.isProduction, sameSite: 'lax', path: '/', maxAge: maxAgeMs };
}

async function createSession(res, kind, subjectId) {
  const token = newToken();
  const ttl = kind === 'admin' ? config.sessions.adminHours * 3600e3 : config.sessions.guestDays * 86400e3;
  await db('sessions').insert({ token_hash: sha256(token), kind, subject_id: subjectId, created_at: now(), expires_at: now(ttl) });
  res.cookie(COOKIE[kind], token, cookieOptions(ttl));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function sessionSubject(req, kind) {
  const token = readCookie(req, COOKIE[kind]);
  if (!token) return null;
  const row = await db('sessions').where({ token_hash: sha256(token), kind }).where('expires_at', '>', now()).first();
  return row ? row.subject_id : null;
}

async function destroySession(req, res, kind) {
  const token = readCookie(req, COOKIE[kind]);
  if (token) await db('sessions').where({ token_hash: sha256(token) }).del();
  res.clearCookie(COOKIE[kind], { path: '/' });
}

async function destroyAllSessions(kind, subjectId) {
  await db('sessions').where({ kind, subject_id: subjectId }).del();
}

// ---------- Middleware ----------

function requireAdmin() {
  return async (req, res, next) => {
    try {
      const id = await sessionSubject(req, 'admin');
      const admin = id && (await db('admins').where({ id, active: true }).first());
      if (!admin) return res.status(401).json({ error: 'Please sign in.' });
      req.admin = { id: admin.id, email: admin.email, name: admin.name };
      next();
    } catch (err) {
      next(err);
    }
  };
}

function requireGuest() {
  return async (req, res, next) => {
    try {
      const id = await sessionSubject(req, 'guest');
      const guest = id && (await db('guests').where({ id }).whereNull('erased_at').first());
      if (!guest) return res.status(401).json({ error: 'Please sign in.' });
      req.guest = guest;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// CSRF defence for cookie-authenticated requests: state-changing calls must come from our own pages.
function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  const host = `${req.protocol}://${req.get('host')}`;
  if (site === 'same-origin' || origin === host || origin === config.baseUrl) return next();
  if (!origin && !site) return next(); // non-browser clients (no ambient cookies to abuse)
  return res.status(403).json({ error: 'Cross-site request blocked.' });
}

// ---------- Magic links ----------

async function createMagicLink(guestId) {
  const token = newToken();
  await db('magic_links').insert({
    token_hash: sha256(token),
    guest_id: guestId,
    created_at: now(),
    expires_at: now(config.sessions.magicLinkMinutes * 60e3),
  });
  return `${config.baseUrl}/auth/magic?token=${encodeURIComponent(token)}`;
}

/** Returns the guest id if the token is valid, marking it used (single use). */
async function consumeMagicLink(token) {
  if (!token) return null;
  return db.transaction(async (trx) => {
    const row = await trx('magic_links').where({ token_hash: sha256(token) }).whereNull('used_at').where('expires_at', '>', now()).first();
    if (!row) return null;
    const updated = await trx('magic_links').where({ token_hash: row.token_hash }).whereNull('used_at').update({ used_at: now() });
    return updated ? row.guest_id : null;
  });
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  createSession,
  destroySession,
  destroyAllSessions,
  requireAdmin,
  requireGuest,
  sameOriginOnly,
  createMagicLink,
  consumeMagicLink,
};
