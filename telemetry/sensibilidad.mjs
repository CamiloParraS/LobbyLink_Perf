#!/usr/bin/env node
// Sensibilidad de la capacidad al tamaño de datos (número de lobbies sembrados).
// Combina el costo del listado medido en F2 (1 worker, 100-1.600 lobbies; tabla "## 4." de datos_*_f2.md) con el costo
// de "ver un lobby" medido en F1 (fila "view" de modelo_*_f1.md) y calcula, para la mezcla dada:
//   X_max(N) = capacidad / Σ pᵢ·Dᵢ(N)    y lo que se sostiene con la regla de recomendación (60 % de X_max).
// Capacidad: "8" = 8 CPU compartidas por app y mongod; "1+1" = cuota propia de la app + cuota propia de mongod.
//
// Uso: node telemetry/sensibilidad.mjs --caso "<etiqueta>|<datos_f2.md>|<modelo_f1.md>|<capacidad>" [--caso ...]
//        [--list 0.5] [--margen 0.6]
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: {
  caso: { type: 'string', multiple: true, default: [] }, list: { type: 'string', default: '0.5' }, margen: { type: 'string', default: '0.6' } } });
const pList = Number(o.list), pView = 1 - pList, margen = Number(o.margen);
const num = (s) => Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
const fmt = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1)).replace('.', ',');

function f2(file) {
  const sec = readFileSync(file, 'utf8').split('## 4.')[1] ?? '';
  const filas = {};
  for (const l of sec.split('\n')) { const c = l.split('|'); if (/^\s*\d+\s*$/.test(c[1] ?? '')) filas[c[1].trim()] = { app: num(c[3]), mg: num(c[4]) }; }
  return { filas, exp: (sec.match(/\*\*([\d,]+)\*\*/) || [])[1] ?? '–' };
}
function view(file) {
  const l = readFileSync(file, 'utf8').split('\n').find((x) => x.startsWith('| view'));
  if (!l) throw new Error(`sin fila view en ${file}`);
  const c = l.split('|'); return { app: num(c[4]), mg: num(c[5]) };
}

const casos = o.caso.map((s) => { const [etq, datos, modelo, cap] = s.split('|'); return { etq, ...f2(datos), v: view(modelo), cap, datos, modelo }; });
const tamaños = [...new Set(casos.flatMap((c) => Object.keys(c.filas)))].sort((a, b) => a - b);

console.log(`# Sensibilidad al tamaño de datos (lobbies sembrados)\n`);
console.log(`Mezcla: ${pList * 100} % listar, ${pView * 100} % ver. Celda: X_max predicho → lo que se sostiene al ${margen * 100} % (regla de recomendación), en req/s.\n`);
console.log(`| Lobbies | ${casos.map((c) => c.etq).join(' | ')} |`);
console.log(`|---|${casos.map(() => '---').join('|')}|`);
for (const n of tamaños) {
  const celdas = casos.map((c) => {
    const r = c.filas[n]; if (!r) return '–';
    const a = pList * r.app + pView * c.v.app, m = pList * r.mg + pView * c.v.mg;
    const x = c.cap.includes('+')
      ? Math.min(Number(c.cap.split('+')[0]) * 1000 / a, Number(c.cap.split('+')[1]) * 1000 / m)
      : Number(c.cap) * 1000 / (a + m);
    return `${fmt(x)} → ${fmt(margen * x)}`;
  });
  console.log(`| ${n} | ${celdas.join(' | ')} |`);
}
console.log(`| exponente del listado (F2) | ${casos.map((c) => c.exp).join(' | ')} |`);
console.log('\nFuentes:');
for (const c of casos) console.log(`- ${c.etq}: listado de \`${c.datos}\`, "ver" de \`${c.modelo}\`, capacidad ${c.cap}`);
console.log('\nEs una cota superior por tamaño (supone D constante con la carga). El medido en F5 quedó cerca del 60 % de X_max; por eso la columna después de la flecha.');
