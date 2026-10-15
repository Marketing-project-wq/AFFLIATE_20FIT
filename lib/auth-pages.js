'use strict';
// Sign-in and password-reset pages. People sign in with their 20FIT app
// account; there is no sign-up on the web. public/assets/auth.js checks the
// password against the 20FIT account service (my.20fit.id, the same check
// the app makes) straight from the browser and only hands this server the
// one-time code it gets back. Without JavaScript the form posts to /login,
// which checks the Supabase password instead.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const STYLE = `
  :root { --bg: #f6f4f4; --text: #141414; --muted: #5c5c5c; --accent: #e5262f; --accent-dark: #b0161f; --line: rgba(20,20,20,.12); }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px;
    font: 15px/1.55 Manrope, system-ui, sans-serif; color: var(--text);
    background: radial-gradient(680px 520px at 6% 0%, rgba(255,154,159,.55), transparent 70%),
                radial-gradient(900px 600px at 50% 115%, rgba(255,217,219,.8), transparent 70%), var(--bg);
  }
  .card {
    width: 100%; max-width: 420px; padding: 32px 28px; border-radius: 24px;
    background: linear-gradient(155deg, rgba(255,255,255,.85), rgba(255,255,255,.6));
    box-shadow: inset 0 0 0 1px rgba(20,20,20,.07), 0 16px 40px rgba(90,20,24,.12);
    backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  }
  .brand { font: 800 15px/1 'Barlow Condensed', sans-serif; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
  h1 { font: 900 36px/1.02 'Barlow Condensed', 'Arial Narrow', sans-serif; margin: 10px 0 6px; }
  p { margin: 0 0 20px; color: var(--muted); }
  label { display: block; font-weight: 600; font-size: 13px; margin: 14px 0 6px; }
  .label-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .label-row a { font-size: 13px; }
  input {
    width: 100%; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line);
    font: inherit; background: rgba(255,255,255,.9); color: var(--text);
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  button {
    width: 100%; margin-top: 22px; padding: 13px 16px; border: 0; border-radius: 999px; cursor: pointer;
    font: 800 18px/1 'Barlow Condensed', sans-serif; letter-spacing: .03em; color: #fff; background: var(--accent);
  }
  button:hover { background: var(--accent-dark); }
  button[disabled] { opacity: .6; cursor: progress; }
  a { color: var(--accent-dark); }
  .msg { margin: 0 0 6px; padding: 10px 12px; border-radius: 12px; font-size: 14px; }
  .msg.error { background: #fff0f0; color: var(--accent-dark); }
  .msg.ok { background: #effaf2; color: #1d6b35; }
  .msg:empty { display: none; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .divider { margin: 24px 0 0; padding-top: 18px; border-top: 1px solid var(--line); font-size: 14px; color: var(--muted); }
  .stores { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .stores a {
    display: inline-flex; align-items: center; padding: 9px 14px; border-radius: 12px; text-decoration: none;
    background: #141414; color: #fff; font-weight: 600; font-size: 13px;
  }
  .or { display: flex; align-items: center; gap: 12px; margin: 18px 0 14px; color: var(--muted); font-size: 13px; }
  .or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--line); }
  .google {
    display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;
    padding: 12px 16px; border: 1px solid var(--line); border-radius: 999px; text-decoration: none;
    font: 800 17px/1 'Barlow Condensed', sans-serif; letter-spacing: .03em; color: var(--text); background: rgba(255,255,255,.9);
  }
  .google:hover { background: #fff; border-color: rgba(20,20,20,.18); }
  .foot { margin-top: 18px; font-size: 13px; text-align: center; }
  [hidden] { display: none !important; }
`;

function shell({ title, body, scriptHref }) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 20FIT Affiliate</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=Manrope:wght@400..700&display=swap">
<style>${STYLE}</style>
</head>
<body>
<main class="card">
${body}
</main>
<script src="${esc(scriptHref)}" defer></script>
</body>
</html>`;
}

// App store buttons only when their URLs are configured; nothing is
// invented here.
function storeButtons(links) {
  const buttons = [
    links.appStore && `<a href="${esc(links.appStore)}" rel="noopener">App Store</a>`,
    links.playStore && `<a href="${esc(links.playStore)}" rel="noopener">Google Play</a>`,
  ].filter(Boolean);
  return buttons.length ? `<div class="stores">${buttons.join('')}</div>` : '';
}

// Signing in to /admin uses the same 20FIT account check (admins are 20FIT
// accounts too); the page just says it's the admin sign-in.
function loginPage({ next, email = '', error = '', links, accountsUrl, scriptHref }) {
  const admin = /^\/admin(\/|$)/.test(next || '');
  const body = `
  <div class="brand">20FIT Affiliate${admin ? ' · Admin' : ''}</div>
  <h1>${admin ? 'Masuk ke admin' : 'Masuk ke dashboard'}</h1>
  <p>${admin ? 'Khusus tim 20FIT yang terdaftar sebagai admin program affiliate. Masuk dengan email dan password akun 20FIT kamu, sama seperti di aplikasi 20FIT dan my.20fit.id.'
    : 'Masuk dengan akun 20FIT yang kamu pakai di aplikasi.'}</p>
  <div class="msg error" role="alert" data-error>${esc(error)}</div>
  <form method="post" action="/login" data-login data-accounts="${esc(accountsUrl)}">
    <input type="hidden" name="next" value="${esc(next)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}" ${email ? '' : 'autofocus'}>
    <div class="label-row"><label for="password">Password</label><a href="/lupa-password${email ? `?email=${encodeURIComponent(email)}` : ''}" data-forgot>Lupa password?</a></div>
    <input id="password" name="password" type="password" autocomplete="current-password" required ${email ? 'autofocus' : ''}>
    <button type="submit">Masuk</button>
  </form>
  <div class="or"><span>atau</span></div>
  <a class="google" href="/auth/google?next=${encodeURIComponent(next)}">
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.8 6.6-9.5 6.6-16z"/><path fill="#FBBC05" d="M10.5 28.3c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.1 0 19.9 0 23.7s1 7.6 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.3 0 11.6-2.1 15.5-5.7l-7.1-5.5c-2 1.3-4.5 2.1-8.4 2.1-6.3 0-11.6-3.7-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>
    <span>Lanjut dengan Google</span>
  </a>
  <div class="hint" style="text-align:center;margin-top:10px">Google dan email masuk ke akun 20FIT yang sama.</div>
  ${admin ? '<div class="divider">Bukan admin? <a href="/login">Masuk ke dashboard affiliate</a>.</div>'
    : `<div class="divider">Belum punya akun? Download aplikasi 20FIT dan daftar di sana, lalu masuk di sini dengan akun yang sama.${storeButtons(links)}</div>`}
  <div class="foot"><a href="/">Kembali ke program affiliate</a></div>`;
  return shell({ title: admin ? 'Masuk admin' : 'Masuk', body, scriptHref });
}

function forgotPage({ email = '', links, accountsUrl, scriptHref }) {
  const body = `
  <div class="brand">20FIT Affiliate</div>
  <h1>Lupa password</h1>
  <p>Password ini sama dengan password akun 20FIT di aplikasi. Kami kirim kode ke email kamu untuk membuat password baru.</p>
  <noscript><div class="msg error">Halaman ini butuh JavaScript. Kamu juga bisa mengganti password lewat aplikasi 20FIT.</div></noscript>
  <div class="msg" role="status" data-msg></div>
  <form data-forgot-request data-accounts="${esc(accountsUrl)}">
    <label for="email">Email akun 20FIT</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}" autofocus>
    <button type="submit">Kirim kode</button>
  </form>
  <form data-forgot-reset hidden>
    <label for="otp">Kode dari email</label>
    <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" required maxlength="8">
    <label for="password">Password baru</label>
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
    <div class="hint">Minimal 8 karakter.</div>
    <label for="password2">Ulangi password baru</label>
    <input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" required>
    <button type="submit">Simpan password baru</button>
  </form>
  <div class="divider">Kalau kamu daftar di aplikasi pakai Google, langkah ini sekalian membuat password untuk masuk di web.${storeButtons(links)}</div>
  <div class="foot"><a href="/login">Kembali ke halaman masuk</a></div>`;
  return shell({ title: 'Lupa password', body, scriptHref });
}

module.exports = { loginPage, forgotPage };
