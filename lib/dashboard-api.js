'use strict';
// Data behind /dashboard and /api/affiliate/*. Every call goes to Supabase
// with the signed-in affiliate's own token and the publishable key, so RLS
// and the affiliate_* functions decide what they can see and do. Responses
// are cut down to the fields the page shows (an affiliate row also carries
// admin notes, for instance).

const TIMEOUT_MS = 6000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Messages from the affiliate_* functions, in the dashboard's language.
// Anything else becomes a generic message (and is logged on the server).
const MESSAGES = [
  [/not joined/i, 'Kamu belum bergabung di program affiliate.'],
  [/account is not active/i, 'Akun affiliate kamu sedang tidak aktif. Hubungi tim affiliate 20FIT.'],
  [/paused; new affiliates/i, 'Pendaftaran affiliate sedang ditutup sementara.'],
  [/paused; new links/i, 'Program sedang dijeda, jadi belum bisa membuat link baru.'],
  [/accept the (current|updated) terms/i, 'Setujui S&K terbaru dulu.'],
  [/code is already taken/i, 'Kode itu sudah dipakai. Coba yang lain.'],
  [/code can only be changed once/i, 'Kode hanya bisa diganti sekali.'],
  [/4.12 letters and digits/i, 'Pakai 4–12 huruf atau angka.'],
  [/not in the affiliate catalog/i, 'Produk itu tidak ada di katalog affiliate.'],
  [/link has been disabled/i, 'Link untuk produk ini sedang dinonaktifkan.'],
  [/payout details first/i, 'Isi data pencairan dulu.'],
  [/claim in progress/i, 'Masih ada klaim yang sedang diproses.'],
  [/below the minimum/i, 'Saldo Tersedia belum mencapai minimum klaim.'],
  [/Adjustments exceed/i, 'Saldo habis untuk potongan penyesuaian (refund setelah pencairan).'],
  [/NIK must be 16 digits/i, 'NIK harus 16 digit.'],
  [/NPWP must be 15 or 16 digits/i, 'NPWP harus 15 atau 16 digit.'],
  [/valid account number/i, 'Nomor rekening tidak valid.'],
];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function friendly(err) {
  if (err instanceof ApiError && err.expose) return err.message;
  for (const [re, text] of MESSAGES) if (re.test(err.message || '')) return text;
  return 'Terjadi kesalahan. Coba lagi sebentar lagi.';
}

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

  // ── reads ──
  async function affiliate(token) {
    const rows = await rest('affiliate?select=code,status,joined_at,terms_version,terms_accepted_at,code_changed_at', token);
    return rows[0] ? cleanAffiliate(rows[0]) : null;
  }

  function cleanAffiliate(a) {
    return {
      code: a.code, status: a.status, joinedAt: a.joined_at, termsVersion: a.terms_version,
      termsAcceptedAt: a.terms_accepted_at, codeChangeable: !a.code_changed_at,
    };
  }

  const products = (token) => rest('affiliate_product?select=slug,name,unit&is_active=eq.true&order=unit.asc,name.asc', token);

  async function links(token, days) {
    const rows = await rpc('affiliate_my_links', token, { p_days: days });
    return rows.map((l) => ({
      id: l.link_id, product: l.product_name, slug: l.product_slug, unit: l.unit, url: l.url, status: l.status,
      opens: Number(l.opens), buyers: Number(l.buyers), transactions: Number(l.transactions), commission: Number(l.commission),
    }));
  }

  async function daily(token, linkId, days) {
    if (!UUID.test(linkId)) throw new ApiError(400, 'bad link id');
    const rows = await rpc('affiliate_my_link_daily', token, { p_link_id: linkId, p_days: days });
    return rows.map((d) => ({ day: d.day, opens: Number(d.opens), transactions: Number(d.transactions), commission: Number(d.commission) }));
  }

  async function commissions(token, linkId) {
    if (linkId && !UUID.test(linkId)) throw new ApiError(400, 'bad link id');
    const rows = await rpc('affiliate_my_commissions', token, { p_link_id: linkId || null });
    // Buyer names come masked from the database; no transaction amounts.
    return rows.slice(0, 300).map((c) => ({
      id: c.commission_id, linkId: c.link_id, product: c.product_name, buyer: c.buyer, at: c.created_at,
      amount: Number(c.amount), status: c.status, availableAt: c.available_at, cancelReason: c.cancel_reason,
    }));
  }

  async function claims(token) {
    const rows = await rest('affiliate_claim?select=id,claim_no,submitted_at,amount_gross,adjustment_amount,tax_rate,tax_amount,' +
      'amount_net,status,payout_snapshot,estimated_transfer_date,transfer_ref,proof_url,reject_reason,paid_at&order=submitted_at.desc&limit=50', token);
    return rows.map(cleanClaim);
  }

  function cleanClaim(c) {
    const snap = c.payout_snapshot || {};
    return {
      id: c.id, no: c.claim_no, submittedAt: c.submitted_at, gross: Number(c.amount_gross), adjustment: Number(c.adjustment_amount || 0),
      taxRate: Number(c.tax_rate), tax: Number(c.tax_amount), net: Number(c.amount_net), status: c.status,
      bank: snap.bank_name || '', account: snap.account_no || '', holder: snap.account_holder || '',
      estimatedTransfer: c.estimated_transfer_date, transferRef: c.transfer_ref, rejectReason: c.reject_reason,
      paidAt: c.paid_at, hasProof: !!c.proof_url,
    };
  }

  async function adjustments(token) {
    const rows = await rest('affiliate_adjustment?select=id,amount,reason,applied_claim_id,created_at&order=created_at.desc&limit=50', token);
    return rows.map((a) => ({ id: a.id, amount: Number(a.amount), reason: a.reason, applied: !!a.applied_claim_id, at: a.created_at }));
  }

  const summary = (token) => rpc('affiliate_my_summary', token);
  const payoutProfile = (token) => rpc('affiliate_my_payout_profile', token);

  // Everything the page needs on first paint.
  async function state(token) {
    const [me, catalog] = await Promise.all([affiliate(token), products(token)]);
    if (!me) return { joined: false, products: catalog };
    const [sum, myLinks, comms, myClaims, adjs, profile] = await Promise.all([
      summary(token), links(token, 30), commissions(token, null), claims(token), adjustments(token), payoutProfile(token),
    ]);
    return { joined: true, affiliate: me, summary: sum, products: catalog, links: myLinks, linksDays: 30,
      commissions: comms, claims: myClaims, adjustments: adjs, payoutProfile: profile };
  }

  // Sales page: totals, weekly and monthly commission, most bought
  // products, all from affiliate_commission (see affiliate_my_sales).
  async function sales(token) {
    const r = await rpc('affiliate_my_sales', token, { p_weeks: 12, p_months: 12 });
    const n = (v) => Number(v) || 0;
    const period = (p) => ({ start: p.start, end: p.end, transactions: n(p.transactions), commission: n(p.commission) });
    const s = r.summary || {};
    return {
      summary: { total: n(s.total), valid: n(s.valid), pending: n(s.pending), cancelled: n(s.cancelled),
        commission_total: n(s.commission_total), commission_valid: n(s.commission_valid), commission_pending: n(s.commission_pending) },
      weekly: (r.weekly || []).map(period), monthly: (r.monthly || []).map(period),
      products: (r.products || []).map((p) => ({ product: p.product, transactions: n(p.transactions), commission: n(p.commission) })),
    };
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

  // ── actions ──
  async function join(token, termsVersion) {
    return cleanAffiliate(await rpc('affiliate_join', token, { p_terms_version: termsVersion }));
  }
  async function acceptTerms(token, termsVersion) {
    return cleanAffiliate(await rpc('affiliate_accept_terms', token, { p_terms_version: termsVersion }));
  }
  async function changeCode(token, code) {
    return cleanAffiliate(await rpc('affiliate_change_code', token, { p_code: String(code || '').trim().toUpperCase() }));
  }
  async function link(token, slug) {
    if (!/^[a-z0-9-]{1,80}$/.test(slug || '')) throw new ApiError(400, 'That product is not in the affiliate catalog');
    const rows = await rpc('affiliate_get_link', token, { p_product_slug: slug });
    const l = rows[0];
    return { id: l.link_id, url: l.url, product: l.product_name };
  }
  async function savePayout(token, f) {
    const digits = (v) => String(v || '').replace(/\D/g, '');
    return rpc('affiliate_save_payout_profile', token, {
      p_ktp_name: String(f.name || '').trim(), p_nik: digits(f.nik), p_npwp: digits(f.npwp),
      p_bank_name: String(f.bank || '').trim(), p_account_no: digits(f.account), p_account_holder: String(f.holder || '').trim(),
    });
  }
  const claimPreview = (token) => rpc('affiliate_claim_preview', token);
  async function submitClaim(token) {
    return cleanClaim(await rpc('affiliate_submit_claim', token));
  }

  // A short-lived link to the proof of transfer, signed with the
  // affiliate's own token: Storage only signs objects its RLS lets them
  // read (their own folder in the private affiliate-proofs bucket).
  async function proofUrl(token, claimId) {
    if (!UUID.test(claimId)) throw new ApiError(404, 'not found');
    const rows = await rest(`affiliate_claim?select=proof_url&id=eq.${claimId}`, token);
    const objectPath = rows[0] && rows[0].proof_url;
    if (!objectPath) throw new ApiError(404, 'not found');
    const encoded = objectPath.split('/').map(encodeURIComponent).join('/');
    const signed = await request(`/storage/v1/object/sign/affiliate-proofs/${encoded}`, token, { method: 'POST', body: { expiresIn: 120 } });
    const rel = signed.signedURL || signed.signedUrl;
    if (!rel) throw new ApiError(404, 'not found');
    return `${supabaseUrl}/storage/v1${rel.startsWith('/') ? rel : `/${rel}`}`;
  }

  return {
    state, summary, links, daily, commissions, claims, adjustments, payoutProfile, sales, account, saveAccount,
    join, acceptTerms, changeCode, link, savePayout, claimPreview, submitClaim, proofUrl,
  };
}

module.exports = { createDashboardApi, friendly, ApiError };
