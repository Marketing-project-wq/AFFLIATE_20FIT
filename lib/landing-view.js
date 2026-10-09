'use strict';
// Server-rendered landing page. Every number comes from affiliate_settings
// and the booking tables (see lib/affiliate-data.js); the page is complete
// before any JavaScript runs, and public/assets/landing.js only adds the
// calculator's interaction.

const Calc = require('../public/assets/affiliate-calc.js');
const { icon } = require('./icons');

const APP_STORE = 'https://share.google/rBYDxx7PNbZ3uwf8J';
const PLAY_STORE = 'https://share.google/hTFIl5RGl7WRZVJuj';
const DEFAULT_BUYERS = 20;
const DEFAULT_TX = 4;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function productIcon(label) {
  const l = label.toLowerCase();
  if (l.includes('open arena')) return 'sun-horizon';
  if (l.includes('hyrox')) return 'lightning';
  if (l.includes('day pass')) return 'ticket';
  if (l.includes('gym') || l.includes('membership')) return 'barbell';
  if (l.includes('massage')) return 'hand-heart';
  if (l.includes('physio')) return 'first-aid-kit';
  if (l.includes('bundle')) return 'package';
  if (l.includes('arena')) return 'buildings';
  return 'ticket';
}

function storeButtons() {
  return `<div class="stores">
    <a class="store" href="${APP_STORE}" target="_blank" rel="noopener">${icon('apple-logo-fill', { size: 26 })}<span><small>Download di</small><b>App Store</b></span></a>
    <a class="store" href="${PLAY_STORE}" target="_blank" rel="noopener">${icon('google-play-logo-fill', { size: 24 })}<span><small>Tersedia di</small><b>Google Play</b></span></a>
  </div>`;
}

function hero(s, products) {
  const rate = s ? Calc.percent(s.commissionRate) : null;
  const example = s && products[0];
  const flow = example ? `
    <div class="flow glass" aria-label="Contoh satu komisi">
      <div class="kicker">Begini satu komisi terjadi</div>
      <div class="flow-row soft">
        <span class="bubble">${icon('user', { size: 18 })}</span>
        <div>Temanmu beli ${esc(example.label)} lewat link kamu<small>Lunas di app 20FIT</small></div>
        <span class="num">${Calc.rupiah(example.price)}</span>
      </div>
      <div class="flow-step">${icon('arrow-down', { size: 16 })}${rate} untuk kamu</div>
      <div class="flow-row hot">
        <span class="bubble">${icon('coins', { size: 18 })}</span>
        <div>Kamu dapat<small>Tercatat di link produk itu</small></div>
        <span class="amount num">${Calc.rupiah(Calc.commission(example.price, s.commissionRate))}</span>
      </div>
      <div class="lifecycle">
        <div><i></i>Tertahan<small>${s.pendingDays} hari setelah lunas</small></div>
        <div><i></i>Tersedia<small>Klaim mulai ${Calc.rupiah(s.minWithdrawal)}</small></div>
        <div><i></i>Diklaim<small>Kamu yang ajukan</small></div>
        <div><i></i>Dibayar<small>Transfer bank</small></div>
      </div>
    </div>` : '';
  return `<section class="hero">
    <div class="hero-copy">
      <span class="tag soft">Program Affiliate 20FIT</span>
      <h1>Bagikan link produk 20FIT. <em>Dapat komisi</em> tiap ada yang beli.</h1>
      <p class="hero-lead">${rate
        ? `Dapatkan <strong>${rate} dari setiap pembelian di app 20FIT</strong> lewat link produk yang kamu bagikan.`
        : 'Dapatkan komisi dari setiap pembelian di app 20FIT lewat link produk yang kamu bagikan.'}
        Semua pengguna 20FIT bisa jadi affiliate, langsung aktif tanpa approval.</p>
      ${s && s.programStatus === 'paused' ? `<p class="paused-note">${icon('info', { size: 16 })}Program affiliate sedang dijeda sementara. Pendaftaran dan link baru dibuka lagi setelah program aktif kembali.</p>` : ''}
      <div class="hero-actions">
        <a class="btn-cta btn-lg" href="/affiliatedashboard">Gabung jadi Affiliate ${icon('arrow-right', { size: 16 })}</a>
        <a class="text-link" href="#gabung">Lihat cara kerjanya</a>
      </div>
      <a class="text-link" href="/affiliatedashboard">Sudah jadi affiliate? Buka dashboard kamu ${icon('arrow-right', { size: 16 })}</a>
    </div>${flow}
  </section>`;
}

