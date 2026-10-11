const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, now } = require('../db');
const { config } = require('../config');
const { getApartment } = require('../apartments');
const auth = require('../auth');
const B = require('../bookings');
const gdpr = require('../gdpr');
const { sendMail } = require('../mailer');
const { audit } = require('../audit');

const router = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Please wait a few minutes.' } });

// Request a sign-in link. The response is the same whether or not the email is known,
// so this can't be used to discover who has stayed with us.
router.post('/api/guest/login', loginLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    const guest = await db('guests').where({ email }).whereNull('erased_at').first();
    if (guest) {
      const link = await auth.createMagicLink(guest.id);
      await sendMail({
        to: email,
        subject: 'Your sign-in link for Unleash Athens',
        heading: 'Sign in to your stays',
        intro: `Hello ${guest.name}, use the button below to sign in. The link works once and expires in ${config.sessions.magicLinkMinutes} minutes. If you didn't ask for it, you can ignore this email.`,
        button: { label: 'Sign in', url: link },
      });
    }
    res.json({ ok: true, message: 'If we have bookings under that email, a sign-in link is on its way. Please check your inbox.' });
  } catch (err) {
    next(err);
  }
});

router.get('/auth/magic', async (req, res, next) => {
  try {
    const guestId = await auth.consumeMagicLink(String(req.query.token || ''));
    if (!guestId) return res.redirect(303, '/account?link=invalid');
    await auth.createSession(res, 'guest', guestId);
    await db('guests').where({ id: guestId }).update({ last_login_at: now() });
    res.redirect(303, '/account');
  } catch (err) {
    next(err);
  }
});

const guestOnly = auth.requireGuest();

function presentBooking(b) {
  const cancel = B.guestCancellation(b);
  const upcoming = b.status === 'confirmed' && b.check_out >= B.athensToday();
  return {
    reference: b.reference,
    apartment: b.apartment_id,
    apartmentName: getApartment(b.apartment_id)?.name || b.apartment_id,
    photo: getApartment(b.apartment_id)?.photo?.src,
    checkIn: b.check_in,
    checkOut: b.check_out,
    nights: b.nights,
    guests: b.guests_count,
    total: b.total_cents / 100,
    paid: b.amount_paid_cents / 100,
    refunded: b.amount_refunded_cents / 100,
    status: b.status,
    paymentStatus: b.payment_status,
    arrivalTime: b.arrival_time,
    specialRequests: b.special_requests,
    upcoming,
    canEdit: upcoming,
    canCancel: cancel.allowed,
    cancelNote: cancel.allowed ? `Free cancellation: you'll be refunded ${B.euro(cancel.refundCents)}.` : upcoming ? cancel.reason : null,
  };
}

router.get('/api/guest/me', guestOnly, async (req, res, next) => {
  try {
    const g = req.guest;
    const bookings = await db('bookings').where({ guest_id: g.id }).whereIn('status', ['confirmed', 'cancelled']).orderBy('check_in', 'desc');
    res.json({
      profile: { name: g.name, email: g.email, phone: g.phone, marketing: Boolean(g.marketing_opt_in) },
      bookings: bookings.map(presentBooking),
      freeCancellationDays: config.booking.freeCancellationDays,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/api/guest/me', guestOnly, async (req, res, next) => {
  try {
    const { name, phone, marketing } = req.body || {};
    const check = B.validateGuestDetails({ name, phone, email: req.guest.email });
    if (check.errors.name || check.errors.phone) return res.status(400).json({ errors: check.errors });
    const update = { name: check.value.name, phone: check.value.phone || null, updated_at: now() };
    if (typeof marketing === 'boolean' && marketing !== Boolean(req.guest.marketing_opt_in)) {
      Object.assign(update, { marketing_opt_in: marketing, marketing_opt_in_at: marketing ? now() : null });
    }
    await db('guests').where({ id: req.guest.id }).update(update);
    await audit({ actor: 'guest', actorId: req.guest.id, action: 'guest.update_profile', entity: 'guest', entityId: req.guest.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

async function ownBooking(req, res) {
  const b = await db('bookings').where({ reference: String(req.params.ref), guest_id: req.guest.id }).first();
  if (!b) res.status(404).json({ error: 'Booking not found.' });
  return b;
}

router.patch('/api/guest/bookings/:ref', guestOnly, async (req, res, next) => {
  try {
    const b = await ownBooking(req, res);
    if (!b) return;
    if (!presentBooking(b).canEdit) return res.status(400).json({ error: 'This booking can no longer be changed online.' });
    await db('bookings').where({ id: b.id }).update({
      arrival_time: String(req.body?.arrivalTime || '').slice(0, 40) || null,
      special_requests: String(req.body?.specialRequests || '').trim().slice(0, 1000) || null,
      updated_at: now(),
    });
    await audit({ actor: 'guest', actorId: req.guest.id, action: 'booking.update_details', entity: 'booking', entityId: b.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/guest/bookings/:ref/cancel', guestOnly, async (req, res, next) => {
  try {
    const b = await ownBooking(req, res);
    if (!b) return;
    const policy = B.guestCancellation(b);
    if (!policy.allowed) return res.status(400).json({ error: policy.reason });
    await B.cancelBooking(b.id, { by: 'guest', actorId: req.guest.id, refundCents: policy.refundCents, reason: 'Cancelled by guest online' });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof B.BookingError) return res.status(400).json({ error: Object.values(err.errors)[0] });
    next(err);
  }
});

// GDPR: download all my data.
router.get('/api/guest/export', guestOnly, async (req, res, next) => {
  try {
    const data = await gdpr.exportGuest(req.guest.id);
    await audit({ actor: 'guest', actorId: req.guest.id, action: 'guest.export', entity: 'guest', entityId: req.guest.id });
    res.setHeader('Content-Disposition', 'attachment; filename="unleash-athens-my-data.json"');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GDPR: delete my account.
router.post('/api/guest/delete', guestOnly, async (req, res, next) => {
  try {
    const result = await gdpr.eraseGuest(req.guest.id, { actor: 'guest', actorId: req.guest.id });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.clearCookie('ua_guest', { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/api/guest/logout', async (req, res, next) => {
  try {
    await auth.destroySession(req, res, 'guest');
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
