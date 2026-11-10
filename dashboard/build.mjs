#!/usr/bin/env node
// Construye dashboard/data.js a partir de resultados/ (solo lee; nunca escribe en resultados/).
// Uso:  node dashboard/build.mjs            (usa dashboard/cache.json: solo reprocesa corridas nuevas o cambiadas)
//       node dashboard/build.mjs --no-cache
// En el PC con una campaña midiendo, correr con prioridad baja:
//   powershell -c "Start-Process node -ArgumentList 'dashboard/build.mjs' -PriorityClass Idle -Wait -NoNewWindow"
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { buildDetail, sourceKey, safeName } from './rundetail.mjs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const RES = join(ROOT, 'resultados');
const CACHE_FILE = join(here, 'cache.json');
const useCache = !process.argv.includes('--no-cache');
const cache = useCache && existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
const newCache = {};
// detalle por corrida para el visor: runs/<id>.js (carga perezosa); runs/_manifest.json evita recalcular lo que no cambió
const RUNS_DIR = join(here, 'runs'); mkdirSync(RUNS_DIR, { recursive: true });
const MANIFEST = join(RUNS_DIR, '_manifest.json');
const manifest = useCache && existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
const newManifest = {}; let detailWritten = 0;

const num = (s) => { if (s == null) return null; const m = String(s).replace(/\*/g, '').replace(/\./g, '').replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean);
const J = (l) => { try { return JSON.parse(l); } catch { return null; } };

// ---------------------------------------------------------------- entorno y jar a partir de nombres
function classifyEc2(label) { return { env: (label.includes('unl') || label.includes('pend') || label.includes('xmx')) ? 'ec2u' : 'ec2s', jar: label.includes('nplus1') ? 'fix' : label.includes('-thr') ? 'thr' : 'base', label }; }
function classifyLocal(dirName) {
  // 20261106_093157_windows_v3-f6-mezcla-lectura-r1  |  ..._docker_v3fix-a1m1-f1-list
  const m = dirName.match(/^\d{8}_\d{6}_(windows|docker)_(.+)$/); if (!m) return null;
  const tokens = m[2].split('-'); const tag = tokens[0];
  const pi = tokens.findIndex((t) => /^f\d+d?$/.test(t)); if (pi < 0) return null;
  const quota = (tokens.find((t) => /^a[\d.]+m[\d.]+$/.test(t))) || null;   // en F4 la cuota va después de la fase (v3-f4-a1m2); en las demás, antes (v3-a1m1-f1-list)
  return { env: m[1] === 'windows' ? 'pc' : 'docker', jar: /^v3fix/.test(tag) ? 'fix' : 'base', net: /net$/.test(tag), tag, quota, phaseIdx: pi, tokens };
}

