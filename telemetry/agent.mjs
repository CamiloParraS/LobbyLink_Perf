#!/usr/bin/env node
// Agente de telemetria. Corre en la maquina del servidor, NO dentro de la app: solo lee contadores del sistema.
// Una linea NDJSON por muestra: {t:'s', at, cpu, disk, net, app, mongo, gen, cgroup?}. La CPU de cada proceso va en
// % de UN nucleo (100 = un nucleo completo); cpu.* es % de TODA la maquina.
//
//   --backend windows   contadores de rendimiento (win-sampler.ps1)            -> entorno "PC fisico" en Windows
//   --backend linux     /proc, /sys, cgroup v2                                  -> PC Linux o instancia EC2 (app nativa)
//   --backend docker    cgroup de cada contenedor via `docker exec` + /proc/stat de la VM -> entorno "Contenedor"
//
// Uso: node agent.mjs --backend linux --out agente.ndjson [--every 2] [--app-port 8080] [--gen-pidfile ruta]
//        [--containers app=lobbylink-app,mongo=lobbylink-mongo]   (solo docker)
//        [--mongo 127.0.0.1:27017 | off]   serverStatus de mongod (lineas {t:'m'}): consultas/s, docs devueltos/s, cache WiredTiger, latencia interna
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { cpus, hostname, release, totalmem } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mongoClient, pickStatus } from './lib/mongostat.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: {
  backend: { type: 'string' }, out: { type: 'string' }, every: { type: 'string', default: '2' },
  'app-port': { type: 'string', default: '8080' }, 'gen-pidfile': { type: 'string', default: '' },
  containers: { type: 'string', default: 'app=lobbylink-app,mongo=lobbylink-mongo' }, mongo: { type: 'string', default: '127.0.0.1:27017' } } });
if (!a.backend || !a.out) { console.error('Faltan --backend y --out'); process.exit(1); }
const EVERY = +a.every;
const r1 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 1000) / 1000);
const write = (o) => appendFileSync(a.out, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(a.out, '');

// ---------------- parsers de /proc y cgroup (sirven para linux y docker) ----------------
function parseStat(text) {
  const cores = []; let total = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu')) continue;
    const [name, ...v] = line.split(/\s+/); const [user, nice, system, idle, iowait, irq, softirq, steal] = v.map(Number);
    const row = { user: user + nice, system: system + irq + softirq, idle, iowait, steal: steal || 0 };
    if (name === 'cpu') total = row; else cores.push(row);
  }
  return { total, cores };
}
const sum = (r) => r.user + r.system + r.idle + r.iowait + r.steal;
function cpuPct(p, c) {
  const dt = sum(c) - sum(p) || 1; const pc = (k) => r1(((c[k] - p[k]) / dt) * 100);
  return { busy: r1(100 - ((c.idle - p.idle + c.iowait - p.iowait) / dt) * 100), user: pc('user'), system: pc('system'), iowait: pc('iowait'), steal: pc('steal'), idle: pc('idle') };
}
const coreBusy = (p, c) => c.map((row, i) => { const q = p[i]; const dt = sum(row) - sum(q) || 1; return r1(100 - ((row.idle - q.idle + row.iowait - q.iowait) / dt) * 100); });
function parseNet(text, skipLo = true) {
  let rx = 0, tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [n, rest] = line.split(':'); if (!rest) continue; if (skipLo && n.trim() === 'lo') continue;
    const f = rest.trim().split(/\s+/).map(Number); rx += f[0]; tx += f[8];
  }
  return { rx, tx };
}
function parseKV(text) { const o = {}; for (const l of text.split('\n')) { const [k, v] = l.split(' '); if (k && v !== undefined) o[k] = Number(v); } return o; }
// io.stat del cgroup v2: "8:0 rbytes=.. wbytes=.. rios=.. wios=.. ..."
function parseIo(text) { const o = { rbytes: 0, wbytes: 0, rios: 0, wios: 0 }; for (const l of text.split('\n')) for (const m of l.matchAll(/(rbytes|wbytes|rios|wios)=(\d+)/g)) o[m[1]] += Number(m[2]); return o; }
// diskstats: solo discos completos (sin particiones, loop ni ram). Sectores de 512 B.
function parseDisk(text) {
  let rios = 0, wios = 0, rsec = 0, wsec = 0, ms = 0;
  for (const l of text.split('\n')) { const f = l.trim().split(/\s+/); if (f.length < 14) continue; const n = f[2];
    if (/^(loop|ram|zram|sr|fd|dm-)/.test(n) || /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+)\d+$/.test(n) || /^(nvme\d+n\d+)p\d+$/.test(n) || /^mmcblk\d+p\d+$/.test(n)) continue;
    rios += +f[3]; rsec += +f[5]; wios += +f[7]; wsec += +f[9]; ms += +f[12]; }
  return { rios, wios, rbytes: rsec * 512, wbytes: wsec * 512, ms };
}

