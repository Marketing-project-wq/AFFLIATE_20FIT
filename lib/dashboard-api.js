'use strict';
// Data behind /dashboard and /api/affiliate/*. The affiliate program is the
// one in the 20FIT app: the Supabase Edge Function `affiliate`
// (/functions/v1/affiliate, actions me | join | update_bank |
// request_payout) and its tables (my20fit_affiliates, …_commissions,
// …_payouts, …_clicks). Every call goes out with the signed-in user's own
// token and the publishable key: the function works out who they are from
// the token, and RLS lets them read only their own commission, payout and
// click rows. Responses are cut down to what the page shows (bank account
// numbers are masked, for instance). The affiliate's KTP details live in
// my20fit_affiliate_identity, reached only through its functions.

const TIMEOUT_MS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Reasons and errors from the `affiliate` function, in the dashboard's
// language. Anything else becomes a generic message (and is logged).
const MESSAGES = {
  missing_bank_details: 'Isi nama bank, nomor rekening, dan nama pemilik rekening.',
  not_affiliate: 'Kamu belum bergabung di program affiliate.',
  invalid_amount: 'Jumlah penarikan tidak valid.',
  below_minimum: 'Jumlah penarikan di bawah minimum.',
  insufficient_available: 'Saldo Tersedia tidak cukup untuk jumlah itu.',
  no_bank_on_file: 'Isi data rekening dulu sebelum menarik saldo.',
  join_failed: 'Pendaftaran belum berhasil. Coba lagi sebentar lagi.',
  update_failed: 'Rekening belum tersimpan. Coba lagi sebentar lagi.',
  payout_failed: 'Penarikan belum berhasil diajukan. Coba lagi sebentar lagi.',
};

