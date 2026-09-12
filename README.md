# Faded Lines — salon booking

A barbershop booking site that runs entirely on Cloudflare's free tier.

- **Front end**: static HTML, CSS and JavaScript. Customers pick a barber,
  services and a time, leave their details, and get a reference, calendar file
  and directions. They can reschedule or cancel from the same device.
- **API**: a Cloudflare Worker backed by a D1 (SQLite) database. Availability
  is shared across every device and the database refuses double bookings.
- **Owner page** at `/admin`: see the day's bookings with the customer's photos
  and requested look, cancel one, add after photos, and block out time (lunch,
  holidays) per barber.
- **Photos and video**: customers can add photos of their hair, or a short video
  walked around their head, when booking. After the visit, the customer or the
  shop adds after photos or video to the same booking. Files live in Cloudflare
  R2 behind unguessable links.
- **AI look advisor**: from the photos plus a description of what they want,
  Claude suggests two or three looks that suit them, maps each to the shop's
  services and price, and names the barber whose skills fit. One tap books that
  barber with those services, and the barber sees the chosen look on the day.

If the API is unreachable, or `api: false` is set in the config, the page runs
in demo mode: availability is simulated and bookings stay in the browser.

## Run locally

Requires Node 18 or newer.

```bash
npm install
```

```bash
npm run dev
```

This builds `dist/`, creates a local D1 database with the schema, and starts
the Worker on http://localhost:8787 with the site, the API and `/admin`.
To use the owner page locally, create a file named `.dev.vars` containing
`ADMIN_TOKEN=anything-you-like` and restart `npm run dev`.

For a front-end-only look without the API, `npm run static` serves the folder
on http://localhost:5173 in demo mode.

## Deploy to Cloudflare (free tier)

One-time setup, run from this folder:

1. Log in. Opens a browser tab to authorise Wrangler.
   ```bash
   npx wrangler login
   ```
2. Create the database and copy the `database_id` it prints into
   [`wrangler.jsonc`](wrangler.jsonc), replacing the zeros.
   ```bash
   npx wrangler d1 create salon-appointment
   ```
3. Create the tables.
   ```bash
   npm run db:init
   ```
4. Create the bucket for photos and video.
   ```bash
   npx wrangler r2 bucket create salon-media
   ```
5. Set the owner password for `/admin`. You'll be prompted to paste a value.
   Pick something long.
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   ```
6. Set the Anthropic API key for the look advisor. Get one at
   console.anthropic.com. Skip this and the advisor button disappears
   gracefully with a "not set up yet" message.
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
7. Deploy. The first run may ask you to register a `workers.dev` subdomain.
   ```bash
   npm run deploy
   ```

### Automatic deploys from GitHub

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys on every
push to `main`. It needs two repository secrets, set under Settings, Secrets
and variables, Actions:

- `CLOUDFLARE_ACCOUNT_ID`: shown in the Cloudflare dashboard sidebar.
- `CLOUDFLARE_API_TOKEN`: create one at dash.cloudflare.com/profile/api-tokens
  from the "Edit Cloudflare Workers" template, then add D1 Edit and R2 Edit
  permissions.

The one-time steps above (create the database, bucket and secrets, paste the
database id) still happen once from your machine. After that, pushing is
deploying. The workflow re-applies the schema each run, which is harmless.

If you deployed before photos and the advisor were added, run the migration
once instead of `db:init`:
`npx wrangler d1 execute salon-appointment --remote --file=worker/migrations/002_media_ai.sql`

Photos are personal data. In the Cloudflare dashboard, add an R2 lifecycle rule
on `salon-media` to delete objects after, say, 90 days, and say so in the
`media.note` copy in the config.

Every later deploy is just `npm run deploy`. The URL is printed at the end and
looks like `https://salon-appointment.<your-subdomain>.workers.dev`.

Optional: to get a message for every booking, set a webhook URL (Slack, Make,
Zapier, your own server) with `npx wrangler secret put NOTIFY_WEBHOOK`. The
Worker posts JSON with an `event` of `booking.created`, `booking.rescheduled`
or `booking.cancelled`, a one-line `text` summary, and the booking fields.

