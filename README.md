# 20FIT Affiliate

The 20FIT affiliate site, deployed on Railway as a small Node server
(`server.js`, no dependencies).

| Path                  | Page                    | Access                                        |
| --------------------- | ----------------------- | --------------------------------------------- |
| `/`                   | Landing page            | Public                                        |
| `/affiliatedashboard` | Affiliate dashboard     | Any signed-in 20FIT account                   |
| `/admin`              | Affiliate admin console | Accounts listed in `public.affiliate_admins`  |
| `/admin/settings`     | Program settings        | Accounts listed in `public.affiliate_admins`  |
| `/login`, `/logout`   | Sign in / out           | Public                                        |

`/affiliatedashbaord` and `/dashboard.html` redirect to `/affiliatedashboard`.

## Program settings

The program's settings live in Supabase (project "20FIT ALL DATA"), table
`public.affiliate_settings` (one row):

| Column                    | Used for                                                       |
| ------------------------- | -------------------------------------------------------------- |
| `commission_rate`         | Rate for every product, e.g. `0.025` for 2,5%                  |
| `min_withdrawal`          | Minimum Tersedia balance to submit a claim, in rupiah          |
| `pending_days`            | Hold period: days a commission stays Tertahan after payment    |
| `tax_rate_npwp`, `tax_rate_no_npwp` | PPh 21 withheld from a claim, with and without NPWP  |
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
- **Dashboard and admin console**: designed in a design tool and exported as
  self-unpacking bundles in `src/bundles/`. `npm run build` (`python3
  tools/unbundle.py`) turns them into plain HTML in `public/` with assets in
  `public/assets/`. The dashboard still shows sample numbers; the server fills
  in the signed-in user's name and the configured scheme.

## Sign-in

People sign in with the email and password of their 20FIT app account
(Supabase Auth). The session is kept in HttpOnly cookies.

## Environment variables

All optional.

| Variable                   | Default                                  |
| -------------------------- | ---------------------------------------- |
| `SUPABASE_URL`             | The 20FIT ALL DATA project               |
| `SUPABASE_PUBLISHABLE_KEY` | That project's publishable key           |
| `PORT`                     | `3000` (Railway sets it)                 |

Run locally with `npm start`.
