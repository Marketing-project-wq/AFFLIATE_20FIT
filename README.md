# 20FIT Affiliate

The 20FIT affiliate site, deployed on Railway as a small Node server
(`server.js`, no dependencies).

| Path                  | Page                    | Access                                        |
| --------------------- | ----------------------- | --------------------------------------------- |
| `/`                   | Landing page            | Public                                        |
| `/dashboard`          | Affiliate dashboard: Home | Any signed-in 20FIT account                 |
| `/dashboard/sales`    | Dashboard: Sales        | Any signed-in 20FIT account                   |
| `/dashboard/profile`  | Dashboard: Profile      | Any signed-in 20FIT account                   |
| `/gabung`             | Affiliate sign-up (KTP details, domisili, payout account, T&C) | Any signed-in 20FIT account |
| `/admin`              | Redirects to `/admin/settings` | Accounts listed in `public.affiliate_admins`  |
| `/admin/settings`     | Program settings        | Accounts listed in `public.affiliate_admins`  |
| `/login`, `/logout`   | Sign in / out           | Public                                        |
| `/lupa-password`      | Reset the app password  | Public                                        |

`/affiliatedashboard`, `/affiliatedashbaord` and `/dashboard.html` redirect
(301, query string kept) to `/dashboard`.

## Program settings

The program's settings live in Supabase (project "20FIT ALL DATA"), table
`public.affiliate_settings` (one row):

| Column                    | Used for                                                       |
| ------------------------- | -------------------------------------------------------------- |
| `commission_rate`         | Rate for every product, e.g. `0.025` for 2,5%                  |
| `min_withdrawal`          | Minimum Tersedia balance to submit a claim, in rupiah          |
| `pending_days`            | Hold period: days a commission stays Tertahan after payment    |
| `tax_rate_npwp`, `tax_rate_no_npwp` | PPh 21 rates, with and without NPWP (not applied: the app program pays gross for now) |
| `program_status`          | `active` or `paused` (no new affiliates, links or commissions) |
| `one_purchase_per_open`   | One opened link attributes one purchase                        |
| `terms_version`, `terms_url`, `terms_summary` | The affiliate terms; a new version asks everyone to accept again |
| `fraud_*`                 | Thresholds for the automatic review flags                      |
| `monthly_potential`       | "Potensi maksimal per bulan" on the calculator                 |
| `sales_targets`           | `[{ "category", "target" }]` behind "Lihat target penjualan"   |
| `calculator_products`     | `[{ "label", "table", "match" }]`: the calculator's chips      |

Admins edit it at `/admin/settings`. Every change, from that page or from SQL,
is logged by a trigger in `public.affiliate_settings_audit` (who, when, old
value, new value). Writes go through `affiliate_update_settings(patch)`, which
checks the admin's role.

### Admin roles

`public.affiliate_admins (email, role)`:

| Role      | Can                                                                                  |
| --------- | ------------------------------------------------------------------------------------ |
| `super`   | Everything                                                                           |
| `growth`  | Catalog, affiliates, links, flags, terms, landing and fraud settings                 |
| `finance` | Claims queue, payouts (decrypted bank details, logged), cancellations and adjustments; reads settings |

Only `super` changes the rate, hold period, minimum claim, tax rates or pauses
the program. To add an admin:

```sql
insert into public.affiliate_admins (email, role) values ('name@20fit.id', 'growth');
```

Calculator prices are read live from the booking tables named in
`calculator_products` (`booking_products`, `gym_day_pass_config`,
`gym_membership_plans`, `clinic_services`): the cheapest active row matching
`match`. Inactive or missing products are left out.

The schema is in `supabase/migrations/`.

## Affiliate program database

`supabase/migrations/20261009090001…090006` build the program from the PRD
(`docs/PRD-20FIT-Affiliate-Program.pdf`):

- **Tables:** `affiliate`, `affiliate_payout_profile` (bank details encrypted
  with a Supabase Vault key), `affiliate_product` (the catalog),
  `affiliate_link` (one per affiliate and product), `affiliate_link_open`,
  `affiliate_link_context` (last link a buyer opened per product),
  `affiliate_commission`, `affiliate_claim`, `affiliate_adjustment`,
  `affiliate_flag`, `affiliate_audit_log`.
- **Access:** RLS everywhere. Affiliates read their own rows; every write
  goes through `affiliate_*` / `affiliate_admin_*` functions.
- **Commission lifecycle:** `held` → `available` (daily pg_cron job
  `affiliate-release-due`) → `claimed` → `paid`, or `cancelled`.
- **App integration:** linking orders to commissions is not wired up yet. See
  `docs/affiliate-integration.md`.

The older `my20fit_affiliate*` tables belong to a different workstream and
aren't used here.

## Pages

- **Landing** (`lib/landing-view.js`): rendered on the server with the
  settings and prices (cached for a minute), so it never shows template
  placeholders. `public/assets/landing.js` adds the calculator's interaction;
  `public/assets/affiliate-calc.js` holds the maths both sides share. If
  Supabase is unreachable it serves the last good data, or empty states.
