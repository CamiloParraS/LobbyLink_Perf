#!/usr/bin/env node
// Codo medido de una rampa a tasa fija (F5): la mayor λ ofrecida que todavia PASA (p95 y errores dentro del umbral, generador valido).
//   node telemetry/knee.mjs <carpeta-rampa> [--p95 1000]    imprime el numero (req/s logradas en ese nivel); codigo 2 si ningun nivel paso
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
const { values: o, positionals: [dir] } = parseArgs({ allowPositionals: true, options: { p95: { type: 'string' } } });
const steps = readFileSync(join(dir, 'load.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.t === 'step' && x.mode === 'rate');
const ok = steps.filter((s) => s.genOk && (o.p95 ? s.passAt?.[o.p95] : s.pass));
if (!ok.length) { console.error('ningun nivel paso'); process.exit(2); }
console.log(Math.max(...ok.map((s) => s.rps)).toFixed(2));
