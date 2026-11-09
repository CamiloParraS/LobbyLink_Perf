#!/usr/bin/env node
// Frecuencia del procesador durante la ventana medida de una corrida en Windows (agente con win-sampler.ps1 que registra
// cpu.perf / cpu.mhz por hilo logico). Responde: ¿en que hilos corrio la carga y a que frecuencia?
//
//   node telemetry/frecuencia.mjs resultados/<carpeta> [resultados/<otra> ...]
//
// Por hilo: % ocupado medio, MHz efectivos medios, y MHz ponderados por ocupacion (la frecuencia a la que de verdad se
// ejecuto trabajo). "Hilos del servidor" = mascara srvMask de run.json (app + mongod).
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const nd = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const f = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('Uso: node telemetry/frecuencia.mjs <carpeta de corrida> ...'); process.exit(1); }

for (const dir of dirs) {
  const A = nd(join(dir, 'agent.ndjson')), L = nd(join(dir, 'load.ndjson'));
  const run = existsSync(join(dir, 'run.json')) ? JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) : {};
  const steps = L.filter((x) => x.t === 'step');
  const S = A.filter((x) => x.t === 's' && Array.isArray(x.cpu?.perf));
  console.log(`\n## ${basename(dir)}\n`);
  if (!S.length) { console.log('Sin cpu.perf en agent.ndjson: la corrida es anterior al contador de frecuencia.'); continue; }
  const mask = run.srvMask ?? 0;
  for (const st of steps.length ? steps : [{ measureFrom: 0, end: Infinity, step: 0 }]) {
    const w = S.filter((x) => x.at >= st.measureFrom && x.at <= st.end);
    if (!w.length) continue;
    const n = w[0].cpu.perf.length, base = w[0].cpu.mhzBase;
    console.log(`Nivel ${st.step}${st.rate != null ? ` (λ = ${st.rate} req/s)` : st.workers != null ? ` (${st.workers} workers)` : ''}: ${w.length} muestras, frecuencia base informada ${base} MHz\n`);
    console.log('| Hilo | Servidor | % ocupado | MHz medios | MHz ponderados por ocupación |', '\n|---|---|---|---|---|');
    let sw = 0, swm = 0;
    for (let i = 0; i < n; i++) {
      const busy = w.map((x) => x.cpu.cores?.[i] ?? 0), mhz = w.map((x) => x.cpu.mhz?.[i] ?? 0);
      const b = busy.reduce((s, v) => s + v, 0) / w.length, m = mhz.reduce((s, v) => s + v, 0) / w.length;
      const wb = busy.reduce((s, v) => s + v, 0), wm = wb ? busy.reduce((s, v, k) => s + v * mhz[k], 0) / wb : null;
      const srv = (mask >> i) & 1;
      if (srv) { sw += wb; swm += wb * (wm ?? 0); }
      console.log(`| ${i} | ${srv ? 'sí' : 'no'} | ${f(b, 1)} | ${f(m)} | ${f(wm)} |`);
    }
    console.log(`\nHilos del servidor: frecuencia ponderada por ocupación ${f(sw ? swm / sw : null)} MHz.\n`);
  }
}