// ---------------- backend linux (app nativa) ----------------
const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
function findPids() {
  const out = { app: null, mongo: null };
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue; let exe; try { exe = basename(readlinkSync(`/proc/${d}/exe`)); } catch { exe = rd(`/proc/${d}/comm`)?.trim(); }
    const cmd = rd(`/proc/${d}/cmdline`)?.replaceAll('\0', ' ') ?? '';
    if (exe === 'java' && cmd.includes('-jar')) out.app ??= +d;
    if (exe === 'mongod') out.mongo ??= +d;
  }
  return out;
}
function readProc(pid) {
  if (!pid) return null; const st = rd(`/proc/${pid}/stat`); if (!st) return null;
  const f = st.slice(st.lastIndexOf(')') + 2).split(' '); const status = rd(`/proc/${pid}/status`) ?? ''; const io = rd(`/proc/${pid}/io`) ?? '';
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(status)?.[1] ?? 0);
  const ion = (k) => Number(new RegExp(`${k}: (\\d+)`).exec(io)?.[1] ?? 0);
  return { pid, ticks: +f[11] + +f[12], rssMB: r1(kb('VmRSS') / 1024), threads: kb('Threads'), rb: ion('read_bytes'), wb: ion('write_bytes') };
}
const rate = (cur, prev, dt, hz = 100) => (cur && prev && cur.pid === prev.pid ? {
  cpu: r1(((cur.ticks - prev.ticks) / hz / dt) * 100), rssMB: cur.rssMB, threads: cur.threads,
  ioReadMBs: r3((cur.rb - prev.rb) / dt / 1048576), ioWriteMBs: r3((cur.wb - prev.wb) / dt / 1048576) } : cur ? { cpu: null, rssMB: cur.rssMB, threads: cur.threads } : null);

async function linuxLoop() {
  let prev = null, pids = findPids(), tick = 0;
  while (true) {
    const now = Date.now(); const st = parseStat(rd('/proc/stat')); const net = parseNet(rd('/proc/net/dev')); const dk = parseDisk(rd('/proc/diskstats') ?? '');
    if (tick++ % 5 === 0) pids = findPids();
    const gp = a['gen-pidfile'] && existsSync(a['gen-pidfile']) ? +rd(a['gen-pidfile']) : null;
    const cur = { now, st, net, dk, app: readProc(pids.app), mongo: readProc(pids.mongo), gen: readProc(gp) };
    if (prev) {
      const dt = (now - prev.now) / 1000; const cg = rd('/sys/fs/cgroup/cpu.stat');
      write({ t: 's', at: now, cpu: { ...cpuPct(prev.st.total, st.total), cores: coreBusy(prev.st.cores, st.cores) },
        disk: { iops: r1((dk.rios + dk.wios - prev.dk.rios - prev.dk.wios) / dt), readIops: r1((dk.rios - prev.dk.rios) / dt), writeIops: r1((dk.wios - prev.dk.wios) / dt),
          mbs: r3((dk.rbytes + dk.wbytes - prev.dk.rbytes - prev.dk.wbytes) / dt / 1048576), util: r1(Math.min(100, ((dk.ms - prev.dk.ms) / (dt * 1000)) * 100)) },
        net: { rxMBs: r3((net.rx - prev.net.rx) / dt / 1048576), txMBs: r3((net.tx - prev.net.tx) / dt / 1048576) },
        app: rate(cur.app, prev.app, dt), mongo: rate(cur.mongo, prev.mongo, dt), gen: rate(cur.gen, prev.gen, dt),
        cgroup: cg ? { throttledUsec: parseKV(cg).throttled_usec ?? null } : null });
    }
    prev = cur; await sleep(EVERY * 1000);
  }
}

