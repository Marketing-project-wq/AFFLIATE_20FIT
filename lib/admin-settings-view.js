'use strict';
// /admin/settings: edit affiliate_settings and see its audit log.

const Calc = require('../public/assets/affiliate-calc.js');

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const FIELD_LABELS = {
  commission_rate: 'Rate komisi',
  min_withdrawal: 'Minimal tarik dana',
  pending_days: 'Masa pending',
  monthly_potential: 'Potensi komisi per bulan',
  sales_targets: 'Target penjualan',
  calculator_products: 'Produk kalkulator',
};

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

// Form body -> patch for affiliate_update_settings(). Throws with a message
// for the admin when something doesn't parse.
function parseForm(form, tables) {
  const rate = Number(String(form.get('commission_rate') || '').replace(',', '.'));
  if (!(rate > 0 && rate < 100)) throw new Error('Rate komisi harus lebih dari 0% dan kurang dari 100%.');
  return {
    commission_rate: Math.round(rate * 100) / 10000,
    min_withdrawal: wholeNumber(form.get('min_withdrawal'), 'Minimal tarik dana'),
    pending_days: wholeNumber(form.get('pending_days'), 'Masa pending'),
    monthly_potential: wholeNumber(form.get('monthly_potential'), 'Potensi komisi per bulan'),
    sales_targets: parseTargets(form.get('sales_targets') || ''),
    calculator_products: parseProducts(form.get('calculator_products') || '', tables),
  };
}

function showValue(field, value) {
  if (value === null || value === undefined) return '–';
  if (field === 'commission_rate') return Calc.percent(Number(value));
  if (field === 'min_withdrawal' || field === 'monthly_potential') return Calc.rupiah(Number(value));
  if (field === 'pending_days') return `${value} hari`;
  if (field === 'sales_targets' && Array.isArray(value)) return targetsToText(value).replace(/\n/g, '; ');
  if (field === 'calculator_products' && Array.isArray(value)) return productsToText(value).replace(/\n/g, '; ');
  return JSON.stringify(value);
}

function renderSettingsPage({ settings, values, audit, email, notice, error }) {
  const v = values || {
    commission_rate: String(Math.round(settings.commissionRate * 10000) / 100).replace('.', ','),
    min_withdrawal: settings.minWithdrawal,
    pending_days: settings.pendingDays,
    monthly_potential: settings.monthlyPotential,
    sales_targets: targetsToText(settings.salesTargets),
    calculator_products: productsToText(settings.calculatorProducts),
  };
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
  input, textarea { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); font: inherit; background: #fff; }
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
  <div><h1>Pengaturan komisi</h1>
  <p class="meta">Dipakai oleh kalkulator dan teks di landing page. Perubahan tampil dalam 1 menit dan tercatat di riwayat di bawah.${settings.updatedAt ? ` Terakhir diubah ${esc(when(settings.updatedAt))}${settings.updatedBy ? ` oleh ${esc(settings.updatedBy)}` : ''}.` : ''}</p></div>
  ${notice ? `<div class="notice" role="status">${esc(notice)}</div>` : ''}
  ${error ? `<div class="error" role="alert">${esc(error)}</div>` : ''}
  <form method="post" action="/admin/settings" class="card">
    <h2>Skema komisi</h2>
    <div class="grid">
      <div><label for="rate">Rate komisi (%)</label><input id="rate" name="commission_rate" inputmode="decimal" required value="${esc(v.commission_rate)}"><span class="hint">Berlaku untuk semua produk, contoh 2,5</span></div>
      <div><label for="min">Minimal tarik dana (Rp)</label><input id="min" name="min_withdrawal" inputmode="numeric" required value="${esc(v.min_withdrawal)}"></div>
      <div><label for="pending">Masa pending (hari)</label><input id="pending" name="pending_days" inputmode="numeric" required value="${esc(v.pending_days)}"><span class="hint">Dihitung setelah sesi selesai</span></div>
      <div><label for="potential">Potensi komisi per bulan (Rp)</label><input id="potential" name="monthly_potential" inputmode="numeric" required value="${esc(v.monthly_potential)}"><span class="hint">Tampil sebagai "Rp…+"</span></div>
    </div>
    <div class="grid" style="margin-top:16px">
      <div><label for="targets">Target penjualan per bulan</label><textarea id="targets" name="sales_targets" spellcheck="false">${esc(v.sales_targets)}</textarea><span class="hint">Satu kategori per baris: <code>Kategori = jumlah pax</code></span></div>
      <div><label for="products">Produk di kalkulator</label><textarea id="products" name="calculator_products" spellcheck="false">${esc(v.calculator_products)}</textarea><span class="hint">Satu chip per baris: <code>Label | tabel | kolom=nilai</code>. Harga diambil dari baris aktif yang cocok (termurah kalau ada beberapa). Tabel: booking_products, gym_day_pass_config, gym_membership_plans, clinic_services.</span></div>
    </div>
    <div class="actions"><button type="submit">Simpan perubahan</button><span class="meta">Hanya kolom yang berubah yang dicatat.</span></div>
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
