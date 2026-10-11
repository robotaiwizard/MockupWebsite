const { db, now } = require('./db');

// Records who did what to which record. Details must never contain guest personal data.
async function audit({ actor, actorId = null, action, entity = null, entityId = null, details = null }, trx = db) {
  await trx('audit_log').insert({
    actor,
    actor_id: actorId,
    action,
    entity,
    entity_id: entityId == null ? null : String(entityId),
    details: details ? JSON.stringify(details) : null,
    created_at: now(),
  });
}

module.exports = { audit };
