# Booxs

Your private bookshelf: an iPhone-friendly PWA that scans ISBN barcodes, checks saved books, and tracks ownership and reading independently.

- **Ownership:** Neither / Want to buy / Owned.
- **Reading:** Unread / Reading / Finished.
- Manual entry, Open Library search and ISBN lookup, editing, and confirmed deletion.
- Exact ISBN matching with ISBN-10 → ISBN-13 normalization and duplicate prevention. Editions stay separate.
- Offline scanning and search against the last downloaded library. Writes require internet.
- React + TypeScript, one Cloudflare Worker, D1, and a private email/password login. No Cloudflare Access or Zero Trust subscription is used.

## Local development

Use **Node 24** (`.nvmrc`), then:

```sh
npm ci
npm run dev
```

Open the URL printed by Wrangler, normally **http://localhost:8787**. This builds the PWA, applies SQL migrations to a local database, and starts the Worker. Local data stays in ignored `.wrangler/` storage. No production credentials are needed.

The local identity is enabled only by the `local` Wrangler environment **and** a loopback request hostname, with no `OWNER_PASSWORD_HASH` configured. Production never enables it. Don't expose the local server through a public tunnel. To test real sign-in locally, put `OWNER_EMAIL` and `OWNER_PASSWORD_HASH` in the ignored `.dev.vars.local` file and restart the Worker.

For frontend hot reload, keep the Worker running and start `npm run dev:ui` in a second terminal. Vite proxies `/api` to port 8787. The offline service worker is only registered in the production build served by Wrangler, so use port 8787 for offline testing.

```sh
npm run typecheck
npm test
npm run build
```

Tests cover ISBN checksums, all nine state combinations, D1-backed CRUD, duplicate handling, manual books without ISBN, input validation, salted password hashing, invalid credentials, session expiry/rotation/revocation, brute-force throttling, and cross-origin writes. They run without a Cloudflare account or live metadata requests.

The original `backend/` Python prototype is retained as reference. It is not part of the app build or deployment; Python is no longer required.

## Cloudflare deployment

Use **Workers Free** and **D1 Free**. Authentication runs inside Booxs, so the Zero Trust activation/payment-details step is unnecessary. Stay on the free plans; check current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

1. Sign in and create the database:

   ```sh
   npx wrangler login
   npx wrangler d1 create booxs
   ```

   Keep the returned `database_id`. Select your account's `workers.dev` subdomain in the Cloudflare dashboard. The app's hostname will be `booxs.YOUR-SUBDOMAIN.workers.dev`.

2. Generate a hash for a separate Booxs password or passphrase:

   ```sh
   npm run auth:password
   ```

   Enter and confirm at least 16 characters. Input is hidden; the command prints only the salted hash. Save your password in your password manager. Do not send it in chat or commit it. The app does not send email, register accounts, or provide a password-reset mailbox.

3. Copy `.env.example` to `.env.production` and fill in `CLOUDFLARE_D1_DATABASE_ID`, `OWNER_EMAIL`, and `OWNER_PASSWORD_HASH`. Keep the hash inside single quotes in this file. It is ignored by Git. Wrangler's own OAuth credentials stay outside the repository. You may instead pass these settings as environment variables.

4. Check and deploy:

   ```sh
   npm run deploy:check
   npm run deploy
   ```

   The scripts build, generate the ignored `wrangler.production.json`, apply remote migrations, upload the Worker, and upload the password verifier to encrypted Worker secret storage using stdin. Existing `pbkdf2-sha256$600000$…` build secrets are automatically converted to the current verifier format without changing the password. The generated configuration contains no password hash. On first deployment the private API rejects access until that secret is uploaded. `deploy:check` only builds and bundles locally; it does not change cloud resources.

5. Open the deployed HTTPS URL and sign in with your configured email and password. Confirm that `/api/books` returns 401 without a signed-in session. Preview URLs are disabled in the checked-in config.

### Git-connected Cloudflare builds

Under **Workers & Pages → booxs → Settings → Build**, set **Deploy command** to `npm run deploy`. Leave **Build command** empty because the deploy script builds the app. Do not use the default `npx wrangler deploy`: that bypasses configuration generation, migrations, and secret upload and would use the local placeholder D1 ID.

