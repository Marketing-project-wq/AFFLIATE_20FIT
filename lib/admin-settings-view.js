'use strict';
// /admin/settings: edit affiliate_settings and see its audit log.

const Calc = require('../public/assets/affiliate-calc.js');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const FIELD_LABELS = {
  commission_rate: 'Rate komisi',
  min_withdrawal: 'Minimal klaim',
  pending_days: 'Masa tahan',
  monthly_potential: 'Potensi komisi per bulan',
  sales_targets: 'Target penjualan',
  calculator_products: 'Produk kalkulator',
  program_status: 'Status program',
  one_purchase_per_open: 'Satu buka link = satu transaksi',
  tax_rate_npwp: 'PPh 21 (dengan NPWP)',
  tax_rate_no_npwp: 'PPh 21 (tanpa NPWP)',
  terms_version: 'Versi S&K',
  terms_url: 'Link S&K lengkap',
  terms_summary: 'Ringkasan S&K',
  fraud_device_accounts: 'Ambang akun per perangkat',
  fraud_device_window_hours: 'Jendela perangkat (jam)',
  fraud_spike_multiplier: 'Ambang lonjakan transaksi',
  fraud_refund_ratio: 'Ambang rasio refund',
  landing_content: 'Isi landing link',
};

// Same split as affiliate_update_settings(): money and program state are
// Super admin only, the rest Growth or Super; Finance reads only.
const FINANCIAL = new Set(['commission_rate', 'min_withdrawal', 'pending_days', 'tax_rate_npwp', 'tax_rate_no_npwp',
  'program_status', 'one_purchase_per_open']);

function canEdit(role, field) {
  if (role === 'super') return true;
  if (role === 'growth') return !FINANCIAL.has(field);
  return false;
}

const ROLE_LABELS = { super: 'Super admin', growth: 'Growth', finance: 'Finance' };

// Text forms of the two list settings, one entry per line.
function targetsToText(list) {
  return list.map((t) => `${t.category} = ${t.target}`).join('\n');
}

function productsToText(list) {
  return list.map((p) => {
    const match = Object.entries(p.match || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return [p.label, p.table, match].filter(Boolean).join(' | ');
  }).join('\n');
}

function parseTargets(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const m = line.match(/^(.+?)\s*=\s*(\d+)$/);
    if (!m) throw new Error(`Target penjualan baris ${i + 1}: tulis "Kategori = angka".`);
    return { category: m[1].trim(), target: Number(m[2]) };
  });
}

function parseProducts(text, tables) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line, i) => {
    const [label, table, matchText = ''] = line.split('|').map((s) => s.trim());
    if (!label || !tables.has(table)) {
      throw new Error(`Produk kalkulator baris ${i + 1}: tulis "Label | tabel | kolom=nilai", dengan tabel salah satu dari ${[...tables].join(', ')}.`);
    }
    const match = {};
    for (const pair of matchText.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = pair.match(/^([a-z_][a-z0-9_]*)\s*=\s*(.+)$/);
      if (!m) throw new Error(`Produk kalkulator baris ${i + 1}: filter "${pair}" harus berbentuk kolom=nilai.`);
      match[m[1]] = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
    }
    return { label, table, match };
  });
}

