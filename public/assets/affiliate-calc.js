// Commission calculator math, shared by the server (first render) and the
// browser (interaction) so both always show the same numbers.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AffiliateCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Meter geometry, in SVG user units (viewBox 0 0 320 206).
  var GEOMETRY = { width: 320, height: 206, cx: 160, cy: 170, r: 130 };

  function groupThousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  // Rp7.500: no space, dot thousands separator, rounded down.
  function rupiah(n) {
    var v = Math.floor(Math.abs(n));
    return (n < 0 ? '-' : '') + 'Rp' + groupThousands(v);
  }

  // Rp50rb, Rp1jt, Rp1,5jt: for meter tick labels.
  function rupiahShort(n) {
    if (n >= 1e6) return 'Rp' + String(Math.round(n / 1e5) / 10).replace('.', ',') + 'jt';
    if (n >= 1e3) return 'Rp' + Math.round(n / 1e3) + 'rb';
    return rupiah(n);
  }

  // 0.025 -> "2,5%"
  function percent(rate) {
    return String(Math.round(rate * 10000) / 100).replace('.', ',') + '%';
  }

  // Exact commission for one transaction, rounded down to the rupiah. The
  // inner round strips float noise (300000 * 0.025 = 7500.000000000001).
  function commission(amount, rate) {
    return Math.floor(Math.round(amount * rate * 100) / 100);
  }

  // Monthly estimate: rounded down to Rp10.000 under Rp1.000.000 and to
  // Rp100.000 from there, then "+". Amounts that would round to Rp0 show
  // exactly instead.
  function monthlyLabel(value) {
    var step = value < 1e6 ? 1e4 : 1e5;
    var rounded = Math.floor(value / step) * step;
    return rounded > 0 ? rupiah(rounded) + '+' : rupiah(value);
  }

  // The meter runs from the cheapest to the most expensive product on a
  // square-root scale, so the cheap end isn't squeezed together.
  function scale(products) {
    var prices = products.map(function (p) { return p.price; });
    var max = Math.max.apply(null, prices);
    var min = Math.min.apply(null, prices);
    if (!(max > min)) min = 0;
    return { min: min, max: max };
  }

  function toT(amount, s) {
    var x = (amount - s.min) / (s.max - s.min);
    return Math.sqrt(Math.min(1, Math.max(0, x)));
  }

  function fromT(t, s) {
    return s.min + (s.max - s.min) * t * t;
  }

  function snap(amount, s) {
    var step = amount < 1e6 ? 1e4 : 5e4;
    var v = Math.round(amount / step) * step;
    return Math.min(s.max, Math.max(s.min, v));
  }

  function point(t, radius) {
    var a = Math.PI * (1 - t);
    return [GEOMETRY.cx + radius * Math.cos(a), GEOMETRY.cy - radius * Math.sin(a)];
  }

  // Closest of 1, 2, 2.5 and 5 times a power of ten.
  function roundNice(v) {
    var base = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    return [1, 2, 2.5, 5, 10].map(function (m) { return m * base; })
      .reduce(function (best, c) { return Math.abs(c - v) < Math.abs(best - v) ? c : best; });
  }

  // Tick labels: both ends exactly, plus round amounts in between.
  function ticks(s) {
    var list = [{ value: s.min, t: 0 }];
    [0.3, 0.55, 0.8].forEach(function (t) {
      var nice = roundNice(fromT(t, s));
      var nt = toT(nice, s);
      var prev = list[list.length - 1].t;
      if (nice > s.min && nice < s.max && nt - prev >= 0.15 && 1 - nt >= 0.15) list.push({ value: nice, t: nt });
    });
    list.push({ value: s.max, t: 1 });
    var G = GEOMETRY;
    return list.map(function (tick, i) {
      var end = i === 0 || i === list.length - 1;
      // End labels sit under the arc's round caps; the rest just outside it.
      var p = end ? [G.cx + (i === 0 ? -G.r : G.r), G.cy + 24] : point(tick.t, G.r + 27);
      var a = point(tick.t, G.r + 11), b = point(tick.t, G.r + 15);
      return {
        label: rupiahShort(tick.value),
        left: (p[0] / G.width * 100).toFixed(2) + '%',
        top: (p[1] / G.height * 100).toFixed(2) + '%',
        line: end ? null : { x1: a[0].toFixed(1), y1: a[1].toFixed(1), x2: b[0].toFixed(1), y2: b[1].toFixed(1) },
      };
    });
  }

  // Everything the meter needs for one amount.
  function meter(amount, s) {
    var t = toT(amount, s);
    var length = Math.PI * GEOMETRY.r;
    var knob = point(t, GEOMETRY.r);
    return {
      dash: (t * length).toFixed(1) + ' ' + length.toFixed(1),
      kx: knob[0].toFixed(1),
      ky: knob[1].toFixed(1),
    };
  }

  // The commission figure shrinks for long amounts so it stays inside the
  // arc at every width (sizes are in container-width units).
  function figureSize(text) {
    return Math.min(11, 100 / text.length).toFixed(2) + 'cqw';
  }

  function pointerToAmount(clientX, clientY, rect, s) {
    var k = GEOMETRY.width / rect.width;
    var x = (clientX - rect.left) * k, y = (clientY - rect.top) * k;
    var a = Math.atan2(GEOMETRY.cy - y, x - GEOMETRY.cx);
    if (a < 0) a = x < GEOMETRY.cx ? Math.PI : 0;
    return snap(fromT(1 - a / Math.PI, s), s);
  }

  return {
    GEOMETRY: GEOMETRY, rupiah: rupiah, rupiahShort: rupiahShort, percent: percent,
    commission: commission, monthlyLabel: monthlyLabel, scale: scale, snap: snap,
    ticks: ticks, meter: meter, figureSize: figureSize, pointerToAmount: pointerToAmount,
  };
});
