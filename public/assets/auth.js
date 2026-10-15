// Sign-in and password reset against the 20FIT account service (the same
// one the app uses). The password goes from the browser straight to
// my.20fit.id; this site only receives the one-time code that service
// returns and turns it into a session. If that service says no or can't be
// reached, the form falls back to a normal post to /login, which checks
// the Supabase password.
(function () {
  'use strict';

  var GENERIC = 'Email atau password salah. Kalau kamu daftar pakai Google, pilih Lanjut dengan Google.';
  var OFFLINE = 'Tidak bisa menghubungi server 20FIT. Periksa koneksi lalu coba lagi.';

  function postJson(url, body, timeoutMs) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var t = ctrl && setTimeout(function () { ctrl.abort(); }, timeoutMs || 15000);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
      credentials: url.charAt(0) === '/' ? 'same-origin' : 'omit',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
    }).finally(function () { if (t) clearTimeout(t); });
  }

  // ── sign in ──
  var login = document.querySelector('[data-login]');
  if (login) {
    var errorEl = document.querySelector('[data-error]');
    var button = login.querySelector('button[type="submit"]');
    var forgot = document.querySelector('[data-forgot]');
    var accounts = login.getAttribute('data-accounts');
    var fallback = false;

    login.email.addEventListener('input', function () {
      if (forgot) forgot.href = '/lupa-password' + (login.email.value ? '?email=' + encodeURIComponent(login.email.value.trim()) : '');
    });

    var label = button.textContent;
    // Coming back with the Back button shows the form as it was left.
    window.addEventListener('pageshow', function () { button.disabled = false; button.textContent = label; fallback = false; });
    login.addEventListener('submit', function (e) {
      // Shown while signing in, so a slow answer doesn't look like a frozen page.
      button.disabled = true;
      button.textContent = 'Sedang masuk…';
      if (fallback || !window.fetch || !accounts) return; // plain post to /login
      e.preventDefault();
      var email = login.email.value.trim().toLowerCase();
      var password = login.password.value;
      errorEl.textContent = '';

      // The account service can take a while; the button says so, and
      // after 15 s the form stops waiting and checks the password the
      // classic way.
      var slow = setTimeout(function () { button.textContent = 'Masih memeriksa akun 20FIT…'; }, 4000);
      postJson(accounts + '/api/fitco-login', { email: email, password: password }, 15000)
        .finally(function () { clearTimeout(slow); })
        .then(function (r) {
          if (!r.ok || !r.data || !r.data.email_otp) throw new Error('fallback');
          // Only the one-time code leaves for this site; the 20FIT app
          // token in the same response is dropped here.
          return postJson('/login/otp', { email: r.data.email || email, otp: r.data.email_otp, next: login.next.value });
        })
        .then(function (r) {
          if (r.ok && r.data && r.data.redirect) { location.assign(r.data.redirect); return; }
          button.disabled = false;
          button.textContent = label;
          errorEl.textContent = (r.data && r.data.error) || GENERIC;
        })
        .catch(function () {
          // Not accepted by the account service (or it's unreachable): try
          // the Supabase password the classic way.
          fallback = true;
          login.submit();
        });
    });
  }

  // ── forgotten password ──
  var request = document.querySelector('[data-forgot-request]');
  var reset = document.querySelector('[data-forgot-reset]');
  if (request && reset) {
    var msg = document.querySelector('[data-msg]');
    var base = request.getAttribute('data-accounts');
    var email = '';
    function say(text, kind) { msg.textContent = text; msg.className = 'msg' + (kind ? ' ' + kind : ''); }

    request.addEventListener('submit', function (e) {
      e.preventDefault();
      email = request.email.value.trim().toLowerCase();
      var btn = request.querySelector('button');
      btn.disabled = true;
      postJson(base + '/api/fitco-forgot', { email: email })
        .then(function () {
          // Same answer whether or not the email has an account.
          say('Kalau email itu terdaftar di 20FIT, kode sudah kami kirim ke ' + email + '. Cek juga folder spam.', 'ok');
          request.hidden = true;
          reset.hidden = false;
          reset.otp.focus();
        })
        .catch(function () { say(OFFLINE, 'error'); })
        .finally(function () { btn.disabled = false; });
    });

    reset.addEventListener('submit', function (e) {
      e.preventDefault();
      if (reset.password.value !== reset.password2.value) return say('Kedua password tidak sama.', 'error');
      var btn = reset.querySelector('button');
      btn.disabled = true;
      postJson(base + '/api/fitco-reset', { email: email, otp: reset.otp.value.trim(), password: reset.password.value })
        .then(function (r) {
          if (!r.ok) return say('Kode salah atau sudah kedaluwarsa, atau password belum memenuhi syarat. Coba lagi.', 'error');
          reset.hidden = true;
          msg.innerHTML = '';
          msg.className = 'msg ok';
          msg.appendChild(document.createTextNode('Password baru tersimpan. Pakai password ini juga di aplikasi 20FIT. '));
          var a = document.createElement('a');
          a.href = '/login?email=' + encodeURIComponent(email);
          a.textContent = 'Masuk sekarang';
          msg.appendChild(a);
        })
        .catch(function () { say(OFFLINE, 'error'); })
        .finally(function () { btn.disabled = false; });
    });
  }
})();
