# Faded Lines — salon booking

A static, no-backend booking page for a barbershop. Customers pick a barber,
services and a time, leave their details, and get a reference, calendar file and
directions. Bookings are saved on the customer's device so they can reschedule
or cancel. Optionally every booking is POSTed to a URL you choose.

## Run it locally

Any static file server works. With Node installed:

```bash
npx serve -l 5173 .
```

Then open http://localhost:5173. Opening `index.html` directly from the file
system also works for a quick look, but use a server to test the calendar
download and manifest.

## Deploy to Cloudflare (free tier)

The project ships as Cloudflare Workers static assets. One-time setup:

```bash
npx wrangler login
```

Then every deploy is:

```bash
npm run deploy
```

This copies the shippable files into `dist/`, adds security headers, and
uploads them. The first deploy prints a `*.workers.dev` URL. Preview locally
on Cloudflare's runtime with `npm run preview`.

## Deploy anywhere else

Upload the whole folder to any static host. No build step.

- **Netlify / Vercel / Cloudflare Pages**: drag-and-drop the folder, or point
  the site at this repo with no build command and `.` as the output directory.
- **GitHub Pages**: push to a branch and enable Pages for that branch.
- **Your own web host**: copy `index.html`, `manifest.webmanifest` and `assets/`
  to the web root.

## Customise

Everything a shop owner changes lives in one file:
[`assets/js/config.js`](assets/js/config.js).

| Setting | What it does |
| --- | --- |
| `name`, `suburb`, `tagline`, `blurb` | Shop name and copy on the home screen |
| `address`, `phone`, `phoneDisplay` | Used for directions, the calendar entry and tap-to-call |
| `hours` | Opening hours per weekday. `null` marks a closed day |
| `slotMinutes`, `leadMinutes`, `daysAhead` | Slot spacing, same-day notice, booking horizon |
| `cancelHours` | Free cancellation window shown in copy |
| `paymentNote` | Payment copy on the details step |
| `bookingEndpoint` | Optional URL that receives each booking as JSON |
| `images` | Hero, desktop rail and gallery photos |
| `barbers` | Staff, starting prices, days off, photos |
| `services` | Menu, durations, price multipliers, photos |

### Photos

Images are Unsplash photos resized on the fly. To use your own, put the files in
`assets/img/` and replace an entry's `id` with `src: "assets/img/file.jpg"`.

### Receiving bookings

Set `bookingEndpoint` to a URL that accepts a JSON POST, such as a Formspree
form, a Make or Zapier webhook, or your own API. The payload includes an
`event` field (`booking.created`, `booking.rescheduled`, `booking.cancelled`),
the reference, date, start time (24h decimal), services, barber, customer
details and notes. If the request fails the booking is still saved on the
device and the customer is told to call.

### Availability

Availability is generated locally: a deterministic set of busy blocks per barber
per day, plus anything already booked on this device. To use real availability,
replace `busyBlocks()` in [`assets/js/app.js`](assets/js/app.js) with a call to
your booking system.

### Taking a card hold

This build takes no payment online. To hold a card with Stripe, mount Stripe
Elements into the `#card-mount` container in `index.html` and add a server
endpoint that creates a SetupIntent.

## Files

```
index.html               page shell
manifest.webmanifest     add-to-home-screen metadata
assets/icon.svg          favicon and app icon
assets/css/styles.css    styles, mobile first with a desktop split layout
assets/js/config.js      shop configuration
assets/js/app.js         booking logic
barbershop-booking-new.html   original single-file prototype, kept for reference
```
