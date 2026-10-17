const crypto = require('crypto');
const { db, now } = require('./db');
const { config } = require('./config');
const { getApartment } = require('./apartments');
const payments = require('./payments');
const { sendMail } = require('./mailer');
const { createMagicLink } = require('./auth');
const { audit } = require('./audit');

const DAY = 86400e3;

// ---------- Dates & money ----------

/** Today's date in Athens as YYYY-MM-DD. */
function athensToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens' }).format(new Date());
}

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const nightsBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / DAY);
const addDays = (s, n) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const euro = (cents) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;

function quote(apartmentId, checkIn, checkOut) {
  const apt = getApartment(apartmentId);
  const nights = nightsBetween(checkIn, checkOut);
  return { apartment: apt, nights, totalCents: nights * Math.round(apt.price * 100) };
}

/** Validates apartment, dates and party size. Returns { errors, value }. */
function validateStay({ apartment: apartmentId, checkIn, checkOut, guests }, { allowPast = false } = {}) {
  const errors = {};
  const apt = getApartment(apartmentId);
  const count = Number.parseInt(guests, 10);
  if (!apt) errors.apartment = 'Please choose a room.';
  if (!isIsoDate(checkIn)) errors.checkIn = 'Please choose a check-in date.';
  else if (!allowPast && checkIn < athensToday()) errors.checkIn = 'Check-in cannot be in the past.';
  else if (checkIn > addDays(athensToday(), config.booking.maxAdvanceDays)) errors.checkIn = 'That date is too far ahead to book online. Please email us.';
  if (!isIsoDate(checkOut)) errors.checkOut = 'Please choose a check-out date.';
  else if (isIsoDate(checkIn) && checkOut <= checkIn) errors.checkOut = 'Check-out must be after check-in.';
  else if (isIsoDate(checkIn) && nightsBetween(checkIn, checkOut) > config.booking.maxNights)
    errors.checkOut = `Online bookings are up to ${config.booking.maxNights} nights. Please email us for longer stays.`;
  if (!Number.isInteger(count) || count < 1) errors.guests = 'Please enter the number of guests.';
  else if (apt && count > apt.guests) errors.guests = `${apt.name} sleeps up to ${apt.guests} guests.`;
  return { errors, value: { apartmentId, checkIn, checkOut, guests: count } };
}

function validateGuestDetails({ name, email, phone }) {
  const errors = {};
  const value = {
    name: String(name || '').trim().slice(0, 120),
    email: String(email || '').trim().toLowerCase().slice(0, 254),
    phone: String(phone || '').trim().slice(0, 40),
  };
  if (value.name.length < 2) errors.name = 'Please enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) errors.email = 'Please enter a valid email address.';
  if (value.phone && !/^[+\d][\d\s()-]{5,}$/.test(value.phone)) errors.phone = 'Please enter a valid phone number.';
  return { errors, value };
}

// ---------- Availability ----------

/** Bookings and blocks that occupy any night in [checkIn, checkOut). */
function occupying(trx, apartmentId, checkIn, checkOut) {
  return trx('bookings')
    .where({ apartment_id: apartmentId })
    .where('check_in', '<', checkOut)
    .where('check_out', '>', checkIn)
    .where((q) => q.where('status', 'confirmed').orWhere((p) => p.where('status', 'pending_payment').where('hold_expires_at', '>', now())));
}

async function isAvailable(trx, apartmentId, checkIn, checkOut, excludeBookingId = null) {
  const q = occupying(trx, apartmentId, checkIn, checkOut);
  if (excludeBookingId) q.whereNot('id', excludeBookingId);
  const clash = await q.first('id');
  if (clash) return false;
  const block = await trx('blocked_dates').where({ apartment_id: apartmentId }).where('start_date', '<', checkOut).where('end_date', '>', checkIn).first('id');
  return !block;
}

