#!/usr/bin/env node
// MODELO DE COSTO (ley de utilizacion). Convierte las corridas F1 (un endpoint aislado, 1 worker, sin cola) en:
//   1. D por endpoint: segundos de CPU de la app y de mongod, E/S de disco y bytes por peticion   -> "¿por que ese numero?"
//   2. X_max de cualquier mezcla: X_max = min_r capacidad_r / Σ p_i·D_i,r                        -> techo predicho ANTES de la rampa
//   3. Con --base-rps R: utilizacion de cada recurso a R y a 10·R; el primero que pasa de 100 %   -> "¿que se rompe primero con ×10?"
//   4. Con --sweep: D del listado contra el numero de lobbies y su exponente (pendiente log-log)  -> crecimiento por datos (N+1)
//   5. Con --validate <carpetas de rate.mjs>: prediccion contra medicion (X logrado, utilizacion)
// Una invocacion = UN entorno (las carpetas F1 de esa maquina).
//
//   node telemetry/model.mjs resultados/*_windows_v3-f1-*                         tablas en Markdown
//   node telemetry/model.mjs resultados/*_windows_v3-f1-* --xmax mezcla-lectura   imprime solo X_max (lo usa la campana)
//   node telemetry/model.mjs <f1...> --base-rps 12 --net-mbps 940 --disk-iops 3000 --validate resultados/*_windows_v3-f6*
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  xmax: { type: 'string' }, 'base-rps': { type: 'string' }, 'net-mbps': { type: 'string' }, 'disk-iops': { type: 'string' },
  lobbies: { type: 'string', default: '200' }, pool: { type: 'string' }, validate: { type: 'string', multiple: true, default: [] }, mixes: { type: 'string' }, sweep: { type: 'boolean', default: false }, by: { type: 'string', default: 'lobbies' } } });   // --by participants: el barrido F2 varía los participantes por lobby (lobbies fijos)
const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
const nd = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const get = (s, path) => path.split('.').reduce((q, k) => q?.[k], s);
const quota = (s) => { if (!s || s.startsWith('max')) return null; const [q, p] = s.split(' ').map(Number); return q / p; };
const popcount = (n) => n.toString(2).replace(/0/g, '').length;

function load(dir) {
  const L = nd(join(dir, 'load.ndjson')), A = nd(join(dir, 'agent.ndjson'));
  const run = existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : null;
  const idle = existsSync(join(dir, 'idle.json')) ? JSON.parse(readFileSync(join(dir, 'idle.json'), 'utf8')) : null;
  return { dir, name: basename(dir), meta: L.find((x) => x.t === 'meta'), seed: L.find((x) => x.t === 'seed'), steps: L.filter((x) => x.t === 'step'),
    mach: A.find((x) => x.t === 'machine'), S: A.filter((x) => x.t === 's'), run, idle };
}
// Nucleos que tiene el servidor (app + mongod). Docker: cuota CFS de cada contenedor. Windows: hilos fijados si mongod quedo fijado.
function capacity(r) {
  const { mach, run, S } = r;
  if (mach?.backend === 'docker') { const x = S.find((s) => s.app?.cpuMax || s.mongo?.cpuMax); return { split: true, app: quota(x?.app?.cpuMax) ?? mach.logicalCpus, mongo: quota(x?.mongo?.cpuMax) ?? mach.logicalCpus, note: 'cuota CFS de cada contenedor' }; }
  if (mach?.backend === 'windows' && run?.srvMask) {
    const pinned = /^ok/.test(run.pinned?.java ?? '') && /^ok/.test(run.pinned?.mongod ?? '');
    const pool = pinned ? popcount(run.srvMask) : mach.logicalCpus;
    return { split: false, pool, note: pinned ? `${pool} hilos fijados para app + mongod` : `mongod sin afinidad: ${pool} hilos (compartidos con el generador)` };
  }
  return { split: false, pool: mach?.logicalCpus, note: `${mach?.logicalCpus ?? '?'} vCPU de la máquina` };
}
// Costo de UNA peticion en el primer nivel (1 worker): (uso en la ventana medida - uso en reposo) / req/s
function demand(r, step = r.steps[0]) {
  if (!step || !step.rps) return null;
  const w = r.S.filter((x) => x.at >= step.measureFrom && x.at <= step.end), m = (p) => mean(w.map((x) => get(x, p)).filter((v) => v != null));
  const net = (v, idle) => (v == null ? null : Math.max(0, v - (idle ?? 0)));
  // reposo: idle.json (PC/contenedor) o, en modo --server-only (EC2), las muestras del agente antes de que empiece la siembra
  let idle = r.idle;
  if (!idle?.samples && r.meta?.startedAtMs) { const t = r.meta.startedAtMs - (r.seed?.seconds ?? 0) * 1000 - 2000, q = r.S.filter((x) => x.at < t);
    if (q.length >= 3) idle = { appCpu: mean(q.map((x) => x.app?.cpu ?? 0)), mongoCpu: mean(q.map((x) => x.mongo?.cpu ?? 0)) }; }
  const app = net(m('app.cpu'), idle?.appCpu), mongo = net(m('mongo.cpu'), idle?.mongoCpu), iops = net(m('disk.iops'), idle?.iops);
  const op = Object.keys(r.meta?.profile?.mix ?? {})[0];
  return { op, profile: r.meta?.profile?.id, lobbies: r.seed?.lobbies, participants: r.seed?.participants ?? 1, rps: step.rps, samples: w.length,
    app: app == null ? null : app / 100 / step.rps, mongo: mongo == null ? null : mongo / 100 / step.rps,   // segundos de CPU por peticion
    io: iops == null ? null : iops / step.rps,                                                             // E/S de disco por peticion
    bytes: step.respBytes?.[op] != null ? step.respBytes[op] + 150 : (step.mbInPerS != null ? (step.mbInPerS * 1048576) / step.rps : null),
    p50: step.byOp?.[op]?.p50 ?? step.lat?.p50, p95: step.lat?.p95 };
}

