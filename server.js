'use strict';
// Serves the affiliate site. The landing page and /assets are public; the
// affiliate dashboard needs a 20FIT account, checked against Supabase Auth
// (the same accounts the 20FIT app uses), and the admin pages an account in
// public.affiliate_admins.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createAffiliateData } = require('./lib/affiliate-data');
const { renderLanding } = require('./lib/landing-view');
const { renderSettingsPage, parseForm } = require('./lib/admin-settings-view');
const { loginPage, forgotPage } = require('./lib/auth-pages');
const Calc = require('./public/assets/affiliate-calc.js');

const PORT = Number(process.env.PORT) || 3000;
// Public values (the publishable key ships in every Supabase client), so they
// default here and can be overridden per environment.
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://cpvzwqptzcxnwzfzgrmt.supabase.co').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_0t9vEOYeIo_YM1__X5iNMQ_qXofEozw';

// The 20FIT account service (my.20fit.id). The app signs people in there,
// so the browser checks passwords against it too; see public/assets/auth.js.
const ACCOUNTS_URL = (process.env.ACCOUNTS_URL || 'https://my.20fit.id').replace(/\/+$/, '');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DASHBOARD_PATH = '/dashboard';
// Earlier addresses of the dashboard (and a common misspelling).
const OLD_DASHBOARD_PATHS = ['/affiliatedashboard', '/affiliatedashbaord', '/dashboard.html'];
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
  dashboard: read('dashboard.html'),
  admin: read('admin.html'),
};

function read(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

// Hand-written assets keep their names, so their URLs carry a content hash
// for the year-long asset cache.
function versioned(name) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, 'assets', name))).digest('hex');
  return `/assets/${name}?v=${hash.slice(0, 12)}`;
}

const landingAssets = {
  cssHref: versioned('landing.css'),
  calcHref: versioned('affiliate-calc.js'),
  jsHref: versioned('landing.js'),
};

const authScript = versioned('auth.js');

const affiliateData = createAffiliateData({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY });

// ── helpers ─────────────────────────────────────────────────────────────

// App store and support links: an environment variable wins, otherwise
// affiliate_settings.landing_content. Missing ones are simply not shown.
function siteLinks(settings) {
  const content = (settings && settings.landingContent) || {};
  const pick = (env, key) => {
    const v = String(process.env[env] || content[key] || '').trim();
    return /^https:\/\/\S+$/.test(v) ? v : '';
  };
  return {
    appStore: pick('APP_STORE_URL', 'app_store_url'),
    playStore: pick('PLAY_STORE_URL', 'play_store_url'),
    support: pick('SUPPORT_URL', 'support_url'),
    terms: (settings && /^https:\/\//.test(settings.termsUrl || '') && settings.termsUrl) || '',
  };
}

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

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function redirect(res, location, cookies, status = 302) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookies) headers['Set-Cookie'] = cookies;
  send(res, status, '', headers);
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

// Turns the one-time email code the 20FIT account service hands out after a
// correct password into a Supabase session (same as the app's verifyOtp).
async function verifyEmailOtp(email, token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token }),
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
  return user ? { user, cookies, accessToken } : null;
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

// The dashboard design hard-codes the commission scheme in its copy; these
// swap in the configured values. (Its "2.5%" for PPh 21 is a tax rate and
// stays.)
function schemeCopy(settings) {
  const days = settings.pendingDays;
  const rate = Calc.percent(settings.commissionRate).replace(',', '.');
  return [
    ['Commission is held for 14 days after payment.', `Commission is held for ${days} days after payment.`],
    ['Released 14 days after payment', `Released ${days} days after payment`],
    ['Refunded within the 14-day hold', `Refunded within the ${days}-day hold`],
    ["Commission becomes available 14 days after your friend's payment", `Commission becomes available ${days} days after your friend's payment`],
    ['Earn 2.5% of every app purchase', `Earn ${rate} of every app purchase`],
    ['2.5% of what they pay in the app', `${rate} of what they pay in the app`],
    ['2.5% of every app purchase by friends', `${rate} of every app purchase by friends`],
    ['MIN = 50000', `MIN = ${settings.minWithdrawal}`],
    ["'Rp50.000 to go'", `'${Calc.rupiah(settings.minWithdrawal)} to go'`],
  ];
}

