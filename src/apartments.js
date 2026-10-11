const { db } = require('./db');
const photos = require('../data/photos.json');
const source = require('../data/apartments.json');

// data/apartments.json is the source of truth for descriptions and prices;
// the apartments table mirrors id/name/price/capacity so bookings can reference them.
const apartments = source.map((a) => ({ ...a, photo: photos[`apt-${a.id}`] }));
const byId = new Map(apartments.map((a) => [a.id, a]));

async function syncApartments() {
  for (const a of apartments) {
    const row = { name: a.name, price_cents: Math.round(a.price * 100), max_guests: a.guests, active: true };
    const existing = await db('apartments').where({ id: a.id }).first();
    if (existing) await db('apartments').where({ id: a.id }).update(row);
    else await db('apartments').insert({ id: a.id, ...row });
  }
  // Apartments removed from the JSON stay in the table (old bookings reference them) but are inactive.
  await db('apartments').whereNotIn('id', apartments.map((a) => a.id)).update({ active: false });
}

module.exports = { apartments, getApartment: (id) => byId.get(id), syncApartments };
