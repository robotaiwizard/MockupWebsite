# Casa Vecchia

Website for Casa Vecchia, a boutique hotel of six apartments at Koumarianou 23, below Strefi Hill in Athens.

## Run

```bash
npm install
npm start          # http://localhost:3000  (npm run dev restarts on file changes)
```

## Structure

| Path | What it is |
| --- | --- |
| `server.js` | Express server: serves `public/`, `GET /api/apartments`, `POST /api/bookings` |
| `data/apartments.json` | The six apartments (name, size, guests, price, features). Edit here; the page and booking form update automatically |
| `data/photos.json` | Every photo on the site: Wikimedia Commons URL, alt text, author and licence. The server fills `<img data-photo="key">` slots in `index.html` and the footer photo credits from this file |
| `data/bookings.json` | Booking requests, created on the first booking (git-ignored) |
| `public/` | The single-page site: `index.html`, `styles.css`, `app.js` |

Booking requests are validated on the server (required fields, dates not in the past, guest limit per apartment) and rejected if they overlap an existing booking for the same apartment. No payment is taken; the guest gets a reference number and the request is saved to `data/bookings.json`.

## Photos

The neighbourhood and sightseeing photos are freely licensed images from Wikimedia Commons, loaded directly from Wikimedia. Most are CC BY-SA, which requires the credit shown in the footer; that list is generated from `data/photos.json`, so fill in the author and licence for any photo you add. The apartment cards currently show neighbourhood photos; replace them with real interior photos (add entries to `photos.json` as `apt-<apartment id>`) when available.