const runs = positionals.map(load).filter((r) => r.steps.length);
if (!runs.length) { console.error('Uso: node model.mjs <carpetas F1 de un entorno> [--xmax mezcla] [--base-rps R] [--net-mbps M] [--disk-iops N] [--validate carpetas] [--sweep]'); process.exit(1); }
// --pool: capacidad fija en CPU (p. ej. línea base de una t3 Standard sin créditos, 2 vCPU × 20 % = 0,4, dato de la ficha de AWS)
const cap = o.pool ? { split: false, pool: +o.pool, note: `--pool ${o.pool}: CPU disponibles según la ficha (línea base de créditos), no los hilos visibles` } : capacity(runs[0]);
const D = {};
for (const r of runs) { const d = demand(r); if (!d?.op || r.meta?.profile?.id?.startsWith('mezcla')) continue;
  if (d.op === 'list' && String(d.lobbies) !== o.lobbies) continue;   // el listado depende del tamano de datos: se usa el de --lobbies
  D[d.op] = d; }

const mixFiles = o.mixes ? o.mixes.split(',') : readdirSync(join(here, 'profiles')).filter((x) => /^(mezcla|solo|login)/.test(x)).map((x) => x.replace('.json', ''));
const mixes = Object.fromEntries(mixFiles.map((id) => [id, JSON.parse(readFileSync(join(here, 'profiles', `${id}.json`), 'utf8')).mix]));
function predict(mix) {
  const tot = Object.values(mix).reduce((s, p) => s + p, 0), miss = Object.keys(mix).filter((k) => !D[k]);
  if (miss.length) return { miss };
  const sum = (k) => Object.entries(mix).reduce((s, [op, p]) => s + (p / tot) * (D[op][k] ?? 0), 0);
  const dApp = sum('app'), dMongo = sum('mongo'), io = sum('io'), bytes = sum('bytes');
  const res = cap.split ? [['CPU de la app', cap.app / dApp, dApp, cap.app], ['CPU de mongod', cap.mongo / dMongo, dMongo, cap.mongo]]
    : [['CPU compartida (app + mongod)', cap.pool / (dApp + dMongo), dApp + dMongo, cap.pool]];
  if (o['net-mbps'] && bytes) res.push(['Red (medida con iperf3)', (+o['net-mbps'] * 1e6 / 8) / bytes, bytes, +o['net-mbps']]);
  if (o['disk-iops'] && io > 0.001) res.push(['Disco (IOPS medidas con fio)', +o['disk-iops'] / io, io, +o['disk-iops']]);
  res.sort((x, y) => x[1] - y[1]);
  return { dApp, dMongo, io, bytes, res, xmax: res[0][1], first: res[0][0], share: dMongo / (dApp + dMongo) };
}

if (o.xmax) { const p = predict(mixes[o.xmax] ?? {}); if (p.miss || !Number.isFinite(p.xmax)) { console.error('faltan corridas F1 para', p.miss?.join(',') ?? o.xmax); process.exit(2); } console.log(p.xmax.toFixed(2)); process.exit(0); }