// ---------------- backend docker ----------------
const CT = Object.fromEntries(a.containers.split(',').map((s) => s.split('=')));
function dexec(name, script) {
  const r = spawnSync('docker', ['exec', name, 'sh', '-c', script], { encoding: 'utf8', timeout: 8000 });
  return r.status === 0 ? r.stdout : null;
}
const CG = 'for f in /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.stat /sys/fs/cgroup/io.stat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /proc/net/dev /proc/stat; do echo "##$f"; cat $f 2>/dev/null; done';
function readCt(name) {
  const t = dexec(name, CG); if (!t) return null; const sec = {};
  for (const part of t.split('##').slice(1)) { const nl = part.indexOf('\n'); sec[part.slice(0, nl).trim().split('/').pop()] = part.slice(nl + 1); }
  const cpu = parseKV(sec['cpu.stat'] ?? ''), mem = parseKV(sec['memory.stat'] ?? '');
  return { usec: cpu.usage_usec, thr: cpu.throttled_usec, nthr: cpu.nr_throttled, cur: Number(sec['memory.current']) , anon: mem.anon, file: mem.file,
    io: parseIo(sec['io.stat'] ?? ''), net: parseNet(sec['dev'] ?? '', true), stat: parseStat(sec['stat'] ?? ''), cpuMax: sec['cpu.max']?.trim(), memMax: sec['memory.max']?.trim() };
}
async function dockerLoop() {
  let prev = null;
  while (true) {
    const now = Date.now(); const cur = { now }; for (const [k, n] of Object.entries(CT)) cur[k] = readCt(n);
    if (prev && cur.app && prev.app) {
      const dt = (now - prev.now) / 1000;
      const proc = (k) => { const c = cur[k], p = prev[k]; if (!c || !p) return null; return { cpu: r1(((c.usec - p.usec) / 1e6 / dt) * 100), rssMB: r1(c.anon / 1048576), memCurrentMB: r1(c.cur / 1048576), cacheMB: r1(c.file / 1048576),
        throttledMs: r1((c.thr - p.thr) / 1000 / dt), ioReadMBs: r3((c.io.rbytes - p.io.rbytes) / dt / 1048576), ioWriteMBs: r3((c.io.wbytes - p.io.wbytes) / dt / 1048576),
        iops: r1((c.io.rios + c.io.wios - p.io.rios - p.io.wios) / dt), cpuMax: c.cpuMax, memMax: c.memMax }; };
      const app = proc('app'), mongo = proc('mongo');
      const dk = (k) => (cur[k] && prev[k] ? (cur[k].io.rios + cur[k].io.wios - prev[k].io.rios - prev[k].io.wios) / dt : 0);
      const mb = (k) => (cur[k] && prev[k] ? (cur[k].io.rbytes + cur[k].io.wbytes - prev[k].io.rbytes - prev[k].io.wbytes) / dt / 1048576 : 0);
      const nrx = (cur.app.net.rx - prev.app.net.rx) / dt / 1048576, ntx = (cur.app.net.tx - prev.app.net.tx) / dt / 1048576;
      write({ t: 's', at: now, vm: true, cpu: { ...cpuPct(prev.app.stat.total, cur.app.stat.total), cores: coreBusy(prev.app.stat.cores, cur.app.stat.cores) },
        disk: { iops: r1(dk('app') + dk('mongo')), mbs: r3(mb('app') + mb('mongo')), util: null }, net: { rxMBs: r3(nrx), txMBs: r3(ntx) }, // red del contenedor app (eth0): clientes + mongo
        app, mongo, gen: null, cgroup: { throttledMs: app?.throttledMs ?? null } });
    }
    prev = cur; await sleep(Math.max(0, EVERY * 1000 - (Date.now() - now)));
  }
}

// ---------------- backend windows ----------------
function windowsLoop() {
  const args = ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(here, 'win-sampler.ps1'), '-AppPort', a['app-port'], '-Every', String(EVERY)];
  if (a['gen-pidfile']) args.push('-GenPidFile', a['gen-pidfile']);
  const p = spawn('powershell', args, { stdio: ['ignore', 'pipe', 'inherit'] }); let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith('{')) { try { write({ t: 's', ...JSON.parse(line) }); } catch {} } } });
  process.on('SIGTERM', () => { p.kill(); process.exit(0); }); process.on('SIGINT', () => { p.kill(); process.exit(0); });
}