Add these under **Build variables and secrets**, not just runtime variables:

| Name                        | Type     | Value                                                                             |
| --------------------------- | -------- | --------------------------------------------------------------------------------- |
| `CLOUDFLARE_D1_DATABASE_ID` | Variable | Actual UUID from your D1 database's detail page                                   |
| `OWNER_EMAIL`               | Variable | The one email allowed to sign in                                                  |
| `OWNER_PASSWORD_HASH`       | Secret   | Entire output hash from `npm run auth:password` (without quotes in the dashboard) |

The build API token needs **Workers Scripts: Edit** and **D1: Edit** in your account to upload the Worker/secret and apply migrations. Keep the token in Cloudflare; do not paste it into source files. Remove the obsolete `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `BOOXS_ACCESS_CONFIGURED` build settings. If you previously configured an Access gate, remove that obsolete application gate so requests reach the Booxs login page.

### Authentication behavior

The browser fetches the public salt and derives a password proof using PBKDF2-HMAC-SHA256 with 600,000 iterations. It sends that proof over HTTPS; the Worker hashes it with a domain-separated SHA-256 and compares it in constant time with the encrypted Worker secret. The stored verifier cannot itself be submitted to sign in. This keeps the slow calculation off Workers Free, whose production runtime caps PBKDF2 at 100,000 iterations even though local workerd does not enforce that cap ([Cloudflare runtime issue](https://github.com/cloudflare/workerd/issues/1346)). The password and proof stay in memory only. The current secret format is `pbkdf2-sha256-v2$600000$salt$verifier`; the deploy script upgrades legacy build secrets automatically without needing the password.

The correct proof is accepted only for `OWNER_EMAIL`. Five sign-in attempts per minute across the application are enforced atomically in D1; rejected attempts return 429 and `Retry-After`. This global throttle deliberately trades one minute of possible lockout for a strict limit on distributed guesses.

Sessions use random 256-bit tokens in a `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` cookie. Only token hashes are stored in D1. Sessions expire after 30 days. Signing out revokes the current session server-side; changing the owner email or password hash invalidates all previous sessions. To reset the password, generate a new hash, update the build secret, and redeploy. Book data remains intact.

The static app shell and login page are public and contain no personal data. All book/metadata APIs require a valid session; the salt/work-factor GET and same-origin sign-in/logout POST endpoints are unauthenticated. No signup is exposed. Passwords, proofs, and session tokens are never written to IndexedDB/localStorage or application logs. API responses use `Cache-Control: no-store`.

## iPhone and offline use

1. Open the deployed **HTTPS** URL in Safari and sign in with your email and Booxs password.
2. Tap **Share → Add to Home Screen**, then open Booxs from its icon.
3. Open the app online once and allow its offline files to download. Books are refreshed on authenticated launch, reconnect, manual refresh, and after changes.
4. In **Scan**, tap **Start camera** and allow camera access. Aim at the book's EAN-13 barcode (ISBN beginning 978 or 979). Camera frames stay on the device. You can always type an ISBN instead.

The scanner decoder is bundled and downloaded ahead of time, so scanning works offline without a native `BarcodeDetector`. The camera stops after a successful scan, on leaving the screen, or when the app is backgrounded. Camera autofocus and physical barcode scanning still need validation on your actual iPhone; desktop WebKit cannot substitute for this.

The service worker caches only app assets. Personal book data is stored separately in IndexedDB on that device. Offline misses say **Not found in downloaded library** and show the last successful full sync time. Metadata lookup and all changes are unavailable offline; there is no deferred write queue. Browser storage can be cleared or evicted: if the offline copy is missing, reconnect to download it again.

**Sign out & clear offline books** revokes the current session and clears local books, app caches, and the service worker. If offline, it records a pending logout first, clears and locks the local app, then revokes the old session before any later library download or new login. The pending marker contains no password or session token. Cached books remain readable on a trusted device when a session expires; edits and fresh downloads require a new sign-in. Offline access relies on your device's security.

## Book metadata

Open Library is the primary optional metadata source. For Czech/Slovak editions (ISBN registration group 80), an Open Library miss or failure falls back to the public [Knihovny.cz API](https://www.knihovny.cz/api). The fallback accepts only records whose normalized ISBN exactly matches the requested edition, preferring a dedicated print record. The catalog publisher may be the publishing company (for example, Dobrovský s.r.o.) rather than its imprint (Fobos). Metadata is optional enrichment, not the source of your personal library. A missed ISBN, provider timeout, or rate limit never prevents manual entry. Title/author search still uses Open Library and fills only title/author, because work-level search can mix editions; edition details come from an explicit ISBN lookup or manual entry. Saved fields remain editable.

After an ISBN check, the scan result displays the title, author, language, publisher, and publication year. Saved books use their library details, including offline; new editions look up metadata automatically before adding. Missing details remain marked as unavailable and can be entered manually. Language and publisher are editable and saved with the book.

Metadata is requested through the Worker with a Booxs identification header/contact email and a 24-hour public metadata cache. ISBN lookups allow six seconds per attempt. A transient Knihovny.cz network error, timeout, or HTTP 429/500/502/503/504 is retried once; `Retry-After` is honored, and a requested pause longer than two seconds leaves retrying to the user. The ISBN client allows 25 seconds for both sources and this retry; title/author search allows eight seconds per provider request. Failed requests are not cached. Errors distinguish timeouts, rate limits, access denial, and service failures, and the scan result offers **Retry book details** while keeping manual entry available. Worker logs record only the failed provider, status, and failure type. Personal states never enter the public metadata cache or provider diagnostics. Searches are submitted explicitly, not on every keystroke. Knihovny.cz needs no API key for these public lookups. Follow [Open Library's usage guidelines](https://openlibrary.org/developers/api), including registering the application if required by its current policy.

## API

Book endpoints require authentication. `PATCH` accepts the full editable book payload, with the same validation and defaults as `POST`. GET `/api/auth/parameters` returns the public `{ salt, iterations }`. Same-origin POST `/api/auth/login` accepts `{ email, passwordProof }` (the 64-character lowercase hex PBKDF2 result) and sets the session cookie; POST `/api/auth/logout` revokes that session and expires the cookie. Raw passwords are not sent to the API.

| Method | Route                       | Result                                                                 |
| ------ | --------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/health`               | Authenticated health check                                             |
| GET    | `/api/books`                | `{ books, syncedAt }`, newest updated first; complete offline snapshot |
| POST   | `/api/books`                | Created book (201); duplicate ISBN returns existing `book` (409)       |
| GET    | `/api/books/:id`            | One book, or 404                                                       |
| PATCH  | `/api/books/:id`            | Updated book                                                           |
| DELETE | `/api/books/:id`            | `{ deleted: id }`, or 404                                              |
| GET    | `/api/books/isbn?isbn=…`    | `{ book }`, null when absent                                           |
| GET    | `/api/metadata/isbn?isbn=…` | `{ book }` with optional Open Library / Knihovny.cz details            |
| GET    | `/api/metadata/search?q=…`  | `{ items }`, up to eight title/author results                          |

