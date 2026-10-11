const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, now } = require('../db');
const { config } = require('../config');
const { apartments, getApartment } = require('../apartments');
const auth = require('../auth');
const B = require('../bookings');
const gdpr = require('../gdpr');
const { audit } = require('../audit');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Please wait 15 minutes.' } });
const adminOnly = auth.requireAdmin();

const wrap = (fn) => (req, res, next) =>
  fn(req, res, next).catch((err) => {
    if (err instanceof B.BookingError) return res.status(err.status).json({ errors: err.errors, error: Object.values(err.errors)[0] });
    next(err);
  });
const cents = (v) => (v === undefined || v === null || v === '' ? undefined : Math.round(Number(v) * 100));

// ---------- Session ----------

router.post('/api/admin/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const admin = await db('admins').where({ email, active: true }).first();
  const ok = admin ? await auth.verifyPassword(password, admin.password_hash) : await auth.verifyAgainstDummy(password);
  if (!ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
  await auth.createSession(res, 'admin', admin.id);
  await db('admins').where({ id: admin.id }).update({ last_login_at: now() });
  await audit({ actor: 'admin', actorId: admin.id, action: 'admin.login' });
  res.json({ ok: true });
}));

router.post('/api/admin/logout', wrap(async (req, res) => {
  await auth.destroySession(req, res, 'admin');
  res.json({ ok: true });
}));

router.get('/api/admin/me', adminOnly, (req, res) => res.json({ admin: req.admin, apartments: apartments.map((a) => ({ id: a.id, name: a.name, price: a.price, guests: a.guests })), freeCancellationDays: config.booking.freeCancellationDays }));

router.post('/api/admin/me/password', adminOnly, wrap(async (req, res) => {
  const { current, next: newPassword } = req.body || {};
  const admin = await db('admins').where({ id: req.admin.id }).first();
  if (!(await auth.verifyPassword(String(current || ''), admin.password_hash))) return res.status(400).json({ error: 'Current password is incorrect.' });
  if (String(newPassword || '').length < 12) return res.status(400).json({ error: 'Use at least 12 characters.' });
  await db('admins').where({ id: admin.id }).update({ password_hash: await auth.hashPassword(newPassword) });
  await auth.destroyAllSessions('admin', admin.id);
  await audit({ actor: 'admin', actorId: admin.id, action: 'admin.change_password' });
  res.json({ ok: true });
}));

// ---------- Dashboard ----------

router.get('/api/admin/summary', adminOnly, wrap(async (req, res) => {
  const today = B.athensToday();
  const week = B.addDays(today, 7);
  const confirmed = () => db('bookings').where({ status: 'confirmed' });
  const monthStart = `${today.slice(0, 7)}-01`;
  const [arrivals, departures, inHouse, upcoming, revenue] = await Promise.all([
    confirmed().where({ check_in: today }).count({ n: '*' }).first(),
    confirmed().where({ check_out: today }).count({ n: '*' }).first(),
    confirmed().where('check_in', '<=', today).where('check_out', '>', today).count({ n: '*' }).first(),
    confirmed().where('check_in', '>', today).where('check_in', '<=', week).count({ n: '*' }).first(),
    db('bookings').where('confirmed_at', '>=', `${monthStart} 00:00:00`).sum({ paid: 'amount_paid_cents', refunded: 'amount_refunded_cents' }).first(),
  ]);
  const nextArrivals = await confirmed()
    .join('guests', 'guests.id', 'bookings.guest_id')
    .where('check_in', '>=', today)
    .orderBy('check_in')
    .limit(8)
    .select('bookings.id', 'reference', 'apartment_id', 'check_in', 'check_out', 'guests_count', 'arrival_time', 'guests.name as guest_name');
  res.json({
    today,
    arrivalsToday: Number(arrivals.n),
    departuresToday: Number(departures.n),
    inHouse: Number(inHouse.n),
    arrivalsNext7Days: Number(upcoming.n),
    revenueThisMonth: (Number(revenue.paid || 0) - Number(revenue.refunded || 0)) / 100,
    nextArrivals: nextArrivals.map((b) => ({ ...b, apartmentName: getApartment(b.apartment_id)?.name })),
  });
}));

