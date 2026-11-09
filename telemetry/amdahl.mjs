#!/usr/bin/env node
// F3: ley de Amdahl a partir de una corrida en bucle cerrado con 1, 2, 4 ... N workers (laboratorio de la sesion 05).
//   S(N) = X(N) / X(1)          aceleracion medida (X = req/s)
//   S(N) = 1 / ((1-p) + p/N)    Amdahl  =>  p(N) = (1 - 1/S) / (1 - 1/N)   fraccion paralela que explica cada punto
// Se reporta p por punto y la mediana; techo teorico 1/(1-p). Si p cae al crecer N, la parte secuencial no es fija: hay
// contencion (cerrojos, un solo mongod, SMT compartiendo nucleo) y se dice en que N empieza.
//   node telemetry/amdahl.mjs resultados/<corrida-list> resultados/<corrida-login> [--cores 6 --threads 12]
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { cores: { type: 'string' }, threads: { type: 'string' } } });
const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
const nd = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const out = [];
for (const dir of positionals) {
  const L = nd(join(dir, 'load.ndjson')), A = nd(join(dir, 'agent.ndjson')), mach = A.find((x) => x.t === 'machine');
  const steps = L.filter((x) => x.t === 'step' && typeof x.workers === 'number').sort((a, b) => a.workers - b.workers), meta = L.find((x) => x.t === 'meta');
  const s1 = steps.find((s) => s.workers === 1);
  if (!s1) { out.push(`## ${basename(dir)}: falta el nivel de 1 worker`, ''); continue; }
  const cores = +(o.cores ?? mach?.physicalCores ?? NaN), threads = +(o.threads ?? mach?.logicalCpus ?? NaN);
  out.push(`## Amdahl · perfil \`${meta?.profile?.id}\` · ${basename(dir)}`, '', `Máquina: ${mach?.cpuModel?.trim() ?? '?'} · ${f(cores, 0)} núcleos físicos · ${f(threads, 0)} hilos.`, '',
    '| Workers | req/s | S(N) medido | Eficiencia S/N | p que explica el punto | p50 / p95 (ms) | CPU app (% de 1 núcleo) | CPU mongod (% de 1 núcleo) |', '|---|---|---|---|---|---|---|---|');
  const ps = [];
  for (const s of steps) {
    const S = s.rps / s1.rps, p = s.workers > 1 ? (1 - 1 / S) / (1 - 1 / s.workers) : null; if (p != null) ps.push([s.workers, p]);
    const w = A.filter((x) => x.t === 's' && x.at >= s.measureFrom && x.at <= s.end), m = (k) => { const v = w.map((x) => x[k]?.cpu).filter((q) => q != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    out.push(`| ${s.workers} | ${f(s.rps, 1)} | ${f(S)} | ${f((S / s.workers) * 100, 0)} % | ${f(p, 3)} | ${f(s.lat?.p50, 0)} / ${f(s.lat?.p95, 0)} | ${f(m('app'), 0)} | ${f(m('mongo'), 0)} |`);
  }
  const best = steps.reduce((b, s) => (s.rps > b.rps ? s : b), s1);
  const sorted = ps.map((x) => x[1]).sort((a, b) => a - b), pm = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const upTo = (n) => ps.filter(([N]) => N <= n).map((x) => x[1]), med = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  out.push('', `- Mejor rendimiento: **${f(best.rps, 1)} req/s con ${best.workers} workers** (S = ${f(best.rps / s1.rps)}). Después de ese punto más workers solo alargan la cola.`,
    `- Fracción paralela (mediana de los puntos): **p = ${f(pm, 3)}** → techo de Amdahl 1/(1−p) = **${f(pm != null && pm < 1 ? 1 / (1 - pm) : null, 1)}×**.`);
  if (Number.isFinite(cores)) out.push(`- p hasta ${cores} workers (núcleos físicos): ${f(med(upTo(cores)), 3)}; con todos los puntos: ${f(pm, 3)}. Si baja al pasar de ${cores} a ${f(threads, 0)}, el segundo hilo de cada núcleo (SMT) aporta menos que un núcleo: comparten ALU y caché L1/L2.`);
  const smt = Number.isFinite(cores) && Number.isFinite(threads) ? [steps.find((s) => s.workers === cores), steps.find((s) => s.workers === threads)] : [];
  if (smt[0] && smt[1]) out.push(`- Ganancia de SMT medida: de ${cores} a ${threads} workers el rendimiento pasa de ${f(smt[0].rps, 1)} a ${f(smt[1].rps, 1)} req/s (**${f((smt[1].rps / smt[0].rps - 1) * 100, 0)} %**; la sesión 05 dice 15–30 % según la carga).`);
  out.push('');
}
console.log(out.join('\n'));
