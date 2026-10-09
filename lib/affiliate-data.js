'use strict';
// Reads the affiliate settings (public.affiliate_settings) and the prices of
// the calculator's products from the booking tables in Supabase. Everything
// here is publicly readable under RLS, so the publishable key is enough.

// Booking tables a calculator product may be priced from. All have `price`
// and `is_active` columns.
const PRICE_TABLES = new Set(['booking_products', 'gym_day_pass_config', 'gym_membership_plans', 'clinic_services']);
const COLUMN = /^[a-z_][a-z0-9_]*$/;

const CACHE_MS = 60 * 1000;
const TIMEOUT_MS = 4000;

function createAffiliateData({ supabaseUrl, supabaseKey }) {
  let cached = null; // { at, value }
  let inflight = null;

  async function rest(path, accessToken) {
    const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${accessToken || supabaseKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Supabase ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }

  // The columns anon may read (column grants in the migration); admins get
  // the whole row from affiliate_admin_get_settings().
  const PUBLIC_COLUMNS = 'commission_rate,min_withdrawal,pending_days,monthly_potential,sales_targets,' +
    'calculator_products,program_status,terms_version,terms_url,terms_summary,landing_content';

  function mapSettings(s) {
    return {
      commissionRate: Number(s.commission_rate),
      minWithdrawal: Number(s.min_withdrawal),
      pendingDays: Number(s.pending_days),
      monthlyPotential: Number(s.monthly_potential),
      salesTargets: Array.isArray(s.sales_targets) ? s.sales_targets : [],
      calculatorProducts: Array.isArray(s.calculator_products) ? s.calculator_products : [],
      programStatus: s.program_status || 'active',
      termsVersion: s.terms_version,
      termsUrl: s.terms_url,
      termsSummary: s.terms_summary,
      landingContent: s.landing_content || {},
      // Admin-only columns (undefined on the public read).
      onePurchasePerOpen: s.one_purchase_per_open,
      taxRateNpwp: s.tax_rate_npwp === undefined ? undefined : Number(s.tax_rate_npwp),
      taxRateNoNpwp: s.tax_rate_no_npwp === undefined ? undefined : Number(s.tax_rate_no_npwp),
      fraudDeviceAccounts: s.fraud_device_accounts,
      fraudDeviceWindowHours: s.fraud_device_window_hours,
      fraudSpikeMultiplier: s.fraud_spike_multiplier === undefined ? undefined : Number(s.fraud_spike_multiplier),
      fraudRefundRatio: s.fraud_refund_ratio === undefined ? undefined : Number(s.fraud_refund_ratio),
      updatedAt: s.updated_at,
      updatedBy: s.updated_by,
    };
  }

  async function readSettings() {
    const rows = await rest(`affiliate_settings?id=eq.1&select=${PUBLIC_COLUMNS}`);
    if (!rows.length) throw new Error('affiliate_settings has no row');
    return mapSettings(rows[0]);
  }

  async function rpc(name, accessToken, args = {}) {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: supabaseKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function adminSettings(accessToken) {
    return mapSettings(await rpc('affiliate_admin_get_settings', accessToken));
  }

  // One request per product; a product whose row is missing or inactive is
  // left out rather than failing the whole calculator.
  async function readPrice(item) {
    if (!item || !PRICE_TABLES.has(item.table)) return null;
    const params = new URLSearchParams({ select: 'price', is_active: 'eq.true', order: 'price.asc', limit: '1' });
    for (const [column, value] of Object.entries(item.match || {})) {
      if (!COLUMN.test(column)) return null;
      params.set(column, `eq.${value}`);
    }
    try {
      const rows = await rest(`${item.table}?${params}`);
      const price = rows.length ? Number(rows[0].price) : NaN;
      return price > 0 ? { label: String(item.label), price: Math.round(price) } : null;
    } catch (err) {
      console.error(`price for ${item.label}:`, err.message);
      return null;
    }
  }

  async function load() {
    const settings = await readSettings();
    const products = (await Promise.all(settings.calculatorProducts.map(readPrice))).filter(Boolean);
    return { settings, products };
  }

  // Fresh for a minute; after that the cached copy is still served at once
  // while it refreshes in the background, so only the very first request
  // waits on Supabase. If a refresh fails, the last good copy stays; with
  // none, { settings: null, products: [] } and the page shows its empty
  // states.
  async function get() {
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const refresh = refreshOnce();
    return cached ? cached.value : refresh;
  }

  function refreshOnce() {
    if (!inflight) {
      inflight = load()
        .then((value) => {
          cached = { at: Date.now(), value };
          return value;
        })
        .catch((err) => {
          console.error('affiliate data:', err.message);
          return cached ? cached.value : { settings: null, products: [] };
        })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }

  function invalidate() {
    cached = null;
  }

  // Admin-only reads and writes, made with the signed-in admin's own token so
  // Supabase applies its RLS and role checks. Returns 'growth', 'finance',
  // 'super' or null.
  async function adminRole(accessToken) {
    const role = await rpc('affiliate_admin_role', accessToken);
    return typeof role === 'string' ? role : null;
  }

  async function auditLog(accessToken, limit = 50) {
    return rest(`affiliate_settings_audit?select=changed_at,changed_by,field,old_value,new_value&order=changed_at.desc,id.desc&limit=${limit}`, accessToken);
  }

  // Returns { ok: true } or { ok: false, message }.
  async function updateSettings(accessToken, patch) {
    try {
      await rpc('affiliate_update_settings', accessToken, { patch });
      invalidate();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  return { get, invalidate, readSettings, adminSettings, adminRole, auditLog, updateSettings, PRICE_TABLES };
}

module.exports = { createAffiliateData };
