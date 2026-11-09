#!/usr/bin/env node
// Generador de BUCLE CERRADO: N workers, cada uno manda la siguiente peticion apenas recibe la anterior.
// En v3 se usa SOLO para dos cosas, donde el bucle cerrado es justamente lo que se quiere:
//   F1 (costo por endpoint, 1 worker: sin cola, la CPU / req/s es el costo de una peticion) y
//   F3 (Amdahl: rendimiento con 1, 2, 4 ... N workers, laboratorio de la sesion 05).
// Para latencias bajo carga se usa rate.mjs (tasa fija), porque aqui la carga ofrecida baja cuando el servidor se frena.
// Salida NDJSON: meta | seed | mark | sec (1 por segundo) | step (resumen por nivel) | end
// Uso: node load.mjs --base http://host:8080 --profile solo-list --workers 1,2,4 --seconds 120 --warm 20 --env windows --out salida.ndjson
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { add, summary } from './lib/hist.mjs';
import { client, makeOps, picker, seed } from './lib/lobbylink.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: {
  base: { type: 'string', default: 'http://localhost:8080' }, profile: { type: 'string', default: 'solo-list' },
  workers: { type: 'string', default: '1' }, seconds: { type: 'string', default: '120' }, warm: { type: 'string', default: '20' },
  users: { type: 'string', default: '20' }, lobbies: { type: 'string', default: '200' }, participants: { type: 'string', default: '1' },
  env: { type: 'string', default: 'desconocido' }, out: { type: 'string' }, pause: { type: 'string', default: '15' } } });
const SECS = +a.seconds, WARM = +a.warm, LEVELS = a.workers.split(',').map(Number);
const profile = JSON.parse(readFileSync(join(here, 'profiles', `${a.profile}.json`), 'utf8'));
const thr = JSON.parse(readFileSync(join(here, 'profiles/umbrales.json'), 'utf8'));
const OUT = a.out ?? `lobbylink_${a.env}_${a.profile}.ndjson`;
const w = (o) => appendFileSync(OUT, JSON.stringify(o) + '\n');
writeFileSync(OUT, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { call, bytes } = client(a.base, 60000);
const ctx = await seed(call, { users: +a.users, lobbies: +a.lobbies, participants: +a.participants, run: Date.now().toString(36) });
w({ t: 'meta', mode: 'closed', env: a.env, profile, thresholds: thr, base: a.base, levels: LEVELS, seconds: SECS, warm: WARM, startedAt: new Date().toISOString(), startedAtMs: Date.now(), baseRttMs: ctx.info.baseRttMs, node: process.version });
w({ t: 'seed', ...ctx.info });
console.log('siembra', ctx.info);

const OPS = makeOps(call, ctx), pick = picker(profile.mix);
let stepNo = 0;
for (const CONC of LEVELS) {
  const t0 = Date.now(), warmEnd = t0 + WARM * 1000, end = warmEnd + SECS * 1000;
  w({ t: 'mark', ev: 'step-start', step: stepNo, workers: CONC, at: t0, measureFrom: warmEnd, end });
  const hAll = {}, hOp = {}, codes = {}, bytesOp = {};
  let n = 0, errs = 0, sec = { h: {}, n: 0, errs: 0 }, last = bytes(), bStart = null;
  const tick = setInterval(() => {
    const now = Date.now(), b = bytes();
    if (bStart == null && now >= warmEnd) bStart = b;
    w({ t: 'sec', step: stepNo, at: now, measuring: now > warmEnd, workers: CONC, n: sec.n, errs: sec.errs, bytesIn: b[0] - last[0], bytesOut: b[1] - last[1], lat: summary(sec.h) });
    sec = { h: {}, n: 0, errs: 0 }; last = b;
  }, 1000);
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (Date.now() < end) {
      const op = pick(), s = performance.now(); let code = 'ERR', size = 0;
      try { const r = await OPS[op](); code = r.status; size = r.bytes; } catch {}
      const ms = performance.now() - s, meas = Date.now() >= warmEnd, bad = code === 'ERR' || code >= 500;
      sec.n++; add(sec.h, ms); if (bad) sec.errs++;
      if (!meas) continue;
      n++; if (bad) errs++; add(hAll, ms); add((hOp[op] ??= {}), ms);
      const k = `${op}:${code}`; codes[k] = (codes[k] ?? 0) + 1;
      (bytesOp[op] ??= [0, 0]); bytesOp[op][0] += size; bytesOp[op][1]++;
    }
  }));
  clearInterval(tick);
  const lat = summary(hAll), rps = n / SECS, errorRate = n ? errs / n : 1, b = bytes();
  const reasons = [];
  if (lat && lat.p95 > thr.p95Ms) reasons.push(`p95 ${lat.p95} ms > ${thr.p95Ms}`);
  if (errorRate > thr.errorRate) reasons.push(`errores ${(errorRate * 100).toFixed(2)} % > ${thr.errorRate * 100} %`);
  const byOp = Object.fromEntries(Object.entries(hOp).map(([k, h]) => [k, summary(h)]));
  const respBytes = Object.fromEntries(Object.entries(bytesOp).map(([k, [s, c]]) => [k, Math.round(s / c)]));
  const step = { t: 'step', mode: 'closed', step: stepNo, workers: CONC, measureFrom: warmEnd, end, seconds: SECS, requests: n, rps: +rps.toFixed(2), lat, byOp, codes, respBytes, errors: errs, errorRate: +errorRate.toFixed(4),
    lobbiesNow: ctx.ids.length,
    mbInPerS: bStart ? +((b[0] - bStart[0]) / SECS / 1048576).toFixed(4) : null, mbOutPerS: bStart ? +((b[1] - bStart[1]) / SECS / 1048576).toFixed(4) : null,
    pass: reasons.length === 0, reasons };
  w(step);
  console.log(`[${CONC}w] ${n} reqs ${rps.toFixed(1)} req/s p50/p95/p99=${lat?.p50}/${lat?.p95}/${lat?.p99} ms err=${errs} ${step.pass ? 'PASA' : 'NO PASA: ' + reasons.join('; ')}`);
  stepNo++;
  if (CONC !== LEVELS.at(-1)) await sleep(+a.pause * 1000);
}
w({ t: 'end', at: Date.now() });
