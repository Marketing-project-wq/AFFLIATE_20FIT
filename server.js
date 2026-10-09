'use strict';
// Serves the affiliate site. The landing page and /assets are public; the
// affiliate dashboard and the admin console need a 20FIT account, checked
// against Supabase Auth (the same accounts the 20FIT app uses).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
// Public values (the publishable key ships in every Supabase client), so they
// default here and can be overridden per environment.
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://cpvzwqptzcxnwzfzgrmt.supabase.co').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_0t9vEOYeIo_YM1__X5iNMQ_qXofEozw';
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);

const PUBLIC_DIR = path.join(__dirname, 'public');
const DASHBOARD_PATH = '/affiliatedashboard';
const ACCESS_COOKIE = 'af_at';
const REFRESH_COOKIE = 'af_rt';
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const pages = {
  landing: read('index.html'),
  dashboard: read('dashboard.html'),
  admin: read('admin.html'),
};

function read(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

// ── helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Values end up inside a dc template, where {{ … }} is an expression.
function templateSafe(s) {
  return String(s).replace(/[{}]/g, '');
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || !/^(localhost|127\.0\.0\.1)(:|$)/.test(req.headers.host || '');
}

function cookie(req, name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (isSecure(req) ? '; Secure' : '');
}

function sessionCookies(req, session) {
  return [
    cookie(req, ACCESS_COOKIE, session.access_token, REFRESH_MAX_AGE),
    cookie(req, REFRESH_COOKIE, session.refresh_token, REFRESH_MAX_AGE),
  ];
}

function clearCookies(req) {
  return [cookie(req, ACCESS_COOKIE, '', 0), cookie(req, REFRESH_COOKIE, '', 0)];
}

// Only same-site paths, so ?next= can't bounce people to another domain.
function safeNext(next) {
  return typeof next === 'string' && /^\/(?![\/\\])/.test(next) ? next : DASHBOARD_PATH;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers,
  });
  res.end(body);
}

function redirect(res, location, cookies) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookies) headers['Set-Cookie'] = cookies;
  send(res, 302, '', headers);
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ── Supabase Auth ───────────────────────────────────────────────────────

async function supabaseToken(grant, payload) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return null;
  const session = await res.json();
  return session.access_token && session.refresh_token ? session : null;
}

async function fetchUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  return res.ok ? res.json() : null;
}

function tokenExpiry(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// Short cache so every page load doesn't round-trip to Supabase.
const userCache = new Map();
const USER_CACHE_MS = 60 * 1000;

async function cachedUser(accessToken) {
  const hit = userCache.get(accessToken);
  if (hit && hit.until > Date.now()) return hit.user;
  const user = await fetchUser(accessToken);
  if (user) {
    if (userCache.size > 1000) userCache.clear();
    userCache.set(accessToken, { user, until: Date.now() + USER_CACHE_MS });
  }
  return user;
}

// Returns { user, cookies } for a signed-in request, refreshing an expired
// access token when a refresh token is present; null otherwise.
async function authenticate(req) {
  const jar = parseCookies(req);
  let accessToken = jar[ACCESS_COOKIE];
  const refreshToken = jar[REFRESH_COOKIE];
  let cookies = null;

  if ((!accessToken || tokenExpiry(accessToken) < Date.now() + 30 * 1000) && refreshToken) {
    const session = await supabaseToken('refresh_token', { refresh_token: refreshToken });
    if (!session) return null;
    accessToken = session.access_token;
    cookies = sessionCookies(req, session);
  }
  if (!accessToken) return null;
  const user = await cachedUser(accessToken);
  return user ? { user, cookies } : null;
}

// Per-IP limit on password attempts; Supabase only sees this server's IP.
const attempts = new Map();
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
  recent.push(now);
  attempts.set(ip, recent);
  if (attempts.size > 10000) attempts.clear();
  return recent.length > MAX_ATTEMPTS;
}

// ── pages ───────────────────────────────────────────────────────────────

function displayName(user) {
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || (user.email || '').split('@')[0] || 'Affiliate';
  return templateSafe(name).trim().slice(0, 80) || 'Affiliate';
}

function initials(name) {
  const letters = name.split(/\s+/).map((w) => (w.match(/[\p{L}\p{N}]/u) || [])[0]).filter(Boolean);
  if (!letters.length) return '?';
  return (letters[0] + (letters.length > 1 ? letters[letters.length - 1] : '')).toUpperCase();
}

function renderDashboard(user) {
  const name = displayName(user);
  return pages.dashboard
    .split('__AF_USER_NAME_JS__').join(JSON.stringify(name).replace(/</g, '\\u003c'))
    .split('__AF_USER_INITIALS__').join(escapeHtml(initials(name)))
    .split('__AF_USER_EMAIL__').join(escapeHtml(templateSafe(user.email || '')));
}

