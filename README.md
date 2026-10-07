# KaiZen Perfumería — API

NestJS + TypeORM + PostgreSQL backend for the `frontend-perfume-shop` storefront (KaiZen, a perfume
store in Venezuela: USD prices, BCV Bs conversion and Pago Móvil).
Phase 1: admin auth with roles, products/categories CRUD, image uploads.
Phase 2: editable site content (texts and business data) edited from the admin.
Phase 3: guest orders, the BCV exchange rate and Pago Móvil payments verified by hand.
Phase 4: a Telegram bot that sends each payment to the owner and lets her confirm or reject it.
Phase 5: customer emails ("Pedido recibido", "Consultar mi pedido") and password reset by email.

## Prerequisites

- Node.js 24+ and npm 11+
- Docker (on WSL: enable Docker Desktop → Settings → Resources → WSL integration for this distro)

## First-time setup

```bash
npm install
cp .env.example .env        # then set JWT_SECRET and SEED_ADMIN_PASSWORD
npm run db:up               # starts postgres:17 and Mailpit (docker compose)
npm run db:migrate          # runs pending TypeORM migrations (src/database/migrations)
npm run db:seed             # admin user + categories + products from the frontend mocks
npm run start:dev           # http://localhost:3000/api
```

The container publishes Postgres on host port **5440** so it does not clash with locally
installed PostgreSQL servers (5432/5433 on WSL or Windows). `DATABASE_URL` must use the same port
(`postgresql://kaizen:kaizen@localhost:5440/kaizen`). Set `POSTGRES_PORT` to use another one.

