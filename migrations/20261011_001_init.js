// Initial schema for the booking system. Works on MySQL/MariaDB (production) and SQLite (local).

exports.up = async (knex) => {
  await knex.schema.createTable('apartments', (t) => {
    t.string('id', 64).primary();
    t.string('name', 120).notNullable();
    t.integer('price_cents').notNullable();
    t.integer('max_guests').notNullable();
    t.boolean('active').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('guests', (t) => {
    t.increments('id');
    t.string('email', 254).unique(); // null once erased
    t.string('name', 120).notNullable();
    t.string('phone', 40);
    t.boolean('marketing_opt_in').notNullable().defaultTo(false);
    t.string('marketing_opt_in_at', 19);
    t.string('privacy_ack_version', 20);
    t.string('privacy_ack_at', 19);
    t.string('created_at', 19).notNullable();
    t.string('updated_at', 19).notNullable();
    t.string('last_login_at', 19);
    t.string('erased_at', 19);
  });

  await knex.schema.createTable('bookings', (t) => {
    t.increments('id');
    t.string('reference', 16).notNullable().unique();
    t.integer('guest_id').unsigned().notNullable().references('guests.id');
    t.string('apartment_id', 64).notNullable().references('apartments.id');
    t.string('check_in', 10).notNullable(); // YYYY-MM-DD
    t.string('check_out', 10).notNullable();
    t.integer('nights').notNullable();
    t.integer('guests_count').notNullable();
    t.integer('total_cents').notNullable();
    t.string('currency', 3).notNullable().defaultTo('eur');
    // pending_payment → confirmed → (cancelled) ; pending_payment → expired
    t.string('status', 20).notNullable();
    t.string('payment_status', 20).notNullable().defaultTo('unpaid'); // unpaid | paid | partially_refunded | refunded
    t.string('payment_method', 20); // stripe | offline
    t.integer('amount_paid_cents').notNullable().defaultTo(0);
    t.integer('amount_refunded_cents').notNullable().defaultTo(0);
    t.string('stripe_session_id', 255).unique();
    t.string('stripe_payment_intent_id', 255);
    t.string('hold_expires_at', 19);
    t.string('arrival_time', 40);
    t.text('special_requests');
    t.text('admin_notes');
    t.string('source', 20).notNullable().defaultTo('website'); // website | admin
    t.string('created_at', 19).notNullable();
    t.string('updated_at', 19).notNullable();
    t.string('confirmed_at', 19);
    t.string('cancelled_at', 19);
    t.string('cancelled_by', 20); // guest | admin | system
    t.string('cancel_reason', 255);
    t.index(['apartment_id', 'check_in', 'check_out']);
    t.index(['status']);
    t.index(['guest_id']);
  });

  await knex.schema.createTable('blocked_dates', (t) => {
    t.increments('id');
    t.string('apartment_id', 64).notNullable().references('apartments.id');
    t.string('start_date', 10).notNullable(); // first blocked night
    t.string('end_date', 10).notNullable(); // day after the last blocked night
    t.string('reason', 255);
    t.string('created_at', 19).notNullable();
    t.index(['apartment_id', 'start_date', 'end_date']);
  });

  await knex.schema.createTable('admins', (t) => {
    t.increments('id');
    t.string('email', 254).notNullable().unique();
    t.string('name', 120).notNullable();
    t.string('password_hash', 255).notNullable();
    t.boolean('active').notNullable().defaultTo(true);
    t.string('created_at', 19).notNullable();
    t.string('last_login_at', 19);
  });

  // Only SHA-256 hashes of session and magic-link tokens are stored.
  await knex.schema.createTable('sessions', (t) => {
    t.string('token_hash', 64).primary();
    t.string('kind', 10).notNullable(); // admin | guest
    t.integer('subject_id').notNullable();
    t.string('created_at', 19).notNullable();
    t.string('expires_at', 19).notNullable();
    t.index(['kind', 'subject_id']);
  });

  await knex.schema.createTable('magic_links', (t) => {
    t.string('token_hash', 64).primary();
    t.integer('guest_id').unsigned().notNullable().references('guests.id').onDelete('CASCADE');
    t.string('created_at', 19).notNullable();
    t.string('expires_at', 19).notNullable();
    t.string('used_at', 19);
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.increments('id');
    t.string('actor', 10).notNullable(); // admin | guest | system
    t.integer('actor_id');
    t.string('action', 60).notNullable();
    t.string('entity', 30);
    t.string('entity_id', 40);
    t.text('details');
    t.string('created_at', 19).notNullable();
    t.index(['created_at']);
  });
};

exports.down = async (knex) => {
  for (const t of ['audit_log', 'magic_links', 'sessions', 'admins', 'blocked_dates', 'bookings', 'guests', 'apartments']) {
    await knex.schema.dropTableIfExists(t);
  }
};
