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
const { createDashboardApi, friendly } = require('./lib/dashboard-api');

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
  logoHref: versioned('20fit-logo.png'),
};

const authScript = versioned('auth.js');

const affiliateData = createAffiliateData({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY });
const dashboardApi = createDashboardApi({ supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY });
const qrScript = versioned('qrcode.js');

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

// ── Google login (Supabase OAuth, PKCE done server-side) ──────────────────
// The code_verifier lives in an HttpOnly cookie on THIS origin and the code is
// exchanged here, so the whole flow stays on the domain it started on.
const PKCE_COOKIE = 'af_pkce';

// Absolute origin of the current request (honours Railway's x-forwarded-proto),
// so the OAuth redirect comes back to the exact host login started on.
function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || (isSecure(req) ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}
function pkceVerifier() {
  return crypto.randomBytes(32).toString('base64url'); // 43 chars, within the RFC 7636 range
}
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
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

// The settings the dashboard shows (rate, minimum, hold, terms, program
// status), never anything admin-only.
function publicSettings(settings) {
  if (!settings) return null;
  return {
    commissionRate: settings.commissionRate, minWithdrawal: settings.minWithdrawal, pendingDays: settings.pendingDays,
    programStatus: settings.programStatus, termsVersion: settings.termsVersion,
    termsUrl: /^https:\/\//.test(settings.termsUrl || '') ? settings.termsUrl : '', termsSummary: settings.termsSummary || '',
  };
}

// JSON inside a <script>: no way to close the tag or break the line.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// The page is the dc design (src/dashboard.dc.html, built by
// tools/unbundle.py) and serves Home, Sales and Profile; the server fills
// in the affiliate's own data first so it never paints empty, and later
// actions go through /api/affiliate/*.
const DASHBOARD_PAGES = { [DASHBOARD_PATH]: 'home', [`${DASHBOARD_PATH}/sales`]: 'sales', [`${DASHBOARD_PATH}/profile`]: 'profile' };
const PAGE_TITLES = { home: 'Home', sales: 'Sales', profile: 'Profile' };

async function renderDashboard(user, token, page) {
  const { settings } = await affiliateData.get();
  const [state, account] = await Promise.all([
    dashboardApi.state(token).catch((err) => {
      console.error('dashboard state:', err.message);
      return { error: friendly(err) };
    }),
    // Name for the header; a failure here only hides it.
    dashboardApi.account(token).catch((err) => {
      console.error('dashboard account:', err.message);
      return null;
    }),
  ]);
  const data = {
    page,
    user: { name: (account && account.found && account.name) || displayName(user), email: user.email || '' },
    settings: publicSettings(settings),
    links: siteLinks(settings),
    state,
    account,
    qrSrc: qrScript,
  };
  const head = `<title>${PAGE_TITLES[page]} · 20FIT Affiliate</title><script>window.__AF_DATA__ = ${scriptJson(data)};</script>`;
  return pages.dashboard.replace('<head>', `<head>${head}`).split('__AF_LOGO_SRC__').join(escapeHtml(landingAssets.logoHref));
}

async function renderLogin(opts) {
  const { settings } = await affiliateData.get();
  return loginPage({ ...opts, links: siteLinks(settings), accountsUrl: ACCOUNTS_URL, scriptHref: authScript });
}

