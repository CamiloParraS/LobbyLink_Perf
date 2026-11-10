'use strict';
// Visor de UNA corrida (opcionalmente comparada con otra). Lee window.DATA (lista de corridas, sondas F0, CloudWatch)
// y carga bajo demanda runs/<id>.js (window.RUNS[id]) generado por build.mjs con rundetail.mjs.
(function () {
  const D = window.DATA, LB = window.LIB, { ENVS } = LB;
  const { h, sv, fmt, fms, empty, card, showTip, hideTip, tipRow, niceTicks, logTicks, legendEl, table, pass } = window.UI;
  const ENV = Object.fromEntries(ENVS.map((e) => [e.id, e]));
  const JARN = { base: 'jar base', fix: 'N+1 arreglado', thr: 'saldo 0' };
  const PHASE = { f0: 'F0 sondas', f1: 'F1 costo', f2: 'F2 datos', f3: 'F3 Amdahl', f4: 'F4 cuotas', f5: 'F5 rampa', f6: 'F6 sostenida', f7: 'F7 ×10', f7d: 'F7d datos', f8: 'F8 largo', f9: 'F9 sin caché', fq: 'FQ frecuencia', fm: 'FM -Xmx', fx: 'FX red' };
  const THRESH_P95 = LB.THRESH_P95, THRESH_ERR = LB.THRESH_ERR;
  const RUNS = D.runs.slice().sort((a, b) => ENV[a.env].slot - ENV[b.env].slot || (a.jar > b.jar ? 1 : a.jar < b.jar ? -1 : 0) || a.phase.localeCompare(b.phase) || (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
  const byId = new Map(RUNS.map((r) => [r.id, r]));
  const state = { a: null, b: null, step: null, zoom: null, envs: new Set(ENVS.map((e) => e.id)), jars: new Set(['base', 'fix', 'thr']), phase: '', q: '' };
  const loaded = {}; // id -> detalle
  let crossFns = [], uid = 0;

  // ---------------------------------------------------------------- carga perezosa del detalle
  function getRun(id) {
    if (!id) return Promise.resolve(null);
    if (window.RUNS && window.RUNS[id]) return Promise.resolve(window.RUNS[id]);
    const meta = byId.get(id); if (!meta?.file) return Promise.reject(new Error('Corrida sin archivo de detalle: ' + id));
    return new Promise((ok, no) => {
      const s = document.createElement('script'); s.src = meta.file + '?v=' + (D.generatedAt || '');
      s.onload = () => (window.RUNS && window.RUNS[id] ? ok(window.RUNS[id]) : no(new Error('El archivo no definió la corrida ' + id)));
      s.onerror = () => no(new Error('No se pudo cargar ' + meta.file + '. ¿Existe la carpeta runs/? Regenera con: node dashboard/build.mjs'));
      document.head.append(s);
    });
  }
  const tOf = (r) => (r._t ??= Array.from({ length: r.n }, (_, i) => r.t0 + i * r.B));

  // ---------------------------------------------------------------- hash <-> estado
  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('run') && byId.has(p.get('run'))) state.a = p.get('run');
    if (p.get('b') && byId.has(p.get('b'))) state.b = p.get('b');
    state.step = p.has('step') ? Number(p.get('step')) : null;
    if (p.get('z')) { const z = p.get('z').split(',').map(Number); if (z.length === 2 && z.every(isFinite)) state.zoom = z; }
  }
  function writeHash() {
    const p = new URLSearchParams(); if (state.a) p.set('run', state.a); if (state.b) p.set('b', state.b);
    if (state.step != null) p.set('step', state.step); if (state.zoom) p.set('z', state.zoom.map((v) => Math.round(v * 10) / 10).join(','));
    try { history.replaceState(null, '', '#' + p.toString()); } catch {}
  }

  // ---------------------------------------------------------------- estadísticas de una ventana
  function winStats(r, w0, w1) {
    const g = r.g, B = r.B, i0 = Math.max(0, Math.ceil((w0 - r.t0) / B - 0.5)), i1 = Math.min(r.n - 1, Math.floor((w1 - r.t0) / B));
    const mean = (k) => { const a = g[k]; if (!a) return null; let s = 0, c = 0; for (let i = i0; i <= i1; i++) if (a[i] != null) { s += a[i]; c++; } return c ? s / c : null; };
    const max = (k) => { const a = g[k]; if (!a) return null; let m = null; for (let i = i0; i <= i1; i++) if (a[i] != null && (m == null || a[i] > m)) m = a[i]; return m; };
    const wmean = (k) => { const a = g[k], w = g.rps; if (!a) return null; let s = 0, c = 0; for (let i = i0; i <= i1; i++) if (a[i] != null) { const x = w?.[i] ?? 1; s += a[i] * x; c += x; } return c ? s / c : null; };
    const S = { n: Math.max(0, i1 - i0 + 1) };
    for (const k of ['rps', 'sched', 'errs', 'mbIn', 'mbOut', 'busy', 'user', 'system', 'iowait', 'steal', 'appCpu', 'mongoCpu', 'iops', 'riops', 'wiops', 'dmbs', 'dutil', 'rx', 'tx', 'appThr', 'mongoThr', 'vmThr', 'm_docsExam', 'm_docsRet', 'm_keysExam', 'm_find', 'm_agg', 'm_cacheMB', 'm_missPct', 'm_readLatUs', 'gcMs', 'appIoR', 'appIoW', 'mongoIoR', 'mongoIoW']) S[k] = mean(k);
    for (const k of ['appRss', 'mongoRss', 'appMem', 'mongoMem', 'heapAfter', 'inflight', 'iops', 'dmbs', 'p99']) S[k + 'Max'] = max(k);
    S.p50w = wmean('p50'); S.p95w = wmean('p95');
    return S;
  }
  const loadWindow = (r) => { const st = r.steps; if (!st.length) return [r.t0, r.t0 + r.n * r.B]; return [Math.min(...st.map((s) => s._t.from)), Math.max(...st.map((s) => s._t.end))]; };
  function stepOf(r, ref) { // paso equivalente en r al paso `ref` de otra corrida (misma tasa o mismos workers)
    if (!ref) return null; return r.steps.find((s) => (ref.rate != null && s.rate === ref.rate) || (ref.rate == null && s.workers === ref.workers)) || null;
  }
  function selection(r, refStep) {
    const st = state.step != null ? (r === loaded[state.a] ? r.steps[state.step] : stepOf(r, refStep)) : null;
    if (st) return { w: [st._t.from, st._t.end], step: st, label: `paso ${st.step} · ${stepName(st)}` };
    if (state.zoom) return { w: state.zoom, step: null, label: `selección ${fmt(state.zoom[0], 0)}–${fmt(state.zoom[1], 0)} s` };
    return { w: loadWindow(r), step: null, label: 'toda la carga (promedio que incluye calentamiento y pausas entre pasos; elige un paso para cifras limpias)' };
  }
  const stepName = (s) => (s.rate != null ? `${fmt(s.rate)} req/s` : `${s.workers} workers`);

  // ---------------------------------------------------------------- gráfico de series de tiempo
  const isDark = () => { const r = document.documentElement; return r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
  const autoFmt = (v) => (v == null ? '–' : Math.abs(v) >= 10000 ? fmt(v / 1000, 1) + 'k' : fmt(v, Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0));

  function tsChart(o) {
    const series = o.series.filter((s) => s.v && s.v.some((x) => x != null)); if (!series.length) return null;
    const W = 560, H = o.height || 220, m = { l: 58, r: 14, t: 10, b: 34 }, [x0, x1] = o.domain, id = 'c' + ++uid;
    let lo = Infinity, hi = -Infinity;
    for (const s of series) { const a = lowerBound(s.t, x0 - 1e-9); for (let i = Math.max(0, a - 1); i < s.t.length && s.t[i] <= x1 + (s.t[1] - s.t[0] || 1); i++) { const v = s.v[i]; if (v == null) continue; if (o.ylog && v <= 0) continue; if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    for (const hl of o.hlines || []) { if (hl.y < lo) lo = hl.y; if (hl.y > hi) hi = hl.y; }
    let y0, y1;
    if (o.ylog) { y0 = o.ymin ?? Math.max(lo * 0.8, 1e-3); y1 = o.ymax ?? hi * 1.4; if (y1 <= y0) y1 = y0 * 10; } else { y0 = o.ymin ?? Math.min(0, lo); y1 = o.ymax ?? (hi <= 0 ? 1 : hi * 1.08); if (y1 === y0) y1 = y0 + 1; }
    const px = (t) => m.l + ((t - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
    const py = (v) => H - m.b - (o.ylog ? (Math.log(Math.min(Math.max(v, y0), y1)) - Math.log(y0)) / (Math.log(y1) - Math.log(y0)) : (v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': o.title });
    svg.append(sv('defs', null, sv('clipPath', { id }, sv('rect', { x: m.l, y: m.t - 2, width: W - m.l - m.r, height: H - m.t - m.b + 4 }))));
    for (const b of o.bands || []) { const a = Math.max(px(b.x0), m.l), c = Math.min(px(b.x1), W - m.l * 0 - m.r); if (c - a > 0.5) { svg.append(sv('rect', { x: a, y: m.t, width: c - a, height: H - m.t - m.b, fill: b.color || 'var(--axis)', opacity: b.opacity ?? 0.12 })); if (b.label && c - a > 30) svg.append(sv('text', { x: a + 3, y: m.t + 10, class: 'lbl', 'font-size': 10 }, b.label)); } }
    const yt = o.ylog ? logTicks(y0, y1) : niceTicks(y0, y1, 4);
    for (const v of yt) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: py(v), y2: py(v), stroke: 'var(--grid)' }), sv('text', { x: m.l - 6, y: py(v) + 4, 'text-anchor': 'end' }, (o.fmty || autoFmt)(v)));
    const span = x1 - x0, div = span > 900 ? 60 : 1, unit = div === 60 ? 'min' : 's';
    for (const v of niceTicks(x0 / div, x1 / div, 6)) svg.append(sv('text', { x: px(v * div), y: H - m.b + 15, 'text-anchor': 'middle' }, fmt(v, div === 60 ? 1 : 0)));
    svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: 'var(--axis)' }), sv('text', { class: 'axis-title', x: (m.l + W - m.r) / 2, y: H - 3, 'text-anchor': 'middle' }, `${unit} desde que empieza la carga`));
    if (o.ylabel) svg.append(sv('text', { class: 'axis-title', x: 11, y: (m.t + H - m.b) / 2, transform: `rotate(-90 11 ${(m.t + H - m.b) / 2})`, 'text-anchor': 'middle' }, o.ylabel));
    const plot = sv('g', { 'clip-path': `url(#${id})` }); svg.append(plot);
    for (const hl of o.hlines || []) { plot.append(sv('line', { x1: m.l, x2: W - m.r, y1: py(hl.y), y2: py(hl.y), stroke: hl.color || 'var(--bad)', 'stroke-width': 1.2, 'stroke-dasharray': '5 4' })); }
    for (const hl of o.hlines || []) svg.append(sv('text', { x: W - m.r - 3, y: py(hl.y) - 4, 'text-anchor': 'end', class: 'lbl' }, hl.label || ''));
    for (const s of series) {
      let d = '', pen = false; const a = Math.max(0, lowerBound(s.t, x0) - 1);
      for (let i = a; i < s.t.length; i++) { if (s.t[i] > x1 + (s.t[1] - s.t[0] || 1)) break; const v = s.v[i]; if (v == null || (o.ylog && v <= 0)) { pen = false; continue; } d += (pen ? 'L' : 'M') + px(s.t[i]).toFixed(1) + ' ' + py(v).toFixed(1); pen = true; }
      plot.append(sv('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.w || 1.8, 'stroke-dasharray': s.dash || null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: s.opacity ?? 1 }));
    }
    // interacción: cruz sincronizada, tooltip y selección arrastrando
    const cross = sv('line', { y1: m.t, y2: H - m.b, stroke: 'var(--ink2)', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none' }); svg.append(cross);
    const sel = sv('rect', { y: m.t, height: H - m.t - m.b, fill: 'var(--accent)', opacity: 0, 'pointer-events': 'none' }); svg.append(sel);
    const hit = sv('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent', style: 'cursor:crosshair; touch-action:none' }); svg.append(hit);
    crossFns.push((t) => { if (t == null || t < x0 || t > x1) cross.setAttribute('opacity', 0); else { cross.setAttribute('x1', px(t)); cross.setAttribute('x2', px(t)); cross.setAttribute('opacity', 0.55); } });
    const tAt = (ev) => { const box = svg.getBoundingClientRect(); return x0 + (((ev.clientX - box.left) * (W / box.width) - m.l) / (W - m.l - m.r)) * (x1 - x0); };
    let drag = null;
    hit.addEventListener('pointerdown', (ev) => { drag = { t: tAt(ev), x: ev.clientX }; hit.setPointerCapture(ev.pointerId); });
    hit.addEventListener('pointermove', (ev) => {
      const t = tAt(ev); crossFns.forEach((f) => f(t));
      if (drag) { const a = Math.min(drag.t, t), b = Math.max(drag.t, t); sel.setAttribute('x', px(a)); sel.setAttribute('width', Math.max(0, px(b) - px(a))); sel.setAttribute('opacity', 0.18); hideTip(); return; }
      const rows = series.map((s) => { const i = lowerBound(s.t, t), j = i > 0 && (i >= s.t.length || t - s.t[i - 1] < s.t[i] - t) ? i - 1 : i; if (j >= s.t.length || s.v[j] == null || Math.abs(s.t[j] - t) > 1.6 * ((s.t[1] - s.t[0]) || 1)) return null; return tipRow(s.color, `${s.name}: <b>${(o.fmtTip || autoFmt)(s.v[j])}${o.unit ? ' ' + o.unit : ''}</b>`); }).filter(Boolean);
      showTip(ev, `<b>${fmt(t, 0)} s</b> <span style="opacity:.7">(${fmt(t / 60, 1)} min)</span>` + rows.join(''));
    });
    hit.addEventListener('pointerup', (ev) => {
      if (!drag) return; const t = tAt(ev), a = Math.min(drag.t, t), b = Math.max(drag.t, t), moved = Math.abs(ev.clientX - drag.x); drag = null; sel.setAttribute('opacity', 0);
      if (moved > 8 && b - a > 0.5) { state.zoom = [a, b]; state.step = null; refresh(); }
    });
    hit.addEventListener('pointerleave', () => { if (!drag) { crossFns.forEach((f) => f(null)); hideTip(); } });
    hit.addEventListener('dblclick', () => { state.zoom = null; refresh(); });
    const wrap = h('div', null, svg);
    if (series.length >= 2 || o.forceLegend) wrap.append(legendEl(series.map((s) => ({ name: s.name, color: s.color, dash: s.dash }))));
    return wrap;
  }

  // mapa de calor por núcleo (celdas SVG fusionadas por nivel de color)
  function coreHeat(r, domain) {
    if (!r.cores?.length) return null;
    const W = 560, nc = r.cores.length, rowH = Math.max(7, Math.min(16, 190 / nc)), m = { l: 58, r: 14, t: 10, b: 34 }, H = m.t + m.b + rowH * nc, [x0, x1] = domain, t = tOf(r);
    const px = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r), dark = isDark(), LV = 16;
    const color = (lv) => { const f = lv / (LV - 1); return dark ? `hsl(${215 - 215 * Math.max(0, f - 0.6) / 0.4}, 75%, ${14 + f * 52}%)` : `hsl(${215 - 215 * Math.max(0, f - 0.6) / 0.4}, 75%, ${96 - f * 56}%)`; };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'CPU por núcleo' });
    r.cores.forEach((row, k) => {
      const y = m.t + k * rowH; svg.append(sv('text', { x: m.l - 6, y: y + rowH * 0.75, 'text-anchor': 'end', 'font-size': Math.min(10, rowH) }, 'n' + k));
      let runLv = null, runStart = 0;
      const flush = (iEnd) => { if (runLv == null) return; const a = Math.max(px(t[runStart]), m.l), b = Math.min(px(t[iEnd - 1] + r.B), W - m.r); if (b > a) svg.append(sv('rect', { x: a, y, width: b - a + 0.4, height: rowH - 0.6, fill: color(runLv) })); };
      for (let i = 0; i < r.n; i++) {
        if (t[i] + r.B < x0 || t[i] > x1) { flush(i); runLv = null; continue; }
        const lv = row[i] == null ? null : Math.min(LV - 1, Math.max(0, Math.round((row[i] / 100) * (LV - 1))));
        if (lv !== runLv) { flush(i); runLv = lv; runStart = i; }
      }
      flush(r.n);
    });
    const span = x1 - x0, div = span > 900 ? 60 : 1;
    for (const v of niceTicks(x0 / div, x1 / div, 6)) svg.append(sv('text', { x: px(v * div), y: H - m.b + 15, 'text-anchor': 'middle' }, fmt(v, div === 60 ? 1 : 0)));
    svg.append(sv('text', { class: 'axis-title', x: (m.l + W - m.r) / 2, y: H - 3, 'text-anchor': 'middle' }, `${div === 60 ? 'min' : 's'} desde que empieza la carga`));
    const hit = sv('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: rowH * nc, fill: 'transparent' });
    hit.addEventListener('mousemove', (ev) => {
      const box = svg.getBoundingClientRect(), sx = W / box.width, tt = x0 + (((ev.clientX - box.left) * sx - m.l) / (W - m.l - m.r)) * (x1 - x0), k = Math.floor(((ev.clientY - box.top) * sx - m.t) / rowH), i = lowerBound(t, tt) - 1;
      crossFns.forEach((f) => f(tt)); if (k < 0 || k >= nc || i < 0) return;
      showTip(ev, `<b>núcleo/hilo ${k}</b> · ${fmt(tt, 0)} s<br>CPU: <b>${fmt(r.cores[k][i], 0)} %</b>`);
    });
    hit.addEventListener('mouseleave', () => { crossFns.forEach((f) => f(null)); hideTip(); }); svg.append(hit);
    const leg = h('div', { class: 'legend' }, h('span', null, '0 %'), h('span', { class: 'ramp', style: `background:linear-gradient(90deg,${[0, 5, 10, 15].map((l) => color(l)).join(',')})` }), h('span', null, '100 %'));
    return h('div', null, svg, leg);
  }

  // ---------------------------------------------------------------- catálogo de gráficos (qué mirar y qué componente explica)
  const C = { w1: 'var(--w1)', w2: 'var(--w2)', w3: 'var(--w3)', bad: 'var(--bad)', ink: 'var(--ink)', ink2: 'var(--ink2)', warn: 'var(--warn)' };
  const full = (el) => { el.classList.add('full'); return el; };
  const quota = (cfg, k) => { const v = cfg?.[k]; return v != null && isFinite(Number(v)) ? Number(v) : null; };
  const memMB = (s) => { const m = String(s ?? '').match(/^([\d.]+)\s*([gmk]?)/i); if (!m) return null; const n = Number(m[1]), u = m[2].toLowerCase(); return u === 'g' ? n * 1024 : u === 'k' ? n / 1024 : n; };
  const GROUPS = [
    ['Carga y latencia', [
      { t: 'Throughput: ofrecido y logrado', note: 'Si lo logrado queda por debajo de lo ofrecido, el servidor ya no da abasto y se acumula cola. Las barras sombreadas son los pasos: el tramo claro es calentamiento y el más oscuro, la ventana medida.', s: [['sched', 'Ofrecido (req/s)', C.ink2, '4 3'], ['rps', 'Logrado (req/s)', C.w1], ['errs', 'Errores (por s)', C.bad]], yl: 'req/s' },
      { t: 'Latencia p50, p95 y p99', note: 'Medida desde la hora programada, así que incluye la cola. p95 por segundo (media ponderada por peticiones dentro del cubo); p99 es el pico del cubo. Requisito: p95 ≤ 1.000 ms.', s: [['p50', 'p50', C.w3], ['p95', 'p95', C.w1], ['p99', 'p99 (pico)', C.w2]], log: true, yl: 'ms', hl: [{ y: 1000, label: 'requisito 1.000 ms' }], unit: 'ms' },
      { t: 'Peticiones en vuelo', note: 'Peticiones enviadas y sin respuesta. Crece cuando el servidor se satura; es la cola de la ley de Little (L = λ·W).', s: [['inflight', 'En vuelo (máx. del cubo)', C.w2]], yl: 'peticiones' },
    ]],
    ['CPU', [
      { t: 'CPU de la máquina', note: 'user + system = trabajo útil. iowait alto indicaría disco; steal alto, que el hipervisor nos quita CPU (créditos t3). Para citar: “us X %, sy Y %, wa Z %”.', s: [['busy', 'Ocupada', C.ink], ['user', 'user', C.w1], ['system', 'system', C.w2], ['iowait', 'iowait', C.warn], ['steal', 'steal', C.bad]], ymax: 100, ymin: 0, yl: '% de la máquina', unit: '%' },
      { t: 'CPU por proceso (% de un núcleo)', note: '100 % = un núcleo lleno. En Docker la línea punteada es la cuota CFS del contenedor: al tocarla, el kernel frena el proceso (ver “Frenado”). mongod por encima de la app señala el N+1.', s: [['appCpu', 'app (Java)', C.w2], ['mongoCpu', 'mongod', C.w3], ['genCpu', 'generador de carga', C.ink2]], yl: '% de 1 núcleo', quotaLines: true, hideSeries: ['genCpu'] },
      { t: 'CPU por núcleo / hilo', heat: true, note: 'Una fila por hilo lógico. Un par de filas llenas y el resto vacías = parte secuencial (Amdahl); todas encendidas = paralelismo aprovechado.' },
    ]],
    ['Memoria y JVM', [
      { t: 'Memoria residente (RSS)', note: 'RSS de cada proceso (el agente lo mide por proceso). En Docker, la línea punteada es el límite de memoria del contenedor; “cgroup” es la memoria contada por el kernel (incluye caché de página).', s: [['appRss', 'app RSS', C.w2], ['mongoRss', 'mongod RSS', C.w3], ['appMem', 'app (cgroup)', C.w2, '3 3'], ['mongoMem', 'mongod (cgroup)', C.w3, '3 3']], yl: 'MB', memLimit: true, unit: 'MB' },
      { t: 'Heap de la JVM después de cada GC', note: 'Del registro de GC de la app (-Xlog:gc). Si el piso sube sin parar hay fuga; un serrucho estable es el comportamiento normal.', s: [['heapBefore', 'antes del GC', C.w2, '3 3'], ['heapAfter', 'después del GC', C.w1]], yl: 'MB', unit: 'MB' },
      { t: 'Pausas de GC', note: 'Milisegundos de pausa por segundo. Las pausas detienen la app: si suben junto con el p99, parte de la cola es del recolector.', s: [['gcMs', 'pausa de GC (ms por s)', C.w2]], yl: 'ms de pausa por s', unit: 'ms/s' },
    ]],
    ['Disco', [
      { t: 'IOPS del disco', note: 'Operaciones por segundo de toda la máquina. Se compara con el techo de F0 (tabla “Uso contra techo”). En Docker es el disco de la VM; el journal de mongod aporta las escrituras.', s: [['iops', 'total', C.ink], ['riops', 'lecturas', C.w1], ['wiops', 'escrituras', C.w2]], yl: 'IOPS' },
      { t: 'Ancho de banda del disco', s: [['dmbs', 'MB/s (máquina)', C.w1]], yl: 'MB/s', unit: 'MB/s', note: 'Si la caché de WiredTiger contiene los datos, esto queda cerca de cero: la carga es CPU, no disco.' },
      { t: 'Utilización y cola del disco', s: [['dutil', 'utilización (%)', C.w2], ['dqueue', 'cola', C.ink2]], yl: '% / cola', note: 'Utilización cercana a 100 % con cola creciente indicaría un cuello de disco.' },
      { t: 'E/S de disco por proceso', s: [['appIoR', 'app lectura', C.w2], ['appIoW', 'app escritura', C.w2, '3 3'], ['mongoIoR', 'mongod lectura', C.w3], ['mongoIoW', 'mongod escritura', C.w3, '3 3']], yl: 'MB/s', unit: 'MB/s', note: 'Qué proceso toca el disco. En Windows las ráfagas pueden ser ruido del sistema: cita la mediana, no el promedio.' },
    ]],
    ['Red', [
      { t: 'Red: tarjeta de la máquina y respuestas recibidas por el generador', s: [['rx', 'NIC recibe (MB/s)', C.w1], ['tx', 'NIC envía (MB/s)', C.w2], ['mbIn', 'respuestas al generador (MB/s)', C.w3], ['mbOut', 'peticiones del generador (MB/s)', C.ink2, '3 3']], yl: 'MB/s', unit: 'MB/s', note: 'Las respuestas del generador siempre son válidas. La NIC del agente en las corridas Docker anteriores al 2026-11-07 salió en 0 por un error del agente (corregido): no la cites.' },
    ]],
    ['Frenado de CPU y steal', [
      { t: 'Frenado CFS (ms por s)', s: [['appThr', 'contenedor app', C.w2], ['mongoThr', 'contenedor mongod', C.w3], ['vmThr', 'VM', C.ink2]], yl: 'ms frenado / s', unit: 'ms/s', note: 'Tiempo que el kernel detuvo a los hilos del contenedor por agotar su cuota. Es la señal directa de que el límite de CPU es el cuello (F4).' },
    ]],
    ['MongoDB', [
      { t: 'Operaciones por segundo', s: [['m_find', 'find', C.w1], ['m_agg', 'aggregate', C.w2], ['m_getmore', 'getMore', C.w3], ['m_ins', 'insert', C.warn], ['m_upd', 'update', C.ink2]], yl: 'operaciones/s', note: 'Con el N+1 sin arreglar, cada listado dispara una consulta por lobby: find/s ≈ lobbies × listados/s. Con el arreglo caen a unas pocas por listado.' },
      { t: 'Documentos examinados y devueltos por segundo', s: [['m_docsExam', 'examinados', C.w2], ['m_docsRet', 'devueltos', C.w1], ['m_keysExam', 'claves de índice examinadas', C.w3, '3 3']], log: true, yl: 'documentos/s', note: 'Examinados ≫ devueltos = escaneos de colección sin índice (el conteo por lobby sin índice en participaciones.lobbyId). Es lo que cuadruplica la CPU de mongod.' },
      { t: 'Caché de WiredTiger', s: [['m_cacheMB', 'datos en caché (MB)', C.w1]], yl: 'MB', unit: 'MB', cacheMax: true, note: 'Mientras los datos quepan en la caché no hay lecturas de disco: por eso la carga es de CPU.' },
      { t: 'Fallos de caché de WiredTiger', s: [['m_missPct', 'fallos de caché (%)', C.w2]], yl: '% de fallos', unit: '%', note: 'Fallos cercanos a 0 % explican el disco ocioso.' },
      { t: 'Latencia de lectura de disco de mongod', s: [['m_readLatUs', 'lectura (µs)', C.w1]], yl: 'µs', unit: 'µs', note: 'Solo hay valor cuando mongod llegó a leer del disco; sin datos = todo salió de la caché.' },
      { t: 'Conexiones de mongod', s: [['m_conns', 'conexiones', C.w3]], yl: 'conexiones', note: 'Uno por conexión del pool de la app más las internas.' },
    ]],
  ];

  // ---------------------------------------------------------------- piezas de la página
  const P = {}; // referencias a los controles que se conservan entre renders (para no perder el foco al escribir)
  function buildPick() {
    const pk = document.getElementById('pick');
    P.phase = h('select', { 'aria-label': 'Fase', onchange: (e) => { state.phase = e.target.value; renderAll(); } });
    P.q = h('input', { type: 'search', placeholder: 'f6, list, r2…', 'aria-label': 'Buscar', oninput: (e) => { state.q = e.target.value; renderAll(); } });
    P.run = h('select', { 'aria-label': 'Corrida', onchange: (e) => setRun(e.target.value) });
    P.cmp = h('select', { 'aria-label': 'Comparar con', onchange: (e) => { state.b = e.target.value || null; state.step = null; refresh(true); } });
    P.count = h('span', { class: 'note' });
    const go = (d) => { const list = filtered(), i = list.findIndex((r) => r.id === state.a); if (list.length) setRun(list[(i + d + list.length) % list.length].id); };
    pk.replaceChildren(h('label', null, 'Fase ', P.phase), h('label', null, 'Buscar ', P.q), h('button', { class: 'chip', type: 'button', onclick: () => go(-1), title: 'Corrida anterior' }, '◀'),
      h('label', { class: 'grow' }, 'Corrida ', P.run), h('button', { class: 'chip', type: 'button', onclick: () => go(1), title: 'Corrida siguiente' }, '▶'), P.count, h('label', null, 'Comparar con ', P.cmp));
  }
  function fillRunSelect(sel, value, list, blank) {
    const label = (r) => `${ENV[r.env].short} · ${JARN[r.jar]} · ${r.run}${r.ended ? '' : ' ◐'}`;
    const pool = RUNS.filter((r) => list.includes(r) || r.id === value);
    sel.replaceChildren(...(blank ? [h('option', { value: '' }, blank)] : []), ...ENVS.filter((e) => pool.some((r) => r.env === e.id)).map((e) => h('optgroup', { label: e.name }, pool.filter((r) => r.env === e.id).map((r) => h('option', { value: r.id, selected: r.id === value }, label(r))))));
    sel.value = value || '';
  }
  function pickers() {
    document.getElementById('envchips').replaceChildren(...ENVS.map((e) => h('button', { class: 'chip', type: 'button', 'aria-pressed': state.envs.has(e.id), onclick: () => { state.envs.has(e.id) ? state.envs.delete(e.id) : state.envs.add(e.id); renderAll(); } }, h('span', { class: 'dot', style: `background:var(--s-${e.id})` }), e.short)));
    document.getElementById('jarchips').replaceChildren(...LB.JARS.map((j) => h('button', { class: 'chip', type: 'button', 'aria-pressed': state.jars.has(j.id), onclick: () => { state.jars.has(j.id) ? state.jars.delete(j.id) : state.jars.add(j.id); renderAll(); } }, j.name)));
    const list = filtered(), phases = [...new Set(RUNS.map((r) => r.phase))].sort();
    P.phase.replaceChildren(h('option', { value: '' }, 'todas'), ...phases.map((p) => h('option', { value: p }, PHASE[p] || p))); P.phase.value = state.phase;
    fillRunSelect(P.run, state.a, list); fillRunSelect(P.cmp, state.b, list, '— ninguna —');
    P.count.textContent = `${list.findIndex((r) => r.id === state.a) + 1} de ${list.length}`;
  }
  function filtered() {
    const q = state.q.trim().toLowerCase();
    return RUNS.filter((r) => state.envs.has(r.env) && state.jars.has(r.jar) && (!state.phase || r.phase === state.phase) && (!q || (r.run + ' ' + r.id).toLowerCase().includes(q)));
  }
  function setRun(id) { state.a = id; state.step = null; state.zoom = null; refresh(true); }

  function verdict(r) { const st = r.steps.filter((s) => s.pass != null); if (!st.length) return null; const ok = st.filter((s) => s.pass).length; return { ok, n: st.length, all: ok === st.length }; }
  function runBadge(r, role) {
    const m = byId.get(r.id), v = verdict(r);
    return h('div', { class: 'runhead' }, h('span', { class: 'role' }, role), h('span', { class: 'dot', style: `background:var(--s-${m.env})` }),
      h('b', null, `${ENV[m.env].name} · ${JARN[m.jar]} · ${m.run}`), h('span', { class: 'tag' }, PHASE[m.phase] || m.phase),
      h('span', { class: 'tag' }, r.meta?.mode === 'rate' ? 'tasa fija' : 'bucle cerrado'), h('span', { class: 'tag' }, `perfil ${r.meta?.profile?.id ?? '–'}`),
      v ? h('span', { class: v.all ? 'ok' : 'no' }, `${v.all ? '✓' : '✗'} ${v.ok}/${v.n} pasos pasan`) : null,
      !r.ended ? h('span', { class: 'warn' }, '◐ incompleta') : null);
  }

  function stepChips(a) {
    const chip = (label, active, on, cls) => h('button', { type: 'button', class: 'chip step ' + (cls || ''), 'aria-pressed': active, onclick: on }, label);
    return h('div', { class: 'chips steps' }, h('span', { class: 'note' }, 'Ventana:'), chip('Toda la carga', state.step == null && !state.zoom, () => { state.step = null; state.zoom = null; refresh(); }),
      a.steps.map((s) => chip(`${s.step} · ${stepName(s)}${s.pass == null ? '' : s.pass ? ' ✓' : ' ✗'}`, state.step === s.step, () => { state.step = s.step; state.zoom = null; refresh(); }, s.pass === false ? 'bad' : '')),
      state.zoom ? h('span', { class: 'tag' }, `selección ${fmt(state.zoom[0], 0)}–${fmt(state.zoom[1], 0)} s`) : null,
      (state.zoom || state.step != null) ? h('button', { class: 'chip', type: 'button', onclick: () => { state.step = null; state.zoom = null; refresh(); } }, 'Restablecer zoom') : h('span', { class: 'note' }, 'Arrastra sobre cualquier gráfico para ampliar; doble clic restablece.'));
  }

  // ---- KPI
  function kpis(a, b) {
    const sa = selection(a), refStep = sa.step; const sb = b ? selection(b, refStep) : null;
    const A = winStats(a, ...sa.w), Bs = b ? winStats(b, ...sb.w) : null;
    const stA = sa.step, stB = sb?.step;
    const val = (x, y) => (x == null ? null : { a: x, b: y });
    const tiles = [];
    const T = (label, f, sub, subB, cls, tipTxt) => tiles.push({ label, f, sub, subB, cls, tip: tipTxt });
    // latencia: exacta si hay paso; aproximada si no
    const lat = (st, S) => st ? { p50: st.lat?.p50, p95: st.lat?.p95, p99: st.lat?.p99, exact: true } : { p50: S.p50w, p95: S.p95w, p99: S.p99Max, exact: false };
    const la = lat(stA, A), lb = Bs ? lat(stB, Bs) : null;
    const rpsA = stA ? stA.rps : A.rps, rpsB = Bs ? (stB ? stB.rps : Bs.rps) : null;
    const errA = stA ? (stA.errorRate ?? 0) * 100 : (A.rps ? ((A.errs ?? 0) / A.rps) * 100 : null), errB = Bs ? (stB ? (stB.errorRate ?? 0) * 100 : (Bs.rps ? ((Bs.errs ?? 0) / Bs.rps) * 100 : null)) : null;
    const ok = (st) => (st && st.pass != null ? (st.pass ? '✓ pasa' : '✗ no pasa') : null);
    T('Resultado', null, stA ? `p95 ${fms(la.p95)} ms · errores ${fmt(errA, 2)} %` : `${verdict(a) ? verdict(a).ok + '/' + verdict(a).n + ' pasos pasan' : 'sin veredicto'}`, Bs ? (stB ? `B: ${ok(stB) || '–'}` : verdict(b) ? `B: ${verdict(b).ok}/${verdict(b).n} pasos` : null) : null, stA ? (stA.pass ? 'ok' : 'no') : (verdict(a)?.all ? 'ok' : verdict(a) ? 'no' : ''), `Requisito: p95 ≤ ${THRESH_P95} ms y errores ≤ ${THRESH_ERR * 100} %`);
    tiles[0].v = stA ? ok(stA) || '–' : verdict(a) ? (verdict(a).all ? '✓ todos' : `${verdict(a).ok}/${verdict(a).n}`) : '–';
    T('Throughput logrado', null, stA?.offeredRps != null ? `ofrecido ${fmt(stA.offeredRps)} req/s` : A.sched ? `ofrecido ${fmt(A.sched)} req/s` : '', Bs ? `B: ${fmt(rpsB)} req/s` : null); tiles[1].v = fmt(rpsA) + ' req/s';
    T('Latencia p50 / p95 / p99', null, la.exact ? 'exacta del paso (ms)' : '≈ aproximada de la ventana (ms)', lb ? `B: ${fms(lb.p50)} / ${fms(lb.p95)} / ${fms(lb.p99)}` : null); tiles[2].v = `${fms(la.p50)} / ${fms(la.p95)} / ${fms(la.p99)}`;
    T('Errores', null, stA ? `${stA.errors ?? 0} fallos · ${stA.timeouts ?? 0} timeouts · ${stA.drops ?? 0} descartes` : '', Bs ? `B: ${fmt(errB, 2)} %` : null, errA > THRESH_ERR * 100 ? 'no' : ''); tiles[3].v = fmt(errA, 2) + ' %';
    T('CPU de la máquina', null, `us ${fmt(A.user)} % · sy ${fmt(A.system)} % · wa ${fmt(A.iowait)} % · steal ${fmt(A.steal)} %`, Bs ? `B: ${fmt(Bs.busy)} %` : null); tiles[4].v = fmt(A.busy) + ' %';
    T('app (Java) / mongod', null, 'CPU en % de un núcleo', Bs ? `B: ${fmt(Bs.appCpu, 0)} / ${fmt(Bs.mongoCpu, 0)}` : null); tiles[5].v = `${fmt(A.appCpu, 0)} / ${fmt(A.mongoCpu, 0)} %`;
    T('Memoria residente app / mongod', null, A.appMemMax != null ? `cgroup app ${fmt(A.appMemMax, 0)} MB · mongod ${fmt(A.mongoMemMax, 0)} MB` : 'máximo en la ventana', Bs ? `B: ${fmt(Bs.appRssMax, 0)} / ${fmt(Bs.mongoRssMax, 0)} MB` : null); tiles[6].v = `${fmt(A.appRssMax, 0)} / ${fmt(A.mongoRssMax, 0)} MB`;
    T('Disco', null, `máx. ${fmt(A.iopsMax, 0)} IOPS · util ${fmt(A.dutil)} %`, Bs ? `B: ${fmt(Bs.iops, 0)} IOPS · ${fmt(Bs.dmbs, 2)} MB/s` : null); tiles[7].v = `${fmt(A.iops, 0)} IOPS · ${fmt(A.dmbs, 2)} MB/s`;
    T('Red (generador)', null, A.rx != null ? `NIC rx ${fmt(A.rx, 2)} · tx ${fmt(A.tx, 2)} MB/s` : '', Bs ? `B: ${fmt(Bs.mbIn, 2)} MB/s` : null); tiles[8].v = `${fmt(A.mbIn, 2)} MB/s`;
    if (A.appThr != null || A.mongoThr != null) { T('Frenado CFS app / mongod', null, 'ms de frenado por segundo', Bs ? `B: ${fmt(Bs.appThr, 0)} / ${fmt(Bs.mongoThr, 0)}` : null, (A.appThr || 0) + (A.mongoThr || 0) > 50 ? 'warn' : ''); tiles[tiles.length - 1].v = `${fmt(A.appThr, 0)} / ${fmt(A.mongoThr, 0)}`; }
    if (A.m_docsExam != null && rpsA) { const per = (S, rps) => (S.m_docsExam != null && rps ? S.m_docsExam / rps : null); T('Documentos examinados por petición', null, `${fmt(A.m_docsExam, 0)} docs/s ÷ ${fmt(rpsA)} req/s`, Bs ? `B: ${fmt(per(Bs, rpsB), 0)}` : null); tiles[tiles.length - 1].v = fmt(per(A, rpsA), 0); }
    if (A.heapAfterMax != null) { T('Heap tras GC (máx.) · pausas', null, `GC ${fmt(A.gcMs, 1)} ms/s`, Bs ? `B: ${fmt(Bs.heapAfterMax, 0)} MB` : null); tiles[tiles.length - 1].v = `${fmt(A.heapAfterMax, 0)} MB`; }
    return h('section', { class: 'card full' }, h('div', { class: 'kpihead' }, h('h2', null, 'Cifras de la ventana: ' + sa.label), h('span', { class: 'note' }, `${A.n} cubos de ${a.B} s` + (stA ? '' : ' · promedio de cubos (la latencia con ≈ no es exacta)'))),
      h('div', { class: 'kpis' }, tiles.map((t) => h('div', { class: 'kpi ' + (t.cls || ''), title: t.tip || null }, h('div', { class: 'kl' }, t.label), h('div', { class: 'kv' }, t.v), h('div', { class: 'ks' }, t.sub), t.subB ? h('div', { class: 'kb' }, t.subB) : null))));
  }

  // ---- gráficos
  function charts(a, b) {
    const sa = selection(a); let dom;
    if (state.step != null && sa.step) dom = [sa.step._t.start - Math.min(5, a.B * 3), sa.step._t.end + Math.min(5, a.B * 3)]; else if (state.zoom) dom = state.zoom;
    else { const rs = [a, b].filter(Boolean); dom = [Math.min(...rs.map((r) => r.t0)), Math.max(...rs.map((r) => r.t0 + r.n * r.B))]; }
    const bands = []; a.steps.forEach((s, i) => { bands.push({ x0: s._t.start, x1: s._t.from, opacity: 0.1, color: 'var(--axis)' }, { x0: s._t.from, x1: s._t.end, opacity: i % 2 ? 0.06 : 0.14, color: 'var(--accent)', label: stepName(s) }); });
    if (a.t0 < -1) bands.push({ x0: a.t0, x1: 0, opacity: 0.07, color: 'var(--warn)', label: 'reposo + siembra' });
    const out = [];
    for (const [gname, list] of GROUPS) {
      const cards = [];
      for (const c of list) {
        let node;
        if (c.heat) node = coreHeat(a, dom);
        else {
          const mk = (r, isB) => c.s.filter((s) => !(c.hideSeries || []).includes(s[0])).map(([k, name, color, dash]) => {
            const v = r.g[k]; if (!v) return null;
            return { name: name + (isB ? ' · B' : ''), color, dash: isB ? '7 4' : dash, opacity: isB ? 0.85 : 1, t: tOf(r), v, w: isB ? 1.4 : 1.8 };
          }).filter(Boolean);
          const series = [...mk(a, false), ...(b ? mk(b, true) : [])];
          const hl = [...(c.hl || [])];
          if (c.quotaLines) { const cfg = a.cfg || {}; if (quota(cfg, 'app-cpus') && byId.get(a.id).env === 'docker') { hl.push({ y: quota(cfg, 'app-cpus') * 100, label: `cuota app ${quota(cfg, 'app-cpus')} CPU`, color: C.w2 }); if (quota(cfg, 'mongo-cpus')) hl.push({ y: quota(cfg, 'mongo-cpus') * 100, label: `cuota mongod ${quota(cfg, 'mongo-cpus')} CPU`, color: C.w3 }); } else if (a.machine?.logicalCpus) hl.push({ y: a.machine.logicalCpus * 100, label: `${a.machine.logicalCpus} hilos = ${a.machine.logicalCpus * 100} %`, color: C.ink2 }); }
          if (c.memLimit && byId.get(a.id).env === 'docker') { const l = memMB(a.cfg?.['app-mem']); if (l) hl.push({ y: l, label: `límite ${a.cfg['app-mem']}`, color: C.bad }); }
          if (c.memLimit && byId.get(a.id).env !== 'docker' && a.machine?.memTotalMB) hl.push({ y: a.machine.memTotalMB, label: `RAM ${fmt(a.machine.memTotalMB / 1024, 1)} GB`, color: C.bad });
          if (c.cacheMax && a.mongoinfo?.cacheMaxMB) hl.push({ y: a.mongoinfo.cacheMaxMB, label: `máx. ${a.mongoinfo.cacheMaxMB} MB`, color: C.bad });
          node = tsChart({ title: c.t, series, domain: dom, bands, ylog: c.log, ymin: c.ymin, ymax: c.ymax, ylabel: c.yl, hlines: hl, unit: c.unit });
        }
        if (node) cards.push(card(c.t, c.note, node));
      }
      if (cards.length) out.push(h('h1', { class: 'sec full' }, gname), h('div', { class: 'grid2 full' }, cards));
    }
    // CloudWatch (solo EC2): créditos y CPU alrededor de la corrida
    const cw = D.cloudwatch?.[byId.get(a.id).env];
    if (cw) {
      const from = a.tminMs - 15 * 60e3, to = a.tmaxMs + 15 * 60e3, ser = [['CPUCreditBalance', 'saldo de créditos', C.w1], ['CPUSurplusCreditBalance', 'créditos excedentes', C.bad], ['CPUUtilization', 'CPUUtilization (%)', C.w2]];
      const mkcw = ([k, name, color]) => { const pts = (cw[k] || []).filter((p) => p.t >= from && p.t <= to && p.avg != null); return pts.length ? { name, color, t: pts.map((p) => (p.t - a.originMs) / 1000), v: pts.map((p) => p.avg) } : null; };
      const sr = ser.map(mkcw).filter(Boolean);
      const cdom = [(from - a.originMs) / 1000, (to - a.originMs) / 1000];
      if (sr.length) {
        const ch = tsChart({ title: 'CloudWatch', series: sr, domain: state.zoom || cdom, bands: [{ x0: 0, x1: a.endT ?? (a.tmaxMs - a.originMs) / 1000, opacity: 0.1, color: 'var(--accent)', label: 'la corrida' }], ylabel: 'créditos / %', forceLegend: true });
        out.push(h('h1', { class: 'sec full' }, 'Créditos de CPU (CloudWatch, 5 min)'), h('div', { class: 'grid2 full' }, card('Saldo de créditos y utilización durante la corrida', 'Una muestra cada 5 minutos: una corrida corta tiene pocos puntos. Con Unlimited el excedente se factura; en Standard el saldo en 0 estrangula la CPU a la línea base.', ch)));
      } else out.push(h('h1', { class: 'sec full' }, 'Créditos de CPU (CloudWatch, 5 min)'), card(null, 'CloudWatch no tiene muestras de 5 minutos dentro de esta corrida (o no se descargaron).'));
    }
    return out;
  }

  // ---- tablas
  function stepsTable(r) {
    if (!r.steps.length) return empty('Esta corrida no tiene pasos.');
    const rows = r.steps.map((s) => { const S = winStats(r, s._t.from, s._t.end), P = s.passAt || {};
      return [s.step, stepName(s), fmt(s.seconds ?? (s._t.end - s._t.from), 0), fmt(s.offeredRps ?? s.rate), fmt(s.rps), s.achievedRatio != null ? fmt(s.achievedRatio * 100, 1) + ' %' : '–', fmt(s.lat?.n ?? s.requests, 0), fms(s.lat?.p50), fms(s.lat?.p95), fms(s.lat?.p99), fms(s.lat?.max),
        s.latService ? fms(s.latService.p95) : '–', s.genLag ? fms(s.genLag.p99) : '–', s.genOk == null ? '–' : s.genOk ? 'sí' : h('span', { class: 'no' }, 'no'), fmt(s.errors, 0), fmt((s.errorRate || 0) * 100, 2) + ' %', fmt(s.timeouts ?? 0, 0), fmt(s.drops ?? 0, 0), fmt(s.maxInflight, 0),
        s.pass == null ? '–' : pass(s.pass, s.pass ? 'pasa' : 'no pasa'), Object.keys(P).length ? Object.entries(P).map(([k, v]) => `${k}: ${v ? '✓' : '✗'}`).join(' ') : '–', s.reasons?.length ? s.reasons.join('; ') : '–', s.lobbiesStart != null ? `${s.lobbiesStart} → ${s.lobbiesNow}` : '–',
        fmt(s.mbInPerS, 3), fmt(S.busy), fmt(S.user), fmt(S.system), fmt(S.iowait), fmt(S.steal), fmt(S.appCpu, 0), fmt(S.mongoCpu, 0), `${fmt(S.appRssMax, 0)} / ${fmt(S.mongoRssMax, 0)}`, fmt(S.iops, 0), fmt(S.dmbs, 2), `${fmt(S.rx, 2)} / ${fmt(S.tx, 2)}`, `${fmt(S.appThr, 0)} / ${fmt(S.mongoThr, 0)}`, fmt(S.m_docsExam, 0), fmt(S.m_cacheMB, 1), fmt(S.m_missPct, 2), fmt(S.heapAfterMax, 0), fmt(S.gcMs, 1)]; });
    return table(['Paso', 'Carga', 'Dur. (s)', 'Ofrecido req/s', 'Logrado req/s', 'Logrado/ofrecido', 'Peticiones', 'p50', 'p95', 'p99', 'máx', 'p95 servicio', 'Retraso gen. p99', 'Gen. OK', 'Errores', 'Err %', 'Timeouts', 'Descartes', 'Máx. en vuelo', 'Resultado', 'p95 ≤ 300/500/1000', 'Razones', 'Lobbies ini → fin', 'Resp. MB/s', 'CPU máq %', 'us', 'sy', 'wa', 'steal', 'app %', 'mongod %', 'RSS app / mongod MB', 'IOPS', 'Disco MB/s', 'NIC rx / tx MB/s', 'Frenado app / mongod ms/s', 'Docs examinados/s', 'Caché MB', 'Fallos caché %', 'Heap tras GC MB', 'GC ms/s'], rows, { num: [0, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 36, 37, 38, 39, 40] });
  }
  function opsTable(r) {
    const rows = []; for (const s of r.steps) for (const [op, v] of Object.entries(s.byOp || {})) {
      const codes = Object.entries(s.codes || {}).filter(([k]) => k.startsWith(op + ':')).map(([k, n]) => `${k.split(':')[1]}×${n}`).join(' ');
      rows.push([s.step, stepName(s), op, fmt(v.n, 0), fms(v.p50), fms(v.p95), fms(v.p99), fms(v.max), s.respBytes?.[op] != null ? fmt(s.respBytes[op] / 1024, 1) : '–', codes || '–']);
    }
    return rows.length ? table(['Paso', 'Carga', 'Operación', 'Peticiones', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'máx (ms)', 'KB por respuesta', 'Códigos HTTP'], rows, { num: [0, 3, 4, 5, 6, 7, 8] }) : empty('Sin desglose por operación.');
  }
  function ceilings(r) {
    const m = byId.get(r.id), sd = D.sondas[m.env + '|base']; if (!sd) return null;
    const w = loadWindow(r), S = winStats(r, ...w), rows = [];
    const row = (name, used, usedMax, ceil, unit) => rows.push([name, fmt(used, unit === 'MB/s' ? 2 : 0) + ' ' + unit, fmt(usedMax, unit === 'MB/s' ? 2 : 0) + ' ' + unit, ceil != null ? fmt(ceil, 0) + ' ' + unit : '–', ceil && used != null ? fmt((used / ceil) * 100, 2) + ' %' : '–', ceil && usedMax != null ? fmt((usedMax / ceil) * 100, 2) + ' %' : '–']);
    row('Lectura aleatoria 4 KiB (IOPS de lectura)', S.riops ?? S.iops, Math.max(...(r.g.riops || r.g.iops || [0]).map((x) => x ?? 0)), sd.randread?.iops, 'IOPS');
    row('Escritura 4 KiB con fsync (IOPS de escritura)', S.wiops, Math.max(...(r.g.wiops || [0]).map((x) => x ?? 0)), sd.syncwrite?.iops, 'IOPS');
    row('Ancho de banda de disco (secuencial)', S.dmbs, S.dmbsMax, sd.seqread?.mbs, 'MB/s');
    if (sd.iperfMbps) { const net = ((S.rx || 0) + (S.tx || 0)) * 8; row('Red (rx + tx de la NIC, Mbit/s)', net, (Math.max(...(r.g.rx || [0]).map((x) => x ?? 0)) + Math.max(...(r.g.tx || [0]).map((x) => x ?? 0))) * 8, sd.iperfMbps, 'Mbit/s'); }
    return card('Uso contra techo del hardware (F0)', 'Promedio y máximo del agente durante la carga, frente a lo que el hardware rinde en la sonda fio/iperf3 de ese entorno. Un porcentaje bajo = el recurso no es el cuello. Los techos de F0 son de la máquina entera; en Docker, del disco de la VM.', table(['Recurso', 'Uso medio', 'Uso máx.', 'Techo F0', '% medio', '% máx.'], rows, { num: [1, 2, 3, 4, 5] }));
  }
  function infoCards(r) {
    const kv = (obj) => h('dl', { class: 'kv2' }, Object.entries(obj).filter(([, v]) => v != null && v !== '').flatMap(([k, v]) => [h('dt', null, k), h('dd', null, typeof v === 'object' ? JSON.stringify(v) : String(v))]));
    const m = byId.get(r.id), mc = r.machine || {}, cards = [];
    cards.push(card('Entorno de esta corrida', 'Todo sale de run.json y de las líneas “machine” y “mongoinfo” del agente: lo que hay que anotar en el informe.', kv({
      'Carpeta': m.dirRel, 'Entorno': ENV[m.env].name, 'Jar': r.cfg?.jar ?? JARN[m.jar], 'CPU': mc.cpuModel?.trim(), 'Hilos lógicos': mc.logicalCpus, 'RAM (MB)': mc.memTotalMB, 'SO': mc.os ?? (mc.platform ? mc.platform + ' ' + (mc.release || '') : null), 'Instancia (DMI)': mc.dmi, 'Caché L3': mc.cache, 'Docker': mc.docker,
      'Cuota app (cgroup)': mc.ct_app ? JSON.stringify(mc.ct_app) : null, 'Cuota mongod (cgroup)': mc.ct_mongo ? JSON.stringify(mc.ct_mongo) : null, 'MongoDB': r.mongoinfo?.version, 'Motor': r.mongoinfo?.storageEngine, 'Caché WiredTiger máx. (MB)': r.mongoinfo?.cacheMaxMB, 'Node (generador)': r.meta?.node ?? mc.node })));
    cards.push(card('Parámetros de la corrida', 'Configuración con la que se lanzó (run.json) y definición de la carga.', kv({
      'Perfil': r.meta?.profile?.name, 'Mezcla': r.meta?.profile?.mix ? JSON.stringify(r.meta.profile.mix) : null, 'Modo': r.meta?.mode, 'Niveles': r.meta?.levels ? JSON.stringify(r.meta.levels) : r.cfg?.rates ?? r.cfg?.workers, 'Segundos por nivel': r.cfg?.seconds, 'Calentamiento (s)': r.cfg?.warm, 'Pausa (s)': r.cfg?.pause, 'Timeout (s)': r.cfg?.timeout, 'Semilla': r.cfg?.seed,
      'Lobbies sembrados': r.seed?.lobbies ?? r.cfg?.lobbies, 'Usuarios': r.seed?.users ?? r.cfg?.users, 'App CPUs / mem': r.cfg?.['app-cpus'] != null ? `${r.cfg['app-cpus']} / ${r.cfg['app-mem']}` : null, 'mongod CPUs / mem': r.cfg?.['mongo-cpus'] != null ? `${r.cfg['mongo-cpus']} / ${r.cfg['mongo-mem']}` : null, 'Afinidad': r.cfg?.pinned ?? null, 'Máscara servidor / generador': r.cfg?.srvMask != null ? `${r.cfg.srvMask} / ${r.cfg.genMask}` : null, 'Inicio': r.meta?.startedAt, 'Umbral p95 (ms)': r.meta?.thresholds?.p95Ms, 'Umbral errores': r.meta?.thresholds?.errorRate,
      'Latencia base de siembra': r.seed ? `registro ${fmt(r.seed.registroMs, 0)} ms · login ${fmt(r.seed.loginMs, 0)} ms · crear lobby ${fmt(r.seed.crearLobbyMs, 0)} ms · RTT ${fmt(r.seed.baseRttMs, 1)} ms` : null,
      'Reposo previo': r.idle ? `CPU máquina ${fmt(r.idle.cpuBusyPct)} % (máx. ${fmt(r.idle.maxCpuBusyPct)} %) · app ${fmt(r.idle.appCpu)} % · mongod ${fmt(r.idle.mongoCpu)} % · ${r.idle.clean ? 'limpio' : 'SUCIO (> límite)'}` : null,
      'Muestras': `${r.samples.agent} del agente · ${r.samples.mongo} de mongod · ${r.samples.sec} segundos de carga · cubos de ${r.B} s` })));
    const L = r.log, gc = r.gc;
    cards.push(card('Registro de la app y recolector de basura', 'GC leído de app.log (-Xlog:gc). Las líneas ERROR/WARN se agrupan por mensaje.', kv({
      'Recolector': gc?.kinds?.join(' · '), 'Pausas de GC': gc ? `${fmt(gc.n, 0)} (${gc.full} Full)` : null, 'Tiempo total en pausa': gc ? `${fmt(gc.totalMs, 0)} ms en ${fmt(gc.spanS, 0)} s` : null, 'Pausa máxima': gc ? fmt(gc.maxMs, 1) + ' ms' : null, 'Capacidad de heap (última)': gc ? gc.heapCapMB + ' MB' : null,
      'Líneas de app.log': L?.lines, 'ERROR': L?.err, 'WARN': L?.warn }), L?.top?.length ? h('ul', null, L.top.map((t) => h('li', null, h('code', null, `${t.n}× ${t.msg}`)))) : null));
    return cards;
  }
  function citeText(r) {
    const m = byId.get(r.id), L = [];
    for (const s of r.steps) {
      const S = winStats(r, s._t.from, s._t.end), P = fms;
      L.push(`${ENV[m.env].short} · ${JARN[m.jar]} · ${m.run} · paso ${s.step} (${stepName(s)}): logrado ${fmt(s.rps)} req/s, p50 ${P(s.lat?.p50)} ms, p95 ${P(s.lat?.p95)} ms, p99 ${P(s.lat?.p99)} ms, errores ${fmt((s.errorRate || 0) * 100, 2)} %${s.pass == null ? '' : s.pass ? ' (pasa)' : ' (no pasa)'}; CPU de la máquina ${fmt(S.busy)} % (us ${fmt(S.user)} %, sy ${fmt(S.system)} %, wa ${fmt(S.iowait)} %, steal ${fmt(S.steal)} %); app ${fmt(S.appCpu, 0)} % y mongod ${fmt(S.mongoCpu, 0)} % de un núcleo; RSS app ${fmt(S.appRssMax, 0)} MB y mongod ${fmt(S.mongoRssMax, 0)} MB; disco ${fmt(S.iops, 0)} IOPS y ${fmt(S.dmbs, 2)} MB/s; red ${fmt(S.mbIn, 2)} MB/s de respuestas${S.rx != null ? `, NIC rx ${fmt(S.rx, 2)} / tx ${fmt(S.tx, 2)} MB/s` : ''}${S.appThr != null ? `; frenado CFS app ${fmt(S.appThr, 0)} ms/s y mongod ${fmt(S.mongoThr, 0)} ms/s` : ''}${S.m_docsExam != null && s.rps ? `; mongod examina ${fmt(S.m_docsExam / s.rps, 0)} documentos por petición` : ''}. Fuente: ${m.dirRel}`);
    }
    return L.join('\n');
  }
  function csv(r, kind) {
    const m = byId.get(r.id); let txt;
    if (kind === 'grid') { const keys = Object.keys(r.g).filter((k) => k !== 'measuring'), t = tOf(r); txt = ['t_s,' + keys.join(','), ...t.map((tt, i) => [tt, ...keys.map((k) => r.g[k][i] ?? '')].join(','))].join('\n'); }
    else { const keys = ['step', 'rate', 'workers', 'seconds', 'offeredRps', 'rps', 'achievedRatio', 'errors', 'errorRate', 'timeouts', 'drops', 'maxInflight', 'pass']; txt = [keys.concat(['p50', 'p95', 'p99', 'max']).join(','), ...r.steps.map((s) => keys.map((k) => s[k] ?? '').concat([s.lat?.p50, s.lat?.p95, s.lat?.p99, s.lat?.max]).join(','))].join('\n'); }
    const a = h('a', { href: URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' })), download: `${m.id.replace(/[\\/]/g, '_')}_${kind}.csv` }); document.body.append(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------------- render
  function body(a, b) {
    crossFns = []; uid = 0;
    const main = document.getElementById('main'); main.replaceChildren();
    main.append(full(card(null, null, runBadge(a, 'A'), b ? runBadge(b, 'B (línea discontinua)') : null,
      h('p', { class: 'note' }, 'Un visor para una corrida: todos los datos del generador y del agente en una misma línea de tiempo. Cero = momento en que empieza la carga; lo negativo es el reposo previo y la siembra. Con “Comparar con” se superpone otra corrida por el mismo tiempo de carga; pasos con la misma tasa se comparan en las cifras.'), stepChips(a))));
    main.append(kpis(a, b));
    for (const n of charts(a, b)) main.append(n);
    main.append(h('h1', { class: 'sec full' }, 'Tablas'));
    const ce = ceilings(a); if (ce) main.append(ce);
    main.append(card('Pasos de la corrida', 'Cifras oficiales del generador (latencias exactas por paso) junto con el promedio del agente en la ventana medida de cada paso. Desplaza la tabla hacia la derecha.', stepsTable(a)));
    main.append(card('Por operación', 'Latencia por endpoint dentro de cada paso, tamaño de respuesta y códigos HTTP.', opsTable(a)));
    if (b) { main.append(h('h1', { class: 'sec full' }, 'Corrida B'), card('Pasos de B', null, stepsTable(b))); }
    main.append(h('h1', { class: 'sec full' }, 'Contexto y trazabilidad'));
    for (const c of infoCards(a)) main.append(c);
    const txt = citeText(a);
    main.append(full(card('Cifras para citar en el informe', 'Cada línea sale de esta corrida con los valores exactos y la carpeta de origen. Pegar tal cual y editar el texto alrededor.', h('textarea', { readonly: true, rows: Math.min(14, a.steps.length * 3 + 1), class: 'cite', onclick: (e) => e.target.select() }, txt),
      h('div', { class: 'controls' }, h('button', { class: 'chip', type: 'button', onclick: () => { const ta = document.querySelector('textarea.cite'); ta.select(); try { navigator.clipboard.writeText(ta.value); } catch { document.execCommand('copy'); } } }, 'Copiar'),
        h('button', { class: 'chip', type: 'button', onclick: () => csv(a, 'steps') }, 'CSV de pasos'), h('button', { class: 'chip', type: 'button', onclick: () => csv(a, 'grid') }, 'CSV de la serie de tiempo'),
        h('span', { class: 'note' }, `Datos crudos: resultados/${(byId.get(a.id).dirRel || '').replace(/^resultados\//, '')}/ (load.ndjson, agent.ndjson, app.log, run.json)`)))));
    document.getElementById('tabs').replaceChildren(...[...main.querySelectorAll('h1.sec')].map((e, i) => { e.id = 'sec-' + i; return h('button', { type: 'button', onclick: () => e.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, e.textContent); }));
  }
  let token = 0;
  async function refresh(reload) {
    writeHash(); const my = ++token, main = document.getElementById('main');
    if (reload) { main.replaceChildren(empty('Cargando…')); pickers(); }
    try {
      const [a, b] = await Promise.all([getRun(state.a), getRun(state.b)]); if (my !== token) return;
      loaded[state.a] = a; if (state.b) loaded[state.b] = b;
      if (state.step != null && !a.steps[state.step]) state.step = null;
      body(a, b);
    } catch (e) { main.replaceChildren(card('No se pudo mostrar la corrida', null, h('pre', null, String(e.message || e)))); }
  }
  function renderAll() { pickers(); }
  function defaultRun() { // una corrida representativa: F6 del PC con arreglo si existe; si no, la primera
    return (RUNS.find((r) => r.env === 'docker' && r.jar === 'base' && r.run === 'f6-mezcla-lectura-r1') || RUNS.find((r) => r.phase === 'f6') || RUNS[0])?.id;
  }
  document.getElementById('gen').textContent = `Datos generados ${new Date(D.generatedAt).toLocaleString('es')} · ${RUNS.length} corridas · detalle cargado bajo demanda de runs/ · regenerar: node dashboard/build.mjs`;
  document.getElementById('theme').addEventListener('click', () => { const r = document.documentElement; r.dataset.theme = isDark() ? 'light' : 'dark'; refresh(); });
  addEventListener('hashchange', () => { const before = state.a + '|' + state.b; readHash(); if (state.a + '|' + state.b !== before) refresh(true); else refresh(); });
  readHash(); if (!state.a) state.a = defaultRun(); buildPick(); P.q.value = state.q; pickers(); refresh(true);
})();
