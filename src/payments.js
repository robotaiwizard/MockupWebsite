// Payment provider: Stripe Checkout in production; a local stand-in when no Stripe key is set
// (development only), so the full booking flow can be clicked through without real payments.
const crypto = require('crypto');
const { config } = require('./config');

const stripe = config.stripe.secretKey ? require('stripe')(config.stripe.secretKey) : null;
const isStripe = Boolean(stripe);
const useTestCheckout = !stripe && config.devMode;

if (!stripe && !useTestCheckout) console.warn('Payments are not configured: set STRIPE_SECRET_KEY (or DEV_MODE=true for local testing). Online booking is disabled.');

/**
 * Start a hosted checkout for a booking. Card details never touch our server.
 * Returns { sessionId, url }.
 */
async function createCheckout({ booking, apartmentName, guestEmail, expiresAt }) {
  const description = `${booking.check_in} → ${booking.check_out} · ${booking.nights} night${booking.nights > 1 ? 's' : ''} · ${booking.guests_count} guest${booking.guests_count > 1 ? 's' : ''}`;
  if (!stripe) {
    if (!useTestCheckout) throw Object.assign(new Error('Payments are not configured'), { paymentsUnavailable: true });
    const sessionId = `dev_${crypto.randomBytes(12).toString('hex')}`;
    return { sessionId, url: `${config.baseUrl}/dev/checkout?session_id=${sessionId}` };
  }
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: guestEmail,
    client_reference_id: booking.reference,
    metadata: { booking_reference: booking.reference },
    payment_intent_data: { metadata: { booking_reference: booking.reference }, description: `Unleash Athens ${booking.reference}` },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: booking.currency,
          unit_amount: booking.total_cents,
          product_data: { name: `${apartmentName} · Unleash Athens`, description },
        },
      },
    ],
    expires_at: Math.floor(new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() / 1000),
    success_url: `${config.baseUrl}/booking/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/booking/cancelled?ref=${encodeURIComponent(booking.reference)}`,
  });
  return { sessionId: session.id, url: session.url };
}

/** Look up a checkout session's outcome: { paid, paymentIntentId, amountPaid }. */
async function getCheckout(sessionId) {
  if (!stripe) return null; // the dev stand-in reports completion directly
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  return {
    paid: s.payment_status === 'paid',
    expired: s.status === 'expired',
    paymentIntentId: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id,
    amountPaid: s.amount_total,
  };
}

/** Refund part or all of a payment. */
async function refund({ paymentIntentId, amountCents, reference }) {
  if (!stripe || !paymentIntentId) return { id: `dev_refund_${reference}`, dev: true };
  return stripe.refunds.create({ payment_intent: paymentIntentId, amount: amountCents, metadata: { booking_reference: reference } });
}

/** Verify and parse a Stripe webhook (needs the raw request body). */
function parseWebhook(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

module.exports = { isStripe, useTestCheckout, createCheckout, getCheckout, refund, parseWebhook };