// ---------- Bookings ----------

function presentAdminBooking(b) {
  return {
    id: b.id,
    reference: b.reference,
    apartment: b.apartment_id,
    apartmentName: getApartment(b.apartment_id)?.name || b.apartment_id,
    checkIn: b.check_in,
    checkOut: b.check_out,
    nights: b.nights,
    guests: b.guests_count,
    total: b.total_cents / 100,
    paid: b.amount_paid_cents / 100,
    refunded: b.amount_refunded_cents / 100,
    status: b.status,
    paymentStatus: b.payment_status,
    paymentMethod: b.payment_method,
    source: b.source,
    guestId: b.guest_id,
    guestName: b.guest_name,
    guestEmail: b.guest_email,
    guestPhone: b.guest_phone,
    arrivalTime: b.arrival_time,
    specialRequests: b.special_requests,
    adminNotes: b.admin_notes,
    holdExpiresAt: b.hold_expires_at,
    createdAt: b.created_at,
    confirmedAt: b.confirmed_at,
    cancelledAt: b.cancelled_at,
    cancelledBy: b.cancelled_by,
    cancelReason: b.cancel_reason,
  };
}

const bookingQuery = () =>
  db('bookings')
    .join('guests', 'guests.id', 'bookings.guest_id')
    .select('bookings.*', 'guests.name as guest_name', 'guests.email as guest_email', 'guests.phone as guest_phone');

router.get('/api/admin/bookings', adminOnly, wrap(async (req, res) => {
  const { status, q, from, to, apartment, view } = req.query;
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const per = 50;
  const query = bookingQuery();
  const today = B.athensToday();
  if (view === 'upcoming') query.where('bookings.status', 'confirmed').where('check_out', '>=', today).orderBy('check_in', 'asc');
  else if (view === 'past') query.where('bookings.status', 'confirmed').where('check_out', '<', today).orderBy('check_in', 'desc');
  else query.orderBy('bookings.created_at', 'desc');
  if (status) query.where('bookings.status', status);
  else if (!view) query.whereNot('bookings.status', 'expired');
  if (apartment) query.where('apartment_id', apartment);
  if (B.isIsoDate(from)) query.where('check_out', '>', from);
  if (B.isIsoDate(to)) query.where('check_in', '<', to);
  if (q) {
    const like = `%${String(q).trim().toLowerCase()}%`;
    query.where((w) => w.whereRaw('LOWER(reference) LIKE ?', [like]).orWhereRaw('LOWER(guests.name) LIKE ?', [like]).orWhereRaw('LOWER(guests.email) LIKE ?', [like]));
  }
  const rows = await query.limit(per + 1).offset((page - 1) * per);
  res.json({ bookings: rows.slice(0, per).map(presentAdminBooking), page, hasMore: rows.length > per });
}));

router.get('/api/admin/bookings/:id', adminOnly, wrap(async (req, res) => {
  const b = await bookingQuery().where('bookings.id', req.params.id).first();
  if (!b) return res.status(404).json({ error: 'Not found.' });
  const history = await db('audit_log').where({ entity: 'booking', entity_id: String(b.id) }).whereNot('action', 'booking.view').orderBy('id', 'desc').limit(50);
  const admins = Object.fromEntries((await db('admins').select('id', 'name')).map((a) => [a.id, a.name]));
  await audit({ actor: 'admin', actorId: req.admin.id, action: 'booking.view', entity: 'booking', entityId: b.id });
  res.json({
    booking: presentAdminBooking(b),
    history: history.map((h) => ({ at: h.created_at, action: h.action, by: h.actor === 'admin' ? admins[h.actor_id] || 'admin' : h.actor, details: h.details ? JSON.parse(h.details) : null })),
  });
}));

