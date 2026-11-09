#!/usr/bin/env node
// Generador de TASA FIJA (modelo abierto): llegan λ peticiones por segundo, como proceso de Poisson, respondan o no.
// Es el generador principal de v3 (F5 rampa, F6 sostenida, F7 ×10, F8 larga).
//
// Por que asi y no por "usuarios": la tasa λ es la unica entrada y se expresa en req/s, la misma unidad que se mide.
// No hay duracion de sesion, pausa ni fraccion de usuarios que vuelven: ninguno de esos numeros sale de una medicion.
// Si hace falta hablar de usuarios, se convierte DESPUES con la ley de Little (activos = llegadas/s × duracion), declarada
// como conversion y no como entrada.
//
// Latencia medida desde la hora PROGRAMADA de cada peticion, no desde que el generador logro enviarla: si el servidor se
// atasca, las peticiones siguen llegando a su hora y su espera cuenta (evita la "omision coordinada", que en bucle cerrado
// esconde la cola). Tambien se guarda la latencia de servicio (desde el envio) y el retraso propio del generador: si el
// retraso p99 pasa de 50 ms, el generador no daba abasto y el nivel no vale (genOk=false).
// Timeouts y descartes (mas de --max-inflight en vuelo) cuentan como error con latencia = timeout, no se omiten.
//
// Uso: node rate.mjs --base http://host:8080 --profile mezcla-postman --rates 5,10,20 --seconds 600 --warm 30
//        [--timeout 10] [--max-inflight 4000] [--stop-after-fail 0] [--seed 1] [--users 20 --lobbies 200] --env x --out load.ndjson
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { add, summary } from './lib/hist.mjs';
import { client, makeOps, picker, rng, seed } from './lib/lobbylink.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: {
  base: { type: 'string', default: 'http://localhost:8080' }, profile: { type: 'string', default: 'mezcla-postman' },
  rates: { type: 'string', default: '10' }, seconds: { type: 'string', default: '600' }, warm: { type: 'string', default: '30' }, pause: { type: 'string', default: '15' },
  timeout: { type: 'string', default: '10' }, 'max-inflight': { type: 'string', default: '4000' }, 'stop-after-fail': { type: 'string', default: '0' },
  seed: { type: 'string', default: '1' }, users: { type: 'string', default: '20' }, lobbies: { type: 'string', default: '200' }, participants: { type: 'string', default: '1' },
  env: { type: 'string', default: 'desconocido' }, out: { type: 'string' } } });