function wholeNumber(value, label) {
  const n = Number(String(value).replace(/[.\s]/g, ''));
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} harus angka bulat 0 atau lebih.`);
  return n;
}

// "2,5" (percent) -> 0.025
function percentField(value, label, max = 100) {
  const n = Number(String(value).replace(',', '.'));
  if (!(n >= 0 && n < max)) throw new Error(`${label} harus antara 0 dan ${max}%.`);
  return Math.round(n * 100) / 10000;
}

function positiveNumber(value, label) {
  const n = Number(String(value).replace(',', '.'));
  if (!(n > 0)) throw new Error(`${label} harus lebih dari 0.`);
  return n;
}

// Form body -> patch for affiliate_update_settings(). Fields the admin's
// role can't edit are disabled in the form, so browsers don't send them
// and they stay out of the patch. Throws with a message for the admin when
// something doesn't parse.
function parseForm(form, tables) {
  const patch = {};
  const has = (k) => form.has(k);
  if (has('commission_rate')) {
    patch.commission_rate = percentField(form.get('commission_rate'), 'Rate komisi');
    if (!(patch.commission_rate > 0)) throw new Error('Rate komisi harus lebih dari 0%.');
  }
  if (has('min_withdrawal')) patch.min_withdrawal = wholeNumber(form.get('min_withdrawal'), 'Minimal klaim');
  if (has('pending_days')) patch.pending_days = wholeNumber(form.get('pending_days'), 'Masa tahan');
  if (has('tax_rate_npwp')) patch.tax_rate_npwp = percentField(form.get('tax_rate_npwp'), 'PPh 21 dengan NPWP');
  if (has('tax_rate_no_npwp')) patch.tax_rate_no_npwp = percentField(form.get('tax_rate_no_npwp'), 'PPh 21 tanpa NPWP');
  if (has('program_status')) {
    const st = form.get('program_status');
    if (!['active', 'paused'].includes(st)) throw new Error('Status program tidak dikenal.');
    patch.program_status = st;
  }
  if (has('one_purchase_per_open')) patch.one_purchase_per_open = form.get('one_purchase_per_open') === 'true';
  if (has('monthly_potential')) patch.monthly_potential = wholeNumber(form.get('monthly_potential'), 'Potensi komisi per bulan');
  if (has('sales_targets')) patch.sales_targets = parseTargets(form.get('sales_targets') || '');
  if (has('calculator_products')) patch.calculator_products = parseProducts(form.get('calculator_products') || '', tables);
  if (has('terms_version')) {
    patch.terms_version = String(form.get('terms_version')).trim();
    if (!patch.terms_version) throw new Error('Versi S&K wajib diisi.');
  }
  if (has('terms_url')) {
    patch.terms_url = String(form.get('terms_url')).trim() || null;
    if (patch.terms_url && !/^https:\/\/\S+$/.test(patch.terms_url)) throw new Error('Link S&K harus diawali https://.');
  }
  if (has('terms_summary')) patch.terms_summary = String(form.get('terms_summary')).trim() || null;
  if (has('fraud_device_accounts')) {
    patch.fraud_device_accounts = wholeNumber(form.get('fraud_device_accounts'), 'Ambang akun per perangkat');
    if (patch.fraud_device_accounts < 2) throw new Error('Ambang akun per perangkat minimal 2.');
  }
  if (has('fraud_device_window_hours')) patch.fraud_device_window_hours = wholeNumber(form.get('fraud_device_window_hours'), 'Jendela perangkat');
  if (has('fraud_spike_multiplier')) {
    patch.fraud_spike_multiplier = positiveNumber(form.get('fraud_spike_multiplier'), 'Ambang lonjakan');
    if (patch.fraud_spike_multiplier <= 1) throw new Error('Ambang lonjakan harus lebih dari 1×.');
  }
  if (has('fraud_refund_ratio')) patch.fraud_refund_ratio = percentField(form.get('fraud_refund_ratio'), 'Ambang rasio refund', 100.01);
  return patch;
}

function showValue(field, value) {
  if (value === null || value === undefined) return '–';
  if (['commission_rate', 'tax_rate_npwp', 'tax_rate_no_npwp', 'fraud_refund_ratio'].includes(field)) return Calc.percent(Number(value));
  if (field === 'min_withdrawal' || field === 'monthly_potential') return Calc.rupiah(Number(value));
  if (field === 'pending_days') return `${value} hari`;
  if (field === 'program_status') return value === 'paused' ? 'Dijeda' : 'Aktif';
  if (field === 'one_purchase_per_open') return value ? 'Ya' : 'Tidak';
  if (field === 'fraud_spike_multiplier') return `${value}×`;
  if (typeof value === 'string') return value;
  if (field === 'sales_targets' && Array.isArray(value)) return targetsToText(value).replace(/\n/g, '; ');
  if (field === 'calculator_products' && Array.isArray(value)) return productsToText(value).replace(/\n/g, '; ');
  return JSON.stringify(value);
}

const pct = (rate) => String(Math.round(Number(rate) * 10000) / 100).replace('.', ',');

function renderSettingsPage({ settings, values, audit, role, email, notice, error }) {
  const v = {
    commission_rate: pct(settings.commissionRate),
    min_withdrawal: settings.minWithdrawal,
    pending_days: settings.pendingDays,
    tax_rate_npwp: pct(settings.taxRateNpwp),
    tax_rate_no_npwp: pct(settings.taxRateNoNpwp),
    program_status: settings.programStatus,
    one_purchase_per_open: String(settings.onePurchasePerOpen),
    monthly_potential: settings.monthlyPotential,
    sales_targets: targetsToText(settings.salesTargets),
    calculator_products: productsToText(settings.calculatorProducts),
    terms_version: settings.termsVersion,
    terms_url: settings.termsUrl || '',
    terms_summary: settings.termsSummary || '',
    fraud_device_accounts: settings.fraudDeviceAccounts,
    fraud_device_window_hours: settings.fraudDeviceWindowHours,
    fraud_spike_multiplier: settings.fraudSpikeMultiplier,
    fraud_refund_ratio: pct(settings.fraudRefundRatio),
    ...(values || {}),
  };
  // Inputs the role can't change are disabled (and so not submitted).
  const off = (field) => (canEdit(role, field) ? '' : ' disabled');
  const input = (field, label, hint = '', mode = 'numeric') =>
    `<div><label for="f-${field}">${label}</label><input id="f-${field}" name="${field}" inputmode="${mode}" required value="${esc(v[field])}"${off(field)}>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  const select = (field, label, options, hint = '') =>
    `<div><label for="f-${field}">${label}</label><select id="f-${field}" name="${field}"${off(field)}>${options.map(([val, text]) =>
      `<option value="${val}"${String(v[field]) === val ? ' selected' : ''}>${text}</option>`).join('')}</select>${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
  const canSave = role === 'super' || role === 'growth';
  const when = (iso) => new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short' });
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pengaturan komisi · 20FIT Affiliate</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Manrope:wght@400..700&display=swap">
<style>
  :root { --bg: #f6f4f4; --text: #141414; --muted: #5c5c5c; --accent: #e5262f; --accent-dark: #b0161f; --line: rgba(20,20,20,.12); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 Manrope, system-ui, sans-serif; color: var(--text); background: var(--bg); }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; max-width: 1040px; margin: 0 auto; padding: 20px 16px 0; font-size: 14px; }
  header .brand { font: 800 18px/1 'Barlow Condensed', sans-serif; letter-spacing: .06em; margin-right: auto; }
  header a { color: var(--accent-dark); }
  main { max-width: 1040px; margin: 0 auto; padding: 16px 16px 64px; display: grid; gap: 24px; }
  h1 { font: 800 36px/1.05 'Barlow Condensed', sans-serif; margin: 8px 0 0; }
  h2 { font: 800 24px/1.1 'Barlow Condensed', sans-serif; margin: 0 0 12px; }
  .card { background: #fff; border-radius: 18px; padding: 22px; box-shadow: inset 0 0 0 1px rgba(20,20,20,.07), 0 10px 28px rgba(90,20,24,.08); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 16px; }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; }
  .hint { display: block; font-weight: 400; color: var(--muted); font-size: 12px; margin-top: 4px; }
  input, textarea, select { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); font: inherit; background: #fff; }
  input:disabled, textarea:disabled, select:disabled { background: #f3f1f1; color: var(--muted); }
  h3 { font: 800 19px/1.1 'Barlow Condensed', sans-serif; margin: 22px 0 10px; }
  .role { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #fff0f0; color: var(--accent-dark); font-size: 12px; font-weight: 600; }
  textarea { min-height: 170px; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
  input:focus, textarea:focus { outline: 2px solid var(--accent); border-color: transparent; }
  .actions { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
  button { padding: 11px 22px; border: 0; border-radius: 999px; cursor: pointer; font: 700 16px/1 'Barlow Condensed', sans-serif; letter-spacing: .03em; color: #fff; background: var(--accent); }
  button:hover { background: var(--accent-dark); }
  .notice, .error { padding: 12px 14px; border-radius: 12px; font-size: 14px; }
  .notice { background: #eaf7ee; color: #1e5b32; }
  .error { background: #fff0f0; color: var(--accent-dark); }
  .meta { color: var(--muted); font-size: 13px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); padding: 8px; border-bottom: 1px solid var(--line); }
  td { padding: 10px 8px; border-bottom: 1px solid rgba(20,20,20,.06); vertical-align: top; }
  td.val { max-width: 320px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<header><span class="brand">20FIT AFFILIATE</span><a href="/admin">Admin console</a><a href="/">Landing page</a><span class="meta">${esc(email)}</span><a href="/logout">Keluar</a></header>
<main>
  <div><h1>Pengaturan program</h1>
  <p class="meta">Peranmu: <span class="role">${esc(ROLE_LABELS[role] || role)}</span>. Rate, pajak, masa tahan, minimal klaim, dan jeda program hanya bisa diubah Super admin; sisanya Growth atau Super admin. Perubahan rate hanya berlaku untuk transaksi yang lunas setelahnya. Semua perubahan tampil di landing dalam 1 menit dan tercatat di riwayat.${settings.updatedAt ? ` Terakhir diubah ${esc(when(settings.updatedAt))}${settings.updatedBy ? ` oleh ${esc(settings.updatedBy)}` : ''}.` : ''}</p></div>
  ${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ''}
  ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/admin/settings" class="card">
    <h2>Skema komisi</h2>
    <div class="grid">
      ${input('commission_rate', 'Rate komisi (%)', 'Flat untuk semua produk, contoh 2,5', 'decimal')}
      ${input('pending_days', 'Masa tahan (hari)', 'Dihitung sejak transaksi lunas')}
      ${input('min_withdrawal', 'Minimal klaim (Rp)', 'Saldo Tersedia minimal untuk bisa klaim')}
      ${select('one_purchase_per_open', 'Satu buka link = satu transaksi', [['true', 'Ya'], ['false', 'Tidak']], 'Ya: pembelian ulang perlu membuka link lagi')}
    </div>
    <h3>Pajak (PPh 21, konfirmasi finance)</h3>
    <div class="grid">
      ${input('tax_rate_npwp', 'Potongan dengan NPWP (%)', '', 'decimal')}
      ${input('tax_rate_no_npwp', 'Potongan tanpa NPWP (%)', '', 'decimal')}
    </div>
    <h3>Program</h3>
    <div class="grid">
      ${select('program_status', 'Status program', [['active', 'Aktif'], ['paused', 'Dijeda']], 'Dijeda: tidak ada affiliate atau link baru; transaksi setelah jeda tidak dihitung')}
      ${input('terms_version', 'Versi S&amp;K', 'Mengganti versi meminta semua affiliate setuju ulang sebelum klaim berikutnya', 'text')}
      <div><label for="f-terms_url">Link S&amp;K lengkap</label><input id="f-terms_url" name="terms_url" inputmode="url" value="${esc(v.terms_url)}"${off('terms_url')}></div>
    </div>
    <div style="margin-top:16px"><label for="f-terms_summary">Ringkasan S&amp;K</label><textarea id="f-terms_summary" name="terms_summary" style="min-height:90px;font-family:inherit"${off('terms_summary')}>${esc(v.terms_summary)}</textarea></div>
    <h3>Landing page</h3>
    <div class="grid">
      ${input('monthly_potential', 'Potensi komisi per bulan (Rp)', 'Tampil sebagai "Rp…+" di kalkulator')}
    </div>
    <div class="grid" style="margin-top:16px">
      <div><label for="targets">Target penjualan per bulan</label><textarea id="targets" name="sales_targets" spellcheck="false"${off('sales_targets')}>${esc(v.sales_targets)}</textarea><span class="hint">Satu kategori per baris: <code>Kategori = jumlah pax</code></span></div>
      <div><label for="products">Produk di kalkulator</label><textarea id="products" name="calculator_products" spellcheck="false"${off('calculator_products')}>${esc(v.calculator_products)}</textarea><span class="hint">Satu chip per baris: <code>Label | tabel | kolom=nilai</code>. Harga diambil dari baris aktif yang cocok (termurah kalau ada beberapa). Tabel: booking_products, gym_day_pass_config, gym_membership_plans, clinic_services.</span></div>
    </div>
    <h3>Anti-fraud (ditandai untuk ditinjau)</h3>
    <div class="grid">
      ${input('fraud_device_accounts', 'Akun dari satu perangkat', 'Jumlah akun berbeda yang membuka link dari perangkat yang sama')}
      ${input('fraud_device_window_hours', 'Dalam jendela (jam)')}
      ${input('fraud_spike_multiplier', 'Lonjakan transaksi (×)', 'Transaksi 24 jam dibanding rata-rata harian 30 hari', 'decimal')}
      ${input('fraud_refund_ratio', 'Rasio refund (%)', 'Dalam 90 hari, minimal 5 transaksi', 'decimal')}
    </div>
    ${canSave ? '<div class="actions"><button type="submit">Simpan perubahan</button><span class="meta">Hanya kolom yang berubah yang dicatat.</span></div>'
      : '<p class="meta" style="margin-top:18px">Peran Finance hanya bisa melihat pengaturan.</p>'}
  </form>
  <section class="card">
    <h2>Riwayat perubahan</h2>
    ${audit === null ? '<p class="meta">Riwayat sedang tidak bisa dimuat.</p>' : audit.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Waktu (WIB)</th><th>Oleh</th><th>Pengaturan</th><th>Lama</th><th>Baru</th></tr></thead>
      <tbody>${audit.map((a) => `<tr><td>${esc(when(a.changed_at))}</td><td>${esc(a.changed_by)}</td><td>${esc(FIELD_LABELS[a.field] || a.field)}</td><td class="val">${esc(showValue(a.field, a.old_value))}</td><td class="val">${esc(showValue(a.field, a.new_value))}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="meta">Belum ada perubahan.</p>'}
  </section>
</main>
</body>
</html>`;
}

module.exports = { renderSettingsPage, parseForm };
