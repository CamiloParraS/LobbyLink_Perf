'use strict';
(function () {
  const D = window.DATA, L = window.LIB, A = L.make(D);
  const { ENVS, key } = L;
  const ENV = Object.fromEntries(ENVS.map((e) => [e.id, e]));
  const state = { envs: new Set(ENVS.map((e) => e.id)), jars: new Set(['base', 'fix', 'thr']), runs: {}, mix: 'mezcla-lectura', endpoint: 'list', amdahl: 'solo-list', level: null, cost: {} };
  try { const c = JSON.parse(localStorage.getItem('lobbylink-cost') || '{}'); state.cost = c; } catch {}
  const saveCost = () => { try { localStorage.setItem('lobbylink-cost', JSON.stringify(state.cost)); } catch {} };

  const { NS, h, add, sv, fmt, fms, empty, card, tip, showTip, hideTip, tipRow, niceTicks, logTicks, legendEl, table, pass, select } = window.UI;

  // ---------------------------------------------------------------- utilidades DOM / formato
  const keyName = (k) => { const [e, j] = k.split('|'); return ENV[e].short + (j === 'fix' ? ' · N+1 arreglado' : j === 'thr' ? ' · saldo 0' : ' · base'); };
  const colorOf = (env) => `var(--s-${env})`;
  const dashOf = (jar) => (jar === 'fix' ? '6 4' : jar === 'thr' ? '2 3' : null);
  const hhmm = (t) => new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const activeKeys = () => A.keys().filter((k) => { const [e, j] = k.split('|'); return state.envs.has(e) && state.jars.has(j); }).sort((a, b) => {
    const [ea, ja] = a.split('|'), [eb, jb] = b.split('|'); return ENV[ea].slot - ENV[eb].slot || (ja === 'base' ? -1 : 1) - (jb === 'base' ? -1 : 1);
  });


  function lineChart(opt) {
    const W = Math.max(300, opt.width || 560), H = opt.height || 300, m = { l: 58, r: opt.endLabels ? 118 : 18, t: 12, b: 44 };
    const series = opt.series.filter((s) => s.pts.some((p) => p[1] != null));
    const wrap = h('div'); if (!series.length) { wrap.append(empty('Sin datos para los filtros elegidos')); return wrap; }
    const xs = series.flatMap((s) => s.pts.map((p) => p[0])).concat(opt.vlines ? opt.vlines.map((v) => v.x) : []).concat(opt.xDomain || []);
    const ys = series.flatMap((s) => s.pts.map((p) => p[1]).filter((v) => v != null)).concat(opt.hlines ? opt.hlines.map((v) => v.y) : []);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = opt.ymin ?? (opt.ylog ? Math.min(...ys.filter((v) => v > 0)) * 0.8 : Math.min(0, ...ys)), y1 = opt.ymax ?? Math.max(...ys) * (opt.ylog ? 1.4 : 1.08);
    if (opt.xlog) { x0 = Math.max(x0 * 0.85, 1e-9); x1 *= 1.15; } else if (x0 === x1) x1 = x0 + 1;
    if (!isFinite(y0) || y0 <= 0 && opt.ylog) y0 = 1;
    const px = (v) => m.l + (opt.xlog ? (Math.log(v) - Math.log(x0)) / (Math.log(x1) - Math.log(x0)) : (v - x0) / (x1 - x0)) * (W - m.l - m.r);
    const py = (v) => H - m.b - (opt.ylog ? (Math.log(Math.min(Math.max(v, y0), y1)) - Math.log(y0)) / (Math.log(y1) - Math.log(y0)) : (v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': opt.title || 'gráfico' });
    const yt = opt.ylog ? logTicks(y0, y1) : niceTicks(y0, y1, 5), xt = opt.xticks || (opt.xlog ? logTicks(x0, x1) : niceTicks(x0, x1, 6));
    if (opt.bands) for (const b of opt.bands) { const a = Math.max(px(Math.max(b.x0, x0)), m.l), c = Math.min(px(Math.min(b.x1, x1)), W - m.r); if (c > a) svg.append(sv('rect', { x: a, y: m.t, width: c - a, height: H - m.t - m.b, fill: b.color || 'var(--axis)', opacity: b.opacity ?? 0.18 }), c - a > 34 && b.label ? sv('text', { x: a + 3, y: m.t + 10, 'font-size': 10 }, b.label) : null); }
    for (const v of yt) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: py(v), y2: py(v), stroke: 'var(--grid)', 'stroke-width': 1 }), sv('text', { x: m.l - 6, y: py(v) + 4, 'text-anchor': 'end' }, (opt.fmty || ((q) => fmt(q, 2)))(v)));
    for (const v of xt) svg.append(sv('text', { x: px(v), y: H - m.b + 16, 'text-anchor': 'middle' }, (opt.fmtx || ((q) => fmt(q, 2)))(v)));
    svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: 'var(--axis)' }));
    if (opt.xlabel) svg.append(sv('text', { class: 'axis-title', x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle' }, opt.xlabel));
    if (opt.ylabel) svg.append(sv('text', { class: 'axis-title', x: 12, y: (m.t + H - m.b) / 2, transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})`, 'text-anchor': 'middle' }, opt.ylabel));
    for (const hl of opt.hlines || []) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: py(hl.y), y2: py(hl.y), stroke: hl.color || 'var(--bad)', 'stroke-width': 1.2, 'stroke-dasharray': '5 4' }), sv('text', { x: W - m.r - 4, y: py(hl.y) - 4, 'text-anchor': 'end', class: 'lbl' }, hl.label || ''));
    for (const vl of opt.vlines || []) { if (vl.x < x0 || vl.x > x1) continue; svg.append(sv('line', { x1: px(vl.x), x2: px(vl.x), y1: m.t, y2: H - m.b, stroke: vl.color || 'var(--ink2)', 'stroke-width': 1.2, 'stroke-dasharray': '2 4' })); }
    const ends = [];
    for (const s of series) {
      let d = '', pen = false; for (const p of s.pts) { if (p[1] == null) { pen = false; continue; } d += (pen ? 'L' : 'M') + px(p[0]).toFixed(1) + ' ' + py(p[1]).toFixed(1); pen = true; }
      svg.append(sv('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dash || null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      if (opt.markers !== false) for (const p of s.pts) if (p[1] != null && opt.failAbove != null && p[1] >= opt.failAbove) { const cx = px(p[0]), cy = py(p[1]), q = 5; svg.append(sv('path', { d: `M${cx - q} ${cy - q}L${cx + q} ${cy + q}M${cx - q} ${cy + q}L${cx + q} ${cy - q}`, stroke: 'var(--bad)', 'stroke-width': 2.5, 'stroke-linecap': 'round', fill: 'none' })); } else if (p[1] != null) svg.append(sv('circle', { cx: px(p[0]), cy: py(p[1]), r: s.pts.length > 60 ? 0 : 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
      const last = [...s.pts].reverse().find((p) => p[1] != null); if (last && opt.endLabels) ends.push({ y: py(last[1]), s, x: px(last[0]) });
    }
    ends.sort((a, b) => a.y - b.y); for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const e of ends) svg.append(sv('text', { x: Math.min(e.x + 8, W - m.r + 6), y: e.y + 4, class: 'lbl' }, e.s.short || e.s.name));
    // hover
    const cross = sv('line', { y1: m.t, y2: H - m.b, stroke: 'var(--ink2)', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none' }); svg.append(cross);
    const hit = sv('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }); svg.append(hit);
    hit.addEventListener('mousemove', (ev) => {
      const box = svg.getBoundingClientRect(), mx = (ev.clientX - box.left) * (W / box.width);
      let best = null, bd = 1e9; for (const s of series) for (const p of s.pts) if (p[1] != null) { const d = Math.abs(px(p[0]) - mx); if (d < bd) { bd = d; best = p[0]; } }
      if (best == null) return; cross.setAttribute('x1', px(best)); cross.setAttribute('x2', px(best)); cross.setAttribute('opacity', 0.5);
      const rows = series.map((s) => { const p = s.pts.find((q) => q[0] === best && q[1] != null); return p ? tipRow(s.color, `${s.name}: <b>${(opt.fmtTip || ((q) => fmt(q, 2)))(p[1], p)}</b>`) : null; }).filter(Boolean);
      showTip(ev, `<b>${(opt.fmtx || ((q) => fmt(q, 2)))(best)}${opt.xunit || ''}</b>` + rows.join(''));
    });
    hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); hideTip(); });
    wrap.append(svg);
    if (series.length >= 2 || opt.forceLegend) wrap.append(legendEl(series.map((s) => ({ name: s.name, color: s.color, dash: s.dash }))));
    return wrap;
  }

  // ---------------------------------------------------------------- gráfico de barras (agrupadas o apiladas)
  function barChart(opt) {
    const W = Math.max(300, opt.width || 560), H = opt.height || 280, m = { l: 58, r: 12, t: 14, b: 54 };
    const groups = opt.groups; const wrap = h('div'); if (!groups.length) { wrap.append(empty('Sin datos para los filtros elegidos')); return wrap; }
    // etiquetas: si no caben en horizontal se giran 35° y se reserva margen inferior según la más larga
    const longest = Math.max(...groups.map((g) => String(g.label).length)), slot = (W - m.l - m.r) / groups.length, rotate = longest * 5.9 > slot * 0.92;
    if (rotate) m.b = Math.min(150, 22 + longest * 5.9 * 0.58);
    const tot = (b) => (b.stack ? b.stack.reduce((a, s) => a + (s.value || 0), 0) : b.value);
    const ymax = opt.ymax ?? (Math.max(...groups.flatMap((g) => g.bars.map(tot).filter((v) => v != null)), 0) * 1.1 || 1);
    const yt = niceTicks(0, ymax, 5), y1 = Math.max(ymax, yt[yt.length - 1]);
    const py = (v) => H - m.b - (v / y1) * (H - m.t - m.b);
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': opt.title || 'gráfico de barras' });
    for (const v of yt) svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: py(v), y2: py(v), stroke: 'var(--grid)' }), sv('text', { x: m.l - 6, y: py(v) + 4, 'text-anchor': 'end' }, fmt(v, 2)));
    svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: py(0), y2: py(0), stroke: 'var(--axis)' }));
    if (opt.ylabel) svg.append(sv('text', { class: 'axis-title', x: 12, y: (m.t + H - m.b) / 2, transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})`, 'text-anchor': 'middle' }, opt.ylabel));
    const gw = (W - m.l - m.r) / groups.length; const nb = Math.max(...groups.map((g) => g.bars.length));
    const bw = Math.min(46, (gw * 0.78) / nb), label = nb * groups.length <= 16;
    groups.forEach((g, gi) => {
      const gx = m.l + gi * gw + (gw - bw * g.bars.length) / 2;
      const cx = m.l + gi * gw + gw / 2, ty = H - m.b + 15; const t = rotate ? sv('text', { x: cx + 4, y: ty, 'text-anchor': 'end', transform: `rotate(-35 ${cx + 4} ${ty})` }, g.label) : sv('text', { x: cx, y: ty, 'text-anchor': 'middle' }, g.label); svg.append(t);
      g.bars.forEach((b, bi) => {
        const x = gx + bi * bw; const innerW = bw - 4; if (b.value == null && !b.stack) return;
        const draw = (v0, v1, fill, extra = {}) => { const yTop = py(v1), yBot = py(v0) - (v0 > 0 ? 2 : 0); if (yBot - yTop < 0.5) return null; return sv('rect', { x: x + 2, y: yTop, width: innerW, height: yBot - yTop, rx: 3, fill, ...extra }); };
        let el;
        if (b.stack) { let acc = 0; for (const s of b.stack) { el = draw(acc, acc + (s.value || 0), s.color, { opacity: s.opacity ?? 1 }); if (el) svg.append(el); acc += s.value || 0; } }
        else { el = draw(0, b.value, b.outline ? 'none' : b.color, b.outline ? { stroke: b.color, 'stroke-width': 2 } : {}); if (el) svg.append(el); }
        const top = py(tot(b)); if (label && tot(b) != null) svg.append(sv('text', { x: x + bw / 2, y: top - 4, 'text-anchor': 'middle', class: 'lbl' }, fmt(tot(b), tot(b) < 10 ? 2 : 0)));
        const hit = sv('rect', { x, y: m.t, width: bw, height: H - m.t - m.b, fill: 'transparent' });
        hit.addEventListener('mousemove', (ev) => showTip(ev, `<b>${g.label}</b>` + (b.stack ? b.stack.map((s) => tipRow(s.color, `${s.name}: <b>${fmt(s.value, 2)}</b>`)).join('') + tipRow('var(--ink2)', `total: <b>${fmt(tot(b), 2)}</b>`) : tipRow(b.color, `${b.name}: <b>${fmt(b.value, 2)}</b>`)) ));
        hit.addEventListener('mouseleave', hideTip); svg.append(hit);
      });
    });
    wrap.append(svg); if (opt.legend) wrap.append(legendEl(opt.legend)); return wrap;
  }

  const mixLabel = { 'mezcla-lectura': 'mezcla-lectura (list + view)', 'mezcla-postman': 'mezcla-postman (6 endpoints)' };
  const envLegend = (keys) => keys.map((k) => { const [e, j] = k.split('|'); return { name: keyName(k), color: colorOf(e), dash: dashOf(j) }; });

  // ---------------------------------------------------------------- pestañas
  const TABS = [
    ['resumen', 'Resumen'], ['preguntas', 'Las 4 preguntas'], ['f0', 'F0 Sondas'], ['f1', 'F1 Costo por petición'], ['f2', 'F2 Datos'], ['f3', 'F3 Amdahl'], ['f4', 'F4 Cuotas'], ['f5', 'F5 Rampa'], ['f6', 'F6 Sostenida'],
    ['f78', 'F7 / F8 Largas'], ['recursos', 'Recursos por corrida'], ['creditos', 'Créditos (CloudWatch)'], ['entornos', 'Entornos (hardware)'], ['nmas1', 'N+1 antes / después'], ['costos', 'Costos'], ['datos', 'Datos y descargas'],
  ];

  function tabResumen() {
    const keys = activeKeys(); const out = [];
    const rows = keys.map((k) => {
      const [e, j] = k.split('|'); const kn = A.kneeOf(e, j, 'mezcla-lectura'); const xm = A.xmaxOf(e, j, 'mezcla-lectura'); const mp = A.maxPassingLevel(e, j); const mg = A.marginLevel(e, j, kn && kn.knee); const mc = D.machines[e];
      return [keyName(k), mc ? `${mc.logicalCpus} hilos · ${fmt(mc.memTotalMB / 1024, 1)} GB` : '–', fmt(xm), kn ? (kn.allPass ? `> ${fmt(kn.knee)}` : fmt(kn.knee)) : '–', kn && xm && !kn.allPass ? fmt((kn.knee / xm) * 100, 0) + ' %' : '–',
        mp ? `${fmt(mp.rate, 0)} req/s · p95 ${fms(mp.p95)} ms` : '–', mg ? `${fmt(mg.rate, 1)} req/s` : '–'];
    });
    out.push(card('Qué se midió y qué dice', 'Cada fila es un entorno y una versión del jar. “Codo” = mayor req/s logrado en la rampa F5 (mezcla-lectura) que pasa el requisito (p95 ≤ 1.000 ms y errores ≤ 1 %). “Pasa en F6” = mayor nivel de la escala común que pasa en todas las repeticiones. “Con margen” = mayor nivel que pasa y no pasa del 60 % del codo.',
      table(['Entorno', 'Máquina', 'X_max predicho (req/s)', 'Codo medido F5 (req/s)', 'Medido / predicho', 'Pasa en F6', 'Con margen (≤ 60 % del codo)'], rows, { num: [2, 3, 4] })));
    const groups = keys.map((k) => { const [e, j] = k.split('|'); const kn = A.kneeOf(e, j, 'mezcla-lectura'); return { label: keyName(k), bars: [{ name: 'Predicho (F1)', value: A.xmaxOf(e, j, 'mezcla-lectura'), color: colorOf(e), outline: true }, { name: 'Codo medido (F5)', value: kn ? kn.knee : null, color: colorOf(e) }] }; });
    out.push(card('Codo medido contra techo predicho', 'Borde = predicción de F1 (X_max = capacidad / Σ pᵢ·Dᵢ); relleno = lo que la rampa midió. Si el relleno supera el borde en una barra “> n”, la rampa no llegó a romper la máquina.',
      barChart({ groups, ylabel: 'req/s (mezcla-lectura)', legend: [{ name: 'Predicho', color: 'var(--ink2)', bar: true, outline: true }, { name: 'Medido', color: 'var(--ink2)', bar: true }] })));
    const NA = (e, j, p) => ({ f3: e === 'docker' || e === 'ec2s' ? 'El plan no corre Amdahl en Docker (lo cubre F4) ni en Standard' : null, f4: e !== 'docker' ? 'F4 (cuotas) solo existe en contenedor' : null, f2: e === 'ec2s' ? 'Standard: solo F0 F1 F5 F6 F8' : null, f0: j !== 'base' ? 'Las sondas son del hardware, no del jar' : null, f7: e === 'ec2s' || j === 'thr' ? 'F7 solo en la opción recomendada' : null, f8: e === 'pc' || e === 'docker' ? 'F8 (créditos) solo aplica a EC2 t3' : null }[p] || (j === 'thr' && p !== 'f6' ? 'Corrida solo de F6 con saldo 0' : null));
    const cov = A.coverage().filter((r) => state.envs.has(r.env) && state.jars.has(r.jar)); const ph = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
    out.push(card('Cobertura de la campaña', 'Número de corridas por fase. ◐ = incluye una corrida todavía en curso o incompleta. “— n/a” = el plan no la pide en ese entorno (pase el cursor para ver por qué). “○ falta” = pendiente de medir.',
      table(['Entorno', ...ph.map((p) => p.toUpperCase())], cov.map((r) => [keyName(key(r.env, r.jar)), ...ph.map((p) => { const c = r.cells[p]; if (c.n) return h('span', { class: c.partial ? 'warn' : 'ok' }, (c.partial ? '◐ ' : '✓ ') + c.n); const na = NA(r.env, r.jar, p); return na ? h('span', { class: 'warn', title: na }, '— n/a') : h('span', { class: 'no', title: 'Falta medir' }, '○ falta'); })]), { cls: 'cov' })));
    return out;
  }

  function tabF0() {
    const ks = A.keys().filter((k) => D.sondas[k] && state.envs.has(k.split('|')[0]) && k.endsWith('base')); const out = [];
    if (!ks.length) return [empty('Sin sondas fio / iperf3 todavía')];
    const g = (label, f, ylabel) => card(label, null, barChart({ groups: [{ label: '', bars: ks.map((k) => ({ name: keyName(k), value: f(D.sondas[k]), color: colorOf(k.split('|')[0]) })) }], ylabel, height: 240, legend: ks.map((k) => ({ name: ENV[k.split('|')[0]].short, color: colorOf(k.split('|')[0]), bar: true })) }));
    out.push(h('div', { class: 'grid2 full' }, g('Lectura aleatoria 4 KiB, QD32 (IOPS)', (s) => s.randread?.iops, 'IOPS'), g('Escritura 4 KiB con fsync (IOPS) · lo que hace el journal', (s) => s.syncwrite?.iops, 'IOPS'), g('Lectura secuencial 1 MiB (MB/s)', (s) => s.seqread?.mbs, 'MB/s'), g('Red entre generador y servidor (Mbit/s, iperf3)', (s) => s.iperfMbps, 'Mbit/s')));
    out.push(card('Detalle de las sondas', 'Son los techos del hardware: contra ellos se compara lo que la aplicación usa (IOPS y MB/s del agente). El PC mide el NVMe sin red; EC2 mide el volumen EBS y la red entre dos instancias.',
      table(['Entorno', 'randread IOPS', 'randread p50 / p99 (µs)', 'syncwrite IOPS', 'syncwrite p50 / p99 (µs)', 'fsync p50 (µs)', 'seqread MB/s', 'iperf3 Mbit/s'],
        ks.map((k) => { const s = D.sondas[k]; return [keyName(k), fmt(s.randread?.iops, 0), `${fmt(s.randread?.latP50us, 0)} / ${fmt(s.randread?.latP99us, 0)}`, fmt(s.syncwrite?.iops, 0), `${fmt(s.syncwrite?.latP50us, 0)} / ${fmt(s.syncwrite?.latP99us, 0)}`, fmt(s.syncwrite?.fsyncP50us, 0), fmt(s.seqread?.mbs, 0), fmt(s.iperfMbps, 0)]; }), { num: [1, 3, 5, 6, 7] })));
    return out;
  }

  function tabF1() {
    const keys = activeKeys().filter((k) => D.models[k]?.f1?.f1); if (!keys.length) return [empty('Sin modelo F1 para los filtros')];
    const eps = ['list', 'view', 'login', 'register', 'create', 'join'];
    const groups = keys.map((k) => { const [e] = k.split('|'); const r = A.f1Row(...k.split('|'), state.endpoint); return { label: keyName(k), bars: [{ name: state.endpoint, color: colorOf(e), stack: r ? [{ name: 'app (Java)', value: r.app, color: colorOf(e) }, { name: 'mongod', value: r.mongo, color: colorOf(e), opacity: 0.45 }] : null }] }; });
    const out = [card('Costo de CPU por petición (ms)', 'D = (CPU de la ventana − CPU en reposo) / req/s, con 1 worker (sin cola), un endpoint por corrida. Tono pleno = proceso de la app; tono claro = mongod. Es el dato del que sale toda la predicción.',
      h('div', { class: 'controls' }, select(eps.map((x) => [x, x]), state.endpoint, (v) => { state.endpoint = v; render(); }, 'Endpoint')),
      barChart({ groups, ylabel: 'ms de CPU por petición', legend: [{ name: 'app (tono pleno)', color: 'var(--ink2)', bar: true }, { name: 'mongod (tono claro)', color: 'var(--ink2)', bar: true, opacity: 0.45 }] }))];
    const lp = (k, ep) => { const [e, j] = k.split('|'); const r = A.runsOf(e, j, 'f1', (n) => n === 'f1-' + ep)[0]; return r?.steps?.[0] || null; };
    const pg = keys.map((k) => { const [e] = k.split('|'); const st = lp(k, state.endpoint); return { label: keyName(k), bars: [{ name: 'p50', color: 'var(--w3)', value: st?.p50 }, { name: 'p95', color: 'var(--w1)', value: st?.p95 }, { name: 'p99', color: 'var(--w2)', value: st?.p99 }] }; });
    out.push(card('Latencia por petición: p50, p95 y p99 (' + state.endpoint + ')', 'Un worker, sin cola: es el tiempo de servicio puro del endpoint elegido arriba. La distancia entre p50 y p99 muestra la variabilidad (GC, planificador, caché) antes de que haya contención.',
      barChart({ groups: pg, ylabel: 'ms', legend: [{ name: 'p50', color: 'var(--w3)', bar: true }, { name: 'p95', color: 'var(--w1)', bar: true }, { name: 'p99', color: 'var(--w2)', bar: true }] })));
    const prow = []; for (const k of keys) for (const ep of eps) { const st = lp(k, ep); if (st) prow.push([keyName(k), ep, fms(st.p50), fms(st.p95), fms(st.p99), fms(st.max), fmt(st.rps)]); }
    out.push(card('Percentiles de todos los endpoints (1 worker)', null, table(['Entorno', 'Endpoint', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'máx (ms)', 'req/s'], prow, { num: [2, 3, 4, 5, 6] })));
    const rows = []; for (const k of keys) for (const r of D.models[k].f1.f1) rows.push([keyName(k), r.endpointFull, fmt(r.rps1), fmt(r.app, 2), fmt(r.mongo, 2), fmt(r.total, 2), fmt(r.mongoPct, 0) + ' %', fmt(r.io, 3), fmt(r.kb), fmt(r.p50), r.samples < 30 ? h('span', { class: 'warn' }, `⚠ ${r.samples}`) : r.samples]);
    out.push(card('Todos los endpoints', '⚠ = menos de 30 muestras del agente: la cifra es poco fiable (endpoints rápidos: view, create, join).',
      table(['Entorno', 'Endpoint', 'req/s (1 worker)', 'ms app', 'ms mongod', 'ms total', '% en mongod', 'E/S disco por pet.', 'KB resp.', 'p50 (ms)', 'Muestras'], rows, { num: [2, 3, 4, 5, 6, 7, 8, 9, 10] })));
    const xr = []; for (const k of keys) for (const r of D.models[k].f1.xmax || []) if (r.xmax != null) xr.push([keyName(k), r.mix, fmt(r.app, 1), fmt(r.mongo, 1), fmt(r.xmax), r.first]);
    out.push(card('Techo predicho por mezcla', 'X_max = capacidad / Σ pᵢ·Dᵢ. Es una cota superior: supone que D no cambia con la carga. F5 mide cuánto queda por debajo.', table(['Entorno', 'Mezcla', 'ms app', 'ms mongod', 'X_max (req/s)', 'Se agota primero'], xr, { num: [2, 3, 4] })));
    return out;
  }

  function tabF2() {
    const keys = activeKeys().filter((k) => D.models[k]?.f2?.f2); if (!keys.length) return [empty('Sin barrido de datos (F2) para los filtros')];
    const mk = (f, ylabel, title) => card(title, null, lineChart({ series: keys.map((k) => { const [e, j] = k.split('|'); return { name: keyName(k), short: ENV[e].short + (j === 'fix' ? ' (fix)' : j === 'thr' ? ' (saldo 0)' : ''), color: colorOf(e), dash: dashOf(j), pts: D.models[k].f2.f2.map((r) => [r.lobbies, f(r)]) }; }), xlog: true, ylog: true, xticks: [100, 200, 400, 800, 1600], xlabel: 'lobbies en la base (escala log)', ylabel, fmtx: (v) => fmt(v, 0), fmty: (v) => fmt(v, v < 1 ? 2 : 0), xunit: ' lobbies', endLabels: true }));
    const out = [h('div', { class: 'grid2 full' }, mk((r) => r.total, 'ms de CPU por petición (log)', 'CPU por petición del listado contra lobbies'), mk((r) => r.p50, 'p50 sin cola (ms, log)', 'Latencia p50 del listado contra lobbies'))];
    out.push(card('Exponente del crecimiento', 'Pendiente log-log del costo contra el número de lobbies: 1 = lineal; 2 = cuadrático (el código predice ≈ 2 por el conteo sin índice dentro del N+1). Menor que 1 significa que domina un costo fijo por petición.',
      table(['Entorno', 'Exponente medido', ...[100, 200, 400, 800, 1600].map((n) => `ms @ ${n}`)], keys.map((k) => [keyName(k), h('b', null, fmt(D.models[k].f2.exponent, 2)), ...[100, 200, 400, 800, 1600].map((n) => fmt(D.models[k].f2.f2.find((r) => r.lobbies === n)?.total, 1))]), { num: [1, 2, 3, 4, 5, 6] })));
    return out;
  }

  function tabF3() {
    const keys = activeKeys().filter((k) => D.models[k]?.amdahl?.length); if (!keys.length) return [empty('Sin datos de Amdahl (F3). Solo se corre en PC y EC2 Unlimited.')];
    const prof = state.amdahl; const series = []; const rows = [];
    for (const k of keys) { const [e, j] = k.split('|'); const a = D.models[k].amdahl.find((x) => x.profile === prof); if (!a) continue; series.push({ name: keyName(k), short: ENV[e].short, color: colorOf(e), dash: dashOf(j), pts: a.rows.map((r) => [r.workers, r.S]) });
      rows.push([keyName(k), fmt(a.p, 3), fmt(a.ceiling, 1) + '×', a.smt != null ? a.smt + ' %' : '–', a.rows.map((r) => `${r.workers}w: ${fmt(r.rps)} req/s`).join(' · ')]); }
    const maxN = Math.max(...series.flatMap((s) => s.pts.map((p) => p[0])), 2); series.push({ name: 'Ideal (S = N)', color: 'var(--axis)', dash: '3 3', pts: [[1, 1], [maxN, maxN]] });
    return [card('Aceleración S(N) = X(N) / X(1)', 'Bucle cerrado con 1…2×hilos workers. p = fracción paralela (S = 1/((1−p)+p/N)); techo de Amdahl = 1/(1−p). La ganancia de SMT es el salto de 1 a 2 workers.',
      h('div', { class: 'controls' }, select([['solo-list', 'listar (mongod)'], ['login', 'login (BCrypt, CPU de Java)']], prof, (v) => { state.amdahl = v; render(); }, 'Perfil')),
      lineChart({ series, xlabel: 'workers (N)', ylabel: 'S(N)', fmtx: (v) => fmt(v, 0), xticks: [1, 2, 4, 8, 16].filter((v) => v <= maxN), xlog: true, ymin: 0, endLabels: true }),
      table(['Entorno', 'p (mediana)', 'Techo 1/(1−p)', 'Ganancia SMT', 'Throughput por workers'], rows))];
  }

  function tabF4() {
    const rs = D.runs.filter((r) => r.phase === 'f4' && r.env === 'docker' && state.envs.has('docker') && state.jars.has(r.jar)); if (!rs.length) return [empty('Sin corridas F4 todavía. F4 solo se corre en el contenedor.')];
    const quotas = [...new Set(rs.map((r) => r.quota))]; const WK = ['1', '4', '16']; const jars = [...new Set(rs.map((r) => r.jar))]; const out = [];
    for (const jar of jars) {
      const groups = quotas.map((q) => { const r = rs.find((x) => x.quota === q && x.jar === jar); return { label: q.replace('a', 'app ').replace('m', ' · mongo '), bars: WK.map((w, i) => ({ name: w + ' workers', value: r?.steps.find((s) => String(s.workers) === w)?.rps ?? null, color: `var(--w${i + 1})` })) }; });
      out.push(card(`Rendimiento según el reparto de CPU (${jar === 'fix' ? 'jar con arreglo' : 'jar base'})`, 'Cuota CFS por contenedor. Si subir los CPU de la app no mueve el techo y subir los de mongod sí, el cuello es mongod (Amdahl).',
        barChart({ groups, ylabel: 'req/s logrados', legend: WK.map((w, i) => ({ name: w + ' workers', color: `var(--w${i + 1})`, bar: true })) }),
        table(['Cuota', 'Workers', 'req/s', 'p95 (ms)', 'CPU app %', 'CPU mongod %', 'Frenado app ms/s', 'Frenado mongod ms/s'], rs.filter((r) => r.jar === jar).flatMap((r) => r.steps.map((s) => [r.quota, s.workers, fmt(s.rps), fms(s.p95), fmt(s.res?.app, 0), fmt(s.res?.mongo, 0), fmt(s.res?.thrApp, 0), fmt(s.res?.thrMongo, 0)])), { num: [1, 2, 3, 4, 5, 6, 7] })));
    }
    return out;
  }

  function tabF5() {
    const keys = activeKeys().filter((k) => A.rampSteps(...k.split('|'), state.mix)); const mixSel = h('div', { class: 'controls' }, select(Object.entries(mixLabel), state.mix, (v) => { state.mix = v; render(); }, 'Mezcla'));
    if (!keys.length) return [card('Rampa a tasa fija', null, mixSel, empty('Sin rampa para esta mezcla y filtros'))];
    const series = (f) => keys.map((k) => { const [e, j] = k.split('|'); return { name: keyName(k), short: ENV[e].short + (j === 'fix' ? ' (fix)' : ''), color: colorOf(e), dash: dashOf(j), pts: A.rampSteps(e, j, state.mix).map((s) => [s.rate, f(s)]) }; });
    const vl = keys.map((k) => { const x = A.xmaxOf(...k.split('|'), state.mix); return x ? { x, color: colorOf(k.split('|')[0]) } : null; }).filter(Boolean);
    const out = [card('Rampa a tasa fija: latencia p95', 'λ = 10 %…150 % del X_max predicho por F1 de cada máquina (por eso los niveles difieren entre entornos). Línea punteada vertical = X_max predicho. p95 medido desde la hora programada, con timeouts contados. Escala log: el requisito es 1.000 ms.',
      mixSel, lineChart({ series: series((s) => s.p95), xlabel: 'req/s ofrecidos', ylabel: 'p95 (ms, log)', ylog: true, ymin: 1, hlines: [{ y: 1000, label: 'requisito 1.000 ms' }], vlines: vl, fmtx: (v) => fmt(v, 1), fmty: (v) => fmt(v, 0), xunit: ' req/s', fmtTip: (v) => fms(v) + ' ms' })),
      card('Logrado contra ofrecido', 'Por debajo de la diagonal = la máquina ya no sostiene lo que se le pide (se acumula cola o hay timeouts).', lineChart({ series: [...series((s) => s.rps), { name: 'Ideal (logrado = ofrecido)', color: 'var(--axis)', dash: '3 3', pts: [[0.5, 0.5], [Math.max(...keys.flatMap((k) => A.rampSteps(...k.split('|'), state.mix).map((s) => s.rate))), Math.max(...keys.flatMap((k) => A.rampSteps(...k.split('|'), state.mix).map((s) => s.rate)))]] }], xlabel: 'req/s ofrecidos', ylabel: 'req/s logrados', ymin: 0, fmtx: (v) => fmt(v, 1), xunit: ' req/s' }))];
    const rampPct = (f, name, note) => card('Rampa a tasa fija: latencia ' + name, note, lineChart({ series: series(f), xlabel: 'req/s ofrecidos', ylabel: name + ' (ms, log)', ylog: true, ymin: 1, hlines: name === 'p99' ? [{ y: 1000, label: '1.000 ms (referencia)' }] : [], vlines: vl, fmtx: (v) => fmt(v, 1), fmty: (v) => fmt(v, 0), xunit: ' req/s', fmtTip: (v) => fms(v) + ' ms' }));
    out.push(h('div', { class: 'grid2 full' }, rampPct((s) => s.p50, 'p50', 'La mediana: lo que ve el usuario típico. Se mantiene baja hasta casi el codo; cuando sube, ya hay cola para todos.'), rampPct((s) => s.p99, 'p99', 'La cola de la distribución: 1 de cada 100 peticiones. Se dispara antes que p95 y avisa de la saturación (GC, frenado CFS, cola).'),
      rampPct((s) => s.max, 'máximo', 'La petición más lenta de cada nivel. Con los timeouts contados topa en el timeout (10 s).')));
    out.push(card('Codo medido contra predicho', null, table(['Entorno', 'X_max predicho', 'Codo medido (mayor req/s que pasa)', 'Primer nivel que falla', 'Medido / predicho', 'Niveles'], keys.map((k) => { const [e, j] = k.split('|'); const kn = A.kneeOf(e, j, state.mix), x = A.xmaxOf(e, j, state.mix); const st = A.rampSteps(e, j, state.mix);
      return [keyName(k), fmt(x), kn ? (kn.allPass ? `> ${fmt(kn.knee)} (no llegó a romper)` : fmt(kn.knee)) : '–', kn?.firstFail != null ? fmt(kn.firstFail) : '–', kn && x && !kn.allPass ? fmt((kn.knee / x) * 100, 0) + ' %' : '–', st.map((s) => (s.pass ? '✓' : '✗')).join('')]; }), { num: [1, 2, 3, 4] })));
    return out;
  }

  function tabF6() {
    const keys = activeKeys().filter((k) => A.f6Levels(...k.split('|')).length); if (!keys.length) return [empty('Sin corridas F6 para los filtros')];
    const allRates = [...new Set(keys.flatMap((k) => A.f6Levels(...k.split('|')).map((l) => l.rate)))].sort((a, b) => a - b);
    const out = [card('Carga sostenida: p95 por nivel', 'Misma escala absoluta de req/s en todas las máquinas, 600 s por nivel, mezcla-lectura, mediana de las repeticiones. Corta en el primer nivel que no pasa; una ✕ roja es un nivel que se saturó (p95 en el techo del timeout, no un valor real). Escala log; la línea es el requisito.',
      lineChart({ series: keys.map((k) => { const [e, j] = k.split('|'); return { name: keyName(k), short: ENV[e].short + (j === 'fix' ? ' (fix)' : ''), color: colorOf(e), dash: dashOf(j), pts: A.f6Levels(e, j).map((l) => [l.rate, l.p95]) }; }),
        xlog: true, xticks: allRates, ylog: true, ymin: 1, ymax: 4000, failAbove: 2000, hlines: [{ y: 1000, label: 'requisito 1.000 ms' }], xlabel: 'req/s ofrecidos (escala log)', ylabel: 'p95 (ms, log)', fmtx: (v) => fmt(v, 0), fmty: (v) => fmt(v, 0), xunit: ' req/s', fmtTip: (v) => (v >= 2000 ? 'NO PASA (>' + fmt(v / 1000, 0) + ' s, timeout)' : fms(v) + ' ms') }))];
    const medPct = (key) => (k) => A.f6Levels(...k.split('|')).map((l) => [l.rate, L.median(l.reps.map((x) => x[key]))]);
    const f6Pct = (key, name, note) => card('Carga sostenida: latencia ' + name + ' por nivel', note, lineChart({ series: keys.map((k) => { const [e, j] = k.split('|'); return { name: keyName(k), short: ENV[e].short + (j === 'fix' ? ' (fix)' : ''), color: colorOf(e), dash: dashOf(j), pts: medPct(key)(k) }; }),
      xlog: true, xticks: allRates, ylog: true, ymin: 1, ymax: 12000, failAbove: 2000, hlines: [{ y: 1000, label: '1.000 ms (referencia)' }], xlabel: 'req/s ofrecidos (escala log)', ylabel: name + ' (ms, log)', fmtx: (v) => fmt(v, 0), fmty: (v) => fmt(v, 0), xunit: ' req/s', fmtTip: (v) => (v >= 2000 ? 'saturado (>' + fmt(v / 1000, 0) + ' s)' : fms(v) + ' ms') }));
    out.push(h('div', { class: 'grid2 full' }, f6Pct('p50', 'p50', 'Mediana entre repeticiones, 600 s por nivel: la experiencia típica con carga sostenida.'), f6Pct('p99', 'p99', 'p99 mediano entre repeticiones: la cola. Es el primero en degradarse y el que más separa a un entorno de otro.'), f6Pct('max', 'máximo', 'La petición más lenta de cada nivel (mediana de repeticiones). Diferencia con p99 = valores atípicos aislados.')));
    out.push(card('Percentiles por nivel (tabla)', 'p50 / p95 / p99 / máximo en ms, mediana entre repeticiones. Úsala para citar valores exactos.',
      table(['Entorno', ...allRates.map((r) => fmt(r, 0) + ' req/s')], keys.map((k) => [keyName(k), ...allRates.map((r) => { const l = A.f6Levels(...k.split('|')).find((x) => x.rate === r); if (!l) return '·'; const m = (q) => fms(L.median(l.reps.map((x) => x[q]))); return `${m('p50')} / ${m('p95')} / ${m('p99')} / ${m('max')}`; })]))));
    out.push(card('Pasa / no pasa por nivel', 'p95 mediano (mín–máx entre repeticiones). “%” = tasa de errores. ± = el p95 difiere más de 20 % entre repeticiones: hay que decirlo en el informe.',
      table(['Entorno', ...allRates.map((r) => fmt(r, 0) + ' req/s')], keys.map((k) => [keyName(k), ...allRates.map((r) => { const l = A.f6Levels(...k.split('|')).find((x) => x.rate === r); if (!l) return h('span', { class: 'warn' }, '·');
        return h('span', null, pass(l.allPass, fms(l.p95) + ' ms'), l.nReps > 1 ? h('span', { class: 'warn' }, ` (${fms(l.p95min)}–${fms(l.p95max)})`) : null, l.errorRate > 0.01 ? h('span', { class: 'no' }, ` ${fmt(l.errorRate * 100, 0)} %`) : null, l.spread != null && l.spread > 0.2 ? h('span', { class: 'warn' }, ' ±') : null); })]))));
    const lv = state.level && allRates.includes(+state.level) ? +state.level : allRates[Math.min(2, allRates.length - 1)];
    out.push(card('Recursos al nivel elegido', 'Promedio en la ventana medida (primera repetición). CPU % de la máquina; app y mongod en % de un núcleo.',
      h('div', { class: 'controls' }, select(allRates.map((r) => [r, r + ' req/s']), lv, (v) => { state.level = v; render(); }, 'Nivel')),
      table(['Entorno', 'CPU máquina %', 'steal %', 'app % núcleo', 'mongod % núcleo', 'RSS app (MB)', 'RSS mongod (MB)', 'IOPS', 'disco MB/s', 'red rx / tx MB/s', 'fallos de caché %'], keys.map((k) => { const l = A.f6Levels(...k.split('|')).find((x) => x.rate === lv); const r = l?.res; return [keyName(k), fmt(r?.busy), fmt(r?.steal), fmt(r?.app, 0), fmt(r?.mongo, 0), fmt(r?.appRss, 0), fmt(r?.mongoRss, 0), fmt(r?.iops, 0), fmt(r?.diskMbs, 2), r ? `${fmt(r.rx, 2)} / ${fmt(r.tx, 2)}` : '–', fmt(r?.missPct, 2)]; }), { num: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })));
    const own = keys.map((k) => ({ k, st: A.f6Own(...k.split('|')) })).filter((x) => x.st.length);
    if (own.length) out.push(card('Corridas “propio”: 50 % y 80 % del codo de cada máquina', 'Cada máquina a una fracción de su propio codo medido en F5: qué le sobra cuando está holgada y cuando está casi llena.', table(['Entorno', 'req/s', 'p95 (ms)', 'p99 (ms)', 'errores %', 'Resultado'], own.flatMap((x) => x.st.map((s) => [keyName(x.k), fmt(s.rate), fms(s.p95), fms(s.p99), fmt(s.errorRate * 100, 1), pass(s.pass, s.pass ? 'pasa' : 'no pasa')])), { num: [1, 2, 3, 4] })));
    return out;
  }

  // ---- explorador de corridas (series de tiempo + pasos)
  function explorer(filter, label, scope) {
    const runs = D.runs.filter((r) => filter(r) && state.envs.has(r.env) && state.jars.has(r.jar)); if (!runs.length) return [empty(label || 'Sin corridas')];
    const sel = runs.find((r) => r.id === state.runs[scope]) || runs[0]; const out = [];
    out.push(card('Elegir corrida', null, h('div', { class: 'controls' }, select(runs.map((r) => [r.id, `${keyName(key(r.env, r.jar))} · ${r.run}${r.ended ? '' : ' (en curso)'}`]), sel.id, (v) => { state.runs[scope] = v; render(); }, 'Corrida'), h('a', { class: 'chip', href: 'visor.html#run=' + encodeURIComponent(sel.id) }, 'Abrir en el visor: todas las métricas →')),
      h('p', { class: 'note' }, `Perfil ${sel.profile || '–'} · modo ${sel.mode === 'rate' ? 'tasa fija' : 'bucle cerrado'} · inicio ${sel.startedAtMs ? new Date(sel.startedAtMs).toLocaleString('es') : '–'}` + (sel.idle ? ` · reposo previo: CPU máquina ${fmt(sel.idle.cpuBusyPct)} %` : '') + (sel.pinned ? ` · afinidad: ${JSON.stringify(sel.pinned)}` : '') + (sel.seed ? ` · siembra: ${sel.seed.lobbies} lobbies, ${sel.seed.users} usuarios` : ''))));
    const sr = sel.series;
    if (sr) {
      const pts = (a) => sr.t.map((t, i) => [t / 60, a[i]]); const x = { xlabel: 'minutos desde el inicio', fmtx: (v) => fmt(v, 1), xunit: ' min', markers: false };
      out.push(h('div', { class: 'grid2 full' },
        card('Latencia p95 en el tiempo', 'Promedio ponderado por cubos de 10 s. Escala log.', lineChart({ ...x, series: [{ name: 'p95', color: colorOf(sel.env), pts: pts(sr.p95) }], ylog: true, ymin: 1, hlines: [{ y: 1000, label: '1.000 ms' }], ylabel: 'ms', fmty: (v) => fmt(v, 0), fmtTip: (v) => fms(v) + ' ms', forceLegend: false })),
        card('Ofrecido contra logrado', null, lineChart({ ...x, series: [{ name: 'ofrecido (req/s)', color: 'var(--axis)', dash: '4 3', pts: pts(sr.rate) }, { name: 'logrado (req/s)', color: colorOf(sel.env), pts: pts(sr.rps) }], ymin: 0, ylabel: 'req/s' })),
        card('CPU', 'CPU de la máquina (%), steal (%), y app y mongod en % de un núcleo.', lineChart({ ...x, series: [{ name: 'máquina %', color: 'var(--w1)', pts: pts(sr.busy) }, { name: 'steal %', color: 'var(--bad)', pts: pts(sr.steal) }, { name: 'app (% de 1 núcleo)', color: 'var(--w2)', pts: pts(sr.app) }, { name: 'mongod (% de 1 núcleo)', color: 'var(--w3)', pts: pts(sr.mongo) }], ymin: 0, ylabel: '%' })),
        card('Memoria residente', null, lineChart({ ...x, series: [{ name: 'app (MB)', color: 'var(--w2)', pts: pts(sr.appRss) }, { name: 'mongod (MB)', color: 'var(--w3)', pts: pts(sr.mongoRss) }], ymin: 0, ylabel: 'MB' }))));
    } else out.push(card(null, 'Esta fase es de bucle cerrado: no guarda serie por segundo en el panel, solo los pasos (tabla de abajo).'));
    out.push(card('Pasos de la corrida', 'CPU y recursos promediados en la ventana medida de cada paso.', table(['Paso', 'req/s ofrecidos', 'req/s logrados', 'p50', 'p95', 'p99', 'errores %', 'CPU máq %', 'steal %', 'app %', 'mongod %', 'RSS app/mongod MB', 'IOPS', 'disco MB/s', 'red rx/tx MB/s', 'Frenado ms/s (app / mongod)', 'Ok'],
      sel.steps.map((s) => [s.rate != null ? fmt(s.rate) + ' req/s' : s.workers + ' workers', fmt(s.offered), fmt(s.rps), fms(s.p50), fms(s.p95), fms(s.p99), fmt((s.errorRate || 0) * 100, 1), fmt(s.res?.busy), fmt(s.res?.steal), fmt(s.res?.app, 0), fmt(s.res?.mongo, 0), s.res ? `${fmt(s.res.appRss, 0)} / ${fmt(s.res.mongoRss, 0)}` : '–', fmt(s.res?.iops, 0), fmt(s.res?.diskMbs, 2), s.res ? `${fmt(s.res.rx, 2)} / ${fmt(s.res.tx, 2)}` : '–', s.res && s.res.thrApp != null ? `${fmt(s.res.thrApp, 0)} / ${fmt(s.res.thrMongo, 0)}` : fmt(s.res?.throttledMsPerS, 0), s.pass == null ? '–' : pass(s.pass, '') ]), { num: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15] })));
    return out;
  }

  function tabF78() {
    const out = []; const preds = D.predictions.filter((p) => /x10|f8/.test(p.file));
    out.push(...explorer((r) => r.phase === 'f7' || r.phase === 'f8', 'Aún no hay corridas F7 / F8.', 'f78'));
    if (preds.length) out.push(card('Predicciones escritas antes de medir', 'La marca de tiempo del archivo prueba que se escribieron antes de la corrida.', preds.map((p) => h('details', null, h('summary', null, p.file), h('pre', null, p.text)))));
    return out;
  }
  const tabRecursos = () => explorer(() => true, 'Sin corridas', 'rec');

  function tabCreditos() {
    const cw = D.cloudwatch; if (!cw || (!cw.ec2u && !cw.ec2s)) return [empty('Sin datos de CloudWatch')];
    const mk = (metric, ylabel, title, note) => {
      const series = ['ec2u', 'ec2s'].filter((e) => cw[e] && cw[e][metric] && state.envs.has(e)).map((e) => ({ name: ENV[e].name, short: ENV[e].short, color: colorOf(e), pts: cw[e][metric].map((p) => [p.t, p.avg]) }));
      const bands = D.runs.filter((r) => (r.env === 'ec2u' || r.env === 'ec2s') && state.envs.has(r.env) && r.startedAtMs && r.endAt && ['f5', 'f6', 'f7', 'f8'].includes(r.phase)).map((r) => ({ x0: r.startedAtMs, x1: r.endAt, label: r.phase.toUpperCase(), color: colorOf(r.env), opacity: 0.1 }));
      return card(title, note, lineChart({ series, bands, markers: false, ymin: 0, ylabel, fmtx: hhmm, xlabel: 'hora local', width: 1100, endLabels: true, fmtTip: (v) => fmt(v, 1) }));
    };
    return [mk('CPUCreditBalance', 'créditos', 'Saldo de créditos de CPU', '1 crédito = 1 vCPU al 100 % durante 1 minuto. Bandas = corridas F5–F8. En Standard, el saldo en 0 significa que la CPU baja a la línea base (20 % por vCPU). En Unlimited el saldo se queda en 0 y se paga el excedente.'),
      mk('CPUSurplusCreditBalance', 'créditos excedentes', 'Créditos excedentes acumulados (Unlimited)', 'Lo que se debe por usar más CPU de la que da la línea base cuando no quedan créditos. Se cobra en la factura; CPUSurplusCreditsCharged llega con retraso, por eso conviene volver a leerlo antes de terminar las instancias.'),
      mk('CPUUtilization', '% de CPU', 'Utilización de CPU (CloudWatch, promedio 5 min)', 'Visto desde el hipervisor, sin el generador de carga (que corre en otra instancia).')];
  }

  function tabN1() {
    const pairs = ENVS.filter((e) => state.envs.has(e.id) && A.f1Row(e.id, 'base', 'list') && A.f1Row(e.id, 'fix', 'list'));
    if (!pairs.length) return [empty('Hace falta base y arreglo medidos en el mismo entorno (hoy: EC2 Unlimited y Standard)')];
    const groups = pairs.map((e) => ({ label: e.short, bars: [{ name: 'base', value: A.f1Row(e.id, 'base', 'list').total, color: colorOf(e.id) }, { name: 'con arreglo', value: A.f1Row(e.id, 'fix', 'list').total, color: colorOf(e.id), outline: true }] }));
    const rows = pairs.map((e) => { const b = A.f1Row(e.id, 'base', 'list'), f = A.f1Row(e.id, 'fix', 'list'); const kb = A.kneeOf(e.id, 'base', 'mezcla-lectura'), kf = A.kneeOf(e.id, 'fix', 'mezcla-lectura'); const mb = A.maxPassingLevel(e.id, 'base'), mf = A.maxPassingLevel(e.id, 'fix');
      const eb = D.models[key(e.id, 'base')]?.f2?.exponent, ef = D.models[key(e.id, 'fix')]?.f2?.exponent;
      return [e.name, `${fmt(b.total)} → ${fmt(f.total)}`, h('b', null, fmt(b.total / f.total, 0) + '×'), `${fmt(b.mongoPct, 0)} % → ${fmt(f.mongoPct, 0)} %`, `${fmt(eb, 2)} → ${fmt(ef, 2)}`, `${fmt(A.xmaxOf(e.id, 'base', 'mezcla-lectura'))} → ${fmt(A.xmaxOf(e.id, 'fix', 'mezcla-lectura'))}`,
        `${kb ? (kb.allPass ? '>' : '') + fmt(kb.knee) : '–'} → ${kf ? (kf.allPass ? '>' : '') + fmt(kf.knee) : '–'}`, `${mb ? fmt(mb.rate, 0) : '–'} → ${mf ? fmt(mf.rate, 0) : '–'} (${mf ? 'p95 ' + fms(mf.p95) + ' ms' : ''})`]; });
    return [card('El arreglo del N+1: CPU por petición del listado (200 lobbies)', 'LobbyServiceImpl.listLobbies hacía por cada lobby un findById del videojuego y un countByLobbyId sin índice. El arreglo hace una consulta de videojuegos y una agregación de cupos. Relleno = base; borde = con arreglo.',
      barChart({ groups, ylabel: 'ms de CPU por petición', legend: [{ name: 'base', color: 'var(--ink2)', bar: true }, { name: 'con arreglo', color: 'var(--ink2)', bar: true, outline: true }] })),
      card('Antes → después', 'F6 con el arreglo pasa en todos los niveles de la escala común (5–80 req/s), así que no encuentra el codo: el codo con arreglo sale de F5.',
        table(['Entorno', 'ms CPU / petición', 'Reducción', '% en mongod', 'Exponente F2', 'X_max predicho', 'Codo F5 (req/s)', 'Mayor nivel F6 que pasa'], rows))];
  }

  function priceFor(env) { const c = state.cost; if (env === 'ec2u' || env === 'ec2s') return c[env] ?? 0.0208; return c[env] ?? null; }
  function tabCostos() {
    const keys = activeKeys(); const c = state.cost; const inp = (id, ph, step) => h('input', { type: 'number', step: step || 'any', min: '0', placeholder: ph, value: c[id] ?? '', onchange: (e) => { const v = e.target.value; c[id] = v === '' ? null : Number(v); saveCost(); render(); } });
    const pcH = (c.pcBuy != null && c.pcMonths ? c.pcBuy / (c.pcMonths * 730) : 0) + (c.pcWatts != null && c.pcKwh != null ? (c.pcWatts / 1000) * c.pcKwh : 0);
    const out = [card('Precios (entradas tuyas, no medidas)', 'Los precios de AWS vienen de la ficha de la consola; verifícalos en la página oficial con fecha. Para el PC se calcula depreciación + energía. Docker usa una fracción del PC. Se guardan en este navegador.',
      table(['Entorno', 'USD por hora de uso', 'Cómo se obtiene'], [
        ['EC2 Unlimited / Standard (t3.small)', inp('ec2u', '0.0208'), 'On-demand us-east-1 según la consola: 0,0208 USD/h (no incluye EBS ni créditos excedentes)'],
        ['EC2 Standard', inp('ec2s', '0.0208'), 'Igual al anterior; en Standard no hay excedentes'],
        ['PC: precio de compra (USD)', inp('pcBuy', 'p. ej. 1000'), 'Para la depreciación'], ['PC: vida útil (meses)', inp('pcMonths', 'p. ej. 36'), ''], ['PC: consumo medio (W)', inp('pcWatts', 'p. ej. 60'), 'Medido con vatímetro o TDP declarado, dicho como tal'], ['Energía (USD/kWh)', inp('pcKwh', 'p. ej. 0.15'), ''],
        ['PC → USD/h calculado', h('b', null, pcH ? fmt(pcH, 4) : '–'), '(compra / (meses × 730)) + (W/1000 × USD/kWh)'], ['Docker: fracción del PC', inp('dockFrac', '0.1667'), 'Cuota de CPU / hilos de la máquina (p. ej. 2 de 12)'],
      ]))];
    const rows = keys.map((k) => { const [e, j] = k.split('|'); const price = e === 'pc' ? (pcH || null) : e === 'docker' ? (pcH && c.dockFrac ? pcH * c.dockFrac : null) : priceFor(e); const kn = A.kneeOf(e, j, 'mezcla-lectura'); const mp = A.maxPassingLevel(e, j); const mg = A.marginLevel(e, j, kn && kn.knee);
      const per = (lvl) => (price && lvl ? price / (lvl.rps * 3.6) : null);
      return [keyName(k), price != null ? fmt(price, 4) : 'falta precio', mp ? `${fmt(mp.rps)} req/s` : '–', per(mp) != null ? fmt(per(mp), 5) : '–', mg ? `${fmt(mg.rps)} req/s` : '–', per(mg) != null ? fmt(per(mg), 5) : '–']; });
    out.push(card('Costo por 1.000 peticiones', 'costo por 1.000 peticiones = USD por hora / (req/s sostenidos × 3,6). Se calcula sobre lo que pasa el requisito (mayor nivel de F6) y sobre el nivel con margen (≤ 60 % del codo); la regla de recomendación del plan usa el segundo. Los créditos excedentes de Unlimited suman a la factura y no están incluidos.',
      table(['Entorno', 'USD / hora', 'Sostenido que pasa', 'USD por 1.000 pet.', 'Sostenido con margen', 'USD por 1.000 pet. (margen)'], rows, { num: [1, 2, 3, 4, 5] })));
    return out;
  }

  function tabEntornos() {
    const rows = ENVS.filter((e) => state.envs.has(e.id)).map((e) => {
      const m = D.machines[e.id], mg = D.machines[e.id + '_mongo'], r = D.runs.find((x) => x.env === e.id && x.profile && x.machine);
      const sd = D.sondas[e.id + '|base'], cfg = e.id === 'docker' ? 'app 1 CPU / 1 GB, mongod 1 CPU / 1 GB (cuota CFS)' : e.id === 'pc' ? 'app y mongod en 8 de 12 hilos; generador en el resto' : '2 vCPU; generador en otra instancia (c7i-flex.large)';
      return [e.name, m?.cpuModel?.trim() ?? '–', m ? m.logicalCpus : '–', m ? fmt(m.memTotalMB / 1024, 1) + ' GB' : '–', m?.os ?? (e.id === 'docker' ? 'VM WSL2 sobre Windows 11' : '–'), m?.dmi ?? '–', m?.cache ?? '–', mg ? `MongoDB ${mg.version} · caché ${mg.cacheMaxMB} MB` : '–', cfg,
        sd ? `${fmt(sd.randread?.iops, 0)} IOPS · ${fmt(sd.syncwrite?.iops, 0)} IOPS fsync · ${fmt(sd.seqread?.mbs, 0)} MB/s` : '–', sd?.iperfMbps ? fmt(sd.iperfMbps, 0) + ' Mbit/s' : '–'];
    });
    return [card('Ficha técnica de cada entorno', 'Todo sale de lo que el agente leyó en cada máquina durante las corridas (línea “machine”, “mongoinfo”) y de las sondas F0. Los precios están en la sección Costos.',
      table(['Entorno', 'CPU', 'Hilos lógicos', 'RAM', 'Sistema', 'Instancia', 'Caché L3', 'MongoDB', 'Límites / afinidad', 'Disco F0 (rand. lect. · fsync · sec.)', 'Red F0'], rows)),
      card(null, 'Cada corrida tiene además su ficha completa (run.json, cuotas cgroup, versión de Docker) en el visor.', h('a', { class: 'chip', href: 'visor.html' }, 'Abrir el visor de corridas →'))];
  }

  function tabDatos() {
    const runs = D.runs.filter((r) => state.envs.has(r.env) && state.jars.has(r.jar));
    const csv = () => { const hd = ['entorno', 'jar', 'corrida', 'fase', 'paso', 'req_s_ofrecidos', 'workers', 'req_s_logrados', 'p50_ms', 'p95_ms', 'p99_ms', 'errores', 'tasa_error', 'pasa', 'cpu_maquina', 'steal', 'cpu_app', 'cpu_mongod', 'rss_app_mb', 'rss_mongod_mb', 'iops', 'disco_mbs', 'rx_mbs', 'tx_mbs'];
      const lines = [hd.join(',')]; for (const r of runs) for (const s of r.steps) lines.push([r.env, r.jar, r.run, r.phase, s.step, s.offered ?? s.rate ?? '', s.workers ?? '', s.rps, s.p50, s.p95, s.p99, s.errors, s.errorRate, s.pass ?? '', s.res?.busy ?? '', s.res?.steal ?? '', s.res?.app ?? '', s.res?.mongo ?? '', s.res?.appRss ?? '', s.res?.mongoRss ?? '', s.res?.iops ?? '', s.res?.diskMbs ?? '', s.res?.rx ?? '', s.res?.tx ?? ''].join(','));
      const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: 'lobbylink_v3_pasos.csv' }); a.click(); };
    return [card('Todas las corridas', 'Los datos crudos (load.ndjson, agent.ndjson, run.json, app.log) están en resultados/. Este panel solo los resume; ninguna cifra se escribe a mano.',
      h('div', { class: 'controls' }, h('button', { class: 'chip', type: 'button', onclick: csv }, 'Descargar CSV de pasos')),
      table(['Entorno', 'Jar', 'Corrida', 'Fase', 'Pasos', 'Modo', 'Inicio', 'Estado', 'Reposo previo %', 'Visor'], runs.map((r) => [ENV[r.env].short, r.jar, r.run, r.phase.toUpperCase(), r.steps.length, r.mode === 'rate' ? 'tasa fija' : 'cerrado', r.startedAtMs ? new Date(r.startedAtMs).toLocaleString('es') : '–', r.ended ? 'completa' : h('span', { class: 'warn' }, 'en curso / incompleta'), fmt(r.idle?.cpuBusyPct), h('a', { href: 'visor.html#run=' + encodeURIComponent(r.id) }, 'abrir →')]), { num: [4, 8] }))];
  }


  // ---------------------------------------------------------------- las 4 preguntas y explicación por sección
  const QS = { 1: '¿Por qué ese número y no otro? ¿Cómo lo midieron?', 2: '¿Qué componente causa ese comportamiento?', 3: 'Si la carga se multiplicara por diez, ¿qué se rompería primero?', 4: '¿Qué opción descartaron y por qué?' };
  const EXPL = {
    resumen: { que: 'Vista de conjunto: una fila por entorno y versión del jar con el techo predicho, el codo medido y lo que sostiene la carga prolongada.', como: 'No mide nada nuevo: resume F1, F5 y F6. “Codo” = mayor req/s de la rampa que cumple p95 ≤ 1.000 ms y errores ≤ 1 %. “Con margen” = mayor nivel que pasa y no pasa del 60 % del codo.', q: [1, 4] },
    f0: { que: 'Los techos del hardware, medidos sin la aplicación: lectura aleatoria 4 KiB (QD32), escritura 4 KiB con fsync (lo que hace el journal de MongoDB al confirmar) y lectura secuencial 1 MiB; en EC2 también la red entre generador y servidor (iperf3).', como: '60 s por prueba con un archivo de 1 GiB (fio) y 30 s de iperf3 con 4 flujos. Después se compara lo que la aplicación usa (IOPS y MB/s del agente) con estos techos.', q: [2] },
    f1: { que: 'Cuánto cuesta una petición de cada endpoint: ms de CPU de la app (Java) y de mongod, E/S de disco y bytes por petición.', como: 'Bucle cerrado con 1 worker (sin cola), 120 s medidos tras 20 s de calentamiento, un endpoint por corrida. D = (CPU en la ventana − CPU en reposo) / req/s. Con D se predice el techo: X_max = capacidad / Σ pᵢ·Dᵢ.', q: [1, 2] },
    f2: { que: 'Cómo crece el costo del listado cuando crece la base de datos.', como: 'GET /api/lobbies con 100, 200, 400, 800 y 1.600 lobbies, 1 worker, 90 s cada uno. La pendiente log-log del costo contra los lobbies es el exponente: 1 = lineal, 2 = cuadrático. El código predice cerca de 2 (conteo sin índice dentro del N+1).', q: [2, 3] },
    f3: { que: 'Qué parte del trabajo es paralelizable y qué ganancia da el segundo hilo de cada núcleo (SMT).', como: 'Bucle cerrado con 1, 2, 4… hasta el doble de los hilos, 60 s por nivel, para listar (mongod) y login (BCrypt, CPU pura). S(N) = X(N)/X(1); p despejado de S = 1/((1−p)+p/N); techo de Amdahl = 1/(1−p). No se corre en Docker (lo cubre F4) ni en Standard (mediría el freno de créditos).', q: [2, 3] },
    f4: { que: 'Qué proceso limita en el contenedor: la app o mongod.', como: 'Seis repartos de cuota de CPU (app × mongod: 1×0,5, 1×1, 1×2, 1×4, 2×1, 4×1), bucle cerrado con 1, 4 y 16 workers. Si dar más CPU a la app no mueve el techo y dárselo a mongod sí, el cuello es mongod. “Frenado ms/s” es el tiempo que el kernel detuvo al contenedor por agotar su cuota.', q: [2, 4] },
    f5: { que: 'La rampa que valida el modelo: ¿dónde se rompe la máquina de verdad y cuánto se parece a lo predicho?', como: 'Tasa fija (Poisson con semilla), de 10 % a 150 % del X_max predicho por F1 de esa misma máquina (por eso los niveles difieren entre entornos), 90 s por nivel; corta tras dos niveles seguidos que no pasan. La latencia se mide desde la hora programada y los timeouts cuentan como error.', q: [1, 3] },
    f6: { que: 'La comparación sostenida entre entornos: la misma escala absoluta de req/s en todos.', como: 'Tasa fija 5, 10, 20, 40 y 80 req/s (en Standard también 1 y 2), 600 s por nivel, 3 repeticiones (2 en Standard y en las del arreglo), mezcla-lectura; corta en el primer nivel que no pasa. Se reporta la mediana y se avisa si el p95 difiere más de 20 % entre repeticiones. Además, cada máquina al 50 % y al 80 % de su propio codo.', q: [4, 1] },
    f78: { que: 'F7: qué se rompe primero con 10 veces la carga y con 10 veces los datos. F8: qué pasa con el tiempo (créditos de CPU de la t3).', como: 'La predicción se escribe antes de medir (archivo con marca de tiempo). F7 corre 600 s a BASE_RPS = 10 req/s, a 10 × BASE_RPS = 100 req/s y a BASE_RPS con 2.000 lobbies. F8 mantiene una carga varios minutos y se compara con el saldo de CloudWatch.', q: [3, 4] },
    recursos: { que: 'Explorador de cualquier corrida: latencia, throughput, CPU (con steal), memoria y los recursos de cada paso.', como: 'Datos del agente de telemetría (1 muestra por segundo en Linux, 2 en Windows) cruzados con la ventana medida de cada paso del generador. Sirve para citar cifras exactas: por ejemplo CPU de la máquina con iowait cercano a cero.', q: [2] },
    creditos: { que: 'Saldo de créditos de CPU de las t3.small en CloudWatch (Unlimited contra Standard).', como: 'Métricas de AWS cada 5 minutos: CPUCreditBalance, CPUSurplusCreditBalance, CPUUtilization. Las bandas marcan las corridas de F5 a F8. 1 crédito = 1 vCPU al 100 % durante 1 minuto.', q: [4, 3] },
    nmas1: { que: 'El mismo experimento con el arreglo del N+1 en el listado.', como: 'Mismo código, datos, semillas y escala; solo cambia el jar. Una consulta de videojuegos y una agregación de cupos sustituyen un findById y un conteo sin índice por cada lobby.', q: [2, 3] },
    costos: { que: 'Costo por cada 1.000 peticiones dentro del requisito.', como: 'USD por hora ÷ (req/s sostenidos × 3,6). Los precios los pones tú (AWS: ficha de la consola; PC: depreciación + energía; Docker: fracción del PC). Regla del plan: se recomienda la opción más barata por 1.000 peticiones entre las que cumplen con margen (≤ 60 % del codo).', q: [4] },
    entornos: { que: 'La ficha de hardware de cada opción comparada: modelo de CPU, hilos, RAM, sistema, versión de MongoDB y los techos de disco y red de F0.', como: 'Lectura directa del agente de telemetría en cada máquina; los techos salen de fio e iperf3 (F0). Nada se copia de internet.', q: [1, 2] },
    datos: { que: 'Trazabilidad: cada cifra de este panel sale de una corrida.', como: 'Los datos crudos (load.ndjson, agent.ndjson, run.json, app.log) están en resultados/. Este panel solo los resume; el CSV descarga cada paso con sus recursos.', q: [1] },
  };
  function explCard(id) {
    const e = EXPL[id]; if (!e) return null;
    return h('section', { class: 'card full expl' }, h('div', null, h('b', null, 'Qué es: '), e.que), h('div', null, h('b', null, 'Cómo se mide: '), e.como),
      h('div', null, h('b', null, 'Responde: '), e.q.map((n) => h('a', { class: 'qtag', href: '#sec-preguntas', title: QS[n] }, 'P' + n + ' · ' + QS[n]))));
  }
  function tabPreguntas() {
    const base = activeKeys(); const out = [];
    const li = (...c) => h('li', null, ...c);
    const note = (t) => h('li', { class: 'warn' }, t);
    const p1 = base.map((k) => { const [e, j] = k.split('|'); const l = A.f1Row(e, j, 'list'), xm = A.xmaxOf(e, j, 'mezcla-lectura'), kn = A.kneeOf(e, j, 'mezcla-lectura'); if (!l || xm == null) return null;
      return li(h('b', null, keyName(k) + ': '), `listar cuesta ${fmt(l.total)} ms de CPU por petición (F1); con la capacidad de la máquina el techo predicho de mezcla-lectura es ${fmt(xm)} req/s y la rampa midió un codo de ${kn ? (kn.allPass ? '> ' : '') + fmt(kn.knee) : '–'} req/s` + (kn && !kn.allPass ? ` (${fmt((kn.knee / xm) * 100, 0)} % de lo predicho).` : '.')); }).filter(Boolean);
    out.push(card('P1 · ' + QS[1], 'Ningún nivel de carga es un supuesto de uso: viene del costo medido (F1), del techo que ese costo predice y de la rampa que lo comprueba (F5). La comparación usa la misma escala absoluta (F6). Lo único declarado, no medido, es el requisito: p95 ≤ 1.000 ms y errores ≤ 1 %; las columnas passAt muestran que la conclusión no cambia con 300 o 500 ms.',
      h('ul', null, p1.length ? p1 : note('Faltan datos F1/F5 para los filtros elegidos.')), h('p', { class: 'note' }, 'Fases: F1 → F5 → F6. Cada cifra tiene su archivo crudo en resultados/ (sección Datos).')));
    const p2 = base.map((k) => { const [e, j] = k.split('|'); const l = A.f1Row(e, j, 'list'), lg = A.f1Row(e, j, 'login'), ex = D.models[k]?.f2?.exponent, am = D.models[k]?.amdahl?.find((x) => x.profile === 'solo-list'), lv = A.f6Levels(e, j), top = lv[lv.length - 1], sd = D.sondas[key(e, 'base')] || D.sondas[key(e, j)];
      if (!l) return null; const r = top?.res;
      return li(h('b', null, keyName(k) + ': '), `en listar, mongod gasta el ${fmt(l.mongoPct, 0)} % de la CPU (${fmt(l.mongo)} de ${fmt(l.total)} ms)` + (lg ? `; en login (BCrypt) la app gasta ${fmt(lg.app)} ms y mongod ${fmt(lg.mongo)} ms` : '') + (ex != null ? `; el costo del listado crece con exponente ${fmt(ex, 2)} respecto a los lobbies` : '') + (am && am.p != null ? `; fracción paralela p = ${fmt(am.p, 2)}` : '') +
        (r ? `. Con ${fmt(top.rate, 0)} req/s ofrecidos: CPU de la máquina ${fmt(r.busy)} %, ${r.iowait == null && r.steal == null ? 'iowait y steal no los entrega Windows' : 'iowait ' + fmt(r.iowait) + ' %, steal ' + fmt(r.steal) + ' %'}, disco ${fmt(r.iops, 0)} IOPS` + (sd && sd.randread && sd.randread.iops ? ` de ${fmt(sd.randread.iops, 0)} posibles (${fmt((r.iops / sd.randread.iops) * 100, 1)} %)` : '') + `, fallos de caché de WiredTiger ${fmt(r.missPct, 2)} %.` : '.')); }).filter(Boolean);
    out.push(card('P2 · ' + QS[2], 'Cada afirmación necesita un número medido y un componente de hardware: ms de CPU por proceso (F1), exponente de crecimiento (F2), fracción paralela y SMT (F3), cuota de CPU y frenado en el contenedor (F4), y uso de CPU, iowait, disco y red contra los techos de fio e iperf3 (F0, Recursos).',
      h('ul', null, p2.length ? p2 : note('Faltan datos.')), h('p', { class: 'note' }, 'Fases: F0, F1, F2, F3, F4 y la sección Recursos. Un iowait cercano a 0 con la CPU saturada y el disco a una fracción de su techo significa que el cuello es la CPU, no el disco.')));
    const f7 = D.runs.filter((r) => r.phase === 'f7' && state.envs.has(r.env) && state.jars.has(r.jar));
    const p3 = []; const byKey = {}; f7.forEach((r) => { (byKey[key(r.env, r.jar)] = byKey[key(r.env, r.jar)] || []).push(r); });
    for (const [k, rs] of Object.entries(byKey)) { const tr = rs.find((r) => r.run === 'f7-trafico-x10'), dt = rs.find((r) => r.run === 'f7-datos-x10'); const parts = [];
      if (tr) tr.steps.forEach((s) => parts.push(`a ${fmt(s.rate, 0)} req/s: p95 ${fms(s.p95)} ms, errores ${fmt((s.errorRate || 0) * 100, 1)} %, logrados ${fmt(s.rps)} req/s${s.pass ? ' (pasa)' : ' (no pasa)'}`));
      if (dt) dt.steps.forEach((s) => parts.push(`con ${fmt(s.lobbiesNow != null ? s.lobbiesNow : s.lobbiesStart, 0)} lobbies a ${fmt(s.rate, 0)} req/s: p95 ${fms(s.p95)} ms, errores ${fmt((s.errorRate || 0) * 100, 1)} %${s.pass ? ' (pasa)' : ' (no pasa)'}`));
      p3.push(li(h('b', null, keyName(k) + ': '), parts.join('; ') + '.')); }
    for (const k of base) { const ex = D.models[k] && D.models[k].f2 ? D.models[k].f2.exponent : null; if (ex != null) p3.push(li(h('b', null, keyName(k) + ' (por el exponente de F2): '), `10 veces los datos multiplican el costo del listado por ≈ ${fmt(Math.pow(10, ex), 1)} (10^${fmt(ex, 2)}).`)); }
    out.push(card('P3 · ' + QS[3], 'La predicción se escribe antes de medir (utilización de cada recurso a 10 × BASE_RPS y a 10 veces los datos), y F7 la comprueba con tráfico ×10 y datos ×10.',
      h('ul', null, p3.length ? p3 : note('F7 todavía no tiene corridas recogidas.')), h('p', { class: 'note' }, 'Fases: F7 (y F2 para los datos). Las predicciones con marca de tiempo están en la sección F7 / F8.')));
    const c = state.cost; const pcH = (c.pcBuy != null && c.pcMonths ? c.pcBuy / (c.pcMonths * 730) : 0) + (c.pcWatts != null && c.pcKwh != null ? (c.pcWatts / 1000) * c.pcKwh : 0);
    const rows = base.map((k) => { const [e, j] = k.split('|'); const kn = A.kneeOf(e, j, 'mezcla-lectura'), mp = A.maxPassingLevel(e, j), mg = A.marginLevel(e, j, kn && kn.knee);
      const price = e === 'pc' ? (pcH || null) : e === 'docker' ? (pcH && c.dockFrac ? pcH * c.dockFrac : null) : (c[e] != null ? c[e] : 0.0208); const per = price && mg ? price / (mg.rps * 3.6) : null; return { k, mp, mg, price, per }; });
    const ranked = rows.filter((r) => r.per != null).sort((a, b) => a.per - b.per);
    const p4 = rows.map((r) => li(h('b', null, keyName(r.k) + ': '), `${r.mp ? `la escala común pasa hasta ${fmt(r.mp.rate, 0)} req/s (p95 ${fms(r.mp.p95)} ms)` : 'sin F6 todavía'}${r.mg ? `; con margen (≤ 60 % del codo) sostiene ${fmt(r.mg.rps)} req/s` : ''}${r.per != null ? `; cuesta ${fmt(r.per, 5)} USD por 1.000 peticiones` : '; falta el precio (sección Costos)'}.`));
    const std = D.cloudwatch && D.cloudwatch.ec2s ? D.cloudwatch.ec2s.CPUCreditBalance : null, f8 = D.runs.find((r) => r.env === 'ec2s' && r.phase === 'f8' && r.jar === 'base');
    if (f8 && std && f8.startedAtMs) { const w = std.filter((p) => p.t >= f8.startedAtMs); const first = w[0], zero = w.find((p) => p.avg < 1); p4.push(li(h('b', null, 'EC2 Standard, F8: '), `saldo al inicio ${fmt(first ? first.avg : null)} créditos; ${zero ? `llegó a 0 a los ${fmt((zero.t - f8.startedAtMs) / 60000, 0)} min de carga` : 'no llegó a 0 en la ventana'}.`)); }
    const un = D.cloudwatch && D.cloudwatch.ec2u ? D.cloudwatch.ec2u.CPUSurplusCreditBalance : null; if (un && un.length) p4.push(li(h('b', null, 'EC2 Unlimited: '), `créditos excedentes acumulados hasta ${fmt(Math.max(...un.map((p) => (p.max != null ? p.max : p.avg))), 0)} (se pagan; ver Créditos).`));
    out.push(card('P4 · ' + QS[4], 'Regla del plan: una opción sirve para una carga si cumple el requisito (F6) y su recurso más usado está a ≤ 60 % de la capacidad medida (F5); se recomienda la más barata por cada 1.000 peticiones entre las que sirven. Descartar una opción es una consecuencia medida de esta tabla, no una opinión.',
      h('ul', null, p4), h('p', { class: 'note' }, ranked.length ? `Más barata por 1.000 peticiones con los precios ingresados: ${keyName(ranked[0].k)} (${fmt(ranked[0].per, 5)} USD).` : 'Ingresa los precios en la sección Costos para ver cuál queda como más barata.'), h('p', { class: 'note' }, 'Fases: F6, F8 (créditos), F4 y Costos.')));
    return out;
  }

  const RENDER = { preguntas: tabPreguntas, resumen: tabResumen, f0: tabF0, f1: tabF1, f2: tabF2, f3: tabF3, f4: tabF4, f5: tabF5, f6: tabF6, f78: tabF78, entornos: tabEntornos, recursos: tabRecursos, creditos: tabCreditos, nmas1: tabN1, costos: tabCostos, datos: tabDatos };

  // ---------------------------------------------------------------- shell
  function chips() {
    const ec = document.getElementById('envchips'); ec.replaceChildren(...ENVS.map((e) => h('button', { class: 'chip', type: 'button', 'aria-pressed': state.envs.has(e.id), onclick: () => { state.envs.has(e.id) ? state.envs.delete(e.id) : state.envs.add(e.id); render(); } }, h('span', { class: 'dot', style: `background:${colorOf(e.id)}` }), e.name)));
    const jc = document.getElementById('jarchips'); jc.replaceChildren(...L.JARS.map((j) => h('button', { class: 'chip', type: 'button', 'aria-pressed': state.jars.has(j.id), onclick: () => { state.jars.has(j.id) ? state.jars.delete(j.id) : state.jars.add(j.id); render(); } }, j.id === 'fix' ? '┄┄ ' : j.id === 'thr' ? '··· ' : '── ', j.name)));
    const tabs = document.getElementById('tabs'); tabs.replaceChildren(...TABS.map(([id, name]) => h('button', { type: 'button', onclick: () => { const t = document.getElementById('sec-' + id); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, name)));
  }
  function render() {
    chips(); const main = document.getElementById('main'); main.replaceChildren();
    for (const [id, name] of TABS) {
      main.append(h('h1', { class: 'sec full', id: 'sec-' + id }, name)); const ex = explCard(id); if (ex) main.append(ex);
      try { RENDER[id]().forEach((n) => main.append(n)); } catch (e) { main.append(h('div', { class: 'card full' }, h('h2', null, 'Error al dibujar esta sección'), h('pre', null, String(e.stack || e)))); }
    }
  }
  function activeTab() { const bs = [...document.querySelectorAll('#tabs button')]; let cur = 0; TABS.forEach(([id], i) => { const e = document.getElementById('sec-' + id); if (e && e.getBoundingClientRect().top < 120) cur = i; }); bs.forEach((b, i) => { b.setAttribute('aria-selected', i === cur); if (i === cur) b.scrollIntoView({ inline: 'center', block: 'nearest' }); }); }
  let st; addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(activeTab, 60); }, { passive: true });
  document.getElementById('gen').textContent = `Datos generados ${new Date(D.generatedAt).toLocaleString('es')} · ${D.runs.length} corridas · fuente: resultados/ (solo lectura). Regenerar: node dashboard/build.mjs`;
  document.getElementById('theme').addEventListener('click', () => { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; render(); });
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 200); });
  render(); activeTab();
})();
