const nodemailer = require('nodemailer');
const { config } = require('./config');

const m = config.mail;
const isMailConfigured = Boolean(m.smtpHost);

const transport = isMailConfigured
  ? nodemailer.createTransport({
      host: m.smtpHost,
      port: m.smtpPort,
      secure: m.smtpSecure,
      auth: m.smtpUser ? { user: m.smtpUser, pass: m.smtpPass } : undefined,
    })
  : null;

// Default sender: the SMTP login when it is an email address (Hostinger requires this), else a no-reply address.
const SENDER = /@/.test(m.smtpUser || '') ? m.smtpUser : 'no-reply@unleashathens.com';
const FROM = m.from || `Unleash Athens <${SENDER}>`;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A simple, branded HTML layout for every email.
function layout({ heading, intro, rows = [], button, footer }) {
  const table = rows.length
    ? `<table cellpadding="7" style="border-collapse:collapse;font-size:14px;margin:16px 0">${rows
        .map(
          ([k, v]) =>
            `<tr><td style="color:#64655a;border-bottom:1px solid #dcdac5;vertical-align:top">${escapeHtml(k)}</td>` +
            `<td style="border-bottom:1px solid #dcdac5;white-space:pre-wrap">${escapeHtml(v)}</td></tr>`
        )
        .join('')}</table>`
    : '';
  const cta = button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="background:#a9532f;color:#faf8f1;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">${escapeHtml(button.label)}</a></p>`
    : '';
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#2a2b21;max-width:560px;margin:0 auto;padding:24px">` +
    `<p style="font-family:Georgia,serif;font-size:22px;margin:0 0 20px">Unleash <em style="color:#a9532f">Athens</em></p>` +
    `<h2 style="font-family:Georgia,serif;font-weight:normal;margin:0 0 12px">${escapeHtml(heading)}</h2>` +
    (intro ? `<p style="line-height:1.6">${escapeHtml(intro)}</p>` : '') +
    table +
    cta +
    `<p style="font-size:12px;color:#64655a;line-height:1.6;margin-top:28px">${escapeHtml(
      footer || 'Unleash Athens · Koumarianou 23, 114 73 Athens, Greece · info@unleashathens.com'
    )}</p></div>`
  );
}

function textVersion({ heading, intro, rows = [], button }) {
  return [heading, intro, rows.map(([k, v]) => `${k}: ${v}`).join('\n'), button ? `${button.label}: ${button.url}` : '']
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Send an email. In local test mode (DEV_MODE=true) without SMTP the message is printed
 * to the console so flows like magic-link sign-in can be tested; otherwise SMTP is required.
 */
async function sendMail({ to, subject, replyTo, ...content }) {
  const message = { from: FROM, to, replyTo, subject, html: layout(content), text: textVersion(content) };
  if (transport) return transport.sendMail(message);
  if (!config.devMode) throw new Error('SMTP is not configured');
  console.log(`\n[dev mail] To: ${to}\nSubject: ${subject}\n${message.text}\n`);
  return { dev: true };
}

module.exports = { sendMail, isMailConfigured, escapeHtml };
