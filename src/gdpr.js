// GDPR: right of access (export), right to erasure, and storage limitation (retention clean-up).
const { db, now } = require('./db');
const { config } = require('./config');
const { audit } = require('./audit');
const { athensToday, addDays } = require('./bookings');

/** Everything we hold about a guest, in a portable format (Art. 15 & 20). */
async function exportGuest(guestId) {
  const guest = await db('guests').where({ id: guestId }).first();
  const bookings = await db('bookings')
    .where({ guest_id: guestId })
    .select(
      'reference', 'apartment_id', 'check_in', 'check_out', 'nights', 'guests_count', 'total_cents', 'currency',
      'status', 'payment_status', 'payment_method', 'amount_paid_cents', 'amount_refunded_cents',
      'arrival_time', 'special_requests', 'created_at', 'confirmed_at', 'cancelled_at', 'cancel_reason'
    )
    .orderBy('check_in', 'desc');
  return {
    exportedAt: now(),
    controller: 'Unleash Athens, Koumarianou 23, 114 73 Athens, Greece · info@unleashathens.com',
    note: 'Card details are processed by Stripe and never stored by Unleash Athens.',
    profile: {
      name: guest.name,
      email: guest.email,
      phone: guest.phone,
      marketingOptIn: Boolean(guest.marketing_opt_in),
      marketingOptInAt: guest.marketing_opt_in_at,
      privacyPolicyAcknowledged: guest.privacy_ack_version,
      privacyPolicyAcknowledgedAt: guest.privacy_ack_at,
      accountCreatedAt: guest.created_at,
      lastSignInAt: guest.last_login_at,
    },
    bookings,
  };
}

/**
 * Erase a guest (Art. 17). Contact details and free-text notes are removed now. Booking and
 * payment records are kept, with only the name, until the legal retention period ends
 * (Art. 17(3)(b): tax/accounting obligations), then fully anonymised by the retention job.
 */
async function eraseGuest(guestId, { actor, actorId = null }) {
  const upcoming = await db('bookings')
    .where({ guest_id: guestId })
    .where((q) => q.where('status', 'confirmed').where('check_out', '>=', athensToday()).orWhere('status', 'pending_payment'))
    .first('reference');
  if (upcoming) {
    return { ok: false, error: `There is an active booking (${upcoming.reference}). Please cancel it or wait until after the stay before deleting the account.` };
  }
  await db.transaction(async (trx) => {
    await trx('guests').where({ id: guestId }).update({
      email: null,
      phone: null,
      marketing_opt_in: false,
      marketing_opt_in_at: null,
      erased_at: now(),
      updated_at: now(),
    });
    await trx('bookings').where({ guest_id: guestId }).update({ arrival_time: null, special_requests: null, updated_at: now() });
    await trx('sessions').where({ kind: 'guest', subject_id: guestId }).del();
    await trx('magic_links').where({ guest_id: guestId }).del();
    // Guests with no paid bookings have nothing we must keep: remove them completely.
    const paid = await trx('bookings').where({ guest_id: guestId }).where('amount_paid_cents', '>', 0).first('id');
    if (!paid) {
      await trx('bookings').where({ guest_id: guestId }).del();
      await trx('guests').where({ id: guestId }).update({ name: 'Erased guest' });
    }
    await audit({ actor, actorId, action: 'guest.erase', entity: 'guest', entityId: guestId }, trx);
  });
  return { ok: true };
}

/** Daily clean-up so personal data isn't kept longer than needed (Art. 5(1)(e)). */
async function runRetention() {
  const t = now();
  const stats = {};
  stats.sessions = await db('sessions').where('expires_at', '<', t).del();
  stats.magicLinks = await db('magic_links').where('expires_at', '<', t).del();

  // Abandoned checkouts: unpaid bookings that expired more than N days ago.
  const abandonedBefore = now(-config.gdpr.abandonedDays * 86400e3);
  stats.abandonedBookings = await db('bookings').where({ status: 'expired', amount_paid_cents: 0 }).where('updated_at', '<', abandonedBefore).del();
  stats.unpaidCancelled = await db('bookings').where({ status: 'cancelled', amount_paid_cents: 0 }).where('updated_at', '<', abandonedBefore).del();

  // Guests with no bookings left and no recent sign-in.
  const orphans = await db('guests')
    .whereNotExists(db('bookings').whereRaw('bookings.guest_id = guests.id'))
    .where('created_at', '<', abandonedBefore)
    .where((q) => q.whereNull('last_login_at').orWhere('last_login_at', '<', abandonedBefore))
    .pluck('id');
  if (orphans.length) {
    await db('magic_links').whereIn('guest_id', orphans).del();
    stats.orphanGuests = await db('guests').whereIn('id', orphans).del();
  }

  // After the retention period, anonymise guests whose last stay ended long ago.
  const cutoff = addDays(athensToday(), -Math.round(config.gdpr.retentionYears * 365.25));
  const expired = await db('guests')
    .whereNot('name', 'Anonymised guest')
    .whereExists(db('bookings').whereRaw('bookings.guest_id = guests.id'))
    .whereNotExists(db('bookings').whereRaw('bookings.guest_id = guests.id').where('check_out', '>=', cutoff))
    .pluck('id');
  if (expired.length) {
    await db('guests').whereIn('id', expired).update({ name: 'Anonymised guest', email: null, phone: null, marketing_opt_in: false, erased_at: t, updated_at: t });
    await db('bookings').whereIn('guest_id', expired).update({ arrival_time: null, special_requests: null, admin_notes: null, updated_at: t });
    stats.anonymisedGuests = expired.length;
  }

  stats.auditLog = await db('audit_log').where('created_at', '<', now(-config.gdpr.auditLogDays * 86400e3)).del();
  return stats;
}

module.exports = { exportGuest, eraseGuest, runRetention };