/** Unavailable [start, end) ranges for an apartment between two dates (for calendars). */
async function unavailableRanges(apartmentId, from, to) {
  const bookings = await occupying(db, apartmentId, from, to).select('check_in as start', 'check_out as end');
  const blocks = await db('blocked_dates').where({ apartment_id: apartmentId }).where('start_date', '<', to).where('end_date', '>', from).select('start_date as start', 'end_date as end');
  return [...bookings, ...blocks].sort((a, b) => a.start.localeCompare(b.start));
}

// Serialise bookings per apartment so two guests can't grab the same nights at once.
async function lockApartment(trx, apartmentId) {
  await trx('apartments').where({ id: apartmentId }).forUpdate().first('id');
}

// ---------- Guests ----------

async function upsertGuest(trx, details, { privacyAck = false, marketing = false } = {}) {
  const existing = await trx('guests').where({ email: details.email }).first();
  const fields = { name: details.name, updated_at: now() };
  if (details.phone) fields.phone = details.phone;
  if (privacyAck) Object.assign(fields, { privacy_ack_version: config.gdpr.privacyPolicyVersion, privacy_ack_at: now() });
  if (marketing) Object.assign(fields, { marketing_opt_in: true, marketing_opt_in_at: now() });
  if (existing) {
    await trx('guests').where({ id: existing.id }).update(fields);
    return existing.id;
  }
  const [id] = await trx('guests').insert({ email: details.email, phone: details.phone || null, created_at: now(), ...fields });
  return typeof id === 'object' ? id.id : id;
}

// ---------- Creating bookings ----------

