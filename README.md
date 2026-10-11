# Unleash Athens

Website for Unleash Athens, a boutique hotel of six apartments at Koumarianou 23, below Strefi Hill in Athens.

## Run

```bash
npm install
npm start          # http://localhost:3000  (npm run dev restarts on file changes)
```

## Structure

| Path | What it is |
| --- | --- |
| `server.js` | Express server: serves `public/`, `GET /api/apartments`, `POST /api/bookings` |
| `mailer.js` | Emails each booking request to the hotel (`BOOKING_EMAIL_TO`, default info@unleashathens.com) |
| `data/apartments.json` | The six apartments (name, size, guests, price, features). Edit here; the page and booking form update automatically |
| `data/photos.json` | Every photo on the site: Wikimedia Commons URL, alt text, author and licence. The server fills `<img data-photo="key">` slots in `index.html` and the footer photo credits from this file |
| `public/` | The single-page site: `index.html`, `styles.css`, `app.js` |

Booking requests are validated on the server (required fields, dates not in the past, guest limit per apartment) and emailed to the hotel. They are not stored anywhere. No payment is taken; the guest gets a reference number.

## Photos

The neighbourhood and sightseeing photos are freely licensed images from Wikimedia Commons, loaded directly from Wikimedia. Most are CC BY-SA, which requires the credit shown in the footer; that list is generated from `data/photos.json`, so fill in the author and licence for any photo you add. The apartment cards currently show neighbourhood photos; replace them with real interior photos (add entries to `photos.json` as `apt-<apartment id>`) when available.

## Booking emails

Every booking request is emailed to **info@unleashathens.com** with all the form details. Hitting *Reply* answers the guest directly.

To turn sending on, copy `.env.example` to `.env` and fill in the SMTP settings from your email provider (host, port, username, password). `.env` is git-ignored, so the password never ends up in the repository. On a hosting platform, set the same names as environment variables instead.

Requests are **not stored** on the server: the email is the only copy, and logs never contain guests' details. If the email can't be sent (SMTP not configured, wrong password, mail server down), the guest sees an error asking them to try again or email info@unleashathens.com, so no request is silently lost. To test locally, put SMTP settings in `.env`.
