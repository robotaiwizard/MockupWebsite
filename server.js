const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BOOKINGS_FILE = path.join(__dirname, 'data', 'bookings.json');
const photos = require('./data/photos.json');
const apartments = require('./data/apartments.json').map((a) => ({ ...a, photo: photos[`apt-${a.id}`] }));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fill <img data-photo="key"> slots and the credits list from data/photos.json, once at startup.
function renderIndex() {
  const html = require('fs').readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  const credits = [...new Map(Object.values(photos).map((p) => [p.page, p])).values()]
    .map(
      (p) =>
        `<li><a href="${escapeHtml(p.page)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a> by ${escapeHtml(p.author)}, ` +
        (p.licenseUrl
          ? `<a href="${escapeHtml(p.licenseUrl)}" target="_blank" rel="noopener">${escapeHtml(p.license)}</a>`
          : escapeHtml(p.license)) +
        '</li>'
    )
    .join('\n        ');
  return html
    .replace(/data-photo="([^"]+)"/g, (_, key) => {
      const photo = photos[key];
      if (!photo) throw new Error(`Unknown photo "${key}" in index.html`);
      return `src="${escapeHtml(photo.src)}" alt="${escapeHtml(photo.alt)}"`;
    })
    .replace('{{credits}}', credits);
}
const indexHtml = renderIndex();

app.use(express.json({ limit: '20kb' }));
app.get(['/', '/index.html'], (req, res) => res.type('html').send(indexHtml));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

async function readBookings() {
  try {
    return JSON.parse(await fs.readFile(BOOKINGS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeBookings(bookings) {
  await fs.writeFile(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}

// Parse a YYYY-MM-DD string as a UTC date so night counts are unaffected by DST.
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateBooking(body) {
  const errors = {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const notes = String(body.notes || '').trim().slice(0, 1000);
  const apartment = apartments.find((a) => a.id === body.apartment);
  const guests = Number.parseInt(body.guests, 10);
  const checkIn = parseDate(body.checkIn);
  const checkOut = parseDate(body.checkOut);

  if (name.length < 2) errors.name = 'Please enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Please enter a valid email address.';
  if (phone && !/^[+\d][\d\s()-]{5,}$/.test(phone)) errors.phone = 'Please enter a valid phone number.';
  if (!apartment) errors.apartment = 'Please choose an apartment.';

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (!checkIn) errors.checkIn = 'Please choose a check-in date.';
  else if (checkIn < today) errors.checkIn = 'Check-in cannot be in the past.';
  if (!checkOut) errors.checkOut = 'Please choose a check-out date.';
  else if (checkIn && checkOut <= checkIn) errors.checkOut = 'Check-out must be after check-in.';

  if (!Number.isInteger(guests) || guests < 1) errors.guests = 'Please enter the number of guests.';
  else if (apartment && guests > apartment.guests) {
    errors.guests = `${apartment.name} sleeps up to ${apartment.guests} guests.`;
  }

  return { errors, booking: { name, email, phone, notes, apartment, guests, checkIn, checkOut } };
}

app.get('/api/apartments', (req, res) => {
  res.json(apartments);
});

app.post('/api/bookings', async (req, res, next) => {
  try {
    const { errors, booking } = validateBooking(req.body || {});
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    const { apartment, checkIn, checkOut } = booking;
    const existing = await readBookings();
    const overlaps = existing.some(
      (b) =>
        b.apartmentId === apartment.id &&
        new Date(`${b.checkIn}T00:00:00Z`) < checkOut &&
        new Date(`${b.checkOut}T00:00:00Z`) > checkIn
    );
    if (overlaps) {
      return res.status(409).json({
        errors: { checkIn: `${apartment.name} is already booked for some of those nights. Please try other dates or another apartment.` },
      });
    }

    const nights = Math.round((checkOut - checkIn) / 86400000);
    const record = {
      reference: `UA-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      apartmentId: apartment.id,
      apartmentName: apartment.name,
      checkIn: checkIn.toISOString().slice(0, 10),
      checkOut: checkOut.toISOString().slice(0, 10),
      nights,
      guests: booking.guests,
      total: nights * apartment.price,
      name: booking.name,
      email: booking.email,
      phone: booking.phone,
      notes: booking.notes,
      createdAt: new Date().toISOString(),
    };

    existing.push(record);
    await writeBookings(existing);
    console.log(`New booking ${record.reference}: ${record.apartmentName}, ${record.checkIn} → ${record.checkOut}`);

    const { email, phone, notes, ...summary } = record;
    res.status(201).json(summary);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ errors: { form: 'Something went wrong on our side. Please try again or email us.' } });
});

app.listen(PORT, () => {
  console.log(`Unleash Athens is open at http://localhost:${PORT}`);
});