function whatEarns(s, products) {
  const head = `<div class="section-head">
      <h2>Yang menghasilkan komisi</h2>
      <p>Bagikan link untuk produk-produk ini. Setiap pembelian produk itu di app 20FIT lewat link kamu dihitung${s ? `, dan kamu dapat ${Calc.percent(s.commissionRate)} dari yang dibayar pembeli` : ''}.</p>
    </div>`;
  const cards = s && products.length
    ? `<div class="products">${products.map((p) => `
      <div class="product glass">
        <div class="product-head"><span class="bubble">${icon(productIcon(p.label), { size: 22 })}</span><div class="product-name">${esc(p.label)}</div></div>
        <div class="product-foot"><span class="muted num">${Calc.rupiah(p.price)}</span><span class="plus num">+${Calc.rupiah(Calc.commission(p.price, s.commissionRate))}</span></div>
      </div>`).join('')}
    </div>
    <div class="fineprint">Harga sesuai harga di app 20FIT saat ini dan bisa berubah.</div>`
    : emptyState('Daftar produk sedang tidak bisa dimuat.', 'Coba muat ulang halaman ini sebentar lagi.');
  return `<section id="produk">
    ${head}
    ${cards}
    <div class="notes">
      <div class="note soft">${icon('calculator')}<div><b>Dihitung dari yang dibayar pembeli</b>, setelah voucher dan promo bank, tidak termasuk service fee, payment fee, PPN, dan bagian yang dibayar dengan FitPoints.</div></div>
      <div class="note soft">${icon('prohibit')}<div><b>Tidak termasuk:</b> pembelian lewat web, di kasir Cafe atau Clinic, dan kanal lain di luar app. Pembelian lewat link kamu sendiri juga tidak dihitung.</div></div>
    </div>
  </section>`;
}

function emptyState(title, body) {
  return `<div class="calc-empty glass">${icon('info', { size: 22 })}<div><b>${title}</b>${body}</div></div>`;
}

