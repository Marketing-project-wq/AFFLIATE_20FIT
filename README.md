# 20FIT Affiliate

The 20FIT affiliate site, deployed on Railway as a small Node server
(`server.js`, no dependencies).

| Path                  | Page                    | Access                                        |
| --------------------- | ----------------------- | --------------------------------------------- |
| `/`                   | Landing page            | Public                                        |
| `/affiliatedashboard` | Affiliate dashboard     | Any signed-in 20FIT account                   |
| `/admin`              | Affiliate admin console | Accounts listed in `public.affiliate_admins`  |
| `/admin/settings`     | Commission settings     | Accounts listed in `public.affiliate_admins`  |
| `/login`, `/logout`   | Sign in / out           | Public                                        |

`/affiliatedashbaord` and `/dashboard.html` redirect to `/affiliatedashboard`.

## Commission settings

The commission scheme lives in Supabase (project "20FIT ALL DATA"), table
`public.affiliate_settings` (one row):

| Column                | Used for                                                     |
| --------------------- | ------------------------------------------------------------ |
| `commission_rate`     | Rate for every product, e.g. `0.025` for 2,5%                |
| `min_withdrawal`      | Minimum withdrawal in rupiah                                 |
| `pending_days`        | Hold period: days a commission stays Tertahan after payment  |
| `monthly_potential`   | "Potensi maksimal per bulan" on the calculator               |
| `sales_targets`       | `[{ "category", "target" }]` behind "Lihat target penjualan" |
| `calculator_products` | `[{ "label", "table", "match" }]`: the calculator's chips    |

Admins edit it at `/admin/settings`. Every change, from that page or from SQL,
is logged by a trigger in `public.affiliate_settings_audit` (who, when, old
value, new value). Writes go through `affiliate_update_settings(patch)`, which
only accepts accounts in `public.affiliate_admins`. To add an admin:

```sql
insert into public.affiliate_admins (email) values ('name@20fit.id');
```

Calculator prices are read live from the booking tables named in
`calculator_products` (`booking_products`, `gym_day_pass_config`,
`gym_membership_plans`, `clinic_services`): the cheapest active row matching
`match`. Inactive or missing products are left out.

The schema is in `supabase/migrations/`.

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
