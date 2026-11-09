#!/usr/bin/env node
// Orquestador de UNA corrida completa y aislada. Crea resultados/<fecha>_<entorno>_<etiqueta>/ con
// load.ndjson (generador), agent.ndjson (telemetria), app.log y run.json (parametros y reparto de nucleos).
//
//   node telemetry/run.mjs --env windows --label f1-list --profile solo-list --workers 1 --seconds 120     bucle cerrado (load.mjs): F1 y F3
//   node telemetry/run.mjs --env windows --label f6 --profile mezcla-lectura --rates 5,10,20 --seconds 600  tasa fija (rate.mjs): F5-F8
//   node telemetry/run.mjs --env linux   ...      app nativa en Linux/EC2 (Mongo ya escuchando en :27017)
//   node telemetry/run.mjs --env docker  --app-cpus 1 --app-mem 1g --label docker-1cpu ...
//   node telemetry/run.mjs --env linux --server-only   solo app + agente (la carga se lanza desde OTRA maquina con load.mjs o rate.mjs)
//
// Opciones:
//   --rates <λ1,λ2,..>            tasa fija en req/s (rate.mjs); sin --rates se usa --workers (load.mjs)
//   --timeout <s> --stop-after-fail <n> --max-inflight <n>   (tasa fija) ver rate.mjs
//   --lobbies <n> / --users <n>   siembra (por defecto 200 / 20). El listado (N+1 doble) crece con los lobbies, no con los usuarios
//   --participants <P>          participantes por lobby (def. 1 = solo el creador); la siembra une P-1 usuarios a cada lobby (sube --users a P si hace falta)
//   --no-gc-log                no registrar el GC de la JVM (por defecto -Xlog:gc:stdout:timemillis va a app.log; report.mjs lo resume)
//   El agente lee serverStatus de mongod (127.0.0.1:27017; en docker 127.0.0.1:27018, publicado solo en loopback)
//
// Cada corrida usa una base de Mongo NUEVA: GET /api/lobbies recorre todos los lobbies, con la base acumulada el rendimiento cae.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(here, '..');
const { values: a } = parseArgs({ options: {
  env: { type: 'string' }, label: { type: 'string', default: 'base' }, profile: { type: 'string', default: 'solo-list' },
  workers: { type: 'string', default: '50' }, seconds: { type: 'string', default: '180' }, warm: { type: 'string', default: '30' }, pause: { type: 'string', default: '15' },
  jar: { type: 'string', default: resolve(ROOT, '../LobbyLink_backend/target/disenofinal-0.0.1-SNAPSHOT.jar') },
  'app-cpus': { type: 'string', default: '1' }, 'app-mem': { type: 'string', default: '1g' }, 'mongo-cpus': { type: 'string', default: '1' }, 'mongo-mem': { type: 'string', default: '1g' },
  'idle-seconds': { type: 'string', default: '20' }, 'no-pin': { type: 'boolean', default: false }, 'server-only': { type: 'boolean', default: false },
  rates: { type: 'string' }, seed: { type: 'string', default: '1' }, timeout: { type: 'string', default: '10' }, 'stop-after-fail': { type: 'string', default: '0' }, 'max-inflight': { type: 'string', default: '4000' }, 'java-opts': { type: 'string', default: '' }, port: { type: 'string', default: '8080' },
  lobbies: { type: 'string', default: '200' }, users: { type: 'string', default: '20' }, participants: { type: 'string', default: '1' }, 'no-gc-log': { type: 'boolean', default: false },
  'max-idle-cpu': { type: 'string', default: '5' }, 'strict-idle': { type: 'boolean', default: false }, // reposo: avisa si la CPU de la maquina supera el limite (%); --strict-idle cancela la corrida
  results: { type: 'string', default: 'resultados' } } }); // --results: subcarpeta de lobbylink_perfv3 (o ruta absoluta) donde se guarda la corrida (campañas nuevas no mezclan datos)