```json
{
  "title": "Matilda",
  "author": "Roald Dahl",
  "language": "English",
  "publisher": "Puffin",
  "isbn": "9780140328721",
  "published_year": 1988,
  "ownership": "want_to_buy",
  "reading": "finished"
}
```

Title is required; author, language, publisher, ISBN, and year are optional. Allowed ownership values are `neither`, `want_to_buy`, `owned`; reading values are `unread`, `reading`, `finished`. Responses add a UUID `id` and UTC `created_at` / `updated_at` timestamps. D1 enforces valid state values and unique non-null ISBNs as well as server validation.

## Before calling the release verified

- Automated tests, type check, and production build pass.
- Browser: add/edit/delete, duplicate ISBN, all filters, metadata not found/provider failure, denied camera permission, known/unknown barcode fixtures, offline cold reload, and reconnect.
- Authentication: signed-out/forged/expired/revoked sessions, wrong owner/password, cross-origin requests, throttling, offline logout/reconnect, and password rotation.
- Real iPhone: rear camera autofocus, live book barcode scan, camera cleanup after backgrounding, home-screen installation, and offline reopening.

D1 provides point-in-time recovery (currently seven days on Free); review its dashboard before any manual production data operation. No existing local book database was found during this implementation, so the initial cloud library starts empty.
