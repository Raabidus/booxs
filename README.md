# Booxs

Your private bookshelf: an iPhone-friendly PWA that scans ISBN barcodes, checks saved books, and tracks ownership and reading independently.

- **Ownership:** Neither / Want to buy / Owned.
- **Reading:** Unread / Reading / Finished.
- Manual entry, Open Library search and ISBN lookup, editing, and confirmed deletion.
- Exact ISBN matching with ISBN-10 → ISBN-13 normalization and duplicate prevention. Editions stay separate.
- Offline scanning and search against the last downloaded library. Writes require internet.
- React + TypeScript, one Cloudflare Worker, D1, and Cloudflare Access email login. No paid service or custom domain is required for the intended personal use.

## Local development

Use **Node 24** (`.nvmrc`), then:

```sh
npm ci
npm run dev
```

Open the URL printed by Wrangler, normally **http://localhost:8787**. This builds the PWA, applies SQL migrations to a local database, and starts the Worker. Local data stays in ignored `.wrangler/` storage. No production credentials are needed.

The local identity is enabled only by the `local` Wrangler environment **and** a loopback request hostname. Production never enables it. Don't expose the local server through a public tunnel.

For frontend hot reload, keep the Worker running and start `npm run dev:ui` in a second terminal. Vite proxies `/api` to port 8787. The offline service worker is only registered in the production build served by Wrangler, so use port 8787 for offline testing.

```sh
npm run typecheck
npm test
npm run build
```

Tests cover ISBN checksums, all nine state combinations, D1-backed CRUD, duplicate handling, manual books without ISBN, input validation, cross-origin writes, and missing/expired/forged/wrong-owner/wrong-audience Access tokens. They run without a Cloudflare account or live metadata requests.

The original `backend/` Python prototype is retained as reference. It is not part of the app build or deployment; Python is no longer required.

## Cloudflare deployment