const out = [];
const m0 = runs[0].mach;
out.push(`# Modelo de costo · ${m0 ? `${m0.cpuModel?.trim()} · ${m0.logicalCpus} hilos · ${f(m0.memTotalMB / 1024, 1)} GB · agente \`${m0.backend}\`` : runs[0].name}`, '',
  `Capacidad usada: ${cap.split ? `app ${f(cap.app, 2)} CPU, mongod ${f(cap.mongo, 2)} CPU` : `${f(cap.pool, 0)} hilos`} (${cap.note}). D se mide con 1 worker (sin cola) y se le resta el consumo en reposo.`, '');
out.push('## 1. Costo de una petición por endpoint (F1)', '', '| Endpoint | Corrida | req/s (1 worker) | ms CPU app | ms CPU mongod | ms CPU total | % en mongod | E/S disco por pet. | KB respuesta | p50 sin cola (ms) | Muestras |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const [op, d] of Object.entries(D)) out.push(`| ${op}${op === 'list' ? ` (${d.lobbies} lobbies)` : ''} | ${d.profile} | ${f(d.rps)} | ${f(d.app * 1000, 2)} | ${f(d.mongo * 1000, 2)} | ${f((d.app + d.mongo) * 1000, 2)} | ${f((d.mongo / (d.app + d.mongo)) * 100, 0)} % | ${f(d.io, 3)} | ${f(d.bytes / 1024, 1)} | ${f(d.p50)} | ${d.samples} |`);
out.push('', 'Lectura: ms de CPU por petición = (CPU del proceso en la ventana − CPU en reposo) / req/s. Es el trabajo que cada petición le cuesta a ese componente; no depende de la carga mientras no haya contención. Muestras < 30: la cifra es poco fiable, alargar la corrida.', '');

out.push('## 2. Techo predicho por mezcla (X_max = capacidad / Σ pᵢ·Dᵢ)', '', '| Mezcla | Pesos | ms CPU app | ms CPU mongod | KB/pet. | X_max predicho (req/s) | Se agota primero | Siguiente recurso |', '|---|---|---|---|---|---|---|---|');
for (const [id, mix] of Object.entries(mixes)) {
  const p = predict(mix);
  if (p.miss) { out.push(`| ${id} | ${JSON.stringify(mix)} | – | – | – | – | faltan F1 de ${p.miss.join(', ')} | – |`); continue; }
  out.push(`| ${id} | ${Object.entries(mix).map(([k, v]) => `${k} ${v}`).join(', ')} | ${f(p.dApp * 1000, 2)} | ${f(p.dMongo * 1000, 2)} | ${f(p.bytes / 1024, 1)} | **${f(p.xmax, 1)}** | ${p.first} | ${p.res[1] ? `${p.res[1][0]} a ${f(p.res[1][1], 0)} req/s` : '–'} |`);
}
out.push('', 'Es una cota superior: supone que D no cambia con la carga. Con hilos SMT, cambios de contexto y contención real el techo medido queda por debajo; la diferencia es un resultado (F5 lo mide).', '');

if (o['base-rps']) {
  const R = +o['base-rps'];
  out.push(`## 3. Carga ×10: base ${f(R, 1)} req/s → ${f(10 * R, 1)} req/s`, '');
  for (const id of Object.keys(mixes).filter((k) => k.startsWith('mezcla'))) {
    const p = predict(mixes[id]); if (p.miss) continue;
    out.push(`### ${id}`, '', '| Recurso | Capacidad | Costo por petición | Utilización a la base | Utilización a ×10 | Se satura con (req/s) |', '|---|---|---|---|---|---|');
    for (const [name, x, d, c] of p.res) {
      const unit = /Red/.test(name) ? [`${f(c, 0)} Mbit/s`, `${f(d / 1024, 1)} KB`] : /Disco/.test(name) ? [`${f(c, 0)} IOPS`, `${f(d, 3)} E/S`] : [`${f(c, 2)} CPU`, `${f(d * 1000, 2)} ms CPU`];
      out.push(`| ${name} | ${unit[0]} | ${unit[1]} | ${f((R / x) * 100, 0)} % | ${f((10 * R / x) * 100, 0)} % | ${f(x, 1)} |`);
    }
    const broken = p.res.filter((q) => q[1] < 10 * R);
    out.push('', broken.length ? `Predicción: a ${f(10 * R, 0)} req/s se rompe primero **${broken[0][0]}** (pasa de 100 % a partir de ${f(broken[0][1], 1)} req/s)${broken[1] ? `; después ${broken.slice(1).map((q) => q[0]).join(', ')}` : ''}. La memoria no escala con λ en este modelo: se toma el RSS medido en F7.` : `Predicción: ningún recurso modelado pasa de 100 % a ${f(10 * R, 0)} req/s.`, '');
  }
}

