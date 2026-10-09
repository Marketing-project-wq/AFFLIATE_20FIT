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