## Customise

Everything a shop owner changes lives in one file:
[`assets/js/config.js`](assets/js/config.js). The Worker reads the same file, so
prices, hours and staff stay in sync between the page and the API. Redeploy
after editing.

| Setting | What it does |
| --- | --- |
| `name`, `suburb`, `tagline`, `blurb` | Shop name and copy on the home screen |
| `address`, `phone`, `phoneDisplay`, `timezone` | Directions, calendar entries, tap-to-call, and what "today" means |
| `whatsapp`, `whatsappMessage` | WhatsApp number (digits only, with country code) for the enquiry buttons, and the pre-filled opening line. Leave the number empty to hide them |
| `images.beforeAfter` | Before-and-after photo pairs with captions, shown on the home screen with a drag-to-compare slider |
| `hours` | Opening hours per weekday. `null` marks a closed day |
| `slotMinutes`, `leadMinutes`, `daysAhead` | Slot spacing, same-day notice, booking horizon |
| `cancelHours` | Free cancellation window shown in copy |
| `paymentNote` | Payment copy on the details step |
| `api` | `true` to use the Worker and D1, `false` for the static demo |
| `media` | Upload size limits and the privacy note shown next to the uploader |
| `ai` | Turn the advisor on or off, how many photos it looks at, and hourly and daily call caps |
| `barbers[].skills` | What each barber is best at. The advisor uses these to match a look to a barber |
| `images` | Hero, desktop rail and gallery photos |
| `barbers` | Staff, starting prices, days off, photos |
| `services` | Menu, durations, price multipliers, photos |

### Photos

Images are Unsplash photos resized on the fly. To use your own, put the files in
`assets/img/` and replace an entry's `id` with `src: "assets/img/file.jpg"`.

### Taking a card hold

This build takes no payment online. To hold a card with Stripe, mount Stripe
Elements into the `#card-mount` container in `index.html` and add a Worker
route that creates a SetupIntent.

## API

All responses are JSON. Errors are `{ "error": "message" }` with a 4xx status.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/availability?from=&to=` | Busy blocks per day per barber |
| POST | `/api/bookings` | Create. Body: `barberId`, `services[]`, `date`, `time`, `name`, `phone`, `email`, `notes` |
| GET | `/api/bookings/:ref` | Read one |
| PATCH | `/api/bookings/:ref` | Reschedule. Body: `date`, `time` |
| DELETE | `/api/bookings/:ref` | Cancel |
| POST | `/api/bookings/:ref/media` | Attach uploads. Body: `kind` (`before` or `after`), `ids[]` |
| POST | `/api/uploads?kind=before` | Upload one photo or video as the raw request body with its content type. Returns `id` and `url` |
| GET | `/api/media/:id` | Serve a stored photo or video. Supports range requests for video |
| POST | `/api/advice` | AI look suggestions. Body: `photoIds[]`, `description`. Rate limited per visitor and per day |
| GET | `/api/admin/bookings?date=` | Owner: day list. Header `Authorization: Bearer <ADMIN_TOKEN>` |
| POST | `/api/admin/blocks` | Owner: block time. Body: `barberId`, `date`, `start`, `end`, `reason` |
| DELETE | `/api/admin/blocks/:id` | Owner: remove a block |

Times are hours in 24-hour decimal in the shop's timezone, so 13.25 is 1:15pm.
Creating or moving a booking is a single conditional insert or update, so two
customers racing for the same slot can never both succeed. "Any barber" is
assigned server-side to the first free barber and priced at that barber's rate.

## Files

```
index.html               customer booking page
admin.html               owner page (served at /admin)
manifest.webmanifest     add-to-home-screen metadata
assets/icon.svg          favicon and app icon
assets/css/styles.css    styles, mobile first with a desktop split layout
assets/js/config.js      shop configuration, shared by page and Worker
assets/js/app.js         booking logic
worker/index.js          Cloudflare Worker API
worker/schema.sql        D1 tables
scripts/build.mjs        copies shippable files into dist/ with security headers
wrangler.jsonc           Cloudflare config: assets, D1 binding
barbershop-booking-new.html   original single-file prototype, kept for reference
```
