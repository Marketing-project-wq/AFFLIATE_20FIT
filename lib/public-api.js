'use strict';
// /api/v1: read-only affiliate data for other 20FIT systems (my.20fit.id,
// the my 20FIT app's backend), authenticated with an API key.
//
// Keys are created and revoked by a Super admin in /admin/settings and kept
// by the consumer as a server-side secret (never in a browser or the app
// itself). The key goes in `Authorization: Bearer <key>`. Every check that
// matters (key, revoked, scope, which fields come back) happens in the
// affiliate_api_* database functions, which this server calls with its
// publishable key only; see
// supabase/migrations/20261015120000_affiliate_api_clients.sql.
//
// Here: the key's format and environment (afk_live_ keys on production,
// afk_test_ keys on staging), a per-key request limit, and routing.

const KEY_RE = /^afk_(live|test)_[0-9a-f]{48}$/;
const CODE_RE = /^[A-Za-z0-9-]{1,40}$/;
const TIMEOUT_MS = 8000;
const WINDOW_MS = 60 * 1000;

const ERRORS = {
  missing_key: [401, 'Missing API key. Send it as "Authorization: Bearer <key>".'],
  invalid_api_key: [401, 'Invalid or revoked API key.'],
  wrong_environment: [401, 'This API key is for another environment.'],
  scope_not_allowed: [403, 'This API key is not allowed to use this endpoint.'],
  not_found: [404, 'Not found.'],
  bad_request: [400, 'Invalid request.'],
  rate_limited: [429, 'Too many requests. Try again in a minute.'],
  method: [405, 'Only GET is supported.'],
};

class PublicApiError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function createPublicApi({ supabaseUrl, supabaseKey, environment, ratePerMinute, productLabel }) {
  const prefix = environment === 'staging' ? 'afk_test_' : 'afk_live_';
  const limit = Number(ratePerMinute) > 0 ? Number(ratePerMinute) : 120;
  const hits = new Map();

  function limited(keyPrefix) {
    const now = Date.now();
    const recent = (hits.get(keyPrefix) || []).filter((t) => now - t < WINDOW_MS);
    recent.push(now);
    hits.set(keyPrefix, recent);
    if (hits.size > 10000) hits.clear();
    return recent.length > limit;
  }

  async function call(fn, args) {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const message = String(body.message || '');
    for (const code of ['invalid_api_key', 'scope_not_allowed', 'not_found']) {
      if (message.includes(code)) throw new PublicApiError(code);
    }
    throw new Error(`${fn}: ${message || `HTTP ${res.status}`}`);
  }

  const int = (v) => (v === null || v === '' || !/^\d{1,6}$/.test(v) ? undefined : Number(v));

  async function route(path, q, key) {
    if (path === 'program') return call('affiliate_api_program', { p_key: key });
    if (path === 'affiliates') {
      return call('affiliate_api_affiliates', { p_key: key, p_limit: int(q.get('limit')), p_offset: int(q.get('offset')) });
    }
    const m = /^affiliates\/([^/]+)\/stats$/.exec(path);
    if (m) {
      const code = decodeURIComponent(m[1]);
      if (!CODE_RE.test(code)) throw new PublicApiError('bad_request');
      return call('affiliate_api_affiliate_stats', { p_key: key, p_code: code });
    }
    if (path === 'commissions') {
      const since = q.get('since');
      if (since && Number.isNaN(Date.parse(since))) throw new PublicApiError('bad_request');
      const code = q.get('code');
      if (code && !CODE_RE.test(code)) throw new PublicApiError('bad_request');
      const r = await call('affiliate_api_commissions', {
        p_key: key, p_since: since ? new Date(since).toISOString() : null, p_limit: int(q.get('limit')), p_code: code || null,
      });
      // Product name next to the source table, as the dashboard shows it.
      r.items = (r.items || []).map((c) => ({ ...c, product: productLabel(c.source_table) }));
      return r;
    }
    throw new PublicApiError('not_found');
  }

  // Returns { status, body } for /api/v1/<path>.
  async function handle(req, url, path) {
    let keyPrefix = '-';
    try {
      if (req.method !== 'GET') throw new PublicApiError('method');
      const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
      if (!m) throw new PublicApiError('missing_key');
      const key = m[1];
      if (!KEY_RE.test(key)) throw new PublicApiError('invalid_api_key');
      keyPrefix = key.slice(0, 17);
      if (!key.startsWith(prefix)) throw new PublicApiError('wrong_environment');
      if (limited(keyPrefix)) throw new PublicApiError('rate_limited');
      const data = await route(path, url.searchParams, key);
      console.log(`api/v1 ${path} ${keyPrefix} 200`);
      return { status: 200, body: { data } };
    } catch (err) {
      const [status, message] = ERRORS[err.code] || [500, 'Something went wrong. Please try again.'];
      if (status === 500) console.error(`api/v1 ${path} ${keyPrefix}:`, err.message);
      else console.log(`api/v1 ${path} ${keyPrefix} ${status}`);
      return { status, body: { error: { code: err.code || 'server_error', message } } };
    }
  }

  return { handle };
}

module.exports = { createPublicApi };
