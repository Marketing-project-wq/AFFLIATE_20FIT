// Landing page interaction: the commission meter, product chips, monthly
// sliders and the sales-target list. The server renders every value first;
// this only keeps them in sync as the visitor plays with the controls.
(function () {
  'use strict';
  var Calc = window.AffiliateCalc;
  var root = document.querySelector('[data-calc]');
  var dataEl = document.getElementById('calc-data');
  if (!Calc || !root || !dataEl) return;

  var data = JSON.parse(dataEl.textContent);
  var state = { amount: data.amount, chip: 0, buyers: 20, tx: 4 };
  var gauge = root.querySelector('[data-gauge]');
  var bar = root.querySelector('[data-bar]');
  var knobs = root.querySelectorAll('[data-knob]');
  var chips = root.querySelectorAll('.chip');

  function setText(name, text) {
    root.querySelectorAll('[data-out="' + name + '"]').forEach(function (el) { el.textContent = text; });
  }

  function render() {
    var comm = Calc.commission(state.amount, data.rate);
    var commText = Calc.rupiah(comm);
    var amountText = Calc.rupiah(state.amount);
    var m = Calc.meter(state.amount, data.scale);
    bar.setAttribute('stroke-dasharray', m.dash);
    knobs.forEach(function (k) { k.setAttribute('cx', m.kx); k.setAttribute('cy', m.ky); });
    gauge.setAttribute('aria-valuenow', state.amount);
    gauge.setAttribute('aria-valuetext', amountText);
    setText('comm', commText);
    setText('amount', amountText);
    root.querySelector('.figure').style.fontSize = Calc.figureSize(commText);
    setText('buyers', state.buyers);
    setText('tx', state.tx);
    setText('monthly', Calc.monthlyLabel(comm * state.buyers * state.tx));
    chips.forEach(function (c, i) { c.setAttribute('aria-pressed', String(i === state.chip)); });
  }

  // A chip stays selected only while the meter shows its price.
  function setAmount(v, chip) {
    state.amount = v;
    state.chip = chip === undefined ? -1 : chip;
    render();
  }

  chips.forEach(function (chip, i) {
    chip.addEventListener('click', function () { setAmount(+chip.dataset.price, i); });
  });

  var dragging = false;
  function fromPointer(e) {
    setAmount(Calc.pointerToAmount(e.clientX, e.clientY, gauge.getBoundingClientRect(), data.scale));
  }
  gauge.addEventListener('pointerdown', function (e) {
    dragging = true;
    gauge.classList.add('dragging');
    if (gauge.setPointerCapture) gauge.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  gauge.addEventListener('pointermove', function (e) { if (dragging) fromPointer(e); });
  ['pointerup', 'pointercancel'].forEach(function (type) {
    gauge.addEventListener(type, function () { dragging = false; gauge.classList.remove('dragging'); });
  });
  gauge.addEventListener('keydown', function (e) {
    var step = state.amount < 1e6 ? 1e4 : 5e4;
    var keys = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, Home: -Infinity, End: Infinity };
    if (!(e.key in keys)) return;
    e.preventDefault();
    var next = keys[e.key] === Infinity ? data.scale.max : keys[e.key] === -Infinity ? data.scale.min : state.amount + keys[e.key];
    setAmount(Calc.snap(next, data.scale));
  });

  root.querySelectorAll('[data-in]').forEach(function (input) {
    input.addEventListener('input', function () {
      state[input.dataset.in] = +input.value;
      render();
    });
  });

  // Without JS the link opens the list through :target; with JS it toggles
  // in place without jumping the page.
  var toggle = root.querySelector('[data-targets-toggle]');
  var targets = document.getElementById('target-penjualan');
  if (toggle && targets) {
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      var open = !targets.classList.contains('open');
      targets.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Tutup target penjualan' : 'Lihat target penjualan';
    });
  }
})();

// Product carousel: arrows and dots on top of the native scroll-snap track.
// One dot per "page" (as many cards as fit); the track stays swipeable and
// keyboard-scrollable without this.
(function () {
  'use strict';
  document.querySelectorAll('[data-carousel]').forEach(function (root) {
    var track = root.querySelector('.carousel-track');
    var prev = root.querySelector('[data-prev]');
    var next = root.querySelector('[data-next]');
    var dotsEl = root.querySelector('[data-dots]');
    var controls = root.querySelector('.carousel-controls');
    var cards = track.children;
    if (!cards.length) return;
    var smooth = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    var pages = 0;

    function step() {
      var gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      return cards[0].getBoundingClientRect().width + gap;
    }
    function perView() { return Math.max(1, Math.floor((track.clientWidth + 1) / step())); }
    function maxScroll() { return track.scrollWidth - track.clientWidth; }
    function pageLeft(i) { return Math.min(i * perView() * step(), maxScroll()); }
    function currentPage() {
      if (track.scrollLeft >= maxScroll() - 2) return pages - 1;
      return Math.round(track.scrollLeft / (perView() * step()));
    }

    function build() {
      pages = Math.ceil(cards.length / perView());
      controls.hidden = pages < 2;
      dotsEl.innerHTML = '';
      for (var i = 0; i < pages; i++) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', 'Halaman produk ' + (i + 1) + ' dari ' + pages);
        b.addEventListener('click', go.bind(null, i));
        dotsEl.appendChild(b);
      }
      sync();
    }
    function go(i) { track.scrollTo({ left: pageLeft(Math.max(0, Math.min(pages - 1, i))), behavior: smooth }); }
    function sync() {
      var cur = currentPage();
      Array.prototype.forEach.call(dotsEl.children, function (d, i) { d.setAttribute('aria-current', String(i === cur)); });
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft >= maxScroll() - 2;
    }

    prev.addEventListener('click', function () { go(currentPage() - 1); });
    next.addEventListener('click', function () { go(currentPage() + 1); });
    var raf = 0;
    track.addEventListener('scroll', function () {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    }, { passive: true });
    var t = 0;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(build, 120); });
    build();
  });
})();
