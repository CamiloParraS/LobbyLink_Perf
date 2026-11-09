#!/usr/bin/env node
// Convierte carpetas de corrida (load.ndjson + agent.ndjson) en tablas Markdown con las metricas del enunciado.
// Uso: node telemetry/report.mjs resultados/<corrida> [resultados/<otra> ...] > resultados/RESULTADOS.md
// Para una corrida cuyo agente estuvo en otra maquina (nube): node report.mjs --load load.ndjson --agent agent.ndjson [--applog app.log]
// Secciones para la sustentacion:
//   - carga ofrecida vs lograda (sesiones): "¿por que ese numero?" -> mientras real/ofrecida ~ 1, el req/s lo fija la carga, no la maquina
//   - demanda de CPU por peticion y cota X_max = nucleos / D (ley de utilizacion): predice el techo y dice que recurso se agota primero
//   - dentro de mongod (serverStatus): consultas por peticion (N+1), cache WiredTiger (por que el disco no se usa), latencia interna
//   - GC de la JVM (app.log con -Xlog:gc): separa "falta CPU" de "falta heap"
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';

const f = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('es-CO', { maximumFractionDigits: d }));
const pm = (xs, d = 1) => (xs.length ? `${f(xs.reduce((s, x) => s + x, 0) / xs.length, d)} / ${f(Math.max(...xs), d)}` : '–');
const lat = (o) => (o ? `${f(o.p50)} / ${f(o.p95)} / ${f(o.p99)}` : '–');
const nd = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const get = (s, path) => path.split('.').reduce((o, k) => o?.[k], s);

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const popcount = (n) => n.toString(2).replace(/0/g, '').length;
const quota = (s) => { if (!s || s.startsWith('max')) return null; const [q, p] = s.split(' ').map(Number); return q / p; }; // cpu.max "100000 100000" -> 1 CPU

// Nucleos disponibles para el servidor en cada entorno (para la cota X_max = nucleos / D).
function capacity(mach, run, w) {
  if (mach?.backend === 'docker') {
    const x = w.find((s) => s.app?.cpuMax || s.mongo?.cpuMax), vm = mach.logicalCpus;
    return { split: true, app: quota(x?.app?.cpuMax) ?? vm, mongo: quota(x?.mongo?.cpuMax) ?? vm, note: 'cuota CFS de cada contenedor' };
  }
  if (mach?.backend === 'windows' && run?.srvMask) {
    const ok = (k) => /^ok/.test(run.pinned?.[k] ?? ''), pinned = ok('java') && ok('mongod');
    const pool = pinned ? popcount(run.srvMask) : mach.logicalCpus, phys = mach.physicalCores ? (pinned ? pool / 2 : mach.physicalCores) : null;
    return { split: false, pool, phys, note: pinned ? `${pool} hilos fijados (app + mongod)` : `mongod sin afinidad: ${pool} hilos lógicos (incluye los del generador)` };
  }
  return { split: false, pool: mach?.logicalCpus, phys: null, note: `${mach?.logicalCpus ?? '?'} vCPU de la máquina` };
}

// Carga ofrecida por el modelo de sesiones (lo que el generador pide si el servidor respondiera al instante).
// Peticiones por sesion = registro (registerRatio) + login + listar + crear (createRatio) + unirse + acciones (sesion / pausa).
// Duracion real = sesion + una pausa (la ultima pausa se completa antes de mirar el reloj). X_ofrecida = activos x peticiones / duracion.
function offered(meta, users) {
  if (meta?.offeredRps != null) return meta.offeredRps;           // v6: lo calcula el generador (incluye modelo abierto y token)
  const F = meta?.profile?.flow; if (!F || !users) return null;
  const S = meta.sessionSec ?? F.sessionMeanSec, T = F.thinkMeanSec, cr = meta.profile.createRatio ?? F.createRatio;
  return (users * (F.registerRatio + 3 + cr + S / T)) / (S + T);
}