// ---------------------------------------------------------------- una corrida
function summarizeRun(dir, info) {
  const loadF = join(dir, 'load.ndjson'); if (!existsSync(loadF)) return null;
  const agentF = join(dir, 'agent.ndjson');
  const key = dir + '|' + statSync(loadF).size + '|' + (existsSync(agentF) ? statSync(agentF).size : 0);
  if (cache[key]) { newCache[key] = cache[key]; return cache[key]; }

  let meta = null, seed = null, ended = false; const steps = []; const secs = [];
  for (const l of lines(loadF)) {
    const o = J(l); if (!o) continue;
    if (o.t === 'meta') meta = o; else if (o.t === 'seed') seed = o; else if (o.t === 'step') steps.push(o); else if (o.t === 'sec') secs.push(o); else if (o.t === 'end') ended = true;
  }
  // agente
  const samples = []; const msamples = []; let machine = null, mongoinfo = null;
  if (existsSync(agentF)) for (const l of lines(agentF)) {
    const o = J(l); if (!o) continue;
    if (o.t === 's') samples.push(o); else if (o.t === 'm') msamples.push(o); else if (o.t === 'machine') machine = o; else if (o.t === 'mongoinfo') mongoinfo = o;
  }
  // promedios por paso, en la ventana medida
  const avg = (arr, f) => { const v = arr.map(f).filter((x) => x != null && isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const mx = (arr, f) => { const v = arr.map(f).filter((x) => x != null && isFinite(x)); return v.length ? Math.max(...v) : null; };
  const outSteps = steps.map((s) => {
    const w = samples.filter((x) => x.at >= s.measureFrom && x.at <= s.end);
    const wm = msamples.filter((x) => x.at >= s.measureFrom && x.at <= s.end);
    const t0 = w.length ? w[0].cgroup?.throttledUsec : null, t1 = w.length ? w[w.length - 1].cgroup?.throttledUsec : null;
    return {
      step: s.step, rate: s.rate ?? null, workers: s.workers ?? null, seconds: s.seconds, offered: s.offeredRps ?? null, rps: s.rps, achievedRatio: s.achievedRatio ?? null,
      n: s.lat?.n, p50: s.lat?.p50, p95: s.lat?.p95, p99: s.lat?.p99, max: s.lat?.max,
      errors: s.errors, errorRate: s.errorRate, timeouts: s.timeouts ?? 0, pass: s.pass ?? null, passAt: s.passAt ?? null, genOk: s.genOk ?? null,
      genLagP99: s.genLag?.p99 ?? null, lobbiesStart: s.lobbiesStart ?? null, lobbiesNow: s.lobbiesNow ?? null, mbIn: s.mbInPerS ?? null, mbOut: s.mbOutPerS ?? null,
      byOp: s.byOp ? Object.fromEntries(Object.entries(s.byOp).map(([k, v]) => [k, { n: v.n, p50: v.p50, p95: v.p95 }])) : null,
      res: w.length ? {
        n: w.length, busy: r1(avg(w, (x) => x.cpu?.busy)), user: r1(avg(w, (x) => x.cpu?.user)), sys: r1(avg(w, (x) => x.cpu?.system)), iowait: r1(avg(w, (x) => x.cpu?.iowait)), steal: r1(avg(w, (x) => x.cpu?.steal)),
        app: r1(avg(w, (x) => x.app?.cpu)), mongo: r1(avg(w, (x) => x.mongo?.cpu)), gen: r1(avg(w, (x) => x.gen?.cpu)),
        appRss: r1(mx(w, (x) => x.app?.rssMB)), mongoRss: r1(mx(w, (x) => x.mongo?.rssMB)),
        iops: r1(avg(w, (x) => x.disk?.iops)), diskMbs: r2(avg(w, (x) => x.disk?.mbs)), diskUtil: r1(avg(w, (x) => x.disk?.util)),
        rx: r2(avg(w, (x) => x.net?.rxMBs)), tx: r2(avg(w, (x) => x.net?.txMBs)),
        thrApp: r1(avg(w, (x) => x.app?.throttledMs ?? x.cgroup?.throttledMs)), thrMongo: r1(avg(w, (x) => x.mongo?.throttledMs)),
        throttledMsPerS: t0 != null && t1 != null && w.length > 1 ? r1((t1 - t0) / 1000 / ((w[w.length - 1].at - w[0].at) / 1000)) : null,
        cacheMB: r1(avg(wm, (x) => x.cacheMB)), missPct: r2(avg(wm, (x) => x.missPct)), docsExam: r1(avg(wm, (x) => x.docsExam)),
      } : null,
    };
  });
  // serie temporal (cubos de 10 s) solo para fases de carga sostenida/rampa
  let series = null;
  const phase = info.phase;
  if (['f5', 'f6', 'f7', 'f7d', 'f8', 'f9', 'fm'].includes(phase) && secs.length) {
    const B = 10000; const t0 = secs[0].at; const buckets = new Map();
    const get = (i) => { if (!buckets.has(i)) buckets.set(i, { n: 0, errs: 0, p95w: 0, p95n: 0, rate: null, inflight: 0, k: 0, busy: [], steal: [], app: [], mongo: [], appRss: [], mongoRss: [], step: null, measuring: false }); return buckets.get(i); };
    for (const s of secs) { const b = get(Math.floor((s.at - t0) / B)); b.n += s.n || 0; b.errs += s.errs || 0; if (s.lat?.n) { b.p95w += s.lat.p95 * s.lat.n; b.p95n += s.lat.n; } b.rate = s.rate ?? b.rate; b.inflight = Math.max(b.inflight, s.inflight || 0); b.step = s.step; b.measuring = b.measuring || !!s.measuring; b.k++; }
    for (const x of samples) { if (x.at < t0) continue; const i = Math.floor((x.at - t0) / B); if (!buckets.has(i)) continue; const b = buckets.get(i); b.busy.push(x.cpu?.busy); b.steal.push(x.cpu?.steal); b.app.push(x.app?.cpu); b.mongo.push(x.mongo?.cpu); b.appRss.push(x.app?.rssMB); b.mongoRss.push(x.mongo?.rssMB); }
    const m = (a) => { const v = a.filter((z) => z != null); return v.length ? r1(v.reduce((p, q) => p + q, 0) / v.length) : null; };
    const idx = [...buckets.keys()].sort((a, b) => a - b);
    series = {
      t0, bucketS: B / 1000,
      t: idx.map((i) => i * B / 1000), rps: idx.map((i) => r1(buckets.get(i).n / (B / 1000 * 1))), rate: idx.map((i) => buckets.get(i).rate),
      p95: idx.map((i) => { const b = buckets.get(i); return b.p95n ? r1(b.p95w / b.p95n) : null; }), errs: idx.map((i) => r1(buckets.get(i).errs / (B / 1000))),
      inflight: idx.map((i) => buckets.get(i).inflight), step: idx.map((i) => buckets.get(i).step), measuring: idx.map((i) => (buckets.get(i).measuring ? 1 : 0)),
      busy: idx.map((i) => m(buckets.get(i).busy)), steal: idx.map((i) => m(buckets.get(i).steal)), app: idx.map((i) => m(buckets.get(i).app)), mongo: idx.map((i) => m(buckets.get(i).mongo)),
      appRss: idx.map((i) => m(buckets.get(i).appRss)), mongoRss: idx.map((i) => m(buckets.get(i).mongoRss)),
    };
  }
  const out = {
    ...info, startedAtMs: meta?.startedAtMs ?? null, mode: meta?.mode ?? null, profile: meta?.profile?.id ?? null, rates: meta?.rates ?? null, ended,
    seed: seed ? { users: seed.users, lobbies: seed.lobbies, registroMs: seed.registroMs, loginMs: seed.loginMs, crearLobbyMs: seed.crearLobbyMs, baseRttMs: seed.baseRttMs } : null,
    machine: machine ? { cpuModel: machine.cpuModel, logicalCpus: machine.logicalCpus, memTotalMB: machine.memTotalMB, os: machine.os, dmi: machine.dmi, cache: machine.cache } : null,
    mongo: mongoinfo ? { version: mongoinfo.version, cacheMaxMB: mongoinfo.cacheMaxMB } : null,
    endAt: steps.length ? steps[steps.length - 1].end : null,
    steps: outSteps, series,
  };
  // reposo
  const idleF = join(dir, 'idle.json'); if (existsSync(idleF)) { try { const i = JSON.parse(readFileSync(idleF, 'utf8')); out.idle = { cpuBusyPct: i.cpuBusyPct ?? null, appCpu: i.appCpu ?? null, mongoCpu: i.mongoCpu ?? null }; } catch {} }
  const runF = join(dir, 'run.json'); if (existsSync(runF)) { try { const r = JSON.parse(readFileSync(runF, 'utf8')); out.pinned = r.pinned ?? null; } catch {} }
  newCache[key] = out;
  return out;
}

// ---------------------------------------------------------------- tablas de los informes md
function parseTables(text) {
  const tables = []; let cur = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('|')) { const cells = l.split('|').slice(1, -1).map((c) => c.trim()); if (!cur) { cur = { header: cells, rows: [] }; tables.push(cur); } else if (cells.every((c) => /^:?-+:?$/.test(c))) { /* separador */ } else cur.rows.push(cells); }
    else cur = null;
  }
  return tables;
}
function parseModel(file) {
  const text = readFileSync(file, 'utf8'); const tables = parseTables(text);
  const f1t = tables.find((t) => t.header[0] === 'Endpoint');
  const xt = tables.find((t) => t.header[0] === 'Mezcla' && t.header.some((h) => h.startsWith('X_max')));
  const f2t = tables.find((t) => t.header[0] === 'Lobbies');
  const out = {};
  if (f1t) out.f1 = f1t.rows.map((r) => ({ endpoint: r[0].replace(/\s*\(.*\)/, ''), endpointFull: r[0], rps1: num(r[2]), app: num(r[3]), mongo: num(r[4]), total: num(r[5]), mongoPct: num(r[6]), io: num(r[7]), kb: num(r[8]), p50: num(r[9]), samples: num(r[10]) }));
  if (xt) out.xmax = xt.rows.map((r) => ({ mix: r[0], app: num(r[2]), mongo: num(r[3]), kb: num(r[4]), xmax: num(r[5]), first: r[6] }));
  if (f2t) out.f2 = f2t.rows.map((r) => ({ lobbies: num(r[0]), rps1: num(r[1]), app: num(r[2]), mongo: num(r[3]), total: num(r[4]), kb: num(r[5]), p50: num(r[6]) }));
  const ex = text.match(/pendiente log-log\)?:\s*\*\*([\d,]+)\*\*/); if (ex) out.exponent = num(ex[1]);
  const cap = text.match(/Capacidad usada:\s*([^\n]+)/); if (cap) out.capacity = cap[1].slice(0, 160);
  const hdr = text.match(/^# Modelo de costo · ([^\n]+)/m); if (hdr) out.hw = hdr[1];
  return out;
}
function parseAmdahl(file) {
  const text = readFileSync(file, 'utf8'); const parts = text.split(/^## Amdahl · perfil /m).slice(1); const out = [];
  for (const p of parts) {
    const prof = p.match(/^`([^`]+)`/)?.[1]; const t = parseTables(p)[0]; if (!t) continue;
    const pm = p.match(/Fracción paralela[^*]*\*\*p = ([\d,]+)\*\*/), ceil = p.match(/techo de Amdahl[^*]*\*\*([\d,]+)×\*\*/), smt = p.match(/Ganancia de SMT[^*]*\*\*(\d+) %\*\*/);
    out.push({ profile: prof, p: pm ? num(pm[1]) : null, ceiling: ceil ? num(ceil[1]) : null, smt: smt ? num(smt[1]) : null,
      rows: t.rows.map((r) => ({ workers: num(r[0]), rps: num(r[1]), S: num(r[2]), eff: num(r[3]), appCpu: num(r[6]), mongoCpu: num(r[7]), lat: r[5] })) });
  }
  return out;
}

// ---------------------------------------------------------------- recorrido
const runs = []; const models = {}; const sondas = {}; const machines = {};
function addRun(info, dir) {
  const r = summarizeRun(dir, info);
  if (!r) return;
  const file = safeName(r.id) + '.js', sk = sourceKey(dir);
  r.file = 'runs/' + file; r.dirRel = relative(ROOT, dir).split(sep).join('/');
  if (manifest[r.id] === sk && existsSync(join(RUNS_DIR, file))) newManifest[r.id] = sk;
  else {
    try {
      const d = buildDetail(dir, r);
      if (d) { writeFileSync(join(RUNS_DIR, file), 'window.RUNS=window.RUNS||{};window.RUNS[' + JSON.stringify(r.id) + ']=' + JSON.stringify(d) + ';\n'); newManifest[r.id] = sk; detailWritten++; }
    } catch (e) { console.error('detalle', r.id, e.message); }
  }
  runs.push(r);
  if (r.machine && !machines[r.env]) machines[r.env] = r.machine;
  if (r.mongo && !machines[r.env + '_mongo']) machines[r.env + '_mongo'] = r.mongo;
}

for (const name of readdirSync(RES)) {
  const full = join(RES, name); if (!statSync(full).isDirectory()) continue;
  if (name.startsWith('ec2_')) {
    if (name.endsWith('-descartado')) continue;
    const lab = name.slice(4); const c = classifyEc2(lab);
    for (const sub of readdirSync(full)) {
      const d = join(full, sub); if (!statSync(d).isDirectory()) continue;
      if (sub === 'f0') { const sf = join(d, 'sondas.json'); if (existsSync(sf)) { const s = JSON.parse(readFileSync(sf, 'utf8')); const ip = join(d, 'iperf.json'); if (existsSync(ip)) { try { const j = JSON.parse(readFileSync(ip, 'utf8')); s.iperfMbps = r1((j.end?.sum_received?.bits_per_second ?? j.end?.sum_sent?.bits_per_second ?? 0) / 1e6); } catch {} } sondas[c.env + '|' + c.jar] = s; } continue; }
      if (sub === '_logs') {
        const mf = join(d, 'modelo_ec2_f1.md'); if (existsSync(mf)) (models[c.env + '|' + c.jar] ??= {}).f1 = parseModel(mf);
        const df = join(d, 'datos_ec2_f2.md'); if (existsSync(df)) (models[c.env + '|' + c.jar] ??= {}).f2 = parseModel(df);
        const af = join(d, 'amdahl_ec2_f3.md'); if (existsSync(af)) (models[c.env + '|' + c.jar] ??= {}).amdahl = parseAmdahl(af);
        continue;
      }
      if (sub === 'cloudwatch') continue;
      const ph = sub.match(/^(f\d+d?)/); if (!ph) continue;
      addRun({ id: name + '/' + sub, env: c.env, jar: c.jar, label: lab, run: lab.includes('xmx') ? sub + '-xmx1g' : sub, phase: ph[1], quota: null, startedFolder: null }, d);
    }
    continue;
  }
  if (name.startsWith('_')) continue;
  const c = classifyLocal(name);
  if (!c) { // sondas
    const sm = name.match(/^\d{8}_\d{6}_(windows|docker)_sondas$/); if (sm) { const sf = join(full, 'sondas.json'); if (existsSync(sf)) sondas[(sm[1] === 'windows' ? 'pc' : 'docker') + '|base'] = JSON.parse(readFileSync(sf, 'utf8')); }
    continue;
  }
  const runName = c.tokens.slice(c.phaseIdx).join('-');
  addRun({ id: name, env: c.env, jar: c.jar, label: c.tag + (c.quota ? '-' + c.quota : ''), run: runName, phase: c.net ? 'fx' : c.tag === 'v3frec' ? 'fq' : c.tag === 'v3xmx' ? 'fm' : c.tokens[c.phaseIdx], quota: c.quota, startedFolder: name.slice(0, 15) }, full);
}
// informes md locales
const LOGS = join(RES, '_logs');
if (existsSync(LOGS)) for (const f of readdirSync(LOGS)) {
  const m = f.match(/^(modelo|datos|amdahl)_(windows|docker)_(v3|v3fix)(?:-(a[\d.]+m[\d.]+))?-f(\d)\.md$/); if (!m) continue;
  const env = m[2] === 'windows' ? 'pc' : 'docker', jar = m[3] === 'v3fix' ? 'fix' : 'base', k = env + '|' + jar; const full = join(LOGS, f);
  try { const o = (models[k] ??= {}); if (m[1] === 'modelo') o.f1 = parseModel(full); else if (m[1] === 'datos') o.f2 = parseModel(full); else o.amdahl = parseAmdahl(full); } catch (e) { console.error('md', f, e.message); }
}
// predicciones x10 (texto)
const predictions = [];
function scanPred(dir) { if (!existsSync(dir)) return; for (const f of readdirSync(dir)) if (/^prediccion_/.test(f)) predictions.push({ file: f, where: dir.replace(ROOT, '').replace(/\\/g, '/'), text: readFileSync(join(dir, f), 'utf8').slice(0, 6000) }); }
scanPred(LOGS); for (const n of readdirSync(RES)) if (n.startsWith('ec2_')) scanPred(join(RES, n, '_logs'));

// CloudWatch
const cloudwatch = {};
for (const [k, dirn] of [['ec2u', 'ec2_t3small-unl'], ['ec2s', 'ec2_t3small-std']]) {
  const d = join(RES, dirn, 'cloudwatch'); if (!existsSync(d)) continue; cloudwatch[k] = {};
  for (const f of readdirSync(d)) { if (!f.endsWith('.json')) continue; const arr = JSON.parse(readFileSync(join(d, f), 'utf8')); cloudwatch[k][f.replace('.json', '')] = arr.map((x) => ({ t: Date.parse(x.Timestamp), avg: r2(x.Average), max: r2(x.Maximum) })); }
}

// ---------------------------------------------------------------- extras: microbenchmarks, frecuencia por hilo, documentos
const readT = (f) => { try { return readFileSync(f, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); } catch { return null; } };
function parseMembench(text) {
  // bloques separados por líneas '--- título'; cada uno con series FREQ_GHZ_serie y/o tabla TAM_KB
  if (!text) return [];
  const body = text.includes('=====BENCH_BEGIN') ? text.slice(text.indexOf('=====BENCH_BEGIN'), text.indexOf('=====BENCH_END')) : text;
  const blocks = []; let cur = null;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r/g, '');
    if (/^---\s/.test(line)) { cur = { title: line.replace(/^---\s*/, '').trim(), freq: [], curve: [], rawFreq: [] }; blocks.push(cur); continue; }
    if (!cur) continue;
    const fm = line.match(/FREQ_GHZ_serie:\s*(.*)$/); if (fm) { const nums = (fm[1].match(/\d+\.\d+/g) || []).map(Number); if (nums.length) cur.rawFreq.push(nums); }
    const cm = line.match(/^(\d+)\s+(\d+\.\d+)\s*$/); if (cm) cur.curve.push([Number(cm[1]), Number(cm[2])]);
  }
  for (const b of blocks) { const all = b.rawFreq.flat(); b.freq = all.length ? { mean: r2(all.reduce((a, c) => a + c, 0) / all.length), min: r2(Math.min(...all)), max: r2(Math.max(...all)), n: all.length } : null; delete b.rawFreq; }
  return blocks.filter((b) => b.freq || b.curve.length);
}
const membench = {
  pc: parseMembench(readT(join(RES, '_microbench_ryzen_20261108', 'salida.txt'))),
  docker: parseMembench(readT(join(RES, '_microbench_docker_20261108', 'salida.txt'))),
  ec2: parseMembench(readT(join(RES, '_microbench_20261108', 'consola_membench_i-0ae9dc8ec7e042858.txt'))),
  pcPorHilo: [],
};
{ const t = readT(join(RES, '_microbench_ryzen_20261108', 'salida_por_hilo.txt')); if (t) for (const l of t.split('\n')) { const m = l.replace(/\r/g, '').match(/hilo (\d+):\s*FREQ_GHZ_serie:\s*(.*)$/); if (m) { const v = (m[2].match(/\d+\.\d+/g) || []).map(Number); membench.pcPorHilo.push({ hilo: Number(m[1]), ghz: v }); } } }

// frecuencia por hilo medida durante F1 (win-sampler)
const frecuencia = [];
{ const t = readT(join(LOGS, 'frecuencia_windows_f1_20261109.md')); if (t) {
  let run = null, lvl = null;
  for (const l of t.split('\n')) {
    const h2 = l.match(/^## (\S+)/); if (h2) { run = { run: h2[1], levels: [] }; frecuencia.push(run); continue; }
    const lv = l.match(/^Nivel (\d+) \((\d+) workers\): (\d+) muestras, frecuencia base informada (\d+) MHz/); if (lv && run) { lvl = { nivel: Number(lv[1]), workers: Number(lv[2]), muestras: Number(lv[3]), baseMHz: Number(lv[4]), hilos: [], ponderadaServidor: null }; run.levels.push(lvl); continue; }
    const row = l.match(/^\| (\d+) \| (sí|no) \| ([\d.,]+) \| ([\d.,]+) \| ([\d.,]+) \|/); if (row && lvl) { lvl.hilos.push({ hilo: Number(row[1]), servidor: row[2] === 'sí', busy: num(row[3]), mhz: num(row[4]), mhzW: num(row[5]) }); continue; }
    const sv = l.match(/frecuencia ponderada por ocupación ([\d.]+) MHz/); if (sv && lvl) lvl.ponderadaServidor = num(sv[1]);
  }
} }

// documentos crudos (md y txt cortos) para la pestaña “Documentos”
const docs = [];
const addDoc = (grupo, file, title) => { const t = readT(file); if (t == null) return; docs.push({ grupo, title: title || relative(RES, file).split(sep).join('/'), path: 'resultados/' + relative(RES, file).split(sep).join('/'), text: t.slice(0, 80000) }); };
for (const f of readdirSync(LOGS).sort()) if (f.endsWith('.md')) addDoc(/^prediccion/.test(f) ? 'Predicciones escritas antes de medir' : /^(modelo|datos|amdahl|validacion)/.test(f) ? 'Modelos y validaciones (PC y contenedor)' : 'Otros informes de corrida', join(LOGS, f));
for (const n of readdirSync(RES).sort()) { const d = join(RES, n); if (!statSync(d).isDirectory()) continue;
  if (n.startsWith('ec2_')) { const ld = join(d, '_logs'); if (existsSync(ld)) for (const f of readdirSync(ld).sort()) if (f.endsWith('.md')) addDoc(/^prediccion/.test(f) ? 'Predicciones escritas antes de medir' : 'EC2 · modelos y validaciones', join(ld, f)); }
  else if (/^_equivalencia/.test(n)) addDoc('Equivalencia del arreglo N+1', join(d, 'resultado.md'));
  else if (/^_microbench/.test(n)) { addDoc('Microbenchmarks de memoria y frecuencia', join(d, 'README.md')); }
  else if (/^_aws_/.test(n)) for (const f of readdirSync(d)) if (f.endsWith('.md')) addDoc('Costos y precios de AWS', join(d, f));
}
for (const n of readdirSync(RES)) if (n.startsWith('ec2_')) { const d = join(RES, n); for (const f of readdirSync(d)) if (f.endsWith('.md')) addDoc('EC2 · informes de corrida', join(d, f)); for (const sub of readdirSync(d)) { const sd = join(d, sub); if (statSync(sd).isDirectory() && sub !== '_logs') for (const f of readdirSync(sd)) if (/^(reporte|resumen).*\.md$/.test(f)) addDoc('EC2 · informes de corrida', join(sd, f)); } }
runs.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0));
const data = { generatedAt: new Date().toISOString(), runs, models, sondas, machines, predictions, cloudwatch, membench, frecuencia };
writeFileSync(join(here, 'docs.js'), 'window.DOCS = ' + JSON.stringify(docs) + ';\n');
writeFileSync(join(here, 'data.js'), 'window.DATA = ' + JSON.stringify(data) + ';\n');
writeFileSync(CACHE_FILE, JSON.stringify(newCache));
writeFileSync(MANIFEST, JSON.stringify(newManifest));
console.log(`dashboard/data.js: ${runs.length} corridas, ${Object.keys(models).length} modelos, ${Object.keys(sondas).length} sondas, ${predictions.length} predicciones, ${detailWritten} detalles de corrida escritos en dashboard/runs/`);