// Product names for the commission ledger's source_table, the same labels
// the `affiliate` function uses in its history.
const PRODUCT_LABELS = {
  arena_class_bookings: 'Arena Class',
  gym_class_bookings: 'Gym Class',
  arena_bookings: 'Arena Rental',
  arena_package_orders: 'Arena Package',
  coach_package_orders: 'Coach Package',
  clinic_bookings: 'Clinic',
  gym_membership_orders: 'Gym Membership',
  my20fit_scan_orders: 'Shop',
  seed_test: 'Test',
};
function productLabel(src) {
  if (PRODUCT_LABELS[src]) return PRODUCT_LABELS[src];
  return String(src || '').replace(/^my20fit_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Errors from the affiliate_identity_* functions.
const IDENTITY_MESSAGES = [
  [/NIK must be 16 digits/i, 'NIK harus 16 angka.'],
  [/Missing KTP field/i, 'Lengkapi semua data KTP dan domisili.'],
  [/Invalid birth date/i, 'Tanggal lahir tidak valid.'],
  [/Invalid gender/i, 'Pilih jenis kelamin.'],
  [/Invalid citizenship/i, 'Pilih kewarganegaraan.'],
  [/already saved/i, 'Data KTP sudah tersimpan dan tidak bisa diubah. Hubungi tim affiliate 20FIT kalau ada yang salah.'],
  [/not saved yet/i, 'Isi data KTP dulu.'],
];

function friendly(err) {
  if (err instanceof ApiError && err.expose) return err.message;
  if (MESSAGES[err.message]) return MESSAGES[err.message];
  for (const [re, text] of IDENTITY_MESSAGES) if (re.test(err.message || '')) return text;
  return 'Terjadi kesalahan. Coba lagi sebentar lagi.';
}

// KTP fields, in the order the form and Profile show them.
const KTP_FIELDS = ['nik', 'full_name', 'birth_place', 'birth_date', 'gender', 'address', 'rt_rw', 'kecamatan',
  'kabupaten', 'provinsi', 'citizenship'];
const DOMICILE_FIELDS = ['domicile_address', 'domicile_city', 'domicile_province', 'domicile_postal_code'];
const clean = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const sameName = (a, b) => clean(a).replace(/\s+/g, ' ').toLowerCase() === clean(b).replace(/\s+/g, ' ').toLowerCase();

const mask = (no) => {
  const d = String(no || '').replace(/\s/g, '');
  return d ? `••••${d.slice(-4)}` : '';
};

function createDashboardApi({ supabaseUrl, supabaseKey }) {
  async function request(path, token, { method = 'GET', body, prefer } = {}) {
    const headers = { apikey: supabaseKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${supabaseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status === 401 ? 401 : 400, (data && (data.message || data.error)) || `HTTP ${res.status}`);
    return data;
  }
  const rest = (path, token) => request(`/rest/v1/${path}`, token);
  const rpc = (name, token, args = {}) => request(`/rest/v1/rpc/${name}`, token, { method: 'POST', body: args });

  // One action of the app's `affiliate` function. Validation answers come
  // back as { ok: false, reason } (sometimes with a 200), hard errors as
  // { error }.
  async function app(token, action, fields = {}) {
    const res = await fetch(`${supabaseUrl}/functions/v1/affiliate`, {
      method: 'POST',
      headers: { apikey: supabaseKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...fields }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new ApiError(401, (data && data.error) || 'invalid_token');
    if (!res.ok || !data || data.ok === false || data.error) {
      const err = new ApiError(400, (data && (data.reason || data.error)) || `HTTP ${res.status}`);
      if (data && data.reason === 'below_minimum' && data.minimum) {
        err.message = `Minimal penarikan Rp${Number(data.minimum).toLocaleString('id-ID')}.`;
        err.expose = true;
      }
      throw err;
    }
    return data;
  }

  function cleanMe(me) {
    const b = me.bank || {};
    return {
      code: me.code, link: me.link, status: me.status, termsVersion: me.termsVersion, joinedAt: me.joinedAt,
      nextPayoutDate: me.nextPayoutDate,
      bank: b.name ? { name: b.name, account: mask(b.accountNo), holder: b.accountName || '' } : null,
    };
  }
  const cleanStats = (s = {}) => ({
    available: Number(s.availableBalance) || 0, pending: Number(s.pendingBalance) || 0,
    total: Number(s.totalEarned) || 0, friends: Number(s.friendsCount) || 0,
  });

  // Everything the page needs on first paint: the `affiliate` function's
  // `me` (profile, live balances, buyers, recent history), plus the
  // affiliate's own ledger rows for the charts, payouts and clicks.
  async function state(token) {
    const [me, ident, appUse] = await Promise.all([app(token, 'me'), identity(token), appStatus(token)]);
    if (!me.joined) return { joined: false, currentTerms: me.currentTerms || '', identity: ident, appInstalled: appUse.installed };
    const [comms, payouts, clicks] = await Promise.all([
      rest('my20fit_affiliate_commissions?select=source_table,commission_amount,status,order_paid_at,created_at,hold_until' +
        '&order=created_at.desc&limit=2000', token),
      rest('my20fit_affiliate_payouts?select=id,amount,status,bank_name,bank_account_no,requested_at,processed_at' +
        '&order=requested_at.desc&limit=50', token),
      rest('my20fit_affiliate_clicks?select=clicked_at,source&order=clicked_at.desc&limit=2000', token),
    ]);
    return {
      joined: true,
      identity: ident,
      appInstalled: appUse.installed,
      affiliate: cleanMe(me),
      stats: cleanStats(me.stats),
      // First names only, as the function returns them.
      referrals: (me.referrals || []).map((r) => ({ name: r.name || '', at: r.joinedAt })),
      // Commission per paid order; what the buyer paid is not passed on.
      commissions: comms.map((c) => ({
        product: productLabel(c.source_table), amount: Number(c.commission_amount) || 0, status: c.status,
        at: c.order_paid_at || c.created_at, holdUntil: c.hold_until,
      })),
      payouts: payouts.map((p) => ({
        id: p.id, amount: Number(p.amount) || 0, status: p.status, bank: p.bank_name || '', account: mask(p.bank_account_no),
        requestedAt: p.requested_at, processedAt: p.processed_at,
      })),
      clicks: clicks.map((c) => ({ at: c.clicked_at, source: c.source || '' })),
    };
  }

  function bankFields(f) {
    const name = String(f.bank || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    const account = String(f.account || '').replace(/\D/g, '');
    const holder = String(f.holder || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!name || !holder) throw new ApiError(400, 'missing_bank_details');
    if (!/^\d{6,20}$/.test(account)) {
      const e = new ApiError(400, 'Nomor rekening tidak valid.');
      e.expose = true;
      throw e;
    }
    const out = { bankName: name, bankAccountNo: account, bankAccountName: holder };
    // Only the bank codes the app's backend is known to use.
    if (/^[A-Z_]{2,20}$/.test(f.code || '')) out.bankCode = f.code;
    return out;
  }

  // ── KTP details (my20fit_affiliate_identity, through its functions) ──
  async function identity(token) {
    const r = await rpc('affiliate_identity_me', token);
    return r && r.nik ? r : null;
  }
  function identityFields(f, fields) {
    const out = {};
    for (const k of fields) out[k] = clean(f && f[k], k === 'address' || k === 'domicile_address' ? 300 : 120);
    return out;
  }
  async function saveIdentity(token, f) {
    await requireApp(token);
    return storeIdentity(token, f);
  }
  async function storeIdentity(token, f) {
    const body = identityFields(f, KTP_FIELDS.concat(DOMICILE_FIELDS));
    body.nik = body.nik.replace(/\D/g, '');
    return rpc('affiliate_identity_save', token, { p: body });
  }
  const updateDomicile = (token, f) => rpc('affiliate_identity_update_domicile', token, { p: identityFields(f, DOMICILE_FIELDS) });

  // The payout account must be in the name on the KTP.
  function checkHolder(ident, f) {
    if (ident && !sameName(ident.full_name, f.holder)) {
      const e = new ApiError(400, 'Nama pemilik rekening harus sama dengan nama di KTP.');
      e.expose = true;
      throw e;
    }
  }

  // ── the 20FIT app ──
  // Signing up needs the app: the account must have used the 20FIT app on a
  // phone (affiliate_app_status, from the app's own events and push tokens).
  async function appStatus(token) {
    const r = await rpc('affiliate_app_status', token);
    return { installed: !!(r && r.installed) };
  }
  async function requireApp(token) {
    if (!(await appStatus(token)).installed) {
      throw exposed('Download app 20FIT dan masuk dengan akun ini dulu, baru bisa daftar jadi affiliate.');
    }
  }

  // ── actions ──
  // Joining: the app first, then the KTP details (saved once), then the
  // app's `join` with the bank details.
  async function join(token, f) {
    const bank = bankFields(f);
    await requireApp(token);
    let ident = await identity(token);
    if (!ident) ident = await storeIdentity(token, f.identity || {});
    checkHolder(ident, f);
    const me = await app(token, 'join', bank);
    return { affiliate: cleanMe(me), identity: ident };
  }
  async function updateBank(token, f) {
    const bank = bankFields(f);
    checkHolder(await identity(token), f);
    return cleanMe(await app(token, 'update_bank', bank));
  }
  async function requestPayout(token, amount) {
    if (!(await identity(token))) {
      const e = new ApiError(400, 'Lengkapi data KTP dulu sebelum menarik saldo.');
      e.expose = true;
      throw e;
    }
    const n = amount === undefined || amount === null || amount === '' ? undefined : Math.floor(Number(amount));
    if (n !== undefined && !(n > 0)) throw new ApiError(400, 'invalid_amount');
    const r = await app(token, 'request_payout', n === undefined ? {} : { amount: n });
    return { amount: Number(r.payout && r.payout.amount) || 0, payoutDate: r.payoutDate, available: Number(r.newAvailable) || 0 };
  }

  // The 20FIT account itself (public.my20fit_profile, the same row the app
  // and my.20fit.id use). RLS limits it to the signed-in user's own row.
  async function account(token) {
    const rows = await rest('my20fit_profile?select=full_name,phone,email,avatar_url&limit=1', token);
    return cleanAccount(rows[0]);
  }
  function cleanAccount(p) {
    // The profile photo only when it is a plain https URL (it ends up in CSS).
    const photo = /^https:\/\/[^\s"'\\<>()]+$/.test(p && p.avatar_url || '') ? p.avatar_url : '';
    return p ? { found: true, name: p.full_name || '', phone: p.phone || '', email: p.email || '', photo } : { found: false };
  }
  // Only the name and phone number can change here; email is the sign-in.
  async function saveAccount(token, userId, f) {
    if (!UUID.test(userId || '')) throw new ApiError(401, 'no user');
    const name = String(f.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
    const phone = String(f.phone || '').replace(/[\s().-]/g, '');
    if (name.length < 2 || name.length > 80) throw exposed('Isi nama 2–80 karakter.');
    if (phone && !/^\+?\d{8,15}$/.test(phone)) throw exposed('Nomor HP pakai 8–15 angka, boleh diawali +.');
    const rows = await request(`/rest/v1/my20fit_profile?auth_user_id=eq.${userId}&select=full_name,phone,email,avatar_url`, token,
      { method: 'PATCH', body: { full_name: name, phone: phone || null }, prefer: 'return=representation' });
    if (!rows || !rows.length) throw exposed('Profil 20FIT kamu belum ada. Lengkapi dulu di aplikasi 20FIT.');
    return cleanAccount(rows[0]);
  }
  function exposed(message) {
    const e = new ApiError(400, message);
    e.expose = true;
    return e;
  }

  return { state, identity, saveIdentity, updateDomicile, join, updateBank, requestPayout, account, saveAccount, appStatus };
}

module.exports = { createDashboardApi, friendly, ApiError };