// Pausas de GC de la JVM a partir de -Xlog:gc:stdout:timemillis ("[1762330000000ms] GC(3) Pause Young (...) 51M->12M(254M) 4.123ms")
function gcLog(text) {
  const ev = []; let algo = null;
  for (const raw of text.split('\n')) {
    const l = raw.trim(), u = /\] Using (\w[\w ]*)$/.exec(l); if (u && !algo) algo = u[1];
    const m = /^\[(\d+)ms\] GC\(\d+\) (Pause .*?) (\d+)([KMG])->(\d+)([KMG])\((\d+)([KMG])\) ([\d.]+)ms/.exec(l);
    if (m) { const mb = (v, k) => +v * (k === 'K' ? 1 / 1024 : k === 'G' ? 1024 : 1); ev.push({ at: +m[1], kind: m[2], after: mb(m[5], m[6]), cap: mb(m[7], m[8]), ms: +m[9] }); }
  }
  return { algo, ev };
}

let targets = [];
const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { load: { type: 'string' }, agent: { type: 'string' }, applog: { type: 'string' } } });
const txt = (p) => (p && existsSync(p) ? readFileSync(p, 'utf8') : '');
if (o.load) targets = [{ name: basename(o.load), load: nd(o.load), agent: nd(o.agent ?? ''), appLog: txt(o.applog), dir: null }];
else targets = positionals.map((d) => ({ name: basename(d), load: nd(join(d, 'load.ndjson')), agent: nd(join(d, 'agent.ndjson')), appLog: txt(join(d, 'app.log')), dir: d }));
if (!targets.length) { console.error('Uso: node report.mjs <carpeta-de-corrida> ...'); process.exit(1); }