if (o.sweep) {
  const byP = o.by === 'participants', K = byP ? 'participants' : 'lobbies';
  const pts = runs.map((r) => demand(r)).filter((d) => d?.op === 'list' && d[K]).sort((x, y) => x[K] - y[K]);
  if (pts.length) {
    out.push(byP ? '## 4b. Crecimiento por participantes: costo del listado contra participantes por lobby (F2b, lobbies fijos)' : '## 4. Crecimiento por datos: costo del listado contra número de lobbies (F2)', '', `| ${byP ? 'Participantes por lobby' : 'Lobbies'} | req/s (1 worker) | ms CPU app | ms CPU mongod | ms CPU total | KB respuesta | p50 (ms) |`, '|---|---|---|---|---|---|---|');
    for (const d of pts) out.push(`| ${d[K]} | ${f(d.rps, 2)} | ${f(d.app * 1000, 1)} | ${f(d.mongo * 1000, 1)} | ${f((d.app + d.mongo) * 1000, 1)} | ${f(d.bytes / 1024, 1)} | ${f(d.p50)} |`);
    if (pts.length >= 2) {
      const xs = pts.map((d) => Math.log(d[K])), ys = pts.map((d) => Math.log(d.app + d.mongo)), mx = mean(xs), my = mean(ys);
      const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
      if (byP) out.push('', `Exponente medido contra los participantes por lobby (pendiente log-log): **${f(b, 2)}**. 0 = el costo no depende de cuántos se unen; 1 = crece lineal con los participantes (el conteo del jar base recorre \`participaciones\`).`);
      else out.push('', `Exponente medido (pendiente log-log): **${f(b, 2)}**. 1 = lineal (una consulta por lobby); 2 = cuadrático (por cada lobby, un conteo que recorre una colección que también crece con los lobbies: \`countByLobbyId\` sin índice en \`participaciones.lobbyId\`).`);
    }
    out.push('');
  }
}

if (o.validate.length) {
  out.push('## 5. Validación: predicción contra medición (corridas a tasa fija)', '', '| Corrida | Mezcla | λ ofrecida | req/s logradas | X_max predicho | Utilización predicha (λ·D) | Utilización medida | p95 (ms) | Pasa |', '|---|---|---|---|---|---|---|---|---|');
  for (const dir of o.validate) {
    const r = load(dir), id = r.meta?.profile?.id, p = mixes[id] ? predict(mixes[id]) : null;
    for (const s of r.steps) {
      const w = r.S.filter((x) => x.at >= s.measureFrom && x.at <= s.end), m = (q) => mean(w.map((x) => get(x, q)).filter((v) => v != null));
      const ua = m('app.cpu'), um = m('mongo.cpu');
      const meas = cap.split ? `app ${f(ua / cap.app, 0)} % · mongod ${f(um / cap.mongo, 0)} %` : `${f(((ua ?? 0) + (um ?? 0)) / cap.pool, 0)} %`;
      const pred = !p || p.miss ? '–' : cap.split ? `app ${f(s.offeredRps * p.dApp / cap.app * 100, 0)} % · mongod ${f(s.offeredRps * p.dMongo / cap.mongo * 100, 0)} %` : `${f(s.offeredRps * (p.dApp + p.dMongo) / cap.pool * 100, 0)} %`;
      out.push(`| ${r.name} | ${id} | ${f(s.offeredRps)} | ${f(s.rps)} | ${p && !p.miss ? f(p.xmax, 1) : '–'} | ${pred} | ${meas} | ${f(s.lat?.p95, 0)} | ${s.pass ? 'sí' : 'no'} |`);
    }
  }
  out.push('', 'Si la utilización medida sigue a la predicha hasta cerca de 100 % y las req/s logradas dejan de seguir a la λ ofrecida cerca de X_max, el modelo explica el sistema. Si la medida crece más rápido que la predicha, D sube con la carga (contención, SMT, cambios de contexto: mirar `sy`).', '');
}
console.log(out.join('\n'));