// ---------------- dentro de mongod: serverStatus (todos los backends) ----------------
// Contadores acumulados -> tasas por segundo. Lo que prueba cada campo:
//   qps / docsRet: consultas y documentos devueltos por segundo; divididos por req/s del generador dan consultas por peticion (N+1 => ~1 + lobbies por listado)
//   cacheMB / cacheMaxMB / missPct: si los datos caben en la cache de WiredTiger (RAM), las lecturas no van al disco (por eso IOPS ~ 0)
//   readLatUs: latencia media DENTRO de mongod por lectura (us); si es baja pero hay miles por segundo, el costo es el numero de consultas, no cada una
async function mongoLoop() {
  if (a.mongo === 'off') return;
  const [host, port] = a.mongo.split(':'); const cli = mongoClient(host, +(port || 27017));
  let prev = null, warned = false, info = false;
  while (true) {
    const t0 = Date.now();
    try {
      const s = await cli.command({ serverStatus: 1, $db: 'admin' }); const cur = { at: Date.now(), ...pickStatus(s) };
      if (!info) { write({ t: 'mongoinfo', version: s.version, host: s.host, storageEngine: s.storageEngine?.name, cacheMaxMB: r1(cur.cacheMax / 1048576) }); info = true; }
      if (prev) {
        const dt = (cur.at - prev.at) / 1000, d = (k) => (cur[k] != null && prev[k] != null ? (cur[k] - prev[k]) / dt : null);
        const req = cur.pagesRequested - prev.pagesRequested, miss = cur.pagesReadInto - prev.pagesReadInto, rops = cur.readOps - prev.readOps;
        write({ t: 'm', at: cur.at, find: r1(d('find')), agg: r1((d('aggregate') ?? 0) + (d('count') ?? 0)), qps: r1(d('query')), getmore: r1(d('getmore')), cmd: r1(d('command')), ins: r1(d('insert')), upd: r1(d('update')),
          docsRet: r1(d('docsReturned')), docsExam: r1(d('docsExamined')), keysExam: r1(d('keysExamined')),
          readLatUs: rops > 0 ? r1((cur.readLatUs - prev.readLatUs) / rops) : null, readOps: r1(rops / dt),
          cacheMB: r1(cur.cacheBytes / 1048576), cacheMaxMB: r1(cur.cacheMax / 1048576), missPct: req > 0 ? r3((miss / req) * 100) : null,
          readIntoMBs: r3(d('bytesReadInto') / 1048576), conns: cur.conns });
      }
      prev = cur; warned = false;
    } catch (e) { if (!warned) { console.error(`agente: serverStatus de ${a.mongo} fallo (${e.message}); reintentando`); warned = true; } prev = null; }
    await sleep(Math.max(0, EVERY * 1000 - (Date.now() - t0)));
  }
}

// ---------------- ficha de la maquina (primera linea) ----------------
function machine() {
  const m = { t: 'machine', backend: a.backend, hostname: hostname(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, memTotalMB: Math.round(totalmem() / 2 ** 20), node: process.version, platform: process.platform, release: release() };
  if (a.backend === 'linux') {
    m.os = /PRETTY_NAME="([^"]+)"/.exec(rd('/etc/os-release') ?? '')?.[1]; m.dmi = rd('/sys/devices/virtual/dmi/id/product_name')?.trim();
    m.cache = (rd('/sys/devices/system/cpu/cpu0/cache/index3/size') ?? '').trim(); m.cgroupCpuMax = rd('/sys/fs/cgroup/cpu.max')?.trim();
  } else if (a.backend === 'windows') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command', "$c=Get-CimInstance Win32_Processor;$o=Get-CimInstance Win32_OperatingSystem;\"$($c.Name)|$($c.NumberOfCores)|$($c.NumberOfLogicalProcessors)|$($c.MaxClockSpeed)|$($c.L2CacheSize)|$($c.L3CacheSize)|$($o.Caption) $($o.Version)\""], { encoding: 'utf8' }).stdout.trim().split('|');
    Object.assign(m, { cpuModel: r[0], physicalCores: +r[1], logicalCpus: +r[2], maxMHz: +r[3], l2KB: +r[4], l3KB: +r[5], os: r[6] });
  } else if (a.backend === 'docker') {
    m.docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}} | {{.OperatingSystem}} | CPUs={{.NCPU}} | Mem={{.MemTotal}}'], { encoding: 'utf8' }).stdout.trim();
    for (const [k, n] of Object.entries(CT)) { const c = readCt(n); m[`ct_${k}`] = c ? { cpuMax: c.cpuMax, memMax: c.memMax } : null; }
  }
  return m;
}
write(machine());
mongoLoop();
if (a.backend === 'linux') linuxLoop(); else if (a.backend === 'docker') dockerLoop(); else if (a.backend === 'windows') windowsLoop(); else { console.error('backend desconocido'); process.exit(1); }