async function newReference(trx) {
  for (;;) {
    const ref = `UA-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    if (!(await trx('bookings').where({ reference: ref }).first('id'))) return ref;
  }
}

class BookingError extends Error {
  constructor(errors, status = 400) {
    super('Booking error');
    this.errors = errors;
    this.status = status;
  }
}

/**
 * Hold the dates and start payment. The booking is only confirmed once Stripe reports
 * the payment (webhook or success page), so unpaid holds simply expire.
 */
async function startWebsiteBooking({ stay, guest, arrivalTime, specialRequests, marketing }) {
  const { nights, totalCents, apartment } = quote(stay.apartmentId, stay.checkIn, stay.checkOut);
  const holdUntil = now(config.booking.holdMinutes * 60e3);

  const booking = await db.transaction(async (trx) => {
    await lockApartment(trx, stay.apartmentId);
    if (!(await isAvailable(trx, stay.apartmentId, stay.checkIn, stay.checkOut))) {
      throw new BookingError({ checkIn: `Sorry, ${apartment.name} is no longer available for those dates. Please choose other dates or another room.` }, 409);
    }
    const guestId = await upsertGuest(trx, guest, { privacyAck: true, marketing });
    const row = {
      reference: await newReference(trx),
      guest_id: guestId,
      apartment_id: stay.apartmentId,
      check_in: stay.checkIn,
      check_out: stay.checkOut,
      nights,
      guests_count: stay.guests,
      total_cents: totalCents,
      currency: config.booking.currency,
      status: 'pending_payment',
      payment_status: 'unpaid',
      payment_method: 'stripe',
      hold_expires_at: holdUntil,
      arrival_time: arrivalTime || null,
      special_requests: specialRequests || null,
      source: 'website',
      created_at: now(),
      updated_at: now(),
    };
    const [id] = await trx('bookings').insert(row);
    return { ...row, id: typeof id === 'object' ? id.id : id };
  });

  try {
    // Stripe sessions last at least 30 minutes; our hold is a little longer.
    const checkout = await payments.createCheckout({ booking, apartmentName: apartment.name, guestEmail: guest.email, expiresAt: now(30 * 60e3 + 30e3) });
    await db('bookings').where({ id: booking.id }).update({ stripe_session_id: checkout.sessionId, updated_at: now() });
    return { reference: booking.reference, checkoutUrl: checkout.url };
  } catch (err) {
    await db('bookings').where({ id: booking.id }).update({ status: 'expired', updated_at: now() });
    throw err;
  }
}

/** Admin-created booking: either paid offline (confirmed now) or with a payment link emailed to the guest. */
async function createAdminBooking({ stay, guest, totalCents, payment, adminId, adminNotes, arrivalTime, specialRequests }) {
  const q = quote(stay.apartmentId, stay.checkIn, stay.checkOut);
  const total = Number.isInteger(totalCents) && totalCents >= 0 ? totalCents : q.totalCents;
  const linkHours = 23;

  const booking = await db.transaction(async (trx) => {
    await lockApartment(trx, stay.apartmentId);
    if (!(await isAvailable(trx, stay.apartmentId, stay.checkIn, stay.checkOut))) {
      throw new BookingError({ checkIn: `${q.apartment.name} is not available for those dates.` }, 409);
    }
    const guestId = await upsertGuest(trx, guest);
    const offline = payment === 'offline';
    const row = {
      reference: await newReference(trx),
      guest_id: guestId,
      apartment_id: stay.apartmentId,
      check_in: stay.checkIn,
      check_out: stay.checkOut,
      nights: q.nights,
      guests_count: stay.guests,
      total_cents: total,
      currency: config.booking.currency,
      status: offline ? 'confirmed' : 'pending_payment',
      payment_status: offline ? 'paid' : 'unpaid',
      payment_method: offline ? 'offline' : 'stripe',
      amount_paid_cents: offline ? total : 0,
      hold_expires_at: offline ? null : now((linkHours + 0.5) * 3600e3),
      confirmed_at: offline ? now() : null,
      arrival_time: arrivalTime || null,
      special_requests: specialRequests || null,
      admin_notes: adminNotes || null,
      source: 'admin',
      created_at: now(),
      updated_at: now(),
    };
    const [id] = await trx('bookings').insert(row);
    const created = { ...row, id: typeof id === 'object' ? id.id : id };
    await audit({ actor: 'admin', actorId: adminId, action: 'booking.create', entity: 'booking', entityId: created.id, details: { payment } }, trx);
    return created;
  });

  if (payment === 'offline') {
    await sendConfirmation(booking.id);
    return { booking };
  }
  let checkout;
  try {
    checkout = await payments.createCheckout({ booking, apartmentName: q.apartment.name, guestEmail: guest.email, expiresAt: now(linkHours * 3600e3) });
  } catch (err) {
    await db('bookings').where({ id: booking.id }).update({ status: 'expired', hold_expires_at: null, updated_at: now() });
    if (err.paymentsUnavailable) throw new BookingError({ payment: 'Online payments are not configured yet (Stripe). Choose "paid offline" or add the Stripe settings.' }, 503);
    throw err;
  }
  await db('bookings').where({ id: booking.id }).update({ stripe_session_id: checkout.sessionId, updated_at: now() });
  await sendMail({
    to: guest.email,
    subject: `Complete your booking ${booking.reference} at Unleash Athens`,
    heading: 'Your stay is reserved for you',
    intro: `Hello ${guest.name}, we've reserved ${q.apartment.name} for you. Please complete the payment within ${linkHours} hours to confirm your booking.`,
    rows: stayRows(booking, q.apartment.name),
    button: { label: 'Pay securely', url: checkout.url },
  });
  return { booking, checkoutUrl: checkout.url };
}

// ---------- Payment outcomes ----------

/**
 * Called from the Stripe webhook and the success page; safe to call more than once.
 * If the hold lapsed and someone else took the dates meanwhile, the payment is refunded.
 */