router.post('/api/admin/bookings', adminOnly, wrap(async (req, res) => {
  const body = req.body || {};
  const stay = B.validateStay(body);
  const guest = B.validateGuestDetails(body);
  const errors = { ...stay.errors, ...guest.errors };
  if (!['offline', 'link'].includes(body.payment)) errors.payment = 'Choose how the guest pays.';
  if (Object.keys(errors).length) return res.status(400).json({ errors, error: Object.values(errors)[0] });
  const result = await B.createAdminBooking({
    stay: stay.value,
    guest: guest.value,
    totalCents: cents(body.total),
    payment: body.payment,
    adminId: req.admin.id,
    adminNotes: String(body.adminNotes || '').slice(0, 2000),
    arrivalTime: String(body.arrivalTime || '').slice(0, 40),
    specialRequests: String(body.notes || '').slice(0, 1000),
  });
  res.status(201).json({ id: result.booking.id, reference: result.booking.reference, checkoutUrl: result.checkoutUrl });
}));

router.patch('/api/admin/bookings/:id', adminOnly, wrap(async (req, res) => {
  const body = req.body || {};
  const changes = await db.transaction(async (trx) => {
    const b = await trx('bookings').where({ id: req.params.id }).first();
    if (!b) throw new B.BookingError({ form: 'Booking not found.' }, 404);
    const stayChanged = ['apartment', 'checkIn', 'checkOut', 'guests'].some((k) => body[k] !== undefined);
    const update = { updated_at: now() };
    if (stayChanged) {
      const stay = B.validateStay(
        { apartment: body.apartment ?? b.apartment_id, checkIn: body.checkIn ?? b.check_in, checkOut: body.checkOut ?? b.check_out, guests: body.guests ?? b.guests_count },
        { allowPast: true }
      );
      if (Object.keys(stay.errors).length) throw new B.BookingError(stay.errors);
      const v = stay.value;
      await B.lockApartment(trx, v.apartmentId);
      if (['confirmed', 'pending_payment'].includes(b.status) && !(await B.isAvailable(trx, v.apartmentId, v.checkIn, v.checkOut, b.id))) {
        throw new B.BookingError({ checkIn: `${getApartment(v.apartmentId).name} is not available for those dates.` }, 409);
      }
      Object.assign(update, { apartment_id: v.apartmentId, check_in: v.checkIn, check_out: v.checkOut, nights: B.nightsBetween(v.checkIn, v.checkOut), guests_count: v.guests });
    }
    if (cents(body.total) !== undefined) update.total_cents = cents(body.total);
    for (const [k, col, max] of [['arrivalTime', 'arrival_time', 40], ['specialRequests', 'special_requests', 1000], ['adminNotes', 'admin_notes', 2000]]) {
      if (body[k] !== undefined) update[col] = String(body[k] || '').slice(0, max) || null;
    }
    await trx('bookings').where({ id: b.id }).update(update);
    const changed = Object.keys(update).filter((k) => k !== 'updated_at');
    await audit({ actor: 'admin', actorId: req.admin.id, action: 'booking.update', entity: 'booking', entityId: b.id, details: { fields: changed } }, trx);
    return changed;
  });
  res.json({ ok: true, changed: changes });
}));

router.post('/api/admin/bookings/:id/cancel', adminOnly, wrap(async (req, res) => {
  const refund = cents(req.body?.refund) || 0;
  await B.cancelBooking(Number(req.params.id), { by: 'admin', actorId: req.admin.id, refundCents: refund, reason: String(req.body?.reason || '').slice(0, 255) || 'Cancelled by Unleash Athens', notify: req.body?.notify !== false });
  res.json({ ok: true });
}));

