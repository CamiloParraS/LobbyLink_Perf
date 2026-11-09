'use strict';
// Utilidades compartidas por index.html (app.js) y visor.html (visor.js): DOM, formato, tooltip, escalas, tabla.
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v === true ? '' : v); }
    add(el, kids); return el;
  }
  function add(el, kids) { for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k.nodeType ? k : document.createTextNode(String(k))); } }
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    add(el, kids); return el;
  }
  const fmt = (x, d = 1) => (x == null || !isFinite(x) ? '–' : Number(x).toLocaleString('es', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const fms = (x) => (x == null ? '–' : x >= 10000 ? '>10 s' : fmt(x, x < 10 ? 2 : 0));
  const empty = (msg) => h('div', { class: 'empty' }, msg);
  const card = (title, note, ...body) => h('section', { class: 'card' + (body.flat(Infinity).some((b) => b && b.className === 'tablewrap') ? ' full' : '') }, title ? h('h2', null, title) : null, note ? h('p', { class: 'note' }, note) : null, ...body);
  // ---------------------------------------------------------------- tooltip
  const tip = document.getElementById('tip');
  function showTip(ev, html) { tip.innerHTML = html; tip.style.display = 'block'; const w = tip.offsetWidth, hh = tip.offsetHeight; let x = ev.clientX + 14, y = ev.clientY + 14; if (x + w > innerWidth - 8) x = ev.clientX - w - 14; if (y + hh > innerHeight - 8) y = ev.clientY - hh - 14; tip.style.left = Math.max(4, x) + 'px'; tip.style.top = Math.max(4, y) + 'px'; }
  const hideTip = () => { tip.style.display = 'none'; };
  const tipRow = (color, text) => `<div class="row"><i style="background:${color}"></i>${text}</div>`;
  // ---------------------------------------------------------------- escalas
  function niceTicks(lo, hi, n = 5) {
    const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), r = step0 / mag;
    const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag; const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v / step) * step); return out;
  }
  function logTicks(lo, hi) { const out = []; for (let p = Math.floor(Math.log10(lo)); p <= Math.ceil(Math.log10(hi)); p++) { for (const m of [1, 2, 5]) { const v = m * Math.pow(10, p); if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v); } } return out; }

  // ---------------------------------------------------------------- gráfico de líneas
  function legendEl(items) {
    return h('div', { class: 'legend' }, items.map((it) => h('span', null,
      it.bar ? sv('svg', { viewBox: '0 0 26 10' }, sv('rect', { x: 2, y: 1, width: 22, height: 8, rx: 2, fill: it.outline ? 'none' : it.color, opacity: it.opacity ?? 1, stroke: it.outline ? it.color : 'none', 'stroke-width': 1.5 }))
        : sv('svg', { viewBox: '0 0 26 10' }, sv('line', { x1: 1, x2: 25, y1: 5, y2: 5, stroke: it.color, 'stroke-width': 2, 'stroke-dasharray': it.dash || null }), sv('circle', { cx: 13, cy: 5, r: 3.2, fill: it.color })), it.name)));
  }
  function table(head, rows, opt = {}) {
    return h('div', { class: 'tablewrap' }, h('table', { class: opt.cls || null }, h('thead', null, h('tr', null, head.map((c, i) => h('th', { class: opt.num && opt.num.includes(i) ? 'n' : null }, c)))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: opt.num && opt.num.includes(i) ? 'n' : null }, c)))))));
  }
  const pass = (ok, text) => h('span', { class: ok ? 'ok' : 'no' }, (ok ? '✓ ' : '✗ ') + text);
  const select = (opts, value, onchange, label) => h('label', null, label ? label + ' ' : '', h('select', { onchange: (e) => onchange(e.target.value) }, opts.map(([v, t]) => h('option', { value: v, selected: v === value ? true : null }, t))));
  root.UI = { NS, h, add, sv, fmt, fms, empty, card, tip, showTip, hideTip, tipRow, niceTicks, logTicks, legendEl, table, pass, select };
})(typeof window !== 'undefined' ? window : globalThis);