async function markPaid({ sessionId, paymentIntentId, amountPaid }) {
  const outcome = await db.transaction(async (trx) => {
    const b = await trx('bookings').where({ stripe_session_id: sessionId }).first();
    if (!b) return { notFound: true };
    await lockApartment(trx, b.apartment_id);
    const fresh = await trx('bookings').where({ id: b.id }).first();
    if (fresh.status === 'confirmed' || fresh.payment_status !== 'unpaid') return { booking: fresh, already: true };

    const free = await isAvailable(trx, fresh.apartment_id, fresh.check_in, fresh.check_out, fresh.id);
    const paid = Number.isInteger(amountPaid) ? amountPaid : fresh.total_cents;
    if (fresh.status === 'cancelled' || !free) {
      await trx('bookings').where({ id: fresh.id }).update({
        status: 'cancelled',
        payment_status: 'paid',
        amount_paid_cents: paid,
        stripe_payment_intent_id: paymentIntentId || null,
        cancelled_at: now(),
        cancelled_by: 'system',
        cancel_reason: 'Dates no longer available when payment completed',
        updated_at: now(),
      });
      return { booking: { ...fresh, stripe_payment_intent_id: paymentIntentId }, conflict: true, paid };
    }
    await trx('bookings').where({ id: fresh.id }).update({
      status: 'confirmed',
      payment_status: 'paid',
      amount_paid_cents: paid,
      stripe_payment_intent_id: paymentIntentId || null,
      confirmed_at: now(),
      hold_expires_at: null,
      updated_at: now(),
    });
    await audit({ actor: 'system', action: 'booking.paid', entity: 'booking', entityId: fresh.id }, trx);
    return { booking: fresh, confirmed: true };
  });

  if (outcome.confirmed) await sendConfirmation(outcome.booking.id);
  if (outcome.conflict) {
    await refundAndRecord(outcome.booking.id, outcome.paid, { actor: 'system' });
    await sendCancellation(outcome.booking.id, 'We are very sorry: those dates were taken while your payment was being processed. Your payment has been refunded in full.');
  }
  return outcome;
}

async function markCheckoutExpired(sessionId) {
  await db('bookings').where({ stripe_session_id: sessionId, status: 'pending_payment' }).update({ status: 'expired', updated_at: now() });
}

/** Releases holds whose time ran out (covers missed webhooks and the dev stand-in). */
async function expireStaleHolds() {
  return db('bookings').where({ status: 'pending_payment' }).where('hold_expires_at', '<', now()).update({ status: 'expired', updated_at: now() });
}

// ---------- Cancellations & refunds ----------

function daysUntil(date) {
  return nightsBetween(athensToday(), date);
}

/** Guests may cancel online with a full refund up to N days before arrival. */
function guestCancellation(booking) {
  if (booking.status !== 'confirmed') return { allowed: false, reason: 'Only confirmed bookings can be cancelled.' };
  const days = daysUntil(booking.check_in);
  if (days < config.booking.freeCancellationDays) {
    return { allowed: false, reason: `Free cancellation ends ${config.booking.freeCancellationDays} days before arrival. Please email us and we'll do our best to help.` };
  }
  return { allowed: true, refundCents: booking.amount_paid_cents - booking.amount_refunded_cents };
}

async function refundAndRecord(bookingId, amountCents, { actor, actorId = null }) {
  if (!amountCents) return;
  const b = await db('bookings').where({ id: bookingId }).first();
  const refundable = b.amount_paid_cents - b.amount_refunded_cents;
  const amount = Math.min(amountCents, refundable);
  if (amount <= 0) return;
  if (b.payment_method === 'stripe') await payments.refund({ paymentIntentId: b.stripe_payment_intent_id, amountCents: amount, reference: b.reference });
  const refunded = b.amount_refunded_cents + amount;
  await db('bookings')
    .where({ id: bookingId })
    .update({ amount_refunded_cents: refunded, payment_status: refunded >= b.amount_paid_cents ? 'refunded' : 'partially_refunded', updated_at: now() });
  await audit({ actor, actorId, action: 'booking.refund', entity: 'booking', entityId: bookingId, details: { amountCents: amount, method: b.payment_method } });
}

async function cancelBooking(bookingId, { by, actorId = null, refundCents = 0, reason = null, notify = true }) {
  const b = await db('bookings').where({ id: bookingId }).first();
  if (!b || !['confirmed', 'pending_payment'].includes(b.status)) throw new BookingError({ form: 'This booking cannot be cancelled.' });
  if (refundCents > 0) await refundAndRecord(bookingId, refundCents, { actor: by, actorId });
  await db('bookings').where({ id: bookingId }).update({ status: 'cancelled', cancelled_at: now(), cancelled_by: by, cancel_reason: reason, hold_expires_at: null, updated_at: now() });
  await audit({ actor: by, actorId, action: 'booking.cancel', entity: 'booking', entityId: bookingId, details: { refundCents } });
  if (notify && b.status === 'confirmed') {
    const fresh = await db('bookings').where({ id: bookingId }).first();
    const refunded = fresh.amount_refunded_cents;
    await sendCancellation(bookingId, refunded ? `A refund of ${euro(refunded)} has been issued to your original payment method. It usually arrives within 5–10 working days.` : null);
  }
}