function calculator(s, products) {
  const head = `<div class="section-head">
      <h2>Kalkulator Komisi</h2>
      <p>Geser meter atau pilih produk untuk melihat komisi dari satu transaksi.</p>
    </div>`;
  if (!s || !products.length) {
    return `<section id="kalkulator">${head}${emptyState('Kalkulator sedang tidak bisa dimuat.', 'Coba muat ulang halaman ini sebentar lagi.')}</section>`;
  }

  const scale = Calc.scale(products);
  const amount = products[0].price;
  const comm = Calc.commission(amount, s.commissionRate);
  const commText = Calc.rupiah(comm);
  const m = Calc.meter(amount, scale);
  const ticks = Calc.ticks(scale);
  const G = Calc.GEOMETRY;
  const arc = `M ${G.cx - G.r} ${G.cy} A ${G.r} ${G.r} 0 0 1 ${G.cx + G.r} ${G.cy}`;
  const data = {
    rate: s.commissionRate,
    products,
    scale,
    amount,
  };

  return `<section id="kalkulator">
    ${head}
    <div class="calc-grid" data-calc>
      <div class="calc-meter glass">
        <div class="gauge">
          <svg viewBox="0 0 ${G.width} ${G.height}" role="slider" tabindex="0" aria-label="Nilai transaksi"
               aria-valuemin="${scale.min}" aria-valuemax="${scale.max}" aria-valuenow="${amount}" aria-valuetext="${Calc.rupiah(amount)}" data-gauge>
            <defs><linearGradient id="gaugeRed" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#b0161f"/><stop offset="1" stop-color="#ef3e47"/></linearGradient></defs>
            <path d="${arc}" fill="none" stroke="rgba(20,20,20,0.08)" stroke-width="18" stroke-linecap="round"/>
            <path d="${arc}" fill="none" stroke="url(#gaugeRed)" stroke-width="18" stroke-linecap="round" stroke-dasharray="${m.dash}" style="filter:drop-shadow(0 0 8px rgba(229,38,47,.35))" data-bar/>
            ${ticks.filter((t) => t.line).map((t) => `<line x1="${t.line.x1}" y1="${t.line.y1}" x2="${t.line.x2}" y2="${t.line.y2}" stroke="rgba(20,20,20,0.28)" stroke-width="1.5"/>`).join('')}
            <circle cx="${m.kx}" cy="${m.ky}" r="15" fill="#fff" style="filter:drop-shadow(0 2px 8px rgba(60,20,20,.28))" data-knob/>
            <circle cx="${m.kx}" cy="${m.ky}" r="5" fill="#e5262f" data-knob/>
          </svg>
          ${ticks.map((t) => `<span class="gauge-tick num" style="left:${t.left};top:${t.top}">${t.label}</span>`).join('')}
          <div class="gauge-center" aria-live="polite">
            <span class="label">Komisi kamu</span>
            <span class="figure num" style="font-size:${Calc.figureSize(commText)}" data-out="comm">${commText}</span>
            <span class="from">dari transaksi <span class="num" data-out="amount">${Calc.rupiah(amount)}</span></span>
          </div>
        </div>
        <div class="formula soft num"><span class="rate">${Calc.percent(s.commissionRate)}</span><span class="op">×</span><span data-out="amount">${Calc.rupiah(amount)}</span><span class="op">=</span><span class="formula-result" data-out="comm">${commText}</span></div>
        <div class="chips" role="group" aria-label="Pilih produk">
          ${products.map((p, i) => `<button type="button" class="chip" aria-pressed="${i === 0}" data-price="${p.price}">${esc(p.label)}</button>`).join('')}
        </div>
      </div>

      <div class="calc-month glass">
        <div><div class="title">Estimasi Komisi per Bulan</div><div class="subtitle">Dari transaksi di meter: <span class="num" data-out="amount">${Calc.rupiah(amount)}</span> → <span class="num" data-out="comm">${commText}</span> per transaksi.</div></div>
        <label class="range">
          <span class="range-head"><span>Pembeli lewat link kamu</span><output class="num" data-out="buyers">${DEFAULT_BUYERS}</output></span>
          <input type="range" min="1" max="200" step="1" value="${DEFAULT_BUYERS}" data-in="buyers">
        </label>
        <label class="range">
          <span class="range-head"><span>Transaksi per pembeli per bulan</span><output class="num" data-out="tx">${DEFAULT_TX}</output></span>
          <input type="range" min="1" max="10" step="1" value="${DEFAULT_TX}" data-in="tx">
        </label>
        <div class="results">
          <div class="result hot"><span class="label">Per bulan</span><span class="value num" data-out="monthly">${Calc.monthlyLabel(comm * DEFAULT_BUYERS * DEFAULT_TX)}</span></div>
          <div class="result soft"><span class="label">Potensi maksimal per bulan</span><span class="value num">${Calc.rupiah(s.monthlyPotential)}+</span>
            <a href="#target-penjualan" aria-controls="target-penjualan" aria-expanded="false" data-targets-toggle>Lihat target penjualan</a></div>
        </div>
        <div class="targets soft" id="target-penjualan">
          <ul>${s.salesTargets.map((t) => `<li><span>${esc(t.category)}</span><span class="pax num">${Number(t.target)}+ pax</span></li>`).join('')}</ul>
        </div>
        <div class="calc-foot">Ini simulasi, bukan jaminan penghasilan. Komisi masuk saldo Tertahan selama ${s.pendingDays} hari setelah transaksi lunas, lalu bisa diklaim mulai ${Calc.rupiah(s.minWithdrawal)}.</div>
      </div>
    </div>
    <script type="application/json" id="calc-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
  </section>`;
}