function loginPage({ next, email = '', error = '' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in · 20FIT Affiliate</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Manrope:wght@400..700&display=swap">
<style>
  :root { --bg: #f6f4f4; --text: #141414; --muted: #5c5c5c; --accent: #e5262f; --accent-dark: #b0161f; --line: rgba(20,20,20,.12); }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
    font: 15px/1.55 Manrope, system-ui, sans-serif; color: var(--text);
    background: radial-gradient(680px 520px at 6% 0%, rgba(255,154,159,.55), transparent 70%),
                radial-gradient(900px 600px at 50% 115%, rgba(255,217,219,.8), transparent 70%), var(--bg);
  }
  .card {
    width: 100%; max-width: 400px; padding: 32px 28px; border-radius: 24px;
    background: linear-gradient(155deg, rgba(255,255,255,.85), rgba(255,255,255,.6));
    box-shadow: inset 0 0 0 1px rgba(20,20,20,.07), 0 16px 40px rgba(90,20,24,.12);
    backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  }
  .brand { font: 800 15px/1 'Barlow Condensed', sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  h1 { font: 800 34px/1.05 'Barlow Condensed', 'Arial Narrow', sans-serif; margin: 10px 0 6px; }
  p { margin: 0 0 22px; color: var(--muted); }
  label { display: block; font-weight: 600; font-size: 13px; margin: 14px 0 6px; }
  input {
    width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
    font: inherit; background: rgba(255,255,255,.9); color: var(--text);
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  button {
    width: 100%; margin-top: 22px; padding: 13px 16px; border: 0; border-radius: 999px; cursor: pointer;
    font: 700 17px/1 'Barlow Condensed', sans-serif; letter-spacing: .03em; color: #fff; background: var(--accent);
  }
  button:hover { background: var(--accent-dark); }
  .error { margin: 0 0 6px; padding: 10px 12px; border-radius: 12px; background: #fff0f0; color: var(--accent-dark); font-size: 14px; }
  .foot { margin-top: 20px; font-size: 13px; color: var(--muted); text-align: center; }
  .foot a { color: var(--accent-dark); }
</style>
</head>
<body>
<main class="card">
  <div class="brand">20FIT Affiliate</div>
  <h1>Log in to your dashboard</h1>
  <p>Use the email and password of your 20FIT app account.</p>
  ${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${escapeHtml(email)}" ${email ? '' : 'autofocus'}>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required ${email ? 'autofocus' : ''}>
    <button type="submit">Log in</button>
  </form>
  <div class="foot">Forgot your password? Reset it in the 20FIT app.<br><a href="/">Back to the affiliate program</a></div>
</main>
</body>
</html>`;
}

function forbiddenPage(email) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>No access · 20FIT Affiliate</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;font:15px/1.55 system-ui,sans-serif;background:#f6f4f4;color:#141414}
main{max-width:420px;text-align:center}a{color:#b0161f}</style></head>
<body><main><h1>No access to the admin console</h1>
<p>You're signed in as ${escapeHtml(email)}, which isn't on the admin list.</p>
<p><a href="${DASHBOARD_PATH}">Go to your affiliate dashboard</a> · <a href="/logout">Log out</a></p></main></body></html>`;
}

// ── routes ──────────────────────────────────────────────────────────────

async function serveProtected(req, res, url, render) {
  const auth = await authenticate(req);
  if (!auth) {
    return redirect(res, `/login?next=${encodeURIComponent(url.pathname)}`, clearCookies(req));
  }
  const headers = { 'Cache-Control': 'private, no-store' };
  if (auth.cookies) headers['Set-Cookie'] = auth.cookies;
  const result = render(auth.user);
  send(res, result.status || 200, result.body, headers);
}

function serveAsset(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(path.join(PUBLIC_DIR, 'assets') + path.sep)) return send(res, 404, 'Not found');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      // Asset names are content hashes.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  if (p.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) return serveAsset(req, res, p);

  if (method === 'GET' || method === 'HEAD') {
    switch (p) {
      case '/':
      case '/index.html':
        return send(res, 200, pages.landing, { 'Cache-Control': 'public, max-age=300' });
      // Old links and a common misspelling.
      case '/dashboard.html':
      case '/affiliatedashbaord':
        return redirect(res, DASHBOARD_PATH);
      case DASHBOARD_PATH:
        return serveProtected(req, res, url, (user) => ({ body: renderDashboard(user) }));
      case '/admin.html':
        return redirect(res, '/admin');
      case '/admin':
        return serveProtected(req, res, url, (user) =>
          ADMIN_EMAILS.has(String(user.email || '').toLowerCase())
            ? { body: pages.admin }
            : { status: 403, body: forbiddenPage(user.email || '') });
      case '/login': {
        const next = safeNext(url.searchParams.get('next'));
        const auth = await authenticate(req);
        if (auth) return redirect(res, next, auth.cookies);
        return send(res, 200, loginPage({ next }), { 'Cache-Control': 'no-store' });
      }
      case '/logout':
        return redirect(res, '/login', clearCookies(req));
      case '/healthz':
        return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    }
  }

  if (method === 'POST' && p === '/login') {
    const form = new URLSearchParams(await readBody(req));
    const next = safeNext(form.get('next'));
    const email = (form.get('email') || '').trim();
    const password = form.get('password') || '';
    if (tooManyAttempts(clientIp(req))) {
      return send(res, 429, loginPage({ next, email, error: 'Too many attempts. Please wait a few minutes and try again.' }), { 'Cache-Control': 'no-store' });
    }
    const session = email && password ? await supabaseToken('password', { email, password }) : null;
    if (!session) {
      return send(res, 401, loginPage({ next, email, error: 'That email and password don’t match a 20FIT account.' }), { 'Cache-Control': 'no-store' });
    }
    return redirect(res, next, sessionCookies(req, session));
  }

  send(res, 404, 'Not found');
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Something went wrong. Please try again.');
    else res.end();
  });
}).listen(PORT, () => console.log(`20FIT affiliate site on :${PORT}`));