const out = [];
for (const r of targets) {
  const meta = r.load.find((x) => x.t === 'meta'), seed = r.load.find((x) => x.t === 'seed'), steps = r.load.filter((x) => x.t === 'step');
  const mach = r.agent.find((x) => x.t === 'machine'), samples = r.agent.filter((x) => x.t === 's');
  const mInfo = r.agent.find((x) => x.t === 'mongoinfo'), mSamples = r.agent.filter((x) => x.t === 'm');
  const run = r.dir && existsSync(join(r.dir, 'run.json')) ? JSON.parse(readFileSync(join(r.dir, 'run.json'), 'utf8')) : null;
  out.push(`## ${meta?.env ?? r.name} · perfil \`${meta?.profile?.id}\``, '');
  out.push(`Carpeta \`${r.name}\` · ${mach ? `${mach.cpuModel?.trim()} · ${mach.logicalCpus} hilos · ${f(mach.memTotalMB / 1024, 1)} GB · ${mach.os ?? ''} · agente \`${mach.backend}\`` : 'sin agente'} · RTT base ${f(meta?.baseRttMs)} ms`);
  if (mach?.docker) out.push(`Docker: ${mach.docker} · limites: app ${JSON.stringify(mach.ct_app)}, mongo ${JSON.stringify(mach.ct_mongo)}`);
  if (run?.pinned && Object.keys(run.pinned).length) out.push(`Afinidad de CPU: ${Object.entries(run.pinned).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
  if (mInfo) out.push(`MongoDB ${mInfo.version} (${mInfo.storageEngine}), caché WiredTiger configurada ${f(mInfo.cacheMaxMB, 0)} MB`);
  if (meta?.profile?.mode === 'sessions') {
    const th = meta.thresholds;
    const P = meta.profile;
    out.push(P.model === 'open'
      ? `Modelo ABIERTO: llegadas y salidas con horario fijo (la carga ofrecida no baja si el servidor se atasca); ${f(P.resumeRatio * 100, 0)} % vuelve con token sin login; registro/login con ${P.retries} reintentos (${P.retryWaitSec?.join('–')} s) y luego se rinde.`
      : 'Modelo de puestos (cerrado por usuario): la siguiente sesión empieza cuando termina la anterior; una sesión fallida reintenta con un login nuevo.');
    out.push(`Carga por sesiones: ${meta.profile.plan.users} usuarios activos, ${f(meta.arrivalPerSec, 2)} llegadas/s, sesión media ${meta.sessionSec} s. Llegada + estabilización ${meta.warm} s (no se mide) + ${meta.seconds} s medidos. Umbral (menos RTT base): p95 listar ≤ ${th.listP95} ms, ver/unirse/crear ≤ ${th.restP95} ms, login/registro ≤ ${th.loginP95} ms, errores ≤ ${th.errorRate * 100} %.`, '');
  } else out.push(`Por nivel: ${meta?.warm} s de calentamiento descartados + ${meta?.seconds} s medidos. Umbral: p95 ≤ ${meta?.thresholds?.p95Ms} ms y errores ≤ ${meta?.thresholds?.errorRate * 100} %.`, '');
  if (seed) out.push(`Latencia base de siembra (1 cliente, sin contención): registro ${f(seed.registroMs)} ms · login ${f(seed.loginMs)} ms · crear lobby ${f(seed.crearLobbyMs)} ms.`, '');

  // reposo
  if (r.dir && existsSync(join(r.dir, 'idle.json'))) {
    const idle = JSON.parse(readFileSync(join(r.dir, 'idle.json'), 'utf8')), s = samples.filter((x) => x.at >= idle.from && x.at <= idle.to);
    if (s.length) out.push(`Reposo (${s.length} muestras): CPU máquina ${pm(s.map((x) => x.cpu?.busy).filter((v) => v != null))} %, RSS app ${pm(s.map((x) => x.app?.rssMB).filter((v) => v != null), 0)} MB, RSS mongod ${pm(s.map((x) => x.mongo?.rssMB).filter((v) => v != null), 0)} MB.`, '');
  }

  out.push('### Rendimiento', '', '| Workers | Resultado | req/s | p50 / p95 / p99 (ms) | máx (ms) | 5xx+red | Códigos | Motivo |', '|---|---|---|---|---|---|---|---|');
  for (const s of steps) out.push(`| ${s.workers} | ${s.pass ? '✓ pasa' : '✕ no pasa'} | ${f(s.rps)} | ${lat(s.lat)} | ${f(s.lat?.max)} | ${s.errors} | ${Object.entries(s.codes).map(([k, v]) => `${k}×${v}`).join(' ')} | ${s.reasons.join('; ') || '–'} |`);
  out.push('');

  if (steps.some((s) => s.mode === 'rate')) {
    const sens = meta?.thresholds?.sensibilidadP95Ms ?? [];
    out.push('### Tasa fija: carga ofrecida vs lograda y validez del generador', '', `| λ (req/s) | Ofrecidas | Logradas (2xx-4xx) | lograda/ofrecida | Timeouts | Descartes | Máx. en vuelo | p95 de servicio (ms) | Retraso del generador p99 (ms) | ${sens.map((p) => `Pasa con p95 ≤ ${p}`).join(' | ')} |`, `|---|---|---|---|---|---|---|---|---|${sens.map(() => '---').join('|')}|`);
    for (const s of steps) out.push(`| ${s.rate} | ${f(s.offeredRps)} | ${f(s.rps)} | ${f(s.achievedRatio, 3)} | ${s.timeouts} | ${s.drops} | ${s.maxInflight} | ${f(s.latService?.p95)} | ${f(s.genLag?.p99)}${s.genOk ? '' : ' ⚠'} | ${sens.map((p) => (s.passAt?.[p] ? 'sí' : 'no')).join(' | ')} |`);
    out.push('', 'La latencia de las tablas se mide desde la hora programada de cada petición (incluye la espera en cola aunque el generador no hubiera podido enviarla aún) y cuenta los timeouts con latencia = timeout. Mientras lograda/ofrecida ≈ 1 la máquina sigue la carga; donde baja, se saturó. Retraso del generador p99 > 50 ms (⚠): el generador no daba abasto y ese nivel no vale. Las columnas "Pasa con p95 ≤ …" muestran si la conclusión depende del requisito de latencia elegido.', '');
    if (steps.some((s) => s.lobbiesNow !== s.lobbiesStart)) out.push(`Crecimiento de datos durante la corrida (la mezcla crea lobbies): ${steps.map((s) => `${s.rate}/s: ${s.lobbiesStart} → ${s.lobbiesNow}`).join(' · ')}.`, '');
  }
  if (steps.some((s) => s.mode === 'sessions')) {
    out.push('### Sesiones: carga ofrecida vs lograda, timeouts y crecimiento de datos', '', '| Activos | Semilla | Llegadas/s teóricas | reales | real/teórica | Timeouts | p50 / p95 / p99 con timeouts (ms) | Lobbies inicio → fin |', '|---|---|---|---|---|---|---|---|');
    for (const s of steps) out.push(`| ${s.users} | ${s.seed ?? '–'} | ${f(s.arrivalPerSec, 2)} | ${f(s.entriesPerSec, 2)} | ${f(s.arrivalRatio, 2)} | ${s.timeouts ?? '–'} (${f((s.timeoutRate ?? 0) * 100, 2)} %) | ${lat(s.latWithTimeouts)} | ${s.lobbiesStart ?? '–'} → ${s.lobbiesEnd ?? '–'} |`);
    out.push('', 'real/teórica < 1: el servidor no sigue la carga (las sesiones se alargan); es la señal de saturación. Los percentiles "con timeouts" cuentan cada timeout con latencia = tiempo máximo, evitando el sesgo de omitir las peticiones más lentas.', '');
    out.push('### Carga ofrecida vs lograda y reintentos', '', '| Activos | Modelo | req/s ofrecidas | req/s logradas | lograda/ofrecida | Logins/s intentados | × logins planeados | Llegadas con token/s | Sesiones fallidas/s |', '|---|---|---|---|---|---|---|---|---|');
    for (const s of steps) {
      const xo = s.aborted ? null : offered(meta, s.users);
      out.push(`| ${s.users} | ${(s.model ?? meta.profile.model) === 'open' ? 'abierto' : 'puestos'} | ${f(xo, 1)} | ${f(s.rps)} | ${xo ? f(s.rps / xo, 2) : '–'} | ${f(s.loginsPerSec, 2)} | ${f(s.loginAmplification, 2)} | ${f(s.resumesPerSec, 2)} | ${f(s.failedSessionsPerSec, 2)} |`);
    }
    out.push('', 'Ofrecida = activos × (autenticación si no trae token + listar + crear + unirse + sesión/pausa) / duración de la sesión. Mientras lograda/ofrecida ≈ 1, el req/s medido lo fija la carga y no dice nada de la capacidad; la capacidad empieza donde baja de 1. En el modelo de puestos la ofrecida misma baja al saturarse (las sesiones se alargan); en el abierto no. × logins planeados > 1: los reintentos multiplican el BCrypt (tormenta de reintentos); en el abierto está acotado por los reintentos. Sesiones fallidas: en puestos reintentan con otro login, en abierto se rinden. Columnas vacías: corrida anterior a v5 del generador.', '');
  }
  out.push('### Latencia por operación (p50 / p95 / p99 ms)', '');
  const ops = [...new Set(steps.flatMap((s) => Object.keys(s.byOp)))];
  out.push(`| Workers | ${ops.join(' | ')} |`, `|---|${ops.map(() => '---').join('|')}|`);
  for (const s of steps) out.push(`| ${s.workers} | ${ops.map((o) => lat(s.byOp[o])).join(' | ')} |`);
  out.push('');

  const rows = [['CPU máquina %', 'cpu.busy', 1], ['us %', 'cpu.user', 1], ['sy %', 'cpu.system', 1], ['iowait %', 'cpu.iowait', 1], ['steal % (t3 sin créditos: CPU que el hipervisor no entrega)', 'cpu.steal', 1],
    ['CPU app (% de 1 núcleo)', 'app.cpu', 0], ['CPU mongod (% de 1 núcleo)', 'mongo.cpu', 0], ['CPU generador (% de 1 núcleo)', 'gen.cpu', 0],
    ['RSS app MB', 'app.rssMB', 0], ['RSS mongod MB', 'mongo.rssMB', 0],
    ['Disco IOPS', 'disk.iops', 0], ['Disco MB/s', 'disk.mbs', 2], ['Disco %util', 'disk.util', 0], ['Red NIC entrada MB/s', 'net.rxMBs', 3], ['Red NIC salida MB/s', 'net.txMBs', 3], ['Frenado (throttled) ms/s', 'cgroup.throttledMs', 0]];
  out.push('### Recursos (promedio / pico por muestra)', '', `| Métrica | ${steps.map((s) => `${s.workers}w`).join(' | ')} |`, `|---|${steps.map(() => '---').join('|')}|`);
  const win = steps.map((s) => samples.filter((x) => x.at >= s.measureFrom && x.at <= s.end));
  for (const [label, path, d] of rows) {
    const cells = win.map((w) => pm(w.map((x) => get(x, path)).filter((v) => v != null), d));
    if (cells.every((c) => c === '–')) continue;
    out.push(`| ${label} | ${cells.join(' | ')} |`);
  }
  const hot = win.map((w) => pm(w.map((x) => (x.cpu?.cores?.length ? Math.max(...x.cpu.cores) : null)).filter((v) => v != null), 0));
  out.push(`| Núcleo más ocupado % | ${hot.join(' | ')} |`);
  out.push(`| Muestras del agente | ${win.map((w) => w.length).join(' | ')} |`, '');

  const dem = steps.map((s, i) => { const w = win[i], m = (p) => { const v = w.map((x) => get(x, p)).filter((q) => q != null); return v.length ? v.reduce((t, q) => t + q, 0) / v.length : null; }; return { s, app: m('app.cpu'), mongo: m('mongo.cpu') }; });
  if (dem.some((d) => d.app != null || d.mongo != null)) {
    const cap = capacity(mach, run, samples);
    out.push('### Demanda de CPU por petición y techo predicho (ley de utilización: D = CPU usada / req/s; X_max = núcleos / D)', '',
      `Núcleos disponibles: ${cap.split ? `app ${f(cap.app, 2)}, mongod ${f(cap.mongo, 2)}` : f(cap.pool, 0)} (${cap.note}).`, '',
      '| Nivel | req/s | app ms CPU/pet. | mongod ms CPU/pet. | total ms CPU/pet. | Utilización | X_max predicho (req/s) | Se agota primero | Núcleos para ×10 |', '|---|---|---|---|---|---|---|---|---|');
    for (const { s, app, mongo } of dem) {
      const a = app == null ? null : (app / 100 / s.rps) * 1000, m = mongo == null ? null : (mongo / 100 / s.rps) * 1000, t = a == null && m == null ? null : (a ?? 0) + (m ?? 0);
      let util = '–', xmax = '–', first = '–';
      if (cap.split && a != null && m != null) {
        const xa = cap.app / (a / 1000), xm = cap.mongo / (m / 1000);
        util = `app ${f(app / cap.app, 0)} % · mongod ${f(mongo / cap.mongo, 0)} %`; xmax = f(Math.min(xa, xm), 1); first = xm < xa ? `CPU de mongod (cuota ${f(cap.mongo, 2)})` : `CPU de la app (cuota ${f(cap.app, 2)})`;
      } else if (!cap.split && t && cap.pool) {
        util = `${f(((app ?? 0) + (mongo ?? 0)) / cap.pool, 0)} %`;
        xmax = f(cap.pool / (t / 1000), 1) + (cap.phys ? ` (${f(cap.phys / (t / 1000), 1)} con ${cap.phys} núcleos físicos)` : '');
        first = `CPU compartida; ${(m ?? 0) >= (a ?? 0) ? 'mongod' : 'app'} pone ${f((Math.max(m ?? 0, a ?? 0) / t) * 100, 0)} % del costo`;
      }
      out.push(`| ${s.users ?? s.workers} | ${f(s.rps)} | ${f(a, 2)} | ${f(m, 2)} | ${f(t, 2)} | ${util} | ${xmax} | ${first} | ${t == null ? '–' : f((t / 1000) * s.rps * 10, 1)} |`);
    }
    out.push('', 'Utilización = CPU usada / núcleos disponibles (100 % = saturado). X_max = núcleos / D: el req/s máximo si D no cambiara con la carga; compárese con el pico medido en la rampa. Si D crece con la carga (contención, SMT, kernel), el techo real queda por debajo. Con hilos SMT la cota con hilos lógicos es optimista: dos hilos comparten las unidades de ejecución y la caché L1/L2 de un núcleo. Núcleos ×10 = 10 × req/s × D / 1000.', '');
  }

  // ---- dentro de mongod ----
  if (mSamples.length) {
    const mw = steps.map((s) => mSamples.filter((x) => x.at >= s.measureFrom && x.at <= s.end));
    const avg = (w, k) => mean(w.map((x) => x[k]).filter((v) => v != null));
    out.push('### Dentro de mongod (serverStatus, promedio en la ventana medida)', '', '| Nivel | req/s | operaciones de mongod/s | find por petición | aggregate/count por petición | docs devueltos por petición | docs examinados por petición | latencia interna por lectura (µs) | caché usada / configurada (MB) | fallos de caché % | leído a caché MB/s | conexiones |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    steps.forEach((s, i) => {
      const w = mw[i], q = avg(w, 'find') ?? avg(w, 'qps'), d = avg(w, 'docsRet'), c = avg(w, 'agg'), x = avg(w, 'docsExam'), per = (v, dd = 1) => (v != null ? f(v / s.rps, dd) : '–');
      out.push(`| ${s.users ?? s.workers} | ${f(s.rps)} | ${f((q ?? 0) + (c ?? 0), 0)} | ${per(q)} | ${per(c)} | ${per(d)} | ${per(x, 0)} | ${f(avg(w, 'readLatUs'), 0)} | ${f(avg(w, 'cacheMB'), 0)} / ${f(avg(w, 'cacheMaxMB'), 0)} | ${f(avg(w, 'missPct'), 3)} | ${f(avg(w, 'readIntoMBs'), 3)} | ${f(avg(w, 'conns'), 0)} |`);
    });
    out.push('', 'El listado hace dos consultas por lobby (N+1 doble, `LobbyServiceImpl.toSummaryDto`): un `find` del videojuego y un `countByLobbyId` de participaciones (un `aggregate`). Con `solo-list` se espera ≈ 1 + lobbies en cada columna. Docs examinados por petición ≫ docs devueltos: hay recorridos completos de colección (sin índice en `participaciones.lobbyId`), así el costo del listado crece con lobbies × participaciones. Latencia interna baja con miles de consultas/s: el costo es la cantidad de consultas (CPU por consulta: parseo, plan, serialización y socket), no cada una. Fallos de caché ≈ 0 % y MB/s leídos ≈ 0: los datos caben en la caché de WiredTiger (RAM), por eso el disco no aparece.', '');
  }

  // ---- GC de la JVM ----
  if (r.appLog) {
    const { algo, ev } = gcLog(r.appLog);
    if (ev.length) {
      out.push(`### GC de la JVM${algo ? ` (${algo})` : ''}`, '', '| Nivel | Pausas | Pausas completas (Full) | Tiempo en pausa % | Pausa máx (ms) | Heap tras GC máx (MB) | Heap comprometido máx (MB) |', '|---|---|---|---|---|---|---|');
      for (const s of steps) {
        const w = ev.filter((e) => e.at >= s.measureFrom && e.at <= s.end), span = (s.end - s.measureFrom) || 1, tot = w.reduce((t, e) => t + e.ms, 0);
        out.push(`| ${s.users ?? s.workers} | ${w.length} | ${w.filter((e) => /Full/.test(e.kind)).length} | ${f((tot / span) * 100, 2)} | ${w.length ? f(Math.max(...w.map((e) => e.ms)), 1) : '–'} | ${w.length ? f(Math.max(...w.map((e) => e.after)), 0) : '–'} | ${w.length ? f(Math.max(...w.map((e) => e.cap)), 0) : '–'} |`);
      }
      out.push('', 'Tiempo en pausa bajo (< 2 %) y sin pausas Full: la memoria de la JVM no limita y el cuello es CPU. Heap tras GC cerca del comprometido o pausas Full repetidas: falta heap (la JVM por defecto toma 1/4 de la RAM visible, en el contenedor de 1 GB son ~256 MB). Con < 2 CPU visibles la JVM elige Serial GC (un solo hilo).', '');
    }
  }
  out.push('### Códigos de respuesta (2xx vs 4xx)', '');
  for (const s of steps) out.push(`- ${s.users ?? s.workers}: ${Object.entries(s.codes).sort().map(([k, v]) => `${k}×${v}`).join(' ')}`);
  out.push('');
  out.push('### Red vista por el generador (cuerpos HTTP + ~350 B de cabeceras por petición)', '', '| Workers | A la app MB/s | De la app MB/s |', '|---|---|---|');
  for (const s of steps) out.push(`| ${s.workers} | ${f(s.mbOutPerS, 3)} | ${f(s.mbInPerS, 3)} |`);
  out.push('');

  out.push('### Estabilidad: req/s por ventana de 30 s dentro del nivel (¿cae con el tiempo?)', '');
  for (const s of steps) {
    const secs = r.load.filter((x) => x.t === 'sec' && x.step === s.step && x.measuring), w = [];
    for (let i = 0; i < secs.length; i += 30) { const c = secs.slice(i, i + 30); w.push(f(c.reduce((t, x) => t + x.n, 0) / c.length, 1)); }
    out.push(`- ${s.workers}w: ${w.join(' → ')}`);
  }
  out.push('');

  // Tasa fija: a λ constante las req/s no dicen nada; lo que muestra si el calentamiento alcanzó es la LATENCIA en el tiempo,
  // y lo que muestra si el enfriamiento alcanzó es que la CPU vuelva al reposo antes del nivel siguiente.
  if (steps.some((s) => s.mode === 'rate')) {
    const med = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    out.push('### Calentamiento y enfriamiento (tasa fija)', '', 'p95 por ventana de 30 s (mediana de los p95 de cada segundo), **incluido el calentamiento** (entre corchetes, no se mide). Si las ventanas medidas se ven planas y solo el calentamiento es más alto, alcanzó. Si la primera ventana medida sigue alta, alargar `--warm`.', '');
    for (const s of steps) {
      const secs = r.load.filter((x) => x.t === 'sec' && x.step === s.step && x.at <= s.end + 1000), w = [];
      for (let i = 0; i < secs.length; i += 30) { const c = secs.slice(i, i + 30), p = f(med(c.map((x) => x.lat?.p95)), 0); w.push(c[0].at < s.measureFrom ? `[${p}]` : p); }
      out.push(`- λ ${s.rate}/s: ${w.join(' → ')} ms`);
    }
    const idleS = r.dir && existsSync(join(r.dir, 'idle.json')) ? JSON.parse(readFileSync(join(r.dir, 'idle.json'), 'utf8')) : null;
    out.push('', `CPU en los 20 s previos a cada nivel (tras la pausa del anterior) contra el reposo${idleS?.cpuBusyPct != null ? ` (${f(idleS.cpuBusyPct)} % de la máquina, app ${f(idleS.appCpu, 0)} %, mongod ${f(idleS.mongoCpu, 0)} % de un núcleo)` : ''}. Si sigue alta, la cola del nivel anterior todavía se estaba drenando: alargar \`--pause\`.`, '', '| Nivel | CPU máquina % | app (% de 1 núcleo) | mongod (% de 1 núcleo) |', '|---|---|---|---|');
    for (const s of steps) {
      const st = r.load.find((x) => x.t === 'mark' && x.ev === 'step-start' && x.step === s.step)?.at; if (!st) continue;
      const q = samples.filter((x) => x.at >= st - 20000 && x.at < st), m = (p) => mean(q.map((x) => get(x, p)).filter((v) => v != null));
      out.push(`| ${s.rate}/s | ${f(m('cpu.busy'))} | ${f(m('app.cpu'), 0)} | ${f(m('mongo.cpu'), 0)} |`);
    }
    out.push('');
  }
}
console.log(out.join('\n'));