Images are stored on **Cloudinary** when all `CLOUDINARY_*` variables are set, otherwise on
**local disk** (`./uploads`, served at `/uploads`). The active driver is logged at startup.
Payment screenshots are **private**: on local disk they go to `./private-uploads` (never served
statically, gitignored); on Cloudinary they are uploaded as `type: authenticated`. Only the admin
proof endpoint can read them (see [Orders](#orders)).

## Scripts

| Script                                                                  | What it does                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `db:up` / `db:down`                                                     | Start / stop the Postgres container                          |
| `db:migrate`                                                            | Run pending migrations (`typeorm migration:run`)             |
| `db:revert`                                                             | Revert the last executed migration                           |
| `db:migration:generate -- src/database/migrations/<Name>`               | Generate a migration from entity changes                     |
| `db:migration:create -- src/database/migrations/<Name>`                 | Create an empty migration                                    |
| `db:seed`                                                               | Idempotent seed (`src/database/seeds/seed.ts`, run with tsx) |
| `db:reset`                                                              | Drop the schema, run all migrations and seed                 |
| `build`, `start:dev`, `lint`, `format`, `typecheck`, `test`, `test:e2e` | Usual Nest tasks                                             |

There is no bundled database GUI; use [DBeaver](https://dbeaver.io/) or
[pgAdmin](https://www.pgadmin.org/) with the `DATABASE_URL` credentials.

## Migrations

The schema is owned by migrations in `src/database/migrations`. The CLI uses
`src/database/data-source.ts` (reads `DATABASE_URL` from `.env`) and runs through `tsx`.

1. Change an entity (`src/**/entities/*.entity.ts`). Always give columns an explicit `type`.
2. Generate a migration: `npm run db:migration:generate -- src/database/migrations/AddProductSku`
3. Review the generated SQL (and its `down()`) before committing it.
4. Apply it: `npm run db:migrate` (production: run the same command before starting the app).

**Never enable `synchronize`.** It is hard-coded to `false` (and `migrationsRun` to `false`)
in `src/database/database.options.ts`; `synchronize` can silently drop columns and data.

**Text lengths.** Every single-line field (text, email, search, tel inputs) accepts at most
100 characters (`TEXT_INPUT_MAX_LENGTH`, `@MaxInputLength` in `src/common/validation/text-limits.ts`),
and its column is `varchar(100)`. Multi-line fields keep their own limit, enforced by the DTO and a
`char_length` CHECK: product description 4000, category description 1000, order notes 300,
brand description 1000, rejection reason 500, internal notes 1000. `products.highlights` holds at most 6
items of up to 100 characters (CHECKs through `max_text_array_item_length(text[])`). Site content is
jsonb, so its limits live only in the content DTOs.

Date/time columns use `timestamptz`. Plain `timestamp` has no zone, and node-postgres reads it as
the Node process's local time, which shifts values on any host that is not on UTC.

## Producción

Single VPS: Docker Compose with Caddy as the only reverse proxy in front of one API instance,
the storefront on Cloudflare Pages. With `NODE_ENV=production` the API refuses to start unless:
`PUBLIC_API_URL` and `PUBLIC_SITE_URL` are public `https://` URLs (no localhost), `CORS_ORIGIN`
has no localhost origin, every `CLOUDINARY_*` variable is set (no local-disk images in
production), `MAIL_DRIVER` is `resend` (or `smtp` with a non-local host) and, when the Telegram
bot runs in webhook mode, `TELEGRAM_WEBHOOK_SECRET` is set. Every missing item is listed at once.

`TRUST_PROXY` (Express `trust proxy`) defaults to `1` in production (one hop: Caddy) and off
elsewhere. It must match the number of proxies in front of the API, or `req.ip` (and so the
per-IP rate limits) is wrong: too low and every customer shares Caddy's address; too high and a
client can spoof its IP with `X-Forwarded-For`. Accepts a hop count, `false`, or names/CIDRs
(`loopback`, `172.16.0.0/12`); `true` is refused.

`GET /api/health` runs `SELECT 1` (2 s timeout): `200 { status: 'ok', database: 'up' }`, or `503`
when the database is down. It is not rate-limited.

After `npm ci && npm run build` (the runtime image only needs `npm ci --omit=dev` and `dist/`):

```bash
npm run migration:run:prod     # node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
# First ADMIN of an empty database (no demo data; does nothing if an active ADMIN exists).
# The password is asked for (hidden) or read from ADMIN_PASSWORD.
node dist/cli/create-admin.js --email duena@tudominio.com --name "Dueña"
npm run start:prod
```

Both read `DATABASE_URL` from the environment (or a `.env` file; `dotenv` is a runtime
dependency). Never run `db:seed` in production: it loads the demo catalog.

### Notifications (outbox)

Customer emails ("Pedido recibido") and the Telegram order notices are written to
`outbox_messages` in the same transaction as the order change, then delivered by `OutboxWorker`
(right after the commit, and every 5 s for retries). A failed delivery is retried after 30 s,
2 min, 10 min, 1 h and then every 6 h; after 8 attempts it stays `failed`. Delivery is
at-least-once: the handlers skip what an earlier attempt already delivered (Telegram) or, at
worst, send an email twice. An advisory lock keeps the worker, the BCV sync and the order expiry
to one instance at a time. ADMIN only:

- `GET /admin/outbox?status&page&pageSize` (`status`: `pending | processing | sent | failed`)
- `POST /admin/outbox/:id/retry` → schedules a `failed` (or waiting) message now, with fresh attempts

### Docker image

The `Dockerfile` builds a two-stage image: `npm ci` + `npm run build`, then a runtime stage with
`npm ci --omit=dev` and `dist/` only, running as the unprivileged `node` user with
`NODE_ENV=production`. It exposes port 3000 (`PORT`) and has a `HEALTHCHECK` on `/api/health`
(through Node's `fetch`, no curl). No `.env` is copied into the image (see `.dockerignore`): pass
the variables at run time.

```bash
docker build -t kaizen-api .
# Migrations are not run on start: run them as a one-off container before each new version.
docker run --rm --env-file .env.production kaizen-api npm run migration:run:prod
docker run --rm --env-file .env.production kaizen-api node dist/cli/create-admin.js \
    --email duena@tudominio.com --name "Dueña"     # first ADMIN only (password from ADMIN_PASSWORD)
docker run -d --name kaizen-api --env-file .env.production -p 3000:3000 kaizen-api
```

The pool and per-connection limits are tunable with `DB_POOL_MAX` (10), `DB_STATEMENT_TIMEOUT_MS`
(5000), `DB_IDLE_TX_TIMEOUT_MS` (10000) and `DB_CONNECT_TIMEOUT_MS` (3000). They apply to the API
only: the migration CLI keeps Postgres' defaults, so long index builds are never cut off.

## Endpoints (prefix `/api`)

Public:

- `GET /health`
- `GET /products?category&search&sort&minPrice&maxPrice&tags&brand&gender&concentration&family&page&pageSize`
  → `Paginated<Product>` (`sort`: `relevance | price-asc | price-desc | newest | name-asc`, a retired
  `rating` falls back to relevance; `tags` and `brand` comma-separated or repeated; `gender`:
  `mujer | hombre | unisex`; `concentration`: `EDC | EDT | EDP | PARFUM | EXTRAIT`; `family` matches
  the olfactory family ignoring case; `pageSize` default 12, max 48; search is accent-insensitive and
  covers name, description, brand, gender, concentration, family, notes and tags)
- `GET /products/featured?limit` (`limit` 1–24, default 8): `isFeatured` products first, then by
  relevance
- `GET /products/facets?category` → `{ priceMin, priceMax, brands[{ slug, name, count }],
genders[{ value, count }], families[…], concentrations[…] }` over the active products
- `GET /brands` → active brands (`sortOrder`, then name) with `productCount` of active products
- `GET /products/:slug`
- `GET /products/:slug/related?limit` (`limit` 1–12, default 4; same category first, then the rest)
- `GET /categories` (in `sortOrder` order, with `productCount` of active products)
- `GET /content` → every site-content section (see [Site content](#site-content))

The public catalog GETs (`/products`, `/products/:slug`, `/products/facets`, `/products/featured`,
`/categories`, `/brands`, `/content`, `/exchange-rate/current`) answer with
`Cache-Control: public, max-age=60, stale-while-revalidate=300` (`@PublicCache`), so browsers and a
CDN may serve them up to a minute old. The API also keeps the category and brand lists, facets and
featured products (60 s), the site content and the current exchange rate in memory
(`src/cache`); every admin write, order stock change, content edit and rate change invalidates
what it affects (`CacheInvalidator`).

Auth (session = httpOnly cookie `kz_session`):

- `POST /auth/login` `{ email, password }` (rate-limited to 5/min) → user + `session`. The email
  is matched ignoring case. A deactivated account gets the same `401` "Correo o contraseña
  incorrectos." as a wrong password, after the same argon2 work. Records `last_login_at`.
- `POST /auth/refresh` (requires a session, rate-limited to 30/min) → re-issues the cookie; same
  body as login
- `POST /auth/logout`
- `GET /auth/me` → user + `session`
- `PATCH /auth/me` `{ name }` (any role, "Mi cuenta") → user + `session`
- `POST /auth/me/password` `{ currentPassword, newPassword }` (any role, rate-limited to 5/min) →
  user + `session` and a new cookie. A wrong current password is a `400` pinned on
  `currentPassword` (not a `401`). Every other session of the user is closed; this one stays open.

`session` is `{ expiresAt, expiresInSeconds, ttlSeconds, idleMinutes, promptSeconds }`.

### Session timeout

The admin session closes after **`SESSION_IDLE_MINUTES` (default 30) without activity**. The
admin front then shows an "extend session?" prompt with a **`SESSION_PROMPT_SECONDS` (default 30)** countdown; "Sí, continuar" calls `POST /auth/refresh`, and while the admin is working the
front refreshes the session in the background. The token and cookie last idle minutes + prompt
seconds + 60 s (`src/auth/session.config.ts`), so the server session never ends before the
prompt does. Tokens issued with a longer lifetime (e.g. the old 7-day ones) are rejected.

Admin (roles `ADMIN` or `EDITOR`; deleting products, categories or brands requires `ADMIN`):

- `GET /admin/products?search&category&isActive&page&pageSize`, `GET /admin/products/:id`
- `POST /admin/products`, `PATCH /admin/products/:id` (partial; `variants` replaces the list)
- `PATCH /admin/products/:id/active` (`{ isActive }`, or empty body to toggle)
- `DELETE /admin/products/:id` (ADMIN only)
- `POST /admin/products/:id/images` (multipart, field `files`, up to 8 JPG/PNG/WEBP, 5 MB each)
- `PATCH /admin/products/:id/images/order` `{ imageIds: string[] }`
- `DELETE /admin/products/:id/images/:imageId`
- `GET /admin/categories` (in `sortOrder` order, with `sortOrder` and `totalProductCount`: every
  product, hidden ones included)
- `POST /admin/categories` `{ name, slug?, tagline?, description?, colorHex, sortOrder? }` (`slug`
  is generated from the name when omitted and must be lowercase kebab-case; a taken slug is `409`;
  `sortOrder` defaults to after the last category; the slug `order` is reserved)
- `PATCH /admin/categories/order` `{ slugs: string[] }` → the admin list in the new order. `slugs`
  must hold every existing category slug exactly once (otherwise `400`); positions are rewritten
  as `0..n-1` in one transaction. The first three categories are the storefront's top menu.
- `PATCH /admin/categories/:slug` (`name`, `tagline`, `description`, `colorHex`, `sortOrder`; the
  slug cannot change)
- `DELETE /admin/categories/:slug` (ADMIN only; `409` while the category has any product, active
  or hidden, `204` otherwise). The `products.category_slug` foreign key is `ON DELETE RESTRICT`, so
  deleting a category can never delete its products.
- `GET /admin/brands`, `GET /admin/brands/:slug` (every brand, with `sortOrder`, `isActive` and
  `totalProductCount`)
- `POST /admin/brands`, `PATCH /admin/brands/:slug` — JSON or multipart `{ name, slug?, logoUrl?,
description?, sortOrder?, isActive? }` plus an optional `logo` image (JPG/PNG/WEBP, 2 MB), stored
  like the product photos; a new logo or `logoUrl` (null clears it) replaces an uploaded one, which
  is then deleted. The slug cannot change.
- `DELETE /admin/brands/:slug` (ADMIN only, `204`): its products stay, without a brand (`ON DELETE
SET NULL`).

Product perfume fields (create/update): `brandSlug` (or null), `gender` (`mujer | hombre | unisex`,
default `unisex`), `concentration` (`EDC | EDT | EDP | PARFUM | EXTRAIT` or null), `volumeMl`,
`notesTop` / `notesHeart` / `notesBase` (up to 12 notes of 60 characters each), `olfactoryFamily`,
`isFeatured` (+20 relevance) and a unique `sku`. Variants take an optional `volumeMl`.

## Site content

The storefront's texts and business data live in `site_content`, one row per section (`key` text
PK, `value` jsonb, `updated_at` timestamptz, `updated_by` → `users.id`, `ON DELETE SET NULL`). The
admin edits them at `/admin/contenido`.

| Section         | What it holds                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `general`       | Brand name, tagline, footer description, page-title suffix, meta description, search placeholder                                                                                                                  |
| `announcements` | Ticker messages (1–8, ordered)                                                                                                                                                                                    |
| `home`          | Hero (badge, headline, subtitle, buttons, check features), section headings and copy, steps, CTA banner, newsletter                                                                                               |
| `about`         | Badge, title, paragraphs, button, values (icon/title/description), stats                                                                                                                                          |
| `contact`       | Email, phone and WhatsApp (`0412-5550134`), city, schedule, Instagram/TikTok handles                                                                                                                              |
| `contactPage`   | Contact page header and FAQ                                                                                                                                                                                       |
| `shipping`      | Free-shipping threshold and flat rate (USD), free-shipping and production copy                                                                                                                                    |
| `payment`       | Pago Móvil: bank code + name, phone, cédula/RIF, holder, instructions. Shown on the customer's order page; while any field but the instructions is empty, `POST /orders` answers `503 PAYMENT_METHOD_UNAVAILABLE` |

- **Defaults live in code** (`src/content/content.defaults.ts`): exactly the texts the storefront
  shipped with. No rows are seeded; `GET` merges the stored value of each section over its
  defaults field by field, so a section nobody edited, or a field added later, renders the
  default. Unknown or mistyped stored fields are ignored. The storefront keeps an identical copy
  (`frontend-perfume-shop/src/configs/content.defaults.ts`) as its offline fallback: keep both in sync.
- **Text conventions.** Words between asterisks are highlighted in headings (`Tus *favoritos*`).
  Placeholders are replaced when rendered, and each field only accepts its own:
  `{envioGratis}` (threshold, `$35`), `{tarifaEnvio}` (flat rate), `{produccion}` (production copy),
  `{categorias}` (category count in words, home only), `{marca}` and `{ciudad}` (About paragraphs).
- **Validation.** Each section has its own DTO (`src/content/dto`): lengths, list sizes, formats
  (`0412-5550134` on an active code, `V-12345678` / `J-123456789`, bank code `0102`, handles without `@`), money
  `>= 0` with 2 decimals, known placeholders and paired asterisks. Errors use the usual Spanish
  `{ message, details: [{ field, errors }] }` body; list items of plain-text lists are reported on
  the list with their position (`El anuncio 2 es obligatorio.`), nested ones by path
  (`steps.1.title`).

Endpoints:

- `GET /content` (public) → `{ general, announcements, … }`. Sent with
  `Cache-Control: public, max-age=60, stale-while-revalidate=300` and a weak ETag: edits reach the
  storefront within about a minute (`304` when revalidated unchanged).
- `GET /admin/content` (ADMIN, EDITOR) → per section `{ section, value, isDefault, updatedAt,
updatedBy }` (`no-store`).
- `PUT /admin/content/:section` (ADMIN, EDITOR) → replaces the whole section (every field must be
  sent) and returns it as saved. Unknown section → `404`.
- `POST /admin/content/:section/reset` (ADMIN only) → deletes the stored row, so the section
  shows the defaults again; returns the section.

## Catalogs

Business lists the owner can see and rename live in the database (`src/catalogs`); what the
code's behavior depends on stays in code.

- **Order statuses.** `order_status_groups` (the admin tabs: `code` PK, `label`, `description`
  shown when the tab is empty, `sort_order`, `highlight`) and `order_statuses` (`code` PK, admin
  `label`, `customer_label` for the customer's timeline, `customer_title` and
  `customer_description` for the message on the order page, which may use `{produccion}` and
  `{marca}`, `group_code` → `order_status_groups`, badge `tone` (CHECK: `blush`, `sky`, `mint`,
  `butter`, `lilac`, `solid`, `neutral`), `sort_order`, `is_terminal`). The codes and the
  transition map stay in `src/orders/order-status.ts`: `orders.status` and
  `order_status_history.from_status` / `to_status` reference `order_statuses.code`
  (`ON UPDATE CASCADE ON DELETE RESTRICT`), and `orders_status_check` is kept. **At startup** the
  API compares the codes in `order_statuses` with `ORDER_STATUSES`: a mismatch is logged and, outside
  `NODE_ENV=production`, stops the boot (run `npm run db:migrate`, or add a new status to both
  the code and a migration). The catalog is cached in memory and reloaded after every admin edit
  (with several instances, the others pick an edit up on restart). Every `statusLabel`, history
  `label` and transition `label` the API returns comes from it.
- **Banks.** `banks` (`code` varchar(4) PK, `name`, `is_active`, `sort_order`), seeded with the
  26 Pago Móvil banks. Payment proofs and the Pago Móvil content only accept an active bank of
  the table (`order_payments.payer_bank_code` references it; the content's `bankName` is taken
  from it). A bank that a payment or the Pago Móvil details use cannot be deleted
  (`409`); deactivate it instead.
- **Mobile operator codes.** `mobile_prefixes` (`code` varchar(4) PK, CHECK `^04[0-9]{2}$`,
  `is_active`, `sort_order`; migration `1791000000000-MobilePrefixes`), seeded with 0412, 0414,
  0416, 0422 and 0424 active and 0426 **inactive** (activate it in Catálogos). Every mobile field
  (content Pago Móvil `phone` and contact `whatsapp`, checkout `phone`, payment `payerPhone`) must
  match `^04\d{2}-\d{7}$` (`src/common/validation/ve-formats.ts`) **and** use an active code
  (`400` "El código 0426 no está disponible." on the field). Phones stay text, so there is no
  foreign key and no data change: stored numbers on an inactive code keep showing; only new saves
  are checked. The contact `phone` also takes landlines (`0251-…`) and is not checked. The rows are
  cached in memory for 60 s and dropped after every admin edit. A code can be deleted only while no
  order in progress (anything but `ENTREGADO`, `CANCELADO`, `EXPIRADO`, checkout or payer phone)
  and no content phone above (defaults included) uses it (`409`); deactivate it instead.
- **Cédula / RIF** stays in code (legal document types the pattern depends on): `^[VJG]-\d{6,9}$`
  for the content `idNumber` and the optional `payerIdNumber` ("Usa V, J o G seguido de 6 a 9
  números, por ejemplo V-12345678."). E and P are no longer accepted; the payer's is optional.

Endpoints:

- `GET /catalogs/order-statuses` (public) → `{ groups: [{ code, label, description, sortOrder,
highlight, statuses }], statuses: [{ code, label, customerLabel, customerTitle,
customerDescription, groupCode, tone, sortOrder, isTerminal }] }`, both sorted.
- `GET /catalogs/banks` (public) → active banks `[{ code, name }]`, in order.
- `GET /catalogs/mobile-prefixes` (public) → active codes `[{ code }]`, in order.
  All three are sent with `Cache-Control: no-cache` and a weak ETag (browsers revalidate on
  every load).
- ADMIN only, under `/admin/catalogs`: `GET order-statuses` (`no-store`),
  `PATCH order-statuses/:code` `{ label?, customerLabel?, customerTitle?, customerDescription?,
tone?, whatsappTemplate? }` (only the admin catalog carries `whatsappTemplate`), `PATCH order-statuses/groups/:code` `{ label?, description?, sortOrder? }` (both
  return the whole catalog; the code, the group and `isTerminal` are not accepted: `400`),
  `GET banks` (with `isActive`, `sortOrder`, `paymentCount`, `usedByPaymentContent`),
  `POST banks` `{ code, name, isActive? }` (`409` for a taken code), `PATCH banks/:code`
  `{ name?, isActive? }`, `PATCH banks/order` `{ codes }` (every code once) and
  `DELETE banks/:code` (`409` while in use); `GET mobile-prefixes` (with `isActive`, `sortOrder`,
  `activeOrderCount`, `contentFields`), `POST mobile-prefixes` `{ code, isActive? }` (`409` for a
  taken code), `PATCH mobile-prefixes/:code` `{ isActive }`, `PATCH mobile-prefixes/order`
  `{ codes }` and `DELETE mobile-prefixes/:code` (`409` while in use).

## Orders

Guest checkout (no customer accounts). Code in `src/orders`, rates in `src/exchange-rate`.

**Flow.** The storefront sends the checkout form and the cart lines (`productId`, `variantId?`,
`quantity`); any other field (e.g. a price) is a `400`. The API locks the
product rows (`SELECT … FOR UPDATE`), checks that each product is active, the variant exists and
the stock is enough (per-line Spanish errors, `400 ORDER_ITEMS_INVALID` with `details` and
`lines[{ index, available, message }]`), recomputes unit price (price + variant `priceDelta`),
subtotal, shipping (content `shipping`: free at the threshold, flat rate below, 0 for store
pickup), the USD total and the Bs total with the current BCV rate (snapshot of rate, source and
fecha valor), decrements the stock and stores the items as snapshots (name, variant label, unit
price, slug, first photo). The code is sequential (`KZ-000123`, sequence `order_code_seq`).

**Private links.** The response carries `accessToken` (32 random bytes, base64url) once; only its
SHA-256 is stored. The customer page is `/pedido/KZ-000123?t=<token>`; a wrong or missing token is a
plain `404`. An order may have several links (`order_access_links`: `order_id` → `orders`
`ON DELETE CASCADE`, unique `token_hash`, `created_by` → `users` (null for the checkout link),
`created_at`, `revoked_at`): checkout issues the first, and the admin issues new ones (the stored
hashes cannot be turned back into the customer's link). Any non-revoked link opens the order; each
candidate is compared in constant time. Links are built from `PUBLIC_SITE_URL` (default
`http://localhost:5173`). Migration `1790700000000-OrderAccessLinksAndWhatsAppTemplates` moved every
existing `orders.access_token_hash` into this table (same hash, so old links keep working) and
dropped the column; its `down()` puts back each order's oldest link.

**Avisar por WhatsApp.** Free `wa.me` links, no WhatsApp API. Each status has a
`whatsapp_template` (text, 1–1000 characters, CHECK; edited in Catálogos) with placeholders
`{nombre}` (first name), `{pedido}`, `{enlace}` (a fresh private link), `{total}` ("$36,00 (Bs.
30.760,69)"), `{motivo}` (note of the latest move into the current status), `{marca}`, `{envio}`
(shipping note, or the delivery method) and `{comprobante}` (public receipt link; only allowed in
`PAGO_VERIFICADO`, `EN_PRODUCCION`, `LISTO_PARA_ENTREGA`, `ENVIADO`, `ENTREGADO`). Unknown
placeholders or stray braces are a `400`. The API renders the message
(`src/orders/whatsapp`); a link is only issued when the template uses `{enlace}` or
`{comprobante}`. A customer phone that is not a Venezuelan mobile (0412/0414/0416/0422/0424/0426)
gets `phone: null` and no `url`.

**Comprobante de compra.** A PDF (pdfkit, A4, embedded Plus Jakarta Sans and Fredoka TTFs plus
the logo from `src/assets`, copied to `dist/assets` by the `assets` entry of `nest-cli.json`; OFL
licenses next to the fonts). Only for an order with a verified payment that is not `CANCELADO`
(`409` otherwise); long item lists paginate. Emoji in customer text are dropped (the fonts cannot
draw them).

**Order QR.** The receipt prints a small QR (about 76 pt, "Escanea para ver el estado de tu
pedido") of the customer's private link (`qrcode` package, error correction M, 4-module quiet
zone, black on white; `src/orders/qr/order-qr.ts`). It is tied to the order code + token, never to
the customer's email. The public receipt uses the token of the request. The admin receipt needs a
link: it reuses the newest admin-issued link of the order from the last 24 hours when this process
still holds its raw token in memory (only hashes are stored, so after a restart, or for a revoked
link, a new one is issued with `created_by` = the admin). A receipt that answers 409 issues nothing.

**Payment.** The customer pays by Pago Móvil outside the site and sends the proof (reference,
bank, phone, optional cédula, date, amount in Bs, optional screenshot). A reference already used
on another live order is accepted but flagged `duplicateReference`; an amount different from the
order's Bs total is flagged with the difference (the Bs total is frozen at creation and never
follows later rate changes). Every submission is kept in `order_payments` with its `source`
(`customer`, or `admin` + `recorded_by` for a proof sent by WhatsApp).

**Late payments: a real payment is never refused.** A proof is accepted in `PENDIENTE_PAGO`,
`PAGO_RECHAZADO` and `EXPIRADO`, with no deadline check. When the customer's payment date
(`paid_on`, a Caracas calendar day) is after the day `payment_due_at` falls on, it is flagged
`late` on the payment and `late_payment` on the order; paying on time and uploading the proof
later is not late. An expired
order takes its stock back with the same row locks as checkout: if every product has enough, it
moves to `PENDIENTE_VERIFICACION` normally; otherwise it still moves there, each product gives
what it has (never below 0) and the order keeps a `stock_conflict` (per product: `requested`,
`available`, `reserved`). Confirming that payment then requires `acknowledgeStockConflict: true`
(`400 STOCK_CONFLICT_UNACKNOWLEDGED` otherwise); the confirmation takes whatever of the missing
stock is there by then and writes what is still missing in the history. A later cancellation
only gives back what the order really took. `CANCELADO` never accepts customer proofs (`409`,
"Si hiciste un pago, escríbenos por WhatsApp").

**Reactivation.** `EXPIRADO` → `PENDIENTE_PAGO` (ADMIN or EDITOR) and `CANCELADO` →
`PENDIENTE_PAGO` (ADMIN only, refused while any payment of the order was ever verified) take the
stock back and set a fresh deadline. Without enough stock the answer is `409 STOCK_INSUFFICIENT`
with `lines`; `forceStock: true` reactivates anyway and records a stock conflict.

**Refunds.** Cancelling an order with a pending or verified payment requires `refundStatus`
(`NO_APLICA` / `PENDIENTE` / `REEMBOLSADO`, plus an optional `refundReference`). A pending refund
is closed with `POST /admin/orders/:code/refund` (adds an internal note) and is listed with
`GET /admin/orders?refundStatus=PENDIENTE`.

**Statuses.** Codes and transitions live in code; labels, customer copy, badge colors and the
admin tabs in the database (see [Catalogs](#catalogs)). One method, `OrderStatusService.transition(code, to, actor, note?)`, applies every
change (admin API, proof upload, expiry job, future Telegram bot) using the map in
`order-status.ts`; anything else is `409`. Each change is written to `order_status_history`
(from, to, actor `admin`/`customer`/`system`/`telegram`, admin user, note).

| From                                                                                                 | To (actor)                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PENDIENTE_PAGO`                                                                                     | `PENDIENTE_VERIFICACION` (payment recorded: customer, or admin), `EXPIRADO` (system), `CANCELADO`                                 |
| `PENDIENTE_VERIFICACION`                                                                             | `PAGO_VERIFICADO` (acknowledgement required with a stock conflict), `PAGO_RECHAZADO` (reason required), `CANCELADO`               |
| `PAGO_RECHAZADO`                                                                                     | `PENDIENTE_VERIFICACION` (payment recorded: customer re-submits, or admin), `CANCELADO`                                           |
| `PAGO_VERIFICADO` → `EN_PRODUCCION` → `LISTO_PARA_ENTREGA` → `ENVIADO` (optional note) → `ENTREGADO` | each step also allows `CANCELADO`; `LISTO_PARA_ENTREGA` → `ENTREGADO` directly for pickup                                         |
| `EXPIRADO`                                                                                           | `PENDIENTE_VERIFICACION` (late payment recorded: customer or admin; takes the stock back), `PENDIENTE_PAGO` (reactivation, admin) |
| `CANCELADO`                                                                                          | `PENDIENTE_PAGO` (reactivation, ADMIN only, never after a verified payment)                                                       |

Moves to `PENDIENTE_VERIFICACION` only happen by recording a payment (the plain transitions API
answers `409`).

Staff steps accept `admin` (ADMIN or EDITOR) and `telegram` actors. `CANCELADO` needs a reason
and the ADMIN role, and restores the stock unless the order was already `ENVIADO`. Unpaid orders
expire after `ORDER_PAYMENT_WINDOW_HOURS` (checked every `ORDER_EXPIRY_INTERVAL_MINUTES`), become
`EXPIRADO` and restore their stock; the Bs amount is valid for the whole window.

**Events**: `order.created`, `order.payment_submitted` (with `late`, `source` and
`stockConflict`), `order.status_changed`, `order.refund_updated` (payloads in `orders.events.ts`).
Notifications (the "Pedido recibido" email, the Telegram bot's messages) are outbox handlers of
these events, recorded in the order's transaction (see [Notifications](#notifications-outbox));
the events are also emitted after commit (`@nestjs/event-emitter`) for in-process reactions such
as cache invalidation. The bot approves through `OrderStatusService` (exported by `OrdersModule`).

### BCV exchange rate

`exchange_rates` keeps every rate (`rate numeric(12,4)`, `source` `bcv`/`dolarapi`/`manual`,
`effective_date` = BCV fecha valor, `fetched_at`, `is_manual`, `created_by`). Providers, tried in
order: **bcv.org.ve** (HTML: the `#dolar` block and "Fecha Valor"; the site does not send its
intermediate certificate, so that one request trusts Node's roots plus the bundled Sectigo DV R36
intermediate in `providers/bcv-ca.ts`; TLS verification is never disabled) and
**ve.dolarapi.com/v1/dolares/oficial** (JSON `promedio` + `fechaActualizacion`). The rate is
fetched at startup and every `EXCHANGE_RATE_SYNC_INTERVAL_MINUTES`; a row is added only when the
rate or its fecha valor differs from the last automatic one, so a manual rate stays in force until
the BCV publishes a different rate. Checkout uses the newest row; with none, or with one whose
fecha valor is older than `EXCHANGE_RATE_MAX_AGE_HOURS`, `POST /orders` answers
`503 EXCHANGE_RATE_UNAVAILABLE` ("No pudimos obtener la tasa del BCV…"). Parser fixtures live in
`src/exchange-rate/providers/__fixtures__`.

### Endpoints

Public (write routes throttled to 10 per 10 minutes per IP):

- `GET /exchange-rate/current` → `{ available: true, rate, source, effectiveDate, … }` or
  `{ available: false, reason: 'missing' | 'stale', message }`
- `POST /orders` → `201 { code, accessToken, order, replayed: false }`. Optional header
  `Idempotency-Key` (16–64 of `A-Z a-z 0-9 -`, e.g. a UUID per checkout attempt; malformed → `400`).
  A retry with the same key and the same body within 24 h creates nothing and takes no stock: it
  answers `200` with the same order, `replayed: true` and a **new** `accessToken` (only token
  hashes are stored; both links open the order). The same key with another body →
  `409 { code: 'IDEMPOTENCY_KEY_REUSED' }`. Concurrent duplicates are caught by the unique index
  and replayed the same way. Keys older than 24 h are freed. Without the header, every request
  creates an order
- `GET /orders/:code?t=` → the customer's order (Pago Móvil details, totals, payments, history,
  `receiptAvailable`)
- `GET /orders/:code/receipt.pdf?t=` → the purchase receipt (`attachment;
filename="comprobante-KZ-000012.pdf"`, 20 per 10 minutes per IP; `404` with a bad token, `409`
  before the payment is verified or once cancelled)
- `POST /orders/lookup` `{ code, email }` ("Consultar mi pedido"; 5 per 15 minutes per IP, 3 per
  email and 3 per code, `429` past that) → always `202 { message: "Si los datos coinciden, te
enviamos un enlace a tu correo." }`. See [Email](#email)
- `POST /orders/:code/payment?t=` (multipart: `reference`, `payerBankCode` (an active bank of
  `banks`), `payerPhone`,
  `payerIdNumber?`, `paidOn`, `amountBs`, file `proof?` JPG/PNG/WEBP up to 5 MB, content-sniffed)
  — in `PENDIENTE_PAGO`, `PAGO_RECHAZADO` or `EXPIRADO` (late ones are flagged), otherwise `409`

Admin (ADMIN, EDITOR):

- `GET /admin/orders?status&refundStatus&search&from&to&page&pageSize` (search: code, name,
  email, phone, payment reference; `from`/`to` are Caracas days) → paginated list + `counts` per
  status + `pendingRefunds`; each row carries `latePayment`, `stockConflict` and `refundStatus`.
  `status` takes one status or several, comma-separated (`status=PENDIENTE_PAGO,PAGO_RECHAZADO`)
  or repeated (`status=A&status=B`), and lists orders in any of them; an unknown value is a `400`.
  `counts`, `countAll` and `pendingRefunds` follow the search and dates but ignore `status`, so
  the admin can show a number on every status group
- `GET /admin/orders/summary` → pending counts (`pendingRefunds` included), `paymentConfigured`,
  rate availability
- `GET /admin/orders/:code` → full order (`latePayment`, `stockConflict`, `refund`) +
  `allowedTransitions` for the current user
- `POST /admin/orders/:code/transitions` `{ to, note?, acknowledgeStockConflict?, forceStock?,
refundStatus?, refundReference? }`; `POST /admin/orders/:code/notes` `{ body }`
- `POST /admin/orders/:code/payments` (same multipart as the customer's proof): "Registrar pago
  manualmente" in `PENDIENTE_PAGO`, `PAGO_RECHAZADO` or `EXPIRADO`
- `POST /admin/orders/:code/refund` `{ reference? }`: the pending refund was made
- `POST /admin/orders/:code/access-links` → `{ token, url, createdAt }`: a new customer link
- `POST /admin/orders/:code/whatsapp-message` → `{ status, statusLabel, customerPhone, phone, text,
url, link, receiptUrl }` (the current status's template rendered; `url` is the wa.me link)
- `POST /admin/orders/:code/whatsapp-message/opened` → adds the internal note "Aviso por WhatsApp
  preparado (estado …)." (status unchanged) and returns the order
- `GET /admin/orders/:code/receipt.pdf` → the same receipt as the customer's
- `GET /admin/orders/:code/payments/:paymentId/proof` → streams the screenshot (local) or
  redirects to a 5-minute signed URL (Cloudinary); `Cache-Control: private, no-store`
- `GET /admin/exchange-rate` (current, last 30, last sync), `POST /admin/exchange-rate/refresh`,
  `POST /admin/exchange-rate/manual` `{ rate, effectiveDate? }` (ADMIN only)

Behind a reverse proxy, enable Express `trust proxy` so the throttler sees the client IP.

## Telegram bot

Code in `src/telegram` ([grammY](https://grammy.dev)). When a payment proof arrives, every linked
chat gets the order (customer, items, totals, Pago Móvil data, the proof photo read privately from
storage, and the warnings: amount off, repeated reference, late payment, missing stock) with
**✅ Pago recibido** / **❌ Rechazar** buttons. Both call `OrderStatusService.transition()` with a
`telegram` actor (the admin who linked the chat is recorded as the reviewer), exactly like the
admin panel, and the messages in every chat are then edited so nobody acts on stale buttons. A
payment handled on the web updates the Telegram copies the same way (`order.status_changed`).

**Configuration** (all optional; without a token the bot is off and the API works as before):

| Variable                  | Default                                                  | What it does                                           |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`      | —                                                        | Token from @BotFather. Never logged.                   |
| `TELEGRAM_ENABLED`        | `true` when a token exists (`false` under NODE_ENV=test) | `false` turns the bot off without removing the token.  |
| `TELEGRAM_MODE`           | `polling` (development), `webhook` (production)          | How updates arrive.                                    |
| `TELEGRAM_WEBHOOK_SECRET` | —                                                        | Required in webhook mode (1–256 of `A-Z a-z 0-9 _ -`). |
| `TELEGRAM_API_ROOT`       | `https://api.telegram.org`                               | Only for tests (a fake Bot API).                       |

The startup log says `Telegram bot disabled: <reason>` or `Telegram bot @<name> connected`. The
connection never blocks the boot: Telegram or network errors are logged and retried with backoff.

- **Polling** (local development): starts after the app is up and stops on shutdown
  (`enableShutdownHooks`), so `nest start --watch` reloads hand over cleanly. A 409 "terminated by
  other getUpdates request" (two processes polling the same token) is logged as a warning and
  retried. Polling calls `deleteWebhook`, so **never poll with the production token** once
  production uses a webhook: create a second bot for development, or set `TELEGRAM_ENABLED=false`.
- **Webhook** (production, e.g. Railway): set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`
  (e.g. `openssl rand -hex 32`), `PUBLIC_API_URL` (the public HTTPS address of the API, e.g.
  `https://kaizen-api.up.railway.app`) and, if you want to be explicit, `TELEGRAM_MODE=webhook`.
  At startup the API calls `setWebhook(<PUBLIC_API_URL>/api/telegram/webhook)` with the secret.
  `POST /api/telegram/webhook` is public and not throttled; it answers 401 unless the
  `X-Telegram-Bot-Api-Secret-Token` header matches. Run a single instance (the pending-reason and
  rate-limit state is in memory). `https://api.telegram.org/bot<token>/getWebhookInfo` shows the
  delivery status.

**Linking a chat** (Telegram bots cannot message a phone number; the person writes first). In
the admin, **Telegram → Vincular un chat** creates a 6-digit code valid for 10 minutes and usable
once (only its HMAC is stored, keyed with `JWT_SECRET`). In Telegram, open the bot and send
`/start 482913` (or use the `t.me/<bot>?start=<code>` link). The chat is linked on behalf of the
admin who created the code. Anyone else gets "este es un bot privado" and never sees order data.
Groups are ignored.

**In the chat:** `/pendientes` (up to 10 payments waiting, each with its buttons), `/pedido
KZ-000012` (or `/pedido 12`), `/micuenta` (the linked panel account), `/ayuda`, `/salir` (unlinks after a confirmation). **Rechazar**
offers quick reasons ("Monto incompleto", "No encontramos el pago", "Referencia inválida") or
"Otro motivo…", which asks for a typed reason (ForceReply, max. 500 characters, 10 minutes). The
reason is what the customer reads on the order page. After a rejection the message offers
"💬 Avisar al cliente por WhatsApp" (the status's WhatsApp template, as in the admin). With an
unresolved stock conflict, **Pago recibido** first asks "✅ Confirmar igual (falta stock)", which
sends `acknowledgeStockConflict`. A payment already handled (web or another chat) answers "Este
pago ya fue procesado: <estado>" and refreshes the message; double taps are ignored. Each chat is
limited to 30 actions per minute (and 5 link attempts per 10 minutes). A chat that blocks the bot
is marked inactive and reactivated when it writes again. "Nuevos pedidos" (per chat, off by
default) also sends a short notice for every new order.

**Tables** (migration `1790800000000-TelegramBot`): `telegram_chats` (`chat_id` bigint unique,
`username`/`first_name` varchar(100), `linked_by_user_id` → `users` SET NULL, `is_active`,
`notify_new_orders`, `linked_at`, `last_seen_at`), `telegram_link_codes` (`code_hash`,
`created_by_user_id` → `users` CASCADE, `expires_at`, `used_at`, `used_by_chat_id`) and
`telegram_messages` (`chat_id` → `telegram_chats.chat_id` CASCADE, `message_id`, `order_id` →
`orders` CASCADE, `payment_id` → `order_payments` CASCADE, `kind`, `resolution`, `created_at`):
what the bot sent, so it can edit it later.

Admin endpoints (ADMIN only): `GET /admin/telegram` → `{ bot: { enabled, mode, connected,
username, name, error }, chats }`; `POST /admin/telegram/link-codes` → `{ code, expiresAt,
expiresInSeconds, botUsername, deepLink }` (503 while the bot is not connected);
`PATCH /admin/telegram/chats/:id` `{ notifyNewOrders }`; `POST /admin/telegram/chats/:id/test`
(502 when Telegram refuses); `DELETE /admin/telegram/chats/:id`.

Tests: `src/telegram/*.spec.ts` and `test/telegram.e2e-spec.ts` run the bot against a fake Bot
API (`test/fixtures/fake-telegram.ts`): nothing reaches Telegram.

**Password recovery** (`src/auth/password-reset`, migration `1791100000000-PasswordResetCodes`).
Panel users who forgot their password get a one-time 6-digit code through a delivery channel
(`PasswordResetChannel`, listed in order of preference in the `PASSWORD_RESET_CHANNEL_LIST` factory
of `password-reset.module.ts`): `TelegramPasswordResetChannel` first, then
`EmailPasswordResetChannel` as the fallback. The first channel that can reach the user wins.

- `POST /auth/password-reset/request` `{ email }` (public; 3 per 15 minutes per IP and per email,
  `429` past that) → always `202 { message }` with the same text. The work runs after the
  response (so its time does not depend on the account). Only an **active** user gets a code: by
  Telegram when they have at least one **active** chat they linked
  (`telegram_chats.linked_by_user_id`), sent to all those chats ("🔐 Código para restablecer tu
  contraseña…", `protect_content`); otherwise by email to the account's address ("Tu código para
  restablecer la contraseña") when mail is on (`MAIL_DRIVER` `smtp` or `resend`; with `log` the
  email channel never claims a user). Their older unused codes expire. Unknown email, inactive
  user, no channel: nothing is sent and it is only logged.
- `POST /auth/password-reset/confirm` `{ email, code, newPassword }` (public, 10 per 15 minutes per
  IP) → `204`. Only the newest live code counts; every attempt is counted atomically before the
  comparison (constant time), and after 5 the code is burned. Wrong, used, burned or expired codes
  and unknown emails all get `400` "Código inválido o vencido." (pinned on `code`); password policy
  problems are the usual field errors. Success sets the password and `password_changed_at` (every
  session ends; no auto-login) and sends "Tu contraseña se cambió" through the channel that
  carried the code (the same chats, or the same email).
- `password_reset_codes`: `user_id` → `users` CASCADE, `code_hash` (HMAC-SHA-256 hex with
  `JWT_SECRET`, user id included), `channel` varchar(20) (`telegram`/`email`), `expires_at` (+10 min),
  `attempts`, `used_at`, `created_at`, `requester_ip` varchar(64).
- The bot's `/micuenta` shows the panel account that linked the chat (name, email, role, active);
  unlinked chats get the usual private-bot reply.

Tests: `test/password-reset.e2e-spec.ts` (fake Bot API and a fake mail transport),
`src/auth/password-reset/reset-code.spec.ts`.

## Email

Code in `src/mail` (`MailService.send({ to, subject, html, text }, context)` and the shared
layout `email-layout.ts`); order emails in `src/orders/emails`. `send` never throws: a failure is
logged with its context (order code or user id, never the address or the body) and returns
`false`, so an outage never fails an order or a password reset.

| `MAIL_DRIVER`   | What happens                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `log` (default) | Nothing is sent. Only the masked recipient and the subject are logged. Order emails are skipped      |
| `smtp`          | Any SMTP server: Mailpit in development (`SMTP_HOST`, `SMTP_PORT`; `SMTP_USER`/`SMTP_PASS` optional) |
| `resend`        | Resend's HTTP API (`POST https://api.resend.com/emails`, `Authorization: Bearer RESEND_API_KEY`)     |

`MAIL_FROM` ("KaiZen Perfumería <pedidos@tudominio.com>") is required by `smtp` and `resend`
(on Resend it must be on a verified domain); `MAIL_REPLY_TO` is optional (customers' replies go
there). The startup validation lists any missing variable. Under `NODE_ENV=test` the driver is
always `log` (the e2e tests replace the `MAIL_TRANSPORT` provider with a fake).

**Mailpit (development).** `npm run db:up` also starts Mailpit (`docker-compose.yml`, service
`mailpit`; `docker compose up -d mailpit` starts only it). It catches every email: open
<http://localhost:8025>. Set in `.env`:

```dotenv
MAIL_DRIVER=smtp
MAIL_FROM="KaiZen Perfumería <pedidos@kaizen.test>"
SMTP_HOST=localhost
SMTP_PORT=1025
```

Change the host ports with `MAILPIT_SMTP_PORT` / `MAILPIT_UI_PORT` (keep `SMTP_PORT` in sync).

**Emails.** All in Spanish, table-based HTML with inline CSS plus a plain-text part, with the
brand name and the contact data of the site content (email, WhatsApp, Instagram) in the footer.
Every customer value is escaped.

- **Pedido recibido** (`order.created`, `OrderEmailsListener`, after the commit): greeting, code,
  items (variant and quantity), totals in USD and Bs with the stored rate, the Pago
  Móvil data with the exact amount, the payment deadline in Caracas time, the delivery method and
  address, a **Ver mi pedido** button and how to reach the shop (reply or WhatsApp). The button
  carries a **new** private link (`order_access_links`, `created_by` null), never the checkout
  token. It is the only automatic customer email for now.
- **Consultar mi pedido** (`POST /orders/lookup` `{ code, email }`, `OrderLookupService`): the
  answer is always the same `202` right away; in the background, when an order has that code and
  that email (trimmed, case-insensitive) a fresh link is emailed to the order's address ("Tu
  enlace para ver el pedido KZ-…"). Rate limits: 5 per 15 minutes per IP (throttler), 3 per email
  and 3 per code (in memory), `429` past that. With `MAIL_DRIVER=log` no link is issued.
- **Password reset** codes and the "password changed" notice (see [Telegram bot](#telegram-bot)).

Tests: `src/mail/*.spec.ts`, `src/orders/emails/*.spec.ts`, `test/order-emails.e2e-spec.ts`.

## Admin users and roles

There is **no public registration**. Every route requires a valid session unless it is marked
`@Public()`; admin routes add `@Roles(...)`. `ADMIN` can do everything; `EDITOR` manages
products, orders and content but cannot delete products or categories, cancel orders, or open
Catálogos, Telegram and Usuarios.

Accounts are managed from the admin (**Usuarios**, code in `src/users`). The seed only creates
the first `ADMIN` from `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `SEED_ADMIN_NAME`.
Re-running it resets that user's password and name, makes it an active `ADMIN` again (the way
back in if every admin is locked out) and, since the password changed, closes its sessions.

**Table** (migration `1790900000000-AdminUserManagement`): `users.is_active` (default true),
`users.password_changed_at` and `users.last_login_at` (timestamptz, nullable), and
`users_email_lower_key`, a unique index on `lower(email)`: emails are unique ignoring case (the
API also stores them lowercase).

**Sessions.** `JwtAuthGuard` re-reads the user on every request: a deactivated user gets `401`
at once, a role change applies at once, and a token whose `iat` (whole seconds) is before
`password_changed_at` is rejected ("Tu contraseña cambió…"). A password change is stamped at
the next whole second (`passwordChangeInstant` in `src/auth/session.config.ts`), so every token
signed so far, even in the same second, is older; the session that made the change gets a new
token dated at that instant (up to one second ahead), so it survives.

**Password policy** (`src/auth/password-policy.ts`, same in the front): 10–200 characters, at
least one letter and one number, Spanish messages. Only argon2 hashes are stored; no endpoint
returns them.

**No hard delete.** Users are deactivated instead, so orders, notes, status history and
Telegram approvals keep their author. Deactivating also switches off the Telegram chats the user
linked (`telegram_chats.linked_by_user_id`) and burns their unused link codes, so a former
employee stops receiving payment data. The bot treats a chat linked by a deactivated user as
unlinked (the "private bot" reply, and writing to it does not reactivate it) until an active
admin links it again. Reactivating the user does not switch the chats back on: each comes back
when it writes to the bot again.

**Safety rules** (`409` in Spanish): an admin cannot change their own role, deactivate
themselves or reset their own password here (that is "Mi cuenta"); at least one active `ADMIN`
must always remain (checked under a transaction-scoped advisory lock, so two admins acting at
once cannot both win); a taken email (any case).

Endpoints (ADMIN only, under `/admin/users`):

- `GET /admin/users?search&page&pageSize` (search: name or email, case-insensitive; `pageSize`
  default 20, max 100) → `Paginated<{ id, name, email, role, isActive, createdAt, updatedAt,
lastLoginAt, passwordChangedAt, telegramChatCount, activeTelegramChatCount }>`
- `GET /admin/users/:id`
- `POST /admin/users` `{ name, email, role, password }` → `201` with the user
- `PATCH /admin/users/:id` `{ name?, email?, role? }`
- `POST /admin/users/:id/password` `{ password }` → `204`; closes every session of that user
- `PATCH /admin/users/:id/active` `{ isActive }` → the user plus `telegramChatsDeactivated`

Tests: `test/admin-users.e2e-spec.ts` (in-memory users table, `test/fixtures/fake-users-db.ts`),
`src/auth/password-policy.spec.ts`, `src/auth/session.config.spec.ts` and
`src/auth/auth.service.spec.ts`.