if (!['windows', 'linux', 'docker'].includes(a.env)) { console.error('--env debe ser windows, linux o docker'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const dir = join(resolve(ROOT, a.results), `${stamp}_${a.env}_${a.label}`); mkdirSync(dir, { recursive: true });
const db = `lobbylink_${a.label.replace(/\W/g, '')}_${stamp}`;
const GC_LOG = a['no-gc-log'] ? '' : '-Xlog:gc:stdout:timemillis'; // una linea por pausa de GC con marca en ms de epoch; costo despreciable
const base = `http://localhost:${a.port}`;
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${m}`);
const info = { ...a, stamp, db, dir, jarSize: existsSync(a.jar) ? readFileSync(a.jar).length : null, pinned: {} };
const children = [];
const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout.trim();
const kill = (c) => { try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F']); else process.kill(c.pid, 'SIGTERM'); } catch {} };
async function waitUp(url, tries = 90) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return; } catch {} await sleep(1000); } throw new Error(`la app no respondio en ${url}`); }
function pin(pid, mask, what) {
  if (a['no-pin'] || process.platform !== 'win32' || !pid) return;
  const r = ps(`try{(Get-Process -Id ${pid}).ProcessorAffinity=${mask};'ok'}catch{'FALLO: '+$_.Exception.Message}`);
  info.pinned[what] = `${r} (mascara 0x${mask.toString(16)})`; log(`afinidad ${what}: ${info.pinned[what]}`);
}
const logicalCpus = Number(spawnSync('node', ['-p', 'require("os").cpus().length'], { encoding: 'utf8' }).stdout) || 8;
const srvMask = (1 << Math.floor(logicalCpus * 2 / 3)) - 1, genMask = ((1 << logicalCpus) - 1) & ~srvMask; // 2/3 de los hilos para app+mongo, el resto para el generador
info.srvMask = srvMask; info.genMask = genMask;

let stopApp = async () => {};
try {
  // ---------- 1. arrancar la app contra una base nueva ----------
  if (a.env === 'docker') {
    const env = { ...process.env, APP_CPUS: a['app-cpus'], APP_MEM: a['app-mem'], MONGO_CPUS: a['mongo-cpus'], MONGO_MEM: a['mongo-mem'], DB: db, JAVA_TOOL_OPTIONS: GC_LOG, JAR_DIR: dirname(a.jar), JAR_NAME: a.jar.split(/[\\/]/).pop() };
    log(`docker compose up (app ${a['app-cpus']} CPU / ${a['app-mem']}, mongo ${a['mongo-cpus']} CPU / ${a['mongo-mem']}, db ${db})`);
    spawnSync('docker', ['compose', '-f', join(ROOT, 'envs/compose.yml'), 'down', '-v'], { env, stdio: 'ignore' });
    const up = spawnSync('docker', ['compose', '-f', join(ROOT, 'envs/compose.yml'), 'up', '-d', '--force-recreate'], { env, encoding: 'utf8' });
    if (up.status !== 0) throw new Error('docker compose up fallo: ' + up.stderr);
    stopApp = async () => { writeFileSync(join(dir, 'app.log'), spawnSync('docker', ['logs', 'lobbylink-app'], { encoding: 'utf8' }).stdout ?? ''); spawnSync('docker', ['compose', '-f', join(ROOT, 'envs/compose.yml'), 'down', '-v'], { env, stdio: 'ignore' }); };
  } else {
    if (!existsSync(a.jar)) throw new Error(`no existe el jar ${a.jar}; compila con mvnw clean package`);
    const out = openSync(join(dir, 'app.log'), 'a');
    const app = spawn('java', [...(GC_LOG ? [GC_LOG] : []), ...a['java-opts'].split(' ').filter(Boolean), '-jar', a.jar, `--spring.data.mongodb.database=${db}`, `--server.port=${a.port}`], { stdio: ['ignore', out, out], windowsHide: true });
    children.push(app); stopApp = async () => {};
  }
  await waitUp(`${base}/api/videojuegos`); log('app lista');

  // ---------- 2. fijar nucleos (Windows) ----------
  if (a.env === 'windows') {
    const appPid = Number(ps(`(Get-NetTCPConnection -LocalPort ${a.port} -State Listen | Select-Object -First 1).OwningProcess`));
    info.appPid = appPid; pin(appPid, srvMask, 'java'); pin(Number(ps('(Get-Process mongod | Select-Object -First 1).Id')), srvMask, 'mongod');
  }

  // ---------- 3. agente ----------
  const backend = a.env;
  const genPidFile = join(dir, 'gen.pid'); if (existsSync(genPidFile)) unlinkSync(genPidFile);
  const agentOut = join(dir, 'agent.ndjson');
  const agent = spawn('node', [join(here, 'agent.mjs'), '--backend', backend, '--out', agentOut, '--app-port', a.port, '--gen-pidfile', genPidFile, '--every', a.env === 'windows' ? '2' : '1', '--mongo', a.env === 'docker' ? '127.0.0.1:27018' : '127.0.0.1:27017'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  children.push(agent); log(`agente ${backend} -> ${agentOut}`);
  writeFileSync(join(dir, 'run.json'), JSON.stringify(info, null, 2));

  if (a['server-only']) {
    log(`MODO SERVIDOR: lanza la carga desde otra maquina:  node telemetry/load.mjs --base http://<IP>:${a.port} --env ${a.label} --workers ${a.workers} --seconds ${a.seconds} --out load.ndjson`);
    log('Ctrl+C para terminar (el agente deja agent.ndjson).'); await new Promise((r) => process.on('SIGINT', r));
  } else {
    log(`reposo ${a['idle-seconds']} s (consumo sin nadie)`); await sleep(+a['idle-seconds'] * 1000);
    const idle = { from: Date.now() - +a['idle-seconds'] * 1000, to: Date.now() };
    // Control de reposo: si la maquina ya esta ocupada antes de la carga (otros programas), la medicion se contamina.
    try {
      const S = readFileSync(agentOut, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter((x) => x && x.t === 's' && x.at >= idle.from && x.at <= idle.to && x.cpu?.busy != null);
      const mean = (f) => S.length ? +(S.reduce((p, q) => p + (f(q) ?? 0), 0) / S.length).toFixed(1) : null;
      idle.samples = S.length; idle.cpuBusyPct = mean((x) => x.cpu.busy); idle.maxCpuBusyPct = S.length ? Math.max(...S.map((x) => x.cpu.busy)) : null;
      idle.appCpu = mean((x) => x.app?.cpu); idle.mongoCpu = mean((x) => x.mongo?.cpu); idle.limitPct = +a['max-idle-cpu']; idle.clean = idle.cpuBusyPct != null && idle.cpuBusyPct <= idle.limitPct;
      if (idle.cpuBusyPct == null) log('AVISO: sin muestras del agente en el reposo; no se pudo controlar la CPU ocupada');
      else if (!idle.clean) {
        log(`AVISO: CPU de la maquina en reposo ${idle.cpuBusyPct} % (limite ${idle.limitPct} %; app ${idle.appCpu} %, mongod ${idle.mongoCpu} % de un nucleo): hay otros programas usando la maquina`);
        if (a['strict-idle']) throw new Error(`reposo sucio (${idle.cpuBusyPct} % > ${idle.limitPct} %): corrida cancelada por --strict-idle; cierra otros programas y repite`);
      } else log(`reposo limpio: CPU de la maquina ${idle.cpuBusyPct} % (limite ${idle.limitPct} %)`);
    } finally { writeFileSync(join(dir, 'idle.json'), JSON.stringify(idle)); }
    // ---------- 4. carga ----------
    const common = ['--base', base, '--profile', a.profile, '--users', a.users, '--lobbies', a.lobbies, '--participants', a.participants, '--seconds', a.seconds, '--warm', a.warm, '--pause', a.pause, '--env', `${a.env}-${a.label}`, '--out', join(dir, 'load.ndjson')];
    const loadArgs = a.rates
      ? [join(here, 'rate.mjs'), ...common, '--rates', a.rates, '--seed', a.seed, '--timeout', a.timeout, '--stop-after-fail', a['stop-after-fail'], '--max-inflight', a['max-inflight']]
      : [join(here, 'load.mjs'), ...common, '--workers', a.workers];
    const load = spawn('node', loadArgs, { stdio: ['ignore', openSync(join(dir, 'load.txt'), 'a'), openSync(join(dir, 'load.err'), 'a')], windowsHide: true });
    writeFileSync(genPidFile, String(load.pid)); pin(load.pid, genMask, 'generador');
    log(a.rates ? `carga a tasa fija: perfil ${a.profile}, λ = ${a.rates} req/s, ${a.seconds} s por nivel (+${a.warm} s)` : `carga: perfil ${a.profile}, workers ${a.workers}, ${a.seconds} s por nivel (+${a.warm} s de calentamiento)`);
    await new Promise((r) => load.on('exit', r));
    log('carga terminada'); await sleep(3000);
  }
} catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
finally {
  for (const c of children.reverse()) kill(c);
  await stopApp();
  log(`Carpeta: ${dir}`);
  try { process.stdout.write(readFileSync(join(dir, 'load.txt'), 'utf8').split('\n').slice(-8).join('\n')); } catch {}
}
