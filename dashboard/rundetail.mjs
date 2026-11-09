// Detalle de UNA corrida para el visor (visor.html): todas las series del generador y del agente en una sola
// rejilla de tiempo, más pasos completos, GC y resumen del log. Solo lee resultados/; nunca escribe allí.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const R = (x, d = 1) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const lines = (f) => readFileSync(f, 'utf8').split('\n').filter(Boolean);
const J = (l) => { try { return JSON.parse(l); } catch { return null; } };
export const safeName = (id) => id.replace(/[^A-Za-z0-9._-]+/g, '_');
export const DETAIL_VERSION = 'd3';

function pickBucket(durS) { for (const b of [1, 2, 5, 10, 15, 30, 60, 120]) if (durS / b <= 720) return b; return 300; }

// Acumulador por cubo: avg (media ponderada), max o sum.
function grid(nb) {
  const d = {};
  return {
    add(name, i, v, mode = 'avg', w = 1) {
      if (v == null || !isFinite(v) || i < 0 || i >= nb) return;
      const a = (d[name] ??= { mode, s: new Float64Array(nb), w: new Float64Array(nb), m: new Float64Array(nb).fill(-Infinity) });
      a.s[i] += v * w; a.w[i] += w; if (v > a.m[i]) a.m[i] = v;
    },
    out(name, dec = 1, scale = 1) {
      const a = d[name]; if (!a) return null;
      const o = new Array(nb); let any = false;
      for (let i = 0; i < nb; i++) { const v = a.mode === 'max' ? (a.w[i] ? a.m[i] : null) : a.mode === 'sum' ? (a.w[i] ? a.s[i] : null) : (a.w[i] ? a.s[i] / a.w[i] : null); o[i] = v == null ? null : R(v * scale, dec); if (o[i] != null) any = true; }
      return any ? o : null;
    },
    has: (n) => !!d[n], mode: (n) => d[n]?.mode, names: () => Object.keys(d),
  };
}

export function parseGc(logFile) {
  if (!existsSync(logFile)) return null;
  const ev = []; let warn = 0, err = 0; const msgs = new Map(); let total = 0;
  const gcRe = /^\[(\d+)ms\]\s+GC\((\d+)\)\s+(Pause [A-Za-z ()]*?)\s+(\d+)M->(\d+)M\((\d+)M\)\s+([\d.]+)ms/;
  const lvRe = /^\S+\s+(ERROR|WARN)\s+\d+\s+---\s+\[[^\]]*\]\s+(\S+)\s*:\s*(.*)$/;
  for (const l of readFileSync(logFile, 'utf8').split('\n')) {
    total++;
    if (l.charCodeAt(0) === 91) { const m = gcRe.exec(l); if (m && +m[1] > 1e12) ev.push({ t: +m[1], kind: m[3].trim(), before: +m[4], after: +m[5], cap: +m[6], ms: +m[7] }); continue; }
    const m = lvRe.exec(l); if (m) { if (m[1] === 'ERROR') err++; else warn++; const k = m[1] + ' ' + m[2].split('.').pop() + ': ' + m[3].replace(/\d{2,}/g, '#').slice(0, 160); msgs.set(k, (msgs.get(k) || 0) + 1); }
  }
  const top = [...msgs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => ({ msg: k, n }));
  return { ev, log: { lines: total, warn, err, top } };
}

