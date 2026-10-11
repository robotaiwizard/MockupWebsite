const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db');
const { config } = require('../config');
const { apartments, getApartment } = require('../apartments');
const payments = require('../payments');
const B = require('../bookings');

const router = express.Router();

const bookingLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { errors: { form: 'Too many attempts. Please wait a few minutes and try again.' } } });

router.get('/api/apartments', (req, res) => res.json(apartments));

// Booked/blocked date ranges only: no guest information is exposed.
router.get('/api/availability', async (req, res, next) => {
  try {
    const { apartment, from, to } = req.query;
    if (!getApartment(apartment) || !B.isIsoDate(from) || !B.isIsoDate(to) || to <= from || B.nightsBetween(from, to) > 400) {
      return res.status(400).json({ error: 'Invalid range.' });
    }
    res.json({ apartment, unavailable: await B.unavailableRanges(apartment, from, to) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/bookings', bookingLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const stay = B.validateStay(body);
    const guest = B.validateGuestDetails(body);
    const errors = { ...stay.errors, ...guest.errors };
    if (body.privacy !== true) errors.privacy = 'Please confirm you have read the privacy policy.';
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const result = await B.startWebsiteBooking({
      stay: stay.value,
      guest: guest.value,
      arrivalTime: String(body.arrivalTime || '').slice(0, 40),
      specialRequests: String(body.notes || '').trim().slice(0, 1000),
      marketing: body.marketing === true,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof B.BookingError) return res.status(err.status).json({ errors: err.errors });
    if (err.paymentsUnavailable) return res.status(503).json({ errors: { form: 'Online booking is temporarily unavailable. Please email us at info@unleashathens.com and we will book your stay.' } });
    next(err);
  }
});

// Shown on the success page. Confirms the payment directly with Stripe in case the webhook is slow.
router.get('/api/checkout/status', async (req, res, next) => {
  try {
    const sessionId = String(req.query.session_id || '');
    let b = sessionId && (await db('bookings').where({ stripe_session_id: sessionId }).first());
    if (!b) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'confirmed' && payments.isStripe) {
      const s = await payments.getCheckout(sessionId);
      if (s?.paid) {
        await B.markPaid({ sessionId, paymentIntentId: s.paymentIntentId, amountPaid: s.amountPaid });
        b = await db('bookings').where({ id: b.id }).first();
      }
    }
    res.json({
      reference: b.reference,
      status: b.status,
      apartmentName: getApartment(b.apartment_id)?.name,
      checkIn: b.check_in,
      checkOut: b.check_out,
      nights: b.nights,
      total: b.total_cents / 100,
      paid: b.amount_paid_cents / 100,
    });
  } catch (err) {
    next(err);
  }
});

// Stripe webhook: needs the raw body for signature verification, so it is mounted before express.json().
const webhook = express.Router();
webhook.post('/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  let event;
  try {
    event = payments.parseWebhook(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('Stripe webhook signature check failed:', err.message);
    return res.status(400).send('Invalid signature');
  }
  try {
    const s = event.data.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type) && s.payment_status === 'paid') {
      await B.markPaid({ sessionId: s.id, paymentIntentId: s.payment_intent, amountPaid: s.amount_total });
    } else if (event.type === 'checkout.session.expired') {
      await B.markCheckoutExpired(s.id);
    }
    res.json({ received: true });
  } catch (err) {
    console.error(`Stripe webhook ${event.type} failed:`, err.message);
    res.status(500).send('Webhook handler error'); // Stripe retries
  }
});

// Local stand-in for Stripe Checkout (only without a Stripe key, never in production).
const dev = express.Router();
if (payments.useTestCheckout) {
  dev.get('/dev/checkout', async (req, res) => {
    const b = await db('bookings').where({ stripe_session_id: String(req.query.session_id || '') }).first();
    if (!b) return res.status(404).send('Unknown session');
    const apt = getApartment(b.apartment_id);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test checkout</title>
<body style="font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px">
<p style="background:#fff3cd;padding:10px 14px;border-radius:8px">Test payment page: Stripe is not configured, no real money moves.</p>
<h2>${apt.name}</h2><p>${b.check_in} → ${b.check_out} · ${b.nights} nights</p><p style="font-size:28px"><b>${B.euro(b.total_cents)}</b></p>
<form method="post" action="/dev/checkout/complete"><input type="hidden" name="session_id" value="${b.stripe_session_id}">
<button name="outcome" value="paid" style="padding:12px 20px;font-size:16px">Pay (test)</button>
<button name="outcome" value="cancel" style="padding:12px 20px;font-size:16px">Cancel</button></form></body>`);
  });
  dev.post('/dev/checkout/complete', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const sessionId = String(req.body.session_id || '');
      const b = await db('bookings').where({ stripe_session_id: sessionId }).first();
      if (!b) return res.status(404).send('Unknown session');
      if (req.body.outcome === 'paid') {
        await B.markPaid({ sessionId, paymentIntentId: null, amountPaid: b.total_cents });
        return res.redirect(303, `/booking/success?session_id=${encodeURIComponent(sessionId)}`);
      }
      res.redirect(303, `/booking/cancelled?ref=${encodeURIComponent(b.reference)}`);
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { router, webhook, dev };