function renderDashboard(user, settings) {
  const name = displayName(user);
  let html = pages.dashboard
    .split('__AF_USER_NAME_JS__').join(JSON.stringify(name).replace(/</g, '\\u003c'))
    .split('__AF_USER_INITIALS__').join(escapeHtml(initials(name)))
    .split('__AF_USER_EMAIL__').join(escapeHtml(templateSafe(user.email || '')));
  if (settings) {
    for (const [from, to] of schemeCopy(settings)) html = html.split(from).join(to);
  }
  return html;
}

async function renderLogin(opts) {
  const { settings } = await affiliateData.get();
  return loginPage({ ...opts, links: siteLinks(settings), accountsUrl: ACCOUNTS_URL, scriptHref: authScript });
}

const LOGIN_FAILED = 'Email atau password salah. Kalau kamu daftar pakai Google di aplikasi, buat password dulu lewat Lupa password.';
const TOO_MANY = 'Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.';

function forbiddenPage(email) {
  return `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidak ada akses · 20FIT Affiliate</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;font:15px/1.55 system-ui,sans-serif;background:#f6f4f4;color:#141414}
main{max-width:420px;text-align:center}a{color:#b0161f}</style></head>
<body><main><h1>Tidak ada akses ke admin</h1>
<p>Kamu masuk sebagai ${escapeHtml(email)}, yang tidak terdaftar sebagai admin affiliate.</p>
<p><a href="${DASHBOARD_PATH}">Buka dashboard affiliate</a> · <a href="/logout">Keluar</a></p></main></body></html>`;
}

// ── routes ──────────────────────────────────────────────────────────────