export function buildDetail(dir, info) {
  const loadF = join(dir, 'load.ndjson'); if (!existsSync(loadF)) return null;
  let meta = null, seed = null, end = null; const steps = [], secs = [], marks = [];
  for (const l of lines(loadF)) {
    const o = J(l); if (!o) continue;
    if (o.t === 'meta') meta = o; else if (o.t === 'seed') seed = o; else if (o.t === 'step') steps.push(o); else if (o.t === 'sec') secs.push(o); else if (o.t === 'mark') marks.push(o); else if (o.t === 'end') end = o;
  }
  const samples = [], msamples = []; let machine = null, mongoinfo = null;
  const agentF = join(dir, 'agent.ndjson');
  if (existsSync(agentF)) for (const l of lines(agentF)) {
    const o = J(l); if (!o) continue;
    if (o.t === 's') samples.push(o); else if (o.t === 'm') msamples.push(o); else if (o.t === 'machine') machine = o; else if (o.t === 'mongoinfo') mongoinfo = o;
  }
  const gcInfo = parseGc(join(dir, 'app.log'));

  const startMarks = marks.filter((m) => m.ev === 'step-start');
  const origin = startMarks.length ? startMarks[0].at : secs.length ? secs[0].at : meta?.startedAtMs ?? samples[0]?.at ?? 0;
  const times = [...secs.map((s) => s.at), ...samples.map((s) => s.at), ...msamples.map((s) => s.at)];
  if (end?.at) times.push(end.at);
  if (!times.length) return null;
  const tmin = Math.min(...times), tmax = Math.max(...times);
  const durS = Math.max(1, (tmax - tmin) / 1000), B = pickBucket(durS), nb = Math.floor(durS / B) + 1;
  const ix = (at) => Math.floor((at - tmin) / (B * 1000));
  const G = grid(nb);

  // ---- generador (una fila por segundo)
  const stepArr = new Array(nb).fill(null), measArr = new Array(nb).fill(0);
  for (const s of secs) {
    const i = ix(s.at); if (i < 0 || i >= nb) continue;
    G.add('rps', i, s.n, 'sum'); G.add('sched', i, s.sched, 'sum'); G.add('errs', i, s.errs, 'sum'); G.add('inflight', i, s.inflight, 'max');
    G.add('rate', i, s.rate ?? s.workers, 'avg'); G.add('bytesIn', i, s.bytesIn, 'sum'); G.add('bytesOut', i, s.bytesOut, 'sum');
    if (s.lat?.n) { G.add('p50', i, s.lat.p50, 'avg', s.lat.n); G.add('p95', i, s.lat.p95, 'avg', s.lat.n); G.add('p99', i, s.lat.p99, 'max'); G.add('pmax', i, s.lat.max, 'max'); }
    stepArr[i] = s.step; if (s.measuring) measArr[i] = 1;
  }
  // ---- agente
  let ncores = 0, prevThr = null;
  for (const x of samples) {
    const i = ix(x.at); if (i < 0 || i >= nb) continue;
    const c = x.cpu || {};
    G.add('busy', i, c.busy); G.add('user', i, c.user); G.add('system', i, c.system); G.add('iowait', i, c.iowait); G.add('steal', i, c.steal);
    if (Array.isArray(c.cores)) { ncores = Math.max(ncores, c.cores.length); c.cores.forEach((v, k) => G.add('core' + k, i, v)); }
    const d = x.disk || {}; G.add('iops', i, d.iops); G.add('riops', i, d.readIops); G.add('wiops', i, d.writeIops); G.add('dmbs', i, d.mbs); G.add('dutil', i, d.util); G.add('dqueue', i, d.queue);
    G.add('rx', i, x.net?.rxMBs); G.add('tx', i, x.net?.txMBs);
    for (const [p, o] of [['app', x.app], ['mongo', x.mongo], ['gen', x.gen]]) {
      if (!o) continue;
      G.add(p + 'Cpu', i, o.cpu); G.add(p + 'Rss', i, o.rssMB); G.add(p + 'Mem', i, o.memCurrentMB); G.add(p + 'Thr', i, o.throttledMs);
      G.add(p + 'IoR', i, o.ioReadMBs); G.add(p + 'IoW', i, o.ioWriteMBs); G.add(p + 'Threads', i, o.threads);
    }
    if (x.cgroup?.throttledUsec != null) { if (prevThr != null && x.cgroup.throttledUsec >= prevThr) G.add('vmThr', i, (x.cgroup.throttledUsec - prevThr) / 1000, 'sum'); prevThr = x.cgroup.throttledUsec; }
    else if (x.cgroup?.throttledMs != null) G.add('vmThr', i, x.cgroup.throttledMs);
  }
  for (const x of msamples) {
    const i = ix(x.at); if (i < 0 || i >= nb) continue;
    for (const k of ['find', 'agg', 'qps', 'getmore', 'cmd', 'ins', 'upd', 'docsRet', 'docsExam', 'keysExam', 'readOps', 'cacheMB', 'missPct', 'readIntoMBs', 'conns']) G.add('m_' + k, i, x[k]);
    G.add('m_readLatUs', i, x.readLatUs);
  }
  // ---- GC
  let gcSummary = null;
  if (gcInfo?.ev.length) {
    for (const e of gcInfo.ev) { const i = ix(e.t); G.add('gcMs', i, e.ms, 'sum'); G.add('heapAfter', i, e.after, 'max'); G.add('heapBefore', i, e.before, 'max'); }
    const ev = gcInfo.ev, tot = ev.reduce((a, e) => a + e.ms, 0);
    gcSummary = { n: ev.length, full: ev.filter((e) => /Full/i.test(e.kind)).length, totalMs: R(tot, 1), maxMs: R(Math.max(...ev.map((e) => e.ms)), 2), spanS: R((ev[ev.length - 1].t - ev[0].t) / 1000, 0), heapCapMB: ev[ev.length - 1].cap, kinds: [...new Set(ev.map((e) => e.kind))].slice(0, 4) };
  }

  const num = (n, d = 1, sc = 1) => G.out(n, d, sc);
  const out = {
    ver: DETAIL_VERSION, id: info.id, B, n: nb, originMs: origin, tminMs: tmin, tmaxMs: tmax,
    t0: R((tmin - origin) / 1000, 2), // segundos de la primera cubeta relativos al inicio de la carga (negativo = reposo/siembra)
    ncores,
    g: {
      rps: num('rps', 2, 1 / B), sched: num('sched', 2, 1 / B), errs: num('errs', 2, 1 / B), inflight: num('inflight', 0), target: num('rate', 2),
      mbIn: num('bytesIn', 3, 1 / 1e6 / B), mbOut: num('bytesOut', 3, 1 / 1e6 / B),
      p50: num('p50', 2), p95: num('p95', 2), p99: num('p99', 2), pmax: num('pmax', 1),
      busy: num('busy'), user: num('user'), system: num('system'), iowait: num('iowait'), steal: num('steal'),
      iops: num('iops'), riops: num('riops'), wiops: num('wiops'), dmbs: num('dmbs', 3), dutil: num('dutil'), dqueue: num('dqueue', 2),
      rx: num('rx', 3), tx: num('tx', 3), vmThr: num('vmThr', 1, G.mode('vmThr') === 'sum' ? 1 / B : 1),
      appCpu: num('appCpu'), appRss: num('appRss'), appMem: num('appMem'), appThr: num('appThr', 1), appIoR: num('appIoR', 3), appIoW: num('appIoW', 3), appThreads: num('appThreads', 0),
      mongoCpu: num('mongoCpu'), mongoRss: num('mongoRss'), mongoMem: num('mongoMem'), mongoThr: num('mongoThr', 1), mongoIoR: num('mongoIoR', 3), mongoIoW: num('mongoIoW', 3), mongoThreads: num('mongoThreads', 0),
      genCpu: num('genCpu'), genRss: num('genRss'),
      m_find: num('m_find', 2), m_agg: num('m_agg', 2), m_qps: num('m_qps', 2), m_getmore: num('m_getmore', 2), m_cmd: num('m_cmd', 2), m_ins: num('m_ins', 2), m_upd: num('m_upd', 2),
      m_docsRet: num('m_docsRet', 0), m_docsExam: num('m_docsExam', 0), m_keysExam: num('m_keysExam', 0), m_cacheMB: num('m_cacheMB', 1), m_missPct: num('m_missPct', 2),
      m_readLatUs: num('m_readLatUs', 0), m_readIntoMBs: num('m_readIntoMBs', 3), m_conns: num('m_conns', 0),
      gcMs: num('gcMs', 2, 1 / B), heapAfter: num('heapAfter', 0), heapBefore: num('heapBefore', 0),
      step: stepArr, measuring: measArr,
    },
    cores: Array.from({ length: ncores }, (_, k) => num('core' + k, 0)),
    steps: steps.map((s) => {
      const st = startMarks.find((m) => m.step === s.step);
      return { ...s, _t: { start: R(((st?.at ?? s.measureFrom) - origin) / 1000, 2), from: R((s.measureFrom - origin) / 1000, 2), end: R((s.end - origin) / 1000, 2) } };
    }),
    marks: marks.map((m) => ({ ev: m.ev, step: m.step ?? null, t: R((m.at - origin) / 1000, 2) })),
    meta: meta ? { mode: meta.mode, profile: meta.profile, thresholds: meta.thresholds, levels: meta.levels ?? null, rates: meta.rates ?? null, seconds: meta.seconds ?? null, warm: meta.warm ?? null, startedAt: meta.startedAt ?? null, baseRttMs: meta.baseRttMs ?? null, node: meta.node ?? null } : null,
    seed: seed ? { users: seed.users, lobbies: seed.lobbies, seconds: seed.seconds, registroMs: seed.registroMs, loginMs: seed.loginMs, crearLobbyMs: seed.crearLobbyMs, baseRttMs: seed.baseRttMs } : null,
    ended: !!end, endT: end ? R((end.at - origin) / 1000, 1) : null,
    machine: machine ? Object.fromEntries(Object.entries(machine).filter(([k]) => k !== 't')) : null,
    mongoinfo: mongoinfo ? Object.fromEntries(Object.entries(mongoinfo).filter(([k]) => k !== 't')) : null,
    gc: gcSummary, log: gcInfo?.log ?? null, samples: { agent: samples.length, mongo: msamples.length, sec: secs.length },
  };
  const runF = join(dir, 'run.json');
  if (existsSync(runF)) {
    try {
      const r = JSON.parse(readFileSync(runF, 'utf8')); const drop = new Set(['dir', 'results', 'db', 'stamp', 'port', 'no-gc-log']);
      out.cfg = Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k)).map(([k, v]) => [k, k === 'jar' ? basename(String(v).replace(/\\/g, '/')) : v]));
    } catch {}
  }
  const idleF = join(dir, 'idle.json'); if (existsSync(idleF)) { try { out.idle = JSON.parse(readFileSync(idleF, 'utf8')); } catch {} }
  // quita series vacías para ahorrar bytes
  for (const k of Object.keys(out.g)) if (out.g[k] == null) delete out.g[k];
  out.cores = out.cores.filter(Boolean);
  return out;
}

export function sourceKey(dir) {
  const sz = (f) => { const p = join(dir, f); return existsSync(p) ? statSync(p).size : 0; };
  return [sz('load.ndjson'), sz('agent.ndjson'), sz('app.log'), sz('run.json'), DETAIL_VERSION].join('|');
}