// ---------- Emails ----------

function stayRows(b, apartmentName) {
  return [
    ['Reference', b.reference],
    ['Room', apartmentName],
    ['Check-in', `${b.check_in} from 15:00`],
    ['Check-out', `${b.check_out} by 11:00`],
    ['Nights', String(b.nights)],
    ['Guests', String(b.guests_count)],
    ['Total', euro(b.total_cents)],
  ];
}

async function loadForEmail(bookingId) {
  const b = await db('bookings').where({ id: bookingId }).first();
  const g = await db('guests').where({ id: b.guest_id }).first();
  return { b, g, aptName: getApartment(b.apartment_id)?.name || b.apartment_id };
}

async function sendConfirmation(bookingId) {
  const { b, g, aptName } = await loadForEmail(bookingId);
  if (!g.email) return;
  const link = await createMagicLink(g.id);
  await sendMail({
    to: g.email,
    subject: `Booking confirmed: ${b.reference} · ${aptName}`,
    heading: 'Your booking is confirmed',
    intro: `Thank you, ${g.name}. We look forward to welcoming you to Unleash Athens. You can view or manage your stay at any time from your account.`,
    rows: [...stayRows(b, aptName), ['Paid', euro(b.amount_paid_cents)]],
    button: { label: 'Manage my booking', url: link },
    footer: `This sign-in link works once and expires in ${config.sessions.magicLinkMinutes} minutes; you can always request a new one at ${config.baseUrl}/account. Free cancellation up to ${config.booking.freeCancellationDays} days before arrival. Unleash Athens · Koumarianou 23, Athens · info@unleashathens.com`,
  });
  await sendMail({
    to: config.mail.to,
    replyTo: { name: g.name, address: g.email },
    subject: `New booking ${b.reference}: ${aptName}, ${b.check_in} → ${b.check_out}`,
    heading: 'New confirmed booking',
    rows: [
      ...stayRows(b, aptName),
      ['Paid', `${euro(b.amount_paid_cents)} (${b.payment_method})`],
      ['Guest', g.name],
      ['Email', g.email],
      ['Phone', g.phone || '—'],
      ['Arrival time', b.arrival_time || '—'],
      ['Requests', b.special_requests || '—'],
    ],
    button: { label: 'Open in admin', url: `${config.baseUrl}/admin#/bookings/${b.id}` },
  });
}

async function sendCancellation(bookingId, refundNote) {
  const { b, g, aptName } = await loadForEmail(bookingId);
  if (g.email) {
    await sendMail({
      to: g.email,
      subject: `Booking cancelled: ${b.reference}`,
      heading: 'Your booking has been cancelled',
      intro: [`Hello ${g.name}, your booking ${b.reference} for ${aptName} (${b.check_in} → ${b.check_out}) has been cancelled.`, refundNote].filter(Boolean).join(' '),
    });
  }
  await sendMail({
    to: config.mail.to,
    subject: `Booking cancelled ${b.reference}: ${aptName}, ${b.check_in} → ${b.check_out}`,
    heading: 'Booking cancelled',
    rows: [...stayRows(b, aptName), ['Cancelled by', b.cancelled_by || '—'], ['Refunded', euro(b.amount_refunded_cents)]],
  });
}

module.exports = {
  athensToday,
  isIsoDate,
  addDays,
  nightsBetween,
  euro,
  quote,
  validateStay,
  validateGuestDetails,
  isAvailable,
  unavailableRanges,
  lockApartment,
  startWebsiteBooking,
  createAdminBooking,
  markPaid,
  markCheckoutExpired,
  expireStaleHolds,
  guestCancellation,
  cancelBooking,
  refundAndRecord,
  sendConfirmation,
  BookingError,
};
