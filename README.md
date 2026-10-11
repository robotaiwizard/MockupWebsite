# Unleash Athens

Website and booking system for Unleash Athens, six boutique apartments at Koumarianou 23, below Strefi Hill in Athens.

- **Guests** book online with live availability and pay in full by card, Apple Pay or Google Pay (Stripe Checkout). They manage their stays from **/account**, signing in with a one-time email link (no passwords).
- **Staff** manage bookings, payments, refunds, closed dates and guests at **/admin**.
- **GDPR**: data export and erasure (self-service and for staff), automatic retention clean-up, an audit log, essential cookies only, and a privacy policy at **/privacy**.

## Run locally

```bash
npm install
npm run create-admin -- you@example.com "Your Name"   # asks for a password (12+ characters)
npm start                                              # http://localhost:3000
```

Locally, with no other settings, the app uses a SQLite file (`data/dev.sqlite3`). For testing without Stripe or SMTP, put `DEV_MODE=true` in `.env`: payments then go through a **test checkout page** and emails (confirmations, sign-in links) are **printed in the terminal**. Test mode must be switched on explicitly and never runs with `NODE_ENV=production`, so a live site can't accidentally accept fake payments; without Stripe settings, online booking is simply disabled with a message to email instead. Put real settings in `.env` (copy `.env.example`) to use MySQL, Stripe test mode or SMTP locally.

## Deploy on Hostinger

1. **Database**: in hPanel → *Databases*, create a MySQL database and user.
2. **Stripe**: in the Stripe Dashboard, get the secret key (*Developers → API keys*). Add a webhook endpoint `https://<your-domain>/webhooks/stripe` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`, then copy its signing secret.
3. **Environment variables**: add everything in `.env.example` to the website's *Environment variables* in hPanel and redeploy. The app refuses to start in production if a required setting is missing, and says which one.
4. **Admin account**: run `npm run create-admin -- you@example.com "Your Name"` once against the production database (from Hostinger's terminal/SSH, or locally with the production `DB_*` settings).

The database tables are created and updated automatically on start (`migrations/`).

## How booking works

1. The guest picks dates; the form shows availability and the price.
2. **Continue to secure payment** holds the dates for 35 minutes and opens Stripe Checkout. Card details never reach our server.
3. When Stripe reports the payment (webhook, with the success page as a backup), the booking is **confirmed**. The guest gets a confirmation with a *Manage my booking* link, and info@unleashathens.com gets a notification.
4. Unpaid holds expire automatically. If a payment completes after its hold lapsed and the dates were taken meanwhile, it is refunded automatically.

Guests can cancel online for a full automatic refund up to `FREE_CANCELLATION_DAYS` (default 7) before arrival; after that they're asked to email. Staff can cancel or refund any amount at any time.

Staff can also create bookings taken by phone: either **paid offline** (confirmed immediately) or with a **payment link** emailed to the guest (dates held for 23 hours).

## Structure

| Path | What it is |
| --- | --- |
| `server.js` | Starts the app: security headers, pages, API routes, background jobs |
| `src/config.js` | All settings, read from environment variables |
| `src/db.js`, `migrations/` | Database (MySQL in production, SQLite locally) and schema |
| `src/bookings.js` | Availability, holds, pricing, confirmation, cancellation, refunds, booking emails |
| `src/payments.js` | Stripe Checkout, refunds and webhook verification (test stand-in locally) |
| `src/auth.js` | Admin passwords (scrypt), sessions, guest magic links, CSRF protection |
| `src/gdpr.js` | Data export, erasure and the daily retention clean-up |
| `src/routes/` | `public.js` (booking, availability, Stripe webhook), `guest.js` (/account API), `admin.js` (/admin API) |
| `src/mailer.js` | Branded HTML emails over SMTP |
| `scripts/create-admin.js` | Create a staff account or reset its password |
| `data/apartments.json` | The six apartments: descriptions, capacity, nightly price. Edit here; the site, booking engine and admin update on restart |
| `data/photos.json` | Every photo: file, alt text, author and licence (feeds the footer credits) |
| `public/` | Pages: `index.html`, `account.html`, `admin.html`, `privacy.html`, `booking-result.html`, with their scripts and styles |

## GDPR

| Requirement | How it's handled |
| --- | --- |
| Lawful basis and transparency | Booking form requires acknowledging the privacy policy (version and time recorded). Marketing is a separate, unticked opt-in |
| Data minimisation | Only what a booking needs. Card data stays with Stripe |
| Right of access and portability | *Download my data* in the guest account. Staff can export any guest from /admin |
| Right to erasure | *Delete my account* (guest) or *Erase personal data* (staff). Contact details and notes are deleted at once; paid booking records keep only the name until the tax retention period ends |
| Storage limitation | Daily job: abandoned checkouts and guests without bookings deleted after 30 days, guests anonymised `RETENTION_YEARS` after their last stay, audit log trimmed after 2 years, expired sessions and links removed (`npm run retention` runs it by hand) |
| Security | HTTPS, strict security headers, hashed passwords and tokens, CSRF checks, rate-limited sign-ins, staff actions logged |
| No third-party tracking | Fonts and images are self-hosted. The Google map loads only when the visitor clicks *Show map*. Only essential cookies, so no cookie banner is needed |

**Still needed from the business:**
- Fill in the highlighted placeholders in `public/privacy.html` (legal name, VAT, GEMI).
- Have a lawyer review the policy.
- Confirm the retention period with your accountant.
- Accept the data processing agreements of Hostinger and Stripe (both offer them in their dashboards/terms).
- Keep a simple record of processing activities.

## Photos

Neighbourhood photos are freely licensed images from Wikimedia Commons, stored in `public/images/commons/` and credited in the footer (generated from `data/photos.json`). The house photos and video are © Unleash Athens.