// The four steps of the PRD's "Tutorial cara join".
function join(s) {
  const rate = s ? Calc.percent(s.commissionRate) : null;
  const steps = [
    ['device-mobile', 'Download app 20FIT', 'Ada di App Store dan Play Store. Buat akun kalau belum punya.'],
    ['handshake', 'Daftar di affiliate.20fit.id', 'Login dengan akun 20FIT, setujui S&amp;K, lalu tekan Gabung jadi Affiliate. Langsung terdaftar tanpa menunggu approval.'],
    ['share-network', 'Bagikan produk 20FIT', 'Pilih produk (paket Arena, membership, scan Visbody, dan lainnya), salin link produkmu, lalu bagikan lewat WhatsApp, Instagram, atau QR code.'],
    ['wallet', 'Dapat komisi per transaksi', s
      ? `Setiap kali ada yang membuka link-mu dan membeli produk itu di app 20FIT, kamu dapat ${rate}. Komisi Tertahan ${s.pendingDays} hari, lalu Tersedia dan bisa diklaim mulai ${Calc.rupiah(s.minWithdrawal)}. Kamu bisa melihat berapa orang yang membeli dari setiap link.`
      : 'Setiap kali ada yang membuka link-mu dan membeli produk itu di app 20FIT, kamu dapat komisi. Kamu bisa melihat berapa orang yang membeli dari setiap link.'],
  ];
  return `<section id="gabung">
    <div class="section-head"><h2>Cara gabung</h2><p>Empat langkah, dari download app sampai komisi pertama.</p></div>
    <div class="steps">${steps.map(([ic, title, body], i) => `
      <div class="step glass"><div class="step-top"><span>0${i + 1}</span>${icon(ic)}</div><div class="step-title">${title}</div><p>${body}</p></div>`).join('')}
    </div>
    <div class="download hot" id="download">
      <div><div class="big">Mulai dari app 20FIT</div><p>Download app-nya, lalu gabung di affiliate.20fit.id dengan akun yang sama.</p></div>
      ${storeButtons()}
    </div>
  </section>`;
}

