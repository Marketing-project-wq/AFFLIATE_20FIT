# 20FIT Affiliate

The 20FIT affiliate site, deployed on Railway as a small Node server
(`server.js`, no dependencies).

| Path                  | Page                | Access                                  |
| --------------------- | ------------------- | --------------------------------------- |
| `/`                   | Landing page        | Public                                  |
| `/affiliatedashboard` | Affiliate dashboard | Any signed-in 20FIT account             |
| `/admin`              | Affiliate admin     | Signed-in accounts listed in `ADMIN_EMAILS` |
| `/login`, `/logout`   | Sign in / out       | Public                                  |

`/affiliatedashbaord` and `/dashboard.html` redirect to `/affiliatedashboard`.

## Sign-in

People sign in with the email and password of their 20FIT app account. The
server checks them against Supabase Auth (project "20FIT ALL DATA") and keeps
the session in HttpOnly cookies. The dashboard still shows sample numbers;
only the name, avatar initials and email come from the signed-in account.

## Environment variables

| Variable                   | Required | Purpose                                                        |
| -------------------------- | -------- | -------------------------------------------------------------- |
| `ADMIN_EMAILS`             | Yes, for `/admin` | Comma-separated emails allowed into the admin console |
| `SUPABASE_URL`             | No       | Defaults to the 20FIT ALL DATA project                         |
| `SUPABASE_PUBLISHABLE_KEY` | No       | Defaults to that project's publishable key                     |
| `PORT`                     | No       | Set by Railway                                                 |

## Updating a page

The pages are designed in a design tool and exported as self-unpacking
bundles. Put the exported file in `src/bundles/` (`landing.html`,
`dashboard.html` or `admin.html`), then run:

```sh
npm run build   # python3 tools/unbundle.py
```

This writes plain HTML to `public/` and the assets to `public/assets/`, and
swaps the dashboard's prototype toolbar for the signed-in account bar.
Commit both. Run locally with `npm start` (port 3000).
