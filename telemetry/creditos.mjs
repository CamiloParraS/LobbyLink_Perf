#!/usr/bin/env node
// Créditos de CPU de la t3.small Unlimited por nivel de carga, medidos con CloudWatch.
// Cruza las ventanas de medición de cada nivel (measureFrom/end de load.ndjson) con las series de 5 min de
// CPUCreditUsage y CPUSurplusCreditBalance exportadas en <dir_cloudwatch>, y calcula el costo mensual de los
// créditos excedentes.
//
// Uso: node telemetry/creditos.mjs <dir_cloudwatch> <dir_corridas>... [--precio 0.05] [--horas 730] [--filtro f6-mezcla]
//   ej.: node telemetry/creditos.mjs resultados/ec2_t3small-unl/cloudwatch resultados/ec2_t3small-unl resultados/ec2_t3small-unl-nplus1
//
// Lectura: con saldo ganado en 0, AWS suma al saldo excedente lo que la instancia gasta por encima de lo que gana
// (24 créditos/h en la t3.small) y lo descuenta cuando gasta menos. Por eso la pendiente del saldo excedente
// (créditos/h) es lo que se cobra si esa carga se sostiene. 1 crédito = 1 vCPU-minuto; precio en USD por vCPU-hora.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const precio = Number(opt('--precio', '0.05')), horas = Number(opt('--horas', '730')), filtro = opt('--filtro', 'f6-mezcla');
const [cwDir, ...runDirs] = args;
if (!cwDir || !runDirs.length) { console.error('uso: creditos.mjs <dir_cloudwatch> <dir_corridas>...'); process.exit(1); }

const serie = (n) => JSON.parse(readFileSync(join(cwDir, n + '.json'), 'utf8'))
  .map((d) => ({ t: Date.parse(d.Timestamp), v: d.Average ?? d.Sum })).sort((a, b) => a.t - b.t);
const uso = serie('CPUCreditUsage'), exc = serie('CPUSurplusCreditBalance');
const mediana = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmt = (x, d = 1) => x == null || Number.isNaN(x) ? '–' : x.toFixed(d).replace('.', ',');

const niveles = new Map();
for (const base of runDirs) for (const r of readdirSync(base).filter((s) => s.includes(filtro))) {
  const f = join(base, r, 'load.ndjson'); if (!existsSync(f)) continue;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    if (!l.includes('"t":"step"')) continue;
    const s = JSON.parse(l), a = s.measureFrom, b = s.end;
    const pu = uso.filter((d) => d.t >= a - 60000 && d.t + 300000 <= b + 60000).map((d) => d.v);
    const pe = exc.filter((d) => d.t >= a - 300000 && d.t <= b);
    const pend = pe.length > 1 ? (pe.at(-1).v - pe[0].v) / ((pe.at(-1).t - pe[0].t) / 3600000) : null;
    const k = `${basename(base)}|${s.rate ?? s.offeredRps}`;
    if (!niveles.has(k)) niveles.set(k, { corrida: basename(base), rate: s.rate ?? s.offeredRps, uso: [], pend: [], reps: [] });
    const n = niveles.get(k); n.uso.push(...pu); if (pend != null) n.pend.push(pend); n.reps.push(r);
  }
}

console.log(`# Créditos de CPU por nivel (CloudWatch, ${basename(join(cwDir, '..'))})\n`);
console.log(`Precio del crédito excedente: ${fmt(precio, 2)} USD por vCPU-hora (1 crédito = 1 vCPU-minuto). Mes de ${horas} h.\n`);
console.log('| Corrida | λ (req/s) | Repeticiones | Créditos gastados por hora (CPUCreditUsage) | Pendiente del saldo excedente (créditos/h, por repetición) | Mediana (créditos/h) | Costo de créditos excedentes (USD/mes, mediana) |');
console.log('|---|---|---|---|---|---|---|');
for (const n of [...niveles.values()].sort((a, b) => a.corrida.localeCompare(b.corrida) || a.rate - b.rate)) {
  const u = n.uso.length ? n.uso.reduce((a, b) => a + b, 0) / n.uso.length * 12 : null;
  const m = n.pend.length ? mediana(n.pend) : null;
  const usd = m == null ? null : Math.max(0, m) * horas / 60 * precio;
  console.log(`| ${n.corrida} | ${n.rate} | ${n.reps.length} | ${fmt(u)} (${n.uso.length} puntos de 5 min) | ${n.pend.map((x) => fmt(x)).join(' · ')} | ${fmt(m)} | ${fmt(usd, 2)} |`);
}
const ultimo = exc.at(-1);
console.log(`\nÚltimo saldo excedente registrado: ${fmt(ultimo.v)} créditos (${new Date(ultimo.t).toISOString()}), ${fmt(ultimo.v / 60 * precio, 3)} USD que AWS cobra al terminar la instancia.`);
console.log('Pendiente negativa: la instancia gasta menos de lo que gana y paga el saldo excedente; no hay cobro adicional si la carga se sostiene.');