function faq(s) {
  const rate = s ? Calc.percent(s.commissionRate) : 'persentase komisi';
  const hold = s ? `${s.pendingDays} hari` : 'masa tahan';
  const min = s ? Calc.rupiah(s.minWithdrawal) : 'batas minimal';
  const items = [
    // The PRD's four short questions first.
    ['Kenapa komisiku belum muncul?', 'Komisi muncul setelah transaksi lunas, hanya untuk produk yang sama dengan link-mu, dan hanya untuk transaksi di app 20FIT.'],
    ['Kapan bisa dicairkan?', `${hold} setelah transaksi lunas, saat saldo Tersedia minimal ${min}, lewat tombol Klaim.`],
    ['Temanku sudah punya akun 20FIT, dihitung?', 'Ya. Akun baru dan akun lama sama-sama dihitung selama membeli lewat link-mu.'],
    ['Teman beli lewat web atau kasir, dihitung?', 'Tidak, hanya transaksi di app 20FIT. Link kamu selalu mengarah ke app.'],
    ['Siapa yang bisa jadi affiliate?', 'Semua pengguna 20FIT dengan akun aktif. Kamu bergabung sendiri di affiliate.20fit.id, tanpa approval.'],
    ['Berapa komisi yang saya dapat?', `${rate} dari nominal yang dibayar pembeli setelah voucher dan promo bank, di luar service fee, payment fee, PPN, dan bagian FitPoints. Dibulatkan ke bawah ke rupiah penuh.`],
    ['Bagaimana kalau dua affiliate membagikan produk yang sama?', 'Komisi masuk ke link produk itu yang terakhir dibuka pembeli sebelum transaksi.'],
    ['Boleh membeli lewat link saya sendiri?', 'Tidak dihitung. Pembelian dari akun, nomor HP, email, atau rekening yang sama dengan affiliate pemilik link otomatis ditolak.'],
    ['Bagaimana saya dibayar?', 'Lewat transfer bank oleh tim 20FIT. Saat klaim pertama kamu mengisi nama sesuai KTP, NIK, NPWP (opsional), dan rekening bank. Pajak (PPh 21) bisa dipotong.'],
    ['Bagaimana kalau pembeli refund?', `Refund dalam masa tahan ${hold} membatalkan komisi itu. Refund setelah komisi dibayar dicatat sebagai penyesuaian yang memotong klaim berikutnya, dan terlihat di riwayatmu.`],
    ['Apakah pembeli dapat diskon?', 'Tidak. Link hanya dipakai untuk mencatat komisi; harga untuk pembeli tetap sama.'],
  ];
  return `<section id="faq" class="faq">
    <div class="section-head"><h2>FAQ</h2><p>Masih ragu? <a href="#">Hubungi tim affiliate</a>.</p></div>
    <div class="faq-list">${items.map(([q, a], i) => `
      <details class="faq-item glass"${i === 0 ? ' open' : ''}><summary><span>${q}</span>${icon('plus', { size: 18, className: 'icon-plus' })}${icon('minus', { size: 18, className: 'icon-minus' })}</summary><p>${a}</p></details>`).join('')}
    </div>
  </section>`;
}

function renderLanding({ settings, products }, { cssHref, calcHref, jsHref }) {
  const s = settings;
  const description = s
    ? `Bagikan link produk 20FIT dan dapatkan ${Calc.percent(s.commissionRate)} dari setiap pembelian di app lewat link kamu.`
    : 'Bagikan link produk 20FIT dan dapatkan komisi dari setiap pembelian di app lewat link kamu.';
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Program Affiliate 20FIT</title>
<meta name="description" content="${esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Manrope:wght@400..700&display=swap">
<link rel="stylesheet" href="${cssHref}">
</head>
<body>
<nav class="nav glass" aria-label="Utama">
  <a class="nav-brand" href="/"><img src="https://media.20fit.id/wp-content/uploads/2026/09/20fit-email-logo.jpg" alt="20FIT" width="84" height="28"><span>Affiliate</span></a>
  <div class="nav-links"><a href="#produk">Produk</a><a href="#kalkulator">Kalkulator</a><a href="#gabung">Cara gabung</a><a href="#faq">FAQ</a></div>
  <a class="btn-cta" href="#download">${icon('download-simple', { size: 16 })}Download app</a>
</nav>
<main>
  ${hero(s, products)}
  ${whatEarns(s, products)}
  ${calculator(s, products)}
  ${join(s)}
  ${faq(s)}
  <section class="closing glass">
    <h2>Teman kamu sudah rutin latihan. Bagikan produk 20FIT favoritmu dan dapat komisi.</h2>
    <a class="btn-cta btn-lg" href="/affiliatedashboard">Gabung jadi Affiliate ${icon('arrow-right', { size: 16 })}</a>
  </section>
  <footer><span>© 2026 20FIT</span><a href="${s && s.termsUrl ? esc(s.termsUrl) : '#'}">Syarat Affiliate</a><a href="#">Privasi</a><a href="#">Bantuan</a></footer>
</main>
<script src="${calcHref}" defer></script>
<script src="${jsHref}" defer></script>
</body>
</html>`;
}

module.exports = { renderLanding };
