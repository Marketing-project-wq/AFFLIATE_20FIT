# 20FIT Affiliate

Static pages for the 20FIT affiliate program, deployed on Railway.

| Path              | Page                      |
| ----------------- | ------------------------- |
| `/`               | Landing page              |
| `/dashboard.html` | Affiliate dashboard       |
| `/admin.html`     | Affiliate admin           |

## Updating a page

The pages are designed in a design tool and exported as self-unpacking
bundles. Put the exported file in `src/bundles/` (`landing.html`,
`dashboard.html` or `admin.html`), then run:

```sh
python3 tools/unbundle.py
```

This writes plain HTML to `public/` and the assets to `public/assets/`.
Commit both. Railway serves `public/` (see `Staticfile`).