const LOGIN_FAILED = 'Email atau password salah. Kalau kamu daftar pakai Google, pilih Lanjut dengan Google.';
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
        // Safety net: an OAuth redirect that lands on "/" carrying ?code=/?error=
        // (e.g. GoTrue fell back to Site URL) is forwarded to /auth/callback intact.
        if (url.searchParams.has('code') || url.searchParams.has('error')) {
          return redirect(res, '/auth/callback' + url.search);
        }
        return send(res, 200, renderLanding(await affiliateData.get(), landingAssets), { 'Cache-Control': 'public, max-age=60' });
      case DASHBOARD_PATH:
      case `${DASHBOARD_PATH}/sales`:
      case `${DASHBOARD_PATH}/profile`:
        return serveProtected(req, res, url, async (user, token) => ({ body: await renderDashboard(user, token, DASHBOARD_PAGES[p]) }));
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
      case '/auth/google': {
        // Start Google OAuth: mint a PKCE verifier, keep it in an HttpOnly cookie
        // on this origin, and send the user to Supabase. The code comes back to
        // /auth/callback on this SAME origin, where we hold the verifier.
        const next = safeNext(url.searchParams.get('next'));
        const verifier = pkceVerifier();
        const challenge = pkceChallenge(verifier);
        const callback = `${originOf(req)}/auth/callback?next=${encodeURIComponent(next)}`;
        const authorize = `${SUPABASE_URL}/auth/v1/authorize?provider=google` +
          `&redirect_to=${encodeURIComponent(callback)}` +
          `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=s256`;
        return redirect(res, authorize, [cookie(req, PKCE_COOKIE, verifier, 600)]);
      }
      case '/auth/callback': {
        const next = safeNext(url.searchParams.get('next'));
        const providerErr = url.searchParams.get('error_description') || url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const verifier = parseCookies(req)[PKCE_COOKIE];
        const clearPkce = cookie(req, PKCE_COOKIE, '', 0);
        if (providerErr) {
          return send(res, 401, await renderLogin({ next, error: 'Masuk dengan Google dibatalkan atau gagal. Coba lagi, atau masuk dengan email dan password.' }), { 'Cache-Control': 'no-store', 'Set-Cookie': clearPkce });
        }
        if (!code || !verifier) {
          // No verifier = sign-in was started elsewhere (other device/tab) or the
          // cookie expired. Don't hang — ask them to retry from this page.
          return send(res, 400, await renderLogin({ next, error: 'Masuk dengan Google belum selesai. Coba lagi dari halaman ini.' }), { 'Cache-Control': 'no-store', 'Set-Cookie': clearPkce });
        }
        const session = await supabaseToken('pkce', { auth_code: code, code_verifier: verifier });
        if (!session) {
          return send(res, 401, await renderLogin({ next, error: 'Masuk dengan Google tidak berhasil. Coba lagi, atau masuk dengan email dan password.' }), { 'Cache-Control': 'no-store', 'Set-Cookie': clearPkce });
        }
        return redirect(res, next, [...sessionCookies(req, session), clearPkce]);
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

  if (p.startsWith('/api/affiliate/')) return handleApi(req, res, url, p.slice('/api/affiliate/'.length), method);

  send(res, 404, 'Not found');
}

// ── /api/affiliate/* ────────────────────────────────────────────────────
// Thin layer over the 20FIT app's `affiliate` function (lib/dashboard-api.js)
// for the dashboard's actions.
// The token stays in the HttpOnly cookie; the browser never holds it.

async function handleApi(req, res, url, route, method) {
  if (method === 'POST' && !sameOrigin(req, true)) return sendJson(res, 403, { error: 'Forbidden' });
  const auth = await authenticate(req);
  if (!auth) return sendJson(res, 401, { error: 'Sesi kamu sudah habis. Masuk lagi.', login: `/login?next=${DASHBOARD_PATH}` }, { 'Set-Cookie': clearCookies(req) });
  const headers = auth.cookies ? { 'Set-Cookie': auth.cookies } : {};
  const token = auth.accessToken;
  const ok = (data) => sendJson(res, 200, data, headers);

  try {
    let body = {};
    if (method === 'POST') {
      const raw = await readBody(req, 4 * 1024);
      body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== 'object') body = {};
    }

    if (method === 'GET') {
      if (route === 'state') return ok(await dashboardApi.state(token));
      if (route === 'account') return ok({ account: await dashboardApi.account(token) });
    }
    if (method === 'POST') {
      if (route === 'join') {
        if (body.agree !== true) return sendJson(res, 400, { error: 'Centang persetujuan S&K dulu.' }, headers);
        const { settings } = await affiliateData.get();
        if (settings && settings.programStatus === 'paused') return sendJson(res, 400, { error: 'Pendaftaran affiliate sedang ditutup sementara.' }, headers);
        return ok({ affiliate: await dashboardApi.join(token, body) });
      }
      if (route === 'bank') return ok({ affiliate: await dashboardApi.updateBank(token, body) });
      if (route === 'payout') return ok({ payout: await dashboardApi.requestPayout(token, body.amount) });
      if (route === 'account') return ok({ account: await dashboardApi.saveAccount(token, auth.user && auth.user.id, body) });
    }
    return sendJson(res, 404, { error: 'Not found' }, headers);
  } catch (err) {
    if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'Permintaan tidak valid.' }, headers);
    if (err.status === 401) return sendJson(res, 401, { error: 'Sesi kamu sudah habis. Masuk lagi.', login: `/login?next=${DASHBOARD_PATH}` });
    if (err.status === 404) return sendJson(res, 404, { error: 'Tidak ditemukan.' }, headers);
    console.error(`api ${route}:`, err.message);
    return sendJson(res, 400, { error: friendly(err) }, headers);
  }
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Something went wrong. Please try again.');
    else res.end();
  });
}).listen(PORT, () => console.log(`20FIT affiliate site on :${PORT}`));