- **Dashboard** (`/dashboard`, `/dashboard/sales`, `/dashboard/profile`):
  one dc component, edited in `src/dashboard.dc.html` (markup and logic),
  that shows Home, Sales or Profile depending on the `page` the server sets.
  `npm run unbundle` builds it into `public/dashboard.html`, taking the
  assets from `src/bundles/dashboard.html`. The affiliate program shown is
  the 20FIT app's: the Supabase Edge Function `affiliate`
  (`/functions/v1/affiliate`) and its tables `my20fit_affiliates`,
  `my20fit_affiliate_commissions`, `my20fit_affiliate_payouts` and
  `my20fit_affiliate_clicks`. The server renders the page with the
  affiliate's own data in `window.__AF_DATA__` (the function's `me`: code,
  referral link, live balances, friends who bought, bank details; plus their
  own commission, payout and click rows, read with their token under RLS;
  and the 20FIT account's name and phone), and the page's actions go through
  `/api/affiliate/*` with the session cookie; the browser never holds a
  token. Rate, minimum withdrawal and hold days come from
  `affiliate_settings`; the next payout date comes from the function. The
  header uses the landing page's logo (`public/assets/20fit-logo.png`).
  Theme (light, dark, system) and language (Bahasa Indonesia, English) are
  kept in the browser's localStorage (`af_theme`, `af_lang`). QR codes are
  drawn in the browser (`public/assets/qrcode.js`, MIT).
- **Admin console**: the design's prototype (`public/admin.html`) still runs
  on sample data, so `/admin` redirects to `/admin/settings`, which is real,
  until the console reads the app's affiliate data.

People who haven't joined are sent from `/dashboard` and `/dashboard/sales`
to `/gabung`: KTP details (everything on the KTP except blood type), then
domisili, then payout account (in the KTP name) and T&C. The KTP details go
to `my20fit_affiliate_identity` through its functions, saved once with the
NIK encrypted; afterwards only the domisili and the payout account can
change. Affiliates who joined in the app fill in the KTP part once (a banner
on Home links to `/gabung`); withdrawals need it.

The earlier web-only program (`affiliate`, `affiliate_link`,
`affiliate_commission`, `affiliate_claim`, the `affiliate_my_*` functions)
is no longer used by the dashboard. Its tables and functions are left in
place (deprecated), not dropped.

### /api/affiliate/*

Signed-in only; POSTs must come from this site's origin. Each call goes out
with the user's own token and the publishable key, and returns only the
fields the page shows (bank account numbers masked).

| Method & path | Calls |
| --- | --- |
| `GET state` | `affiliate` `me` + own rows of `my20fit_affiliate_commissions`, `…_payouts`, `…_clicks` |
| `GET account` | `my20fit_profile` (own row via RLS): name, phone, email, photo |
| `POST join` `{agree:true, identity, bank, account, holder, code?}` | `affiliate_identity_save` (if not saved yet), then `affiliate` `join` |
| `POST identity` `{nik, full_name, …, domicile_*}` | `affiliate_identity_save` (once) |
| `POST domicile` `{domicile_*}` | `affiliate_identity_update_domicile` |
| `POST bank` `{bank, account, holder, code?}` | `affiliate` `update_bank` (holder must match the KTP name) |
| `POST payout` `{amount}` | `affiliate` `request_payout` (needs KTP details; minimum and balance checked by the function) |
| `POST account` `{name, phone}` | updates `full_name` and `phone` of the user's own `my20fit_profile` row (RLS); email can't change |

## Sign-in

People sign in with their 20FIT app account; there is no sign-up on the
web. The app's passwords live in the 20FIT account service (my.20fit.id),
so `public/assets/auth.js` sends the email and password from the browser
straight to `ACCOUNTS_URL/api/fitco-login`, the same check the app makes.
That service answers with a one-time email code, which `POST /login/otp`
exchanges for a Supabase session (`/auth/v1/verify`, publishable key). The
password never reaches this server on that path.

If the account service says no or can't be reached, and when JavaScript is
off, the form posts to `POST /login`, which checks the Supabase password
(accounts made on the web). Both share a per-IP attempt limit, and every
failure shows the same message. The session is kept in HttpOnly cookies.

`/lupa-password` resets the app password the way the app does: a code by
email (`/api/fitco-forgot`), then code + new password (`/api/fitco-reset`).
It shows the same message whether or not the email has an account.

## Environment variables

All optional.

| Variable                   | Default                                  |
| -------------------------- | ---------------------------------------- |
| `SUPABASE_URL`             | The 20FIT ALL DATA project               |
| `SUPABASE_PUBLISHABLE_KEY` | That project's publishable key           |
| `PORT`                     | `3000` (Railway sets it)                 |
| `ACCOUNTS_URL`             | `https://my.20fit.id`                    |
| `APP_STORE_URL`, `PLAY_STORE_URL`, `SUPPORT_URL` | `landing_content.app_store_url`, `play_store_url`, `support_url`; hidden when neither is set |

Run locally with `npm start`.

## Deployment

Railway deploys `main`. `railway.json` pins the Railpack builder, starts the
server with `node server.js` and health-checks `/login` (it doesn't call
Supabase). There is deliberately no `build` script: Railpack runs
`npm run build` when one exists, and the unbundle step needs Python, which the
Node image doesn't have. Its output in `public/` is committed instead.
