#!/usr/bin/env node
// PREDICCION de "datos ×N" escrita ANTES de medir (fase f7d de campana.sh). Cierra la limitacion de v3: la prediccion de
// datos ×10 se extrapolo despues de medir.
//
// Toma el barrido F2 de un entorno (listado con 100..1600 lobbies, 1 worker) y el F1 de ver un lobby. Para cada proceso
// (app y mongod) ajusta D_list(N) = c · N^b por minimos cuadrados en log-log, y predice para cada N pedido:
//   D_mezcla = p_list · D_list(N) + p_view · D_view      (mezcla-lectura: 50/50)
//   utilizacion a λ = λ · D_mezcla / capacidad            (ley de utilizacion; capacidad de run.json / cuota de docker / --pool)
//   pasa si la utilizacion queda < 100 % (techo) y "recomendable" si queda ≤ 60 %.
//
//   node telemetry/prediccion_datos.mjs --view <dir F1 view> --rps 10 --lobbies 2000,20000 <dirs F2 list-*>  [--pool 2]
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: {
  view: { type: 'string' }, rps: { type: 'string', default: '10' }, lobbies: { type: 'string', default: '2000,20000' }, pool: { type: 'string' }, 'p-list': { type: 'string', default: '0.5' } } });
const nd = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const f = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
const quota = (s) => { if (!s || s.startsWith('max')) return null; const [q, p] = s.split(' ').map(Number); return q / p; };
const popcount = (n) => n.toString(2).replace(/0/g, '').length;

function demand(dir) {
  const L = nd(join(dir, 'load.ndjson')), A = nd(join(dir, 'agent.ndjson'));
  const st = L.find((x) => x.t === 'step'), seed = L.find((x) => x.t === 'seed'), meta = L.find((x) => x.t === 'meta');
  const S = A.filter((x) => x.t === 's'), mach = A.find((x) => x.t === 'machine');
  const run = existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : null;
  let idle = existsSync(join(dir, 'idle.json')) ? JSON.parse(readFileSync(join(dir, 'idle.json'), 'utf8')) : null;
  if (!idle?.samples && meta?.startedAtMs) { const t = meta.startedAtMs - (seed?.seconds ?? 0) * 1000 - 2000, q = S.filter((x) => x.at < t);
    if (q.length >= 3) idle = { appCpu: mean(q.map((x) => x.app?.cpu ?? 0)), mongoCpu: mean(q.map((x) => x.mongo?.cpu ?? 0)) }; }
  const w = S.filter((x) => x.at >= st.measureFrom && x.at <= st.end);
  const m = (k) => mean(w.map((x) => x[k]?.cpu).filter((v) => v != null));
  return { dir, lobbies: seed?.lobbies, rps: st.rps, samples: w.length, mach, run, S,
    app: Math.max(0, m('app') - (idle?.appCpu ?? 0)) / 100 / st.rps, mongo: Math.max(0, m('mongo') - (idle?.mongoCpu ?? 0)) / 100 / st.rps };
}
function fit(pts) {   // log D = log c + b log N
  const X = pts.map((p) => Math.log(p[0])), Y = pts.map((p) => Math.log(p[1])), mx = mean(X), my = mean(Y);
  const b = X.reduce((s, x, i) => s + (x - mx) * (Y[i] - my), 0) / X.reduce((s, x) => s + (x - mx) ** 2, 0);
  return { b, c: Math.exp(my - b * mx) };
}

if (!o.view || !positionals.length) { console.error('Uso: node telemetry/prediccion_datos.mjs --view <F1 view> [--rps 10] [--lobbies 2000,20000] [--pool N] <dirs F2>'); process.exit(1); }
const F2 = positionals.map(demand).filter((d) => d.lobbies && d.rps).sort((a, b) => a.lobbies - b.lobbies), V = demand(o.view);
const fa = fit(F2.map((d) => [d.lobbies, d.app])), fm = fit(F2.map((d) => [d.lobbies, d.mongo]));
const mach = F2[0].mach, S0 = F2[0].S.find((s) => s.app?.cpuMax || s.mongo?.cpuMax);
let cap;
if (o.pool) cap = { split: false, pool: +o.pool, note: `--pool ${o.pool}` };
else if (mach?.backend === 'docker') cap = { split: true, app: quota(S0?.app?.cpuMax) ?? 1, mongo: quota(S0?.mongo?.cpuMax) ?? 1, note: 'cuota CFS de cada contenedor' };
else if (mach?.backend === 'windows' && F2[0].run?.srvMask) cap = { split: false, pool: popcount(F2[0].run.srvMask), note: 'hilos fijados para app + mongod' };
else cap = { split: false, pool: mach?.logicalCpus, note: 'vCPU de la máquina' };
const R = +o.rps, pl = +o['p-list'], pv = 1 - pl;

const out = [`# Predicción de datos ×N, escrita antes de medir`, '', `Escrita: ${new Date().toISOString()} (UTC). Entorno: ${mach?.cpuModel?.trim() ?? '?'}, agente \`${mach?.backend}\`. Capacidad: ${cap.split ? `app ${cap.app} CPU, mongod ${cap.mongo} CPU` : `${cap.pool} CPU`} (${cap.note}).`, '',
  '## Barrido F2 usado (1 worker, solo listar)', '', '| Lobbies | ms CPU app | ms CPU mongod | Muestras | Carpeta |', '|---|---|---|---|---|',
  ...F2.map((d) => `| ${d.lobbies} | ${f(d.app * 1000, 2)} | ${f(d.mongo * 1000, 2)} | ${d.samples} | ${basename(d.dir)} |`), '',
  `Ajuste D_list(N) = c · N^b: app b = ${f(fa.b, 3)}, mongod b = ${f(fm.b, 3)}. Ver un lobby (F1, ${basename(o.view)}): app ${f(V.app * 1000, 2)} ms, mongod ${f(V.mongo * 1000, 2)} ms.`, '',
  `## Predicción a λ = ${R} req/s, ${pl * 100} % listar y ${pv * 100} % ver`, '', '| Lobbies | D_list predicho (ms, app + mongod) | D mezcla (ms) | Utilización predicha | ¿Pasa? | ¿≤ 60 %? |', '|---|---|---|---|---|---|'];
for (const N of o.lobbies.split(',').map(Number)) {
  const la = fa.c * N ** fa.b, lm = fm.c * N ** fm.b, da = pl * la + pv * V.app, dm = pl * lm + pv * V.mongo;
  const u = cap.split ? Math.max((R * da) / cap.app, (R * dm) / cap.mongo) : (R * (da + dm)) / cap.pool;
  const who = cap.split ? ((R * da) / cap.app >= (R * dm) / cap.mongo ? ' (app)' : ' (mongod)') : '';
  out.push(`| ${N} | ${f(la * 1000, 1)} + ${f(lm * 1000, 1)} = ${f((la + lm) * 1000, 1)} | ${f((da + dm) * 1000, 1)} | ${f(u * 100, 0)} %${who} | ${u < 1 ? 'sí' : 'no'} | ${u <= 0.6 ? 'sí' : 'no'} |`);
}
out.push('', 'Supuestos: la ley de utilización sin contención y el exponente constante fuera del rango medido (extrapolación). La latencia no se predice: con utilización alta el p95 sube antes del 100 %.');
console.log(out.join('\n'));