router.post('/api/admin/bookings/:id/refund', adminOnly, wrap(async (req, res) => {
  const amount = cents(req.body?.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Enter an amount to refund.' });
  await B.refundAndRecord(Number(req.params.id), amount, { actor: 'admin', actorId: req.admin.id });
  res.json({ ok: true });
}));

router.post('/api/admin/bookings/:id/mark-paid', adminOnly, wrap(async (req, res) => {
  const b = await db('bookings').where({ id: req.params.id }).first();
  if (!b || b.status !== 'pending_payment') return res.status(400).json({ error: 'Only bookings awaiting payment can be marked as paid.' });
  await db.transaction(async (trx) => {
    await B.lockApartment(trx, b.apartment_id);
    if (!(await B.isAvailable(trx, b.apartment_id, b.check_in, b.check_out, b.id))) throw new B.BookingError({ form: 'Those dates have since been taken.' }, 409);
    await trx('bookings').where({ id: b.id }).update({ status: 'confirmed', payment_status: 'paid', payment_method: 'offline', amount_paid_cents: b.total_cents, confirmed_at: now(), hold_expires_at: null, updated_at: now() });
    await audit({ actor: 'admin', actorId: req.admin.id, action: 'booking.mark_paid_offline', entity: 'booking', entityId: b.id }, trx);
  });
  await B.sendConfirmation(b.id);
  res.json({ ok: true });
}));

router.post('/api/admin/bookings/:id/resend', adminOnly, wrap(async (req, res) => {
  const b = await db('bookings').where({ id: req.params.id }).first();
  if (!b || b.status !== 'confirmed') return res.status(400).json({ error: 'Only confirmed bookings have a confirmation to resend.' });
  await B.sendConfirmation(b.id);
  await audit({ actor: 'admin', actorId: req.admin.id, action: 'booking.resend_confirmation', entity: 'booking', entityId: b.id });
  res.json({ ok: true });
}));

// ---------- Calendar & closed dates ----------

router.get('/api/admin/calendar', adminOnly, wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : B.athensToday().slice(0, 7);
  const from = `${month}-01`;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const to = next.toISOString().slice(0, 10);
  const bookings = await bookingQuery()
    .whereIn('bookings.status', ['confirmed', 'pending_payment'])
    .where('check_in', '<', to)
    .where('check_out', '>', from)
    .where((q) => q.where('bookings.status', 'confirmed').orWhere('hold_expires_at', '>', now()));
  const blocks = await db('blocked_dates').where('start_date', '<', to).where('end_date', '>', from);
  res.json({
    month,
    from,
    to,
    apartments: apartments.map((a) => ({ id: a.id, name: a.name })),
    bookings: bookings.map((b) => ({ id: b.id, reference: b.reference, apartment: b.apartment_id, checkIn: b.check_in, checkOut: b.check_out, status: b.status, guestName: b.guest_name })),
    blocks: blocks.map((k) => ({ id: k.id, apartment: k.apartment_id, start: k.start_date, end: k.end_date, reason: k.reason })),
  });
}));

router.post('/api/admin/blocks', adminOnly, wrap(async (req, res) => {
  const { apartment, start, end, reason } = req.body || {};
  if (!getApartment(apartment) || !B.isIsoDate(start) || !B.isIsoDate(end) || end <= start) return res.status(400).json({ error: 'Choose an apartment and a valid date range.' });
  const id = await db.transaction(async (trx) => {
    await B.lockApartment(trx, apartment);
    const clash = await trx('bookings')
      .where({ apartment_id: apartment })
      .where('check_in', '<', end)
      .where('check_out', '>', start)
      .where((q) => q.where('status', 'confirmed').orWhere((p) => p.where('status', 'pending_payment').where('hold_expires_at', '>', now())))
      .first('reference');
    if (clash) throw new B.BookingError({ form: `Booking ${clash.reference} overlaps those dates.` }, 409);
    const [newId] = await trx('blocked_dates').insert({ apartment_id: apartment, start_date: start, end_date: end, reason: String(reason || '').slice(0, 255) || null, created_at: now() });
    return typeof newId === 'object' ? newId.id : newId;
  });
  await audit({ actor: 'admin', actorId: req.admin.id, action: 'block.create', entity: 'block', entityId: id, details: { apartment, start, end } });
  res.status(201).json({ id });
}));

router.delete('/api/admin/blocks/:id', adminOnly, wrap(async (req, res) => {
  await db('blocked_dates').where({ id: req.params.id }).del();
  await audit({ actor: 'admin', actorId: req.admin.id, action: 'block.delete', entity: 'block', entityId: req.params.id });
  res.json({ ok: true });
}));

// ---------- Guests ----------