Use a Cloudflare **Workers Free** account and **Zero Trust Free**. Stay on these plans; quota exhaustion returns errors rather than requiring a paid service. Cloudflare can change its quotas: check [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and [Access setup](https://developers.cloudflare.com/cloudflare-one/setup/).

1. Sign in and create the database:

   ```sh
   npx wrangler login
   npx wrangler d1 create booxs
   ```

   Keep the returned `database_id`. Select your account's `workers.dev` subdomain in the Cloudflare dashboard. The app's hostname will be `booxs.YOUR-SUBDOMAIN.workers.dev`.

2. **Before deploying**, set up Zero Trust and an Access **self-hosted application** for that complete hostname (all paths). Add an **Allow** policy for your exact email, not an entire email domain or Everyone. Enable **One-time PIN** as the login method. Copy the application's **AUD tag** and your `https://TEAM.cloudflareaccess.com` team URL. See [Cloudflare's Access instructions](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and [email PIN setup](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

3. Copy `.env.example` to `.env.production` and fill in the database UUID, team URL, AUD tag, and owner email. Set `BOOXS_ACCESS_CONFIGURED=true` only after completing step 2. Do not commit this file. Wrangler's own OAuth credentials stay outside the repository. You may instead pass these settings as environment variables.

4. Check and deploy:

   ```sh
   npm run deploy:check
   npm run deploy
   ```

   The scripts build, generate the ignored `wrangler.production.json`, and use the configured D1 binding. Actual deployment applies remote migrations before uploading. `deploy:check` only builds and bundles locally; it does not create or modify cloud resources.

5. After deployment, protect the **whole Worker** using its **Access** tab for production and previews, retaining the exact-email policy. Preview URLs are disabled in the checked-in config. Confirm that every configured hostname and `/api/books` requires sign-in. A request reaching the Worker without a valid Access JWT is rejected independently of the edge policy. Only then enter personal books.

No application passwords or registration database are needed. All API routes require Access. The server verifies the token signature, issuer, audience, expiration, and owner email. The static PWA shell is protected by the Access edge policy; it contains no personal data. There is no public API CORS policy. API responses use `Cache-Control: no-store`.

## iPhone and offline use

1. Open the deployed **HTTPS** URL in Safari and sign in with the emailed PIN.
2. Tap **Share → Add to Home Screen**, then open Booxs from its icon.
3. Open the app online once and allow its offline files to download. Books are refreshed on authenticated launch, reconnect, manual refresh, and after changes.
4. In **Scan**, tap **Start camera** and allow camera access. Aim at the book's EAN-13 barcode (ISBN beginning 978 or 979). Camera frames stay on the device. You can always type an ISBN instead.

The scanner decoder is bundled and downloaded ahead of time, so scanning works offline without a native `BarcodeDetector`. The camera stops after a successful scan, on leaving the screen, or when the app is backgrounded. Camera autofocus and physical barcode scanning still need validation on your actual iPhone; desktop WebKit cannot substitute for this.

The service worker caches only app assets. Personal book data is stored separately in IndexedDB on that device. Offline misses say **Not found in downloaded library** and show the last successful full sync time. Metadata lookup and all changes are unavailable offline; there is no deferred write queue. Browser storage can be cleared or evicted: if the offline copy is missing, reconnect to download it again.

**Sign out & clear offline books** clears local books, app caches, and the service worker before going to Cloudflare's logout endpoint. When offline, it clears and locks the local app; reconnect and reload to authenticate again. Offline access relies on your device's security, since a cached copy can be read without contacting the login service.

## Book metadata

Open Library is optional enrichment, not the source of your personal library. A missed ISBN, provider timeout, or rate limit never prevents manual entry. Search results fill only title/author, because work-level search can mix editions; edition ISBN/year comes from an explicit ISBN lookup or manual entry. Saved fields remain editable.

Metadata is requested through the Worker with a Booxs identification header/contact email, an eight-second timeout, and a 24-hour public metadata cache. Personal states never enter that cache. Searches are submitted explicitly, not on every keystroke. Follow [Open Library's usage guidelines](https://openlibrary.org/developers/api), including registering the application if required by its current policy.

## API

All endpoints below require authentication. `PATCH` accepts the full editable book payload, with the same validation and defaults as `POST`.

| Method | Route                       | Result                                                                 |
| ------ | --------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/health`               | Authenticated health check                                             |
| GET    | `/api/books`                | `{ books, syncedAt }`, newest updated first; complete offline snapshot |
| POST   | `/api/books`                | Created book (201); duplicate ISBN returns existing `book` (409)       |
| GET    | `/api/books/:id`            | One book, or 404                                                       |
| PATCH  | `/api/books/:id`            | Updated book                                                           |
| DELETE | `/api/books/:id`            | `{ deleted: id }`, or 404                                              |
| GET    | `/api/books/isbn?isbn=…`    | `{ book }`, null when absent                                           |
| GET    | `/api/metadata/isbn?isbn=…` | `{ book }` with optional Open Library details                          |
| GET    | `/api/metadata/search?q=…`  | `{ items }`, up to eight title/author results                          |

```json
{
  "title": "Matilda",
  "author": "Roald Dahl",
  "isbn": "9780140328721",
  "published_year": 1988,
  "ownership": "want_to_buy",
  "reading": "finished"
}
```

Title is required; author, ISBN, and year are optional. Allowed ownership values are `neither`, `want_to_buy`, `owned`; reading values are `unread`, `reading`, `finished`. Responses add a UUID `id` and UTC `created_at` / `updated_at` timestamps. D1 enforces valid state values and unique non-null ISBNs as well as server validation.

## Before calling the release verified

- Automated tests, type check, and production build pass.
- Browser: add/edit/delete, duplicate ISBN, all filters, metadata not found/provider failure, denied camera permission, known/unknown barcode fixtures, offline cold reload, and reconnect.
- Cloudflare: unauthenticated and wrong-owner requests are blocked on every hostname; no preview route bypasses Access.
- Real iPhone: rear camera autofocus, live book barcode scan, camera cleanup after backgrounding, home-screen installation, and offline reopening.

D1 provides point-in-time recovery (currently seven days on Free); review its dashboard before any manual production data operation. No existing local book database was found during this implementation, so the initial cloud library starts empty.