async function serveProtected(req, res, url, render) {
  const auth = await authenticate(req);
  if (!auth) {
    return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search).replace(/%2F/g, '/')}`, clearCookies(req));
  }
  const headers = { 'Cache-Control': 'private, no-store' };
  if (auth.cookies) headers['Set-Cookie'] = auth.cookies;
  const result = await render(auth.user, auth.accessToken);
  if (result.redirect) return redirect(res, result.redirect, auth.cookies);
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

// Admin = listed in public.affiliate_admins, with a role (growth, finance
// or super); Supabase answers for the signed-in user's token. Cached
// briefly like the user lookup.
const roleCache = new Map();

async function adminRole(accessToken) {
  const hit = roleCache.get(accessToken);
  if (hit && hit.until > Date.now()) return hit.role;
  const role = await affiliateData.adminRole(accessToken).catch(() => null);
  if (roleCache.size > 1000) roleCache.clear();
  roleCache.set(accessToken, { role, until: Date.now() + USER_CACHE_MS });
  return role;
}

// Form posts must come from this site (on top of SameSite=Lax cookies).
function sameOrigin(req, requireOrigin = false) {
  const origin = req.headers.origin;
  if (!origin) return !requireOrigin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function settingsPage(user, accessToken, role, extra = {}) {
  const [settings, audit] = await Promise.all([
    affiliateData.adminSettings(accessToken),
    affiliateData.auditLog(accessToken).catch((err) => {
      console.error('audit log:', err.message);
      return null;
    }),
  ]);
  return renderSettingsPage({ settings, audit, role, email: user.email || '', ...extra });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  if (p.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) return serveAsset(req, res, p);

  if ((method === 'GET' || method === 'HEAD') && OLD_DASHBOARD_PATHS.includes(p)) {
    return send(res, 301, '', { Location: DASHBOARD_PATH + url.search, 'Cache-Control': 'public, max-age=3600' });
  }

  if (method === 'GET' || method === 'HEAD') {
    switch (p) {
      case '/':
      case '/index.html':
        return send(res, 200, renderLanding(await affiliateData.get(), landingAssets), { 'Cache-Control': 'public, max-age=60' });
      case DASHBOARD_PATH:
        return serveProtected(req, res, url, async (user) => ({ body: renderDashboard(user, (await affiliateData.get()).settings) }));
      case '/admin.html':
        return redirect(res, '/admin');
      case '/admin':
        return serveProtected(req, res, url, async (user, token) =>
          (await adminRole(token)) ? { body: pages.admin } : { status: 403, body: forbiddenPage(user.email || '') });
      case '/admin/settings':
        return serveProtected(req, res, url, async (user, token) => {
          const role = await adminRole(token);
          if (!role) return { status: 403, body: forbiddenPage(user.email || '') };
          const notice = url.searchParams.get('saved') ? 'Perubahan disimpan dan dicatat di riwayat.' : '';
          return { body: await settingsPage(user, token, role, { notice }) };
        });
      case '/login': {
        const next = safeNext(url.searchParams.get('next'));
        const auth = await authenticate(req);
        if (auth) return redirect(res, next, auth.cookies);
        const email = (url.searchParams.get('email') || '').slice(0, 200);
        return send(res, 200, await renderLogin({ next, email }), { 'Cache-Control': 'no-store' });
      }
      case '/lupa-password': {
        const { settings } = await affiliateData.get();
        const email = (url.searchParams.get('email') || '').slice(0, 200);
        return send(res, 200, forgotPage({ email, links: siteLinks(settings), accountsUrl: ACCOUNTS_URL, scriptHref: authScript }),
          { 'Cache-Control': 'no-store' });
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
      return send(res, 429, await renderLogin({ next, email, error: TOO_MANY }), { 'Cache-Control': 'no-store' });
    }
    const session = email && password ? await supabaseToken('password', { email, password }) : null;
    if (!session) {
      return send(res, 401, await renderLogin({ next, email, error: LOGIN_FAILED }), { 'Cache-Control': 'no-store' });
    }
    return redirect(res, next, sessionCookies(req, session));
  }

  // Second half of the app-account sign-in (public/assets/auth.js): the
  // browser got a one-time code from the 20FIT account service for a
  // correct password and swaps it for a session here.
  if (method === 'POST' && p === '/login/otp') {
    if (!sameOrigin(req, true)) return sendJson(res, 403, { error: 'Forbidden' });
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch {
      return sendJson(res, 400, { error: LOGIN_FAILED });
    }
    if (tooManyAttempts(clientIp(req))) return sendJson(res, 429, { error: TOO_MANY });
    const email = String(body.email || '').trim().toLowerCase();
    const otp = String(body.otp || '').trim();
    const session = email && /^\d{6,10}$/.test(otp) ? await verifyEmailOtp(email, otp) : null;
    if (!session) return sendJson(res, 401, { error: LOGIN_FAILED });
    return sendJson(res, 200, { redirect: safeNext(body.next) }, { 'Set-Cookie': sessionCookies(req, session) });
  }

  if (method === 'POST' && p === '/admin/settings') {
    if (!sameOrigin(req)) return send(res, 403, 'Forbidden');
    const form = new URLSearchParams(await readBody(req, 64 * 1024));
    return serveProtected(req, res, url, async (user, token) => {
      const role = await adminRole(token);
      if (!role) return { status: 403, body: forbiddenPage(user.email || '') };
      const values = Object.fromEntries(form);
      let patch;
      try {
        patch = parseForm(form, affiliateData.PRICE_TABLES);
      } catch (err) {
        return { status: 400, body: await settingsPage(user, token, role, { values, error: err.message }) };
      }
      if (!Object.keys(patch).length) {
        return { status: 403, body: await settingsPage(user, token, role, { error: 'Peranmu tidak bisa mengubah pengaturan ini.' }) };
      }
      const result = await affiliateData.updateSettings(token, patch);
      if (!result.ok) {
        return { status: 400, body: await settingsPage(user, token, role, { values, error: `Gagal menyimpan: ${result.message}` }) };
      }
      return { redirect: '/admin/settings?saved=1' };
    });
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
