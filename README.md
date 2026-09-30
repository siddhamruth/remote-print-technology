# remote-print-kit

**How to let a stranger on the internet print to your printer, privately, for exactly 15 minutes, only after they've paid.**

This is the reference architecture behind [shhhh.in](https://shhhh.in), a private photo and document printing service in India. Customers book a 15-minute window on a physical Epson EcoTank printer, pay, and press **PRINT** themselves from their browser. Their files never touch a disk, and no staff member ever opens them.

## Your photos never touch our disk

| Data | Where it goes | How long |
|---|---|---|
| **Your photos** | Browser → our server's **memory** (one HTTPS request per photo) → Epson Connect → printer | Our server keeps them only for the length of the upload request. Nothing is written to disk, a database, logs or backups |
| Print job ID + status (`completed`) | Our database (`PrintJob` table: ids and status only, **no image column exists**) | With the order |
| Name, email, phone, address | Our database, to ship the prints | **Erased automatically 24 h after delivery** (`src/privacy/erase.js`) |
| Payment | Cashfree (the card/UPI details never reach us) | Cashfree's own retention, required by law |

**Check it yourself in this repo:**
- [`prisma/schema.prisma`](prisma/schema.prisma) has no column that could hold an image.
- [`examples/nextjs/app/api/sessions/[token]/files/[index]/route.js`](examples/nextjs/app/api/sessions/%5Btoken%5D/files/%5Bindex%5D/route.js) reads the upload into a `Buffer`, hands it to Epson, and returns. There are no `fs` writes, temp files or storage buckets.
- [`src/browser/render.js`](src/browser/render.js) applies your edits (brightness, contrast, rotation, flip) **in your browser** before anything is sent.

What we can't promise away: Epson's cloud receives each file in order to print it (under Epson's privacy policy), and printed photos are physical objects that a person packs. They are handled face-down and mailed in a plain, opaque cover.

Everything that carries risk is here as small, tested modules:

| Module | What it does |
|---|---|
| [`src/epson/client.js`](src/epson/client.js) | Epson Connect API v2 client: OAuth device token, auto-refresh, create job, upload, print, cancel, and status |
| [`src/lease/slots.js`](src/lease/slots.js) | 15-minute hardware lease. Hold, book, and release are each **one atomic SQL update**, with correct IST handling |
| [`src/payments/cashfree.js`](src/payments/cashfree.js) | Cashfree PG: order creation, server-side verification, timing-safe webhook signature check, amount check |
| [`src/session/print-session.js`](src/session/print-session.js) | Time-boxed, hashed print tokens and an atomic "print exactly once" claim |
| [`src/browser/render.js`](src/browser/render.js) | Bakes brightness, contrast, rotation, and flip into real pixels on a canvas before upload. Also composes the 3×4 in retro print on 4×6 in paper at 300 DPI |
| [`src/privacy/erase.js`](src/privacy/erase.js) | Scheduled PII erasure after delivery |
| [`prisma/schema.prisma`](prisma/schema.prisma) | Data model (PostgreSQL, `timestamptz` everywhere) |
| [`examples/nextjs/`](examples/nextjs) | Next.js App Router route handlers and a scheduler that wire it all together |

No runtime dependencies in `src/` (Node ≥ 20 built-ins only). `npm test` runs the unit tests with `node:test`.

---

## How remote printing works

```
 Customer browser                 Your server (Next.js)               Epson cloud              Printer (at your lab)
 ────────────────                 ─────────────────────               ───────────              ─────────────────────
 pick product + slot ──POST /orders──▶ create order + HOLD slot (10 min)
 pay ─────────────────────────────────▶ Cashfree ◀── verify / signed webhook
                                       order PAID, slot BOOKED
                           (slot start) scheduler opens session,
 ◀──────── email: /session/<token> ──── token valid only for [start, end)
 choose photos, edit
 canvas → JPEG (in browser)
 PUT /files/0..N-1 ──────────────────▶ per photo: createJob ─────────▶ jobId + uploadUri
                                       relay bytes (RAM only) ────────▶ upload (≤20 MB)
 press PRINT ──POST /print───────────▶ claim print (once, atomic)
                                       print(jobId) × N ──────────────▶ queue ─────────────▶ prints
 poll GET /status ───────────────────▶ getJob × N ◀──────────────────── status
                                       completed → pack → ship → erase PII after 24 h
```

### 1. The printer is a cloud device (Epson Connect)
Epson EcoTank and WorkForce printers can register with **Epson Connect**. Its API v2 exposes the printer over HTTPS, so your server never needs to be on the same network as the printer. The printer can sit behind a home or lab router with no port forwarding.

- **Auth:** OAuth 2.0 authorization code grant, `scope=device`. You authorize **once** as the printer owner and get a **device token** (about 1 h) plus a refresh token. Every call sends `Authorization: Bearer <device token>` and `x-api-key: <app key>`.
- **One job = one file.** `POST /printing/jobs` returns `{ jobId, uploadUri }`. You upload a single file to `uploadUri&File=1.jpg` (JPEG, PNG, or PDF, max 20 MB), then `POST /printing/jobs/{jobId}/print`. To print N photos, create N jobs or merge them into one multi-page PDF.
- **Status** (`GET /printing/jobs/{jobId}`): `preparing`, `pending`, `processing`, and then `completed`, or one of `error_occurred`, `canceled`, `expired`. `media_empty`, `media_jam`, `marker_supply_empty`, and `stopped_other` mean someone needs to go to the printer; alert your operator.
- **Print settings** follow Epson's appendix values: `paperSize: ps_kg` (4×6) or `ps_a4`, `paperType: pt_photopaper | pt_matte | pt_plain`, `borderless`, `printQuality: high`, `paperSource: rear`. Check your model's supported values with `GET /printing/capability/{photo|document}`.

### 2. The printer is leased, not queued
The day is split into fixed windows (default 10:00–21:00 IST, 15 min each, 44 per day). A slot is **free**, **held** (checkout in progress, 10 min), or **booked** (paid). Each transition is a single conditional `UPDATE … WHERE` that returns a row count, so two people can't both win a slot, even under concurrent load:

```js
const { count } = await tx.slot.updateMany({
  where: { id, isAvailable: true, startsAt: { gt: now }, OR: [{ heldUntil: null }, { heldUntil: { lt: now } }] },
  data: { heldUntil: in10min, heldByOrderId: orderId },
});
if (count !== 1) throw new SlotUnavailableError(); // 409
```

A payment that arrives after the hold expired and someone else booked the slot is marked `SLOT_LOST` (refund or rebook), never double-booked.

### 3. Money is verified server-to-server
The browser never tells you an order is paid. Only these two paths can set `PAID`, and both call `settlePayment()`, which **asks Cashfree's API** and checks the amount:
- the return URL hitting `POST /orders/:id/verify`, and
- a webhook whose `x-webhook-signature` (base64 HMAC-SHA256 of `timestamp + rawBody`) is valid and less than 5 minutes old. A webhook **without** the headers is rejected.

`ACTIVE` (the customer is still on the payment page) keeps the hold. It is not treated as a failure.

### 4. The print session is a short-lived capability
When the slot starts, a scheduler creates a session with a 256-bit random token and emails a link. Only the **SHA-256 hash** is stored. The token:
- works only between `slot.startsAt` and `slot.endsAt`,
- allows `quantity` uploads, and
- allows **exactly one** print, claimed atomically (`printClaimedAt IS NULL` → now).

Job IDs come from the database. The server never trusts a `jobId` sent by the browser.

### 5. Files: browser → RAM → Epson → paper
1. The browser renders each edited photo to a canvas and exports a JPEG. CSS filters change only the preview, so without this step the print won't match what the customer saw.
2. The browser `PUT`s each JPEG to `/api/sessions/:token/files/:i`.
3. The server holds the bytes **in memory** (≤ 20 MB), creates an Epson job, and uploads them. Nothing is written to disk. The Epson `uploadUri` is a bearer capability, so it never reaches the browser.
4. On **PRINT**, the server sends `print` for every job.

> Why relay instead of uploading straight from the browser to `upload.epsonconnect.com`? A cross-origin `POST` with `Content-Type: image/jpeg` needs a CORS preflight. Relaying works whatever CORS policy Epson sets, lets you validate size and type, and keeps the upload key private. The cost is that the bytes pass through your server's RAM.

### 6. Privacy after printing
`erasePiiAfterDelivery()` runs on a schedule and nulls out name, email, phone, and address 24 h after `deliveredAt`. Be honest in your policy: **your payment gateway and courier keep their own records** as required by law. Keep analytics and session-replay scripts (GA, Clarity, Hotjar) **off** any page whose URL carries a token or that shows PII.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Web + API | **Next.js (App Router)** route handlers, Node runtime | One deployable for pages and API. Route handlers expose Web `Request`/`Response` |
| DB | **PostgreSQL 16** + **Prisma 7** (`@prisma/adapter-pg`) | Row-level atomic updates for the lease; `timestamptz` |
| Printing | **Epson Connect API v2** + an EcoTank photo printer (e.g. L8050, 6-colour, borderless 4×6/A4) | Cloud printing with no inbound network access to the printer |
| Payments | **Cashfree PG** (API `2023-08-01`), hosted checkout via `@cashfreepayments/cashfree-js` | UPI, cards, and netbanking for India |
| Email | Any SMTP (e.g. Zoho) via `nodemailer` | Booking confirmation and session link |
| Scheduler | A plain Node loop under **PM2** or a systemd timer | Opens sessions, expires missed slots, erases PII |
| Hosting | A single VPS behind Nginx (TLS, `limit_req` rate limits) | Enough for one printer; scale per printer node |
| Styling (site) | Tailwind CSS, lucide-react | n/a |

---

## Getting started

```bash
git clone https://github.com/siddhamruth/remote-print-kit && cd remote-print-kit
npm test                     # unit tests, no network or DB needed
cp .env.example .env         # fill in Epson + Cashfree sandbox keys
```

To use it in a Next.js app:
1. Copy `prisma/schema.prisma` (or merge its models) and run `npx prisma db push`.
2. Copy the route handlers from `examples/nextjs/app/api/**` and `examples/nextjs/lib/*`, and fix the relative import paths to where you put `src/`.
3. Seed slots with `generateDaySlots('2026-10-01')` → `prisma.slot.createMany`.
4. Authorize the printer once: open `https://your.site/api/epson/auth/start` in a browser, enter `ADMIN_SECRET`, and log in to Epson with the account that owns the printer. Register the same URL's `/api/epson/callback` as the redirect URI in the Epson developer console. Set `EPSON_EXPECTED_SERIAL` so a token for any other printer is refused.
5. Run `examples/nextjs/scripts/scheduler.js` under PM2 next to the app.

> The same design runs in production at shhhh.in: its print session was verified end to end in a real browser (two photos → two jobs → completed). The `examples/` handlers are reference code showing how the modules fit together. They're kept deliberately small and aren't a full app (no UI, email, or shipping). The modules in `src/` are unit-tested. The route handlers are not integration-tested here.

---

## Security checklist (read before going live)

- [ ] `/api/epson/auth/*` requires admin auth **and** a verified OAuth `state`. Pin `EPSON_EXPECTED_SERIAL`. Otherwise an attacker can bind *their* printer and receive your customers' files.
- [ ] No "simulate payment" path reachable in production. `PAID` is set only from Cashfree's API response.
- [ ] Webhook: reject missing signature headers; `timingSafeEqual`; reject timestamps older than 5 minutes.
- [ ] Order lookup never returns an access token. Send a magic link to the email on file.
- [ ] Session: time window enforced server-side; one print per session; job IDs from the DB only.
- [ ] Every upload response is checked. A failed upload must never lead to `print`.
- [ ] All slot times stored as UTC instants. Don't rely on the server's local timezone.
- [ ] No analytics or session replay on `/order/*` or `/session/*`. Tokens in URLs leak to third parties.
- [ ] Escape all user input in emails and HTML responses.
- [ ] Rate-limit order creation, lookup, and contact endpoints.
- [ ] Epson device and refresh tokens stored like passwords (DB or a `0600` file, never in git). Epson **rotates the refresh token on every refresh** (and it expires after 30 days unused). If more than one process can refresh, re-read the store before refreshing, or you'll wipe a newer token.
- [ ] Nginx `client_max_body_size 25m`. The default of 1 MB silently breaks photo uploads.
- [ ] A staff session cookie used on the OAuth callback must be `SameSite=Lax`, not `Strict`. The callback is a cross-site redirect from Epson, and a Strict cookie is not sent on it.

## License
MIT