router.get('/api/admin/guests', adminOnly, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const query = db('guests')
    .leftJoin('bookings', function () {
      this.on('bookings.guest_id', 'guests.id').andOnVal('bookings.status', 'confirmed');
    })
    .groupBy('guests.id', 'guests.name', 'guests.email', 'guests.phone', 'guests.created_at', 'guests.erased_at', 'guests.marketing_opt_in')
    .select('guests.id', 'guests.name', 'guests.email', 'guests.phone', 'guests.created_at', 'guests.erased_at', 'guests.marketing_opt_in')
    .count({ stays: 'bookings.id' })
    .max({ lastStay: 'bookings.check_in' })
    .orderBy('guests.created_at', 'desc')
    .limit(200);
  if (q) query.where((w) => w.whereRaw('LOWER(guests.name) LIKE ?', [`%${q}%`]).orWhereRaw('LOWER(guests.email) LIKE ?', [`%${q}%`]));
  const rows = await query;
  res.json({ guests: rows.map((g) => ({ ...g, stays: Number(g.stays), marketing_opt_in: Boolean(g.marketing_opt_in) })) });
}));

router.get('/api/admin/guests/:id', adminOnly, wrap(async (req, res) => {
  const g = await db('guests').where({ id: req.params.id }).first();
  if (!g) return res.status(404).json({ error: 'Not found.' });
  const bookings = await bookingQuery().where('bookings.guest_id', g.id).orderBy('check_in', 'desc');
  await audit({ actor: 'admin', actorId: req.admin.id, action: 'guest.view', entity: 'guest', entityId: g.id });
  res.json({
    guest: { id: g.id, name: g.name, email: g.email, phone: g.phone, marketing: Boolean(g.marketing_opt_in), marketingAt: g.marketing_opt_in_at, privacyAck: g.privacy_ack_version, privacyAckAt: g.privacy_ack_at, createdAt: g.created_at, lastLoginAt: g.last_login_at, erasedAt: g.erased_at },
    bookings: bookings.map(presentAdminBooking),
  });
}));

router.patch('/api/admin/guests/:id', adminOnly, wrap(async (req, res) => {
  const g = await db('guests').where({ id: req.params.id }).whereNull('erased_at').first();
  if (!g) return res.status(404).json({ error: 'Not found.' });
  const check = B.validateGuestDetails({ name: req.body?.name ?? g.name, email: req.body?.email ?? g.email, phone: req.body?.phone ?? g.phone });
  if (Object.keys(check.errors).length) return res.status(400).json({ errors: check.errors, error: Object.values(check.errors)[0] });
  if (check.value.email !== g.email && (await db('guests').where({ email: check.value.email }).whereNot({ id: g.id }).first())) {
    return res.status(409).json({ error: 'Another guest already uses that email.' });
  }
  await db('guests').where({ id: g.id }).update({ name: check.value.name, email: check.value.email, phone: check.value.phone || null, updated_at: now() });
  await audit({ actor: 'admin', actorId: req.admin.id, action: 'guest.update', entity: 'guest', entityId: g.id });
  res.json({ ok: true });
}));

router.get('/api/admin/guests/:id/export', adminOnly, wrap(async (req, res) => {
  const data = await gdpr.exportGuest(Number(req.params.id));
  await audit({ actor: 'admin', actorId: req.admin.id, action: 'guest.export', entity: 'guest', entityId: req.params.id });
  res.setHeader('Content-Disposition', `attachment; filename="guest-${req.params.id}-data.json"`);
  res.json(data);
}));

router.post('/api/admin/guests/:id/erase', adminOnly, wrap(async (req, res) => {
  const result = await gdpr.eraseGuest(Number(req.params.id), { actor: 'admin', actorId: req.admin.id });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
}));

// ---------- Audit log ----------

router.get('/api/admin/audit', adminOnly, wrap(async (req, res) => {
  const rows = await db('audit_log').leftJoin('admins', 'admins.id', 'audit_log.actor_id').orderBy('audit_log.id', 'desc').limit(200).select('audit_log.*', 'admins.name as admin_name');
  res.json({
    entries: rows.map((r) => ({ at: r.created_at, actor: r.actor === 'admin' ? r.admin_name || 'admin' : r.actor, action: r.action, entity: r.entity, entityId: r.entity_id, details: r.details ? JSON.parse(r.details) : null })),
  });
}));

module.exports = router;
