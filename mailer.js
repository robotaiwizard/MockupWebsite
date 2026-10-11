const nodemailer = require('nodemailer');

const BOOKING_EMAIL_TO = process.env.BOOKING_EMAIL_TO || 'info@unleashathens.com';

const isMailConfigured = Boolean(process.env.SMTP_HOST);

const transport = isMailConfigured
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

// Default sender: the SMTP login when it is an email address, otherwise a no-reply address.
const SENDER = /@/.test(process.env.SMTP_USER || '') ? process.env.SMTP_USER : 'no-reply@unleashathens.com';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const euro = (n) => `€${n.toLocaleString('en-IE')}`;

function bookingRows(b) {
  return [
    ['Reference', b.reference],
    ['Apartment', b.apartmentName],
    ['Check-in', b.checkIn],
    ['Check-out', b.checkOut],
    ['Nights', b.nights],
    ['Guests', b.guests],
    ['Estimated total', euro(b.total)],
    ['Name', b.name],
    ['Email', b.email],
    ['Phone', b.phone || '—'],
    ['Notes', b.notes || '—'],
    ['Received', new Date(b.createdAt).toLocaleString('en-GB', { timeZone: 'Europe/Athens' }) + ' (Athens)'],
  ];
}

async function sendBookingNotification(booking) {
  const rows = bookingRows(booking);
  const message = {
    from: process.env.MAIL_FROM || `Unleash Athens website <${SENDER}>`,
    to: BOOKING_EMAIL_TO,
    replyTo: { name: booking.name, address: booking.email },
    subject: `Booking request ${booking.reference}: ${booking.apartmentName}, ${booking.checkIn} → ${booking.checkOut}`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\nReply to this email to answer the guest directly.',
    html:
      `<h2 style="font-family:Georgia,serif;margin:0 0 12px">New booking request</h2>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">` +
      rows
        .map(
          ([k, v]) =>
            `<tr><td style="color:#64655a;border-bottom:1px solid #dcdac5">${escapeHtml(k)}</td>` +
            `<td style="border-bottom:1px solid #dcdac5;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`
        )
        .join('') +
      `</table><p style="font-family:Arial,sans-serif;font-size:13px;color:#64655a">Reply to this email to answer the guest directly.</p>`,
  };

  if (!transport) throw new Error('SMTP is not configured');
  return transport.sendMail(message);
}

module.exports = { sendBookingNotification, isMailConfigured, BOOKING_EMAIL_TO };