const SECS = +a.seconds, WARM = +a.warm, TMO = +a.timeout * 1000, MAXINF = +a['max-inflight'], STOP = +a['stop-after-fail'];
const RATES = a.rates.split(',').map(Number);
const profile = JSON.parse(readFileSync(join(here, 'profiles', `${a.profile}.json`), 'utf8'));
const thr = JSON.parse(readFileSync(join(here, 'profiles/umbrales.json'), 'utf8'));
const OUT = a.out ?? `lobbylink_${a.env}_${a.profile}_rate.ndjson`;
const w = (o) => appendFileSync(OUT, JSON.stringify(o) + '\n');
writeFileSync(OUT, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { call, bytes } = client(a.base, TMO);
const ctx = await seed(call, { users: +a.users, lobbies: +a.lobbies, participants: +a.participants, run: Date.now().toString(36) });
w({ t: 'meta', mode: 'rate', env: a.env, profile, thresholds: thr, base: a.base, rates: RATES, seconds: SECS, warm: WARM, timeoutMs: TMO, maxInflight: MAXINF, seed: +a.seed,
  startedAt: new Date().toISOString(), startedAtMs: Date.now(), baseRttMs: ctx.info.baseRttMs, node: process.version });
w({ t: 'seed', ...ctx.info });
console.log('siembra', ctx.info);

const verdict = (lat, errorRate, p95Ms) => (lat != null && lat.p95 <= p95Ms && errorRate <= thr.errorRate);
let fails = 0, stepNo = 0;
for (const R of RATES) {
  const R1 = rng(+a.seed * 1000 + stepNo), R2 = rng(+a.seed * 7919 + stepNo);   // llegadas y operaciones con semilla: igual en todas las maquinas
  const OPS = makeOps(call, ctx, R2), pick = picker(profile.mix, R2);
  const wall0 = Date.now(), p0 = performance.now(), toWall = (p) => wall0 + (p - p0);
  const warmEndP = p0 + WARM * 1000, endP = warmEndP + SECS * 1000;
  w({ t: 'mark', ev: 'step-start', step: stepNo, rate: R, at: wall0, measureFrom: toWall(warmEndP), end: toWall(endP) });
  const hAll = {}, hSvc = {}, hLag = {}, hOp = {}, codes = {}, bytesOp = {};
  let sched = 0, n = 0, ok = 0, errs = 0, tmo = 0, drop = 0, inflight = 0, maxIn = 0, creates = 0;
  let sec = { h: {}, n: 0, errs: 0, sched: 0 }, last = bytes(), bStart = null, bEnd = null;
  const tick = setInterval(() => {
    const now = performance.now(), b = bytes();
    if (bStart == null && now >= warmEndP) bStart = b;
    if (bEnd == null && now >= endP) bEnd = b;
    w({ t: 'sec', step: stepNo, at: toWall(now), measuring: now > warmEndP && now <= endP, rate: R, sched: sec.sched, n: sec.n, errs: sec.errs, inflight, bytesIn: b[0] - last[0], bytesOut: b[1] - last[1], lat: summary(sec.h) });
    sec = { h: {}, n: 0, errs: 0, sched: 0 }; last = b;
  }, 1000);

  const pending = new Set();
  const record = (t, op, code, ms, svc, size) => {
    const meas = t >= warmEndP && t < endP, bad = code === 'ERR' || code === 'TIMEOUT' || code === 'DROP' || code >= 500;
    sec.n++; add(sec.h, ms); if (bad) sec.errs++;
    if (!meas) return;
    n++; if (bad) errs++; else ok++;
    if (code === 'TIMEOUT') tmo++; if (code === 'DROP') drop++;
    add(hAll, ms); add((hOp[op] ??= {}), ms); if (svc != null) add(hSvc, svc);
    const k = `${op}:${code}`; codes[k] = (codes[k] ?? 0) + 1;
    if (size != null) { (bytesOp[op] ??= [0, 0]); bytesOp[op][0] += size; bytesOp[op][1]++; }
  };
  const fire = (t) => {
    const op = pick(); sec.sched++; if (t >= warmEndP && t < endP) sched++;
    if (inflight >= MAXINF) { record(t, op, 'DROP', TMO, null, null); return; }
    inflight++; maxIn = Math.max(maxIn, inflight);
    const sent = performance.now(); if (t >= warmEndP && t < endP) add(hLag, Math.max(0, sent - t));
    const p = (async () => {
      let code = 'ERR', size = null;
      try { const r = await OPS[op](); code = r.status; size = r.bytes; if (op === 'create' && r.status < 300) creates++; }
      catch (e) { code = e?.name === 'TimeoutError' ? 'TIMEOUT' : 'ERR'; }
      const done = performance.now();
      record(t, op, code, code === 'TIMEOUT' ? TMO : done - t, done - sent, size);
      inflight--;
    })();
    pending.add(p); p.finally(() => pending.delete(p));
  };

  // reloj de llegadas: intervalos exponenciales (Poisson) de media 1/λ
  let next = p0;
  while (performance.now() < endP) {
    const now = performance.now();
    while (next <= now && next < endP) { fire(next); next += (-Math.log(1 - R1()) / R) * 1000; }
    await sleep(1);
  }
  await Promise.all([...pending]);   // las peticiones medidas que siguen en vuelo terminan (o caen por timeout)
  clearInterval(tick);
  const b = bEnd ?? bytes();
  const lat = summary(hAll), svc = summary(hSvc), lag = summary(hLag), errorRate = n ? errs / n : 1;
  const reasons = [];
  if (lat && lat.p95 > thr.p95Ms) reasons.push(`p95 ${lat.p95} ms > ${thr.p95Ms}`);
  if (errorRate > thr.errorRate) reasons.push(`errores ${(errorRate * 100).toFixed(2)} % > ${thr.errorRate * 100} %`);
  const genOk = !lag || lag.p99 <= 50;
  if (!genOk) reasons.push(`generador atrasado (retraso p99 ${lag.p99} ms > 50): este nivel no vale`);
  const passAt = Object.fromEntries((thr.sensibilidadP95Ms ?? [thr.p95Ms]).map((p) => [p, verdict(lat, errorRate, p)]));
  const byOp = Object.fromEntries(Object.entries(hOp).map(([k, h]) => [k, summary(h)]));
  const respBytes = Object.fromEntries(Object.entries(bytesOp).map(([k, [s, c]]) => [k, Math.round(s / c)]));
  const step = { t: 'step', mode: 'rate', step: stepNo, rate: R, workers: `${R}/s`, measureFrom: toWall(warmEndP), end: toWall(endP), seconds: SECS,
    offeredRps: +(sched / SECS).toFixed(2), requests: n, rps: +(ok / SECS).toFixed(2), achievedRatio: sched ? +(ok / sched).toFixed(3) : null,
    lat, latService: svc, genLag: lag, genOk, maxInflight: maxIn, timeouts: tmo, drops: drop, byOp, codes, respBytes,
    errors: errs, errorRate: +errorRate.toFixed(4), lobbiesStart: ctx.ids.length - creates, lobbiesNow: ctx.ids.length,
    mbInPerS: bStart ? +((b[0] - bStart[0]) / SECS / 1048576).toFixed(4) : null, mbOutPerS: bStart ? +((b[1] - bStart[1]) / SECS / 1048576).toFixed(4) : null,
    pass: reasons.length === 0, passAt, reasons };
  w(step);
  console.log(`[λ=${R}/s] ofrecidas ${step.offeredRps} logradas ${step.rps} req/s p50/p95/p99=${lat?.p50}/${lat?.p95}/${lat?.p99} ms err=${errs} (timeouts ${tmo}, descartes ${drop}) retraso gen p99=${lag?.p99} ms ${step.pass ? 'PASA' : 'NO PASA: ' + reasons.join('; ')}`);
  stepNo++;
  fails = step.pass ? 0 : fails + 1;
  if (STOP && fails >= STOP) { console.log(`corte: ${fails} niveles seguidos sin pasar (--stop-after-fail ${STOP})`); w({ t: 'mark', ev: 'stop-after-fail', at: Date.now() }); break; }
  if (R !== RATES.at(-1)) await sleep(+a.pause * 1000);
}
w({ t: 'end', at: Date.now() });
