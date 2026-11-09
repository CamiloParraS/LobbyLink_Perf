#!/usr/bin/env node
// PRUEBA DE EQUIVALENCIA del arreglo N+1: el jar corregido debe responder EXACTAMENTE lo mismo que el original.
// Arranca un jar, siembra una base con casos que tocan lo que cambio el arreglo (varios videojuegos, lobbies con 1 a 6
// participantes, lobbies llenos -> FULL, cancelados, filtro por juego), guarda todas las respuestas, apaga, arranca el otro
// jar sobre LA MISMA base y vuelve a pedir lo mismo. Compara el JSON campo por campo.
//
//   node telemetry/comparar_respuestas.mjs [--base-jar jars/disenofinal-base.jar] [--fix-jar jars/disenofinal-nplus1-fix.jar]
//        [--port 8095] [--out resultados/_equivalencia_<fecha>]
// Necesita mongod en 127.0.0.1:27017. Deja en --out: respuestas_base.json, respuestas_fix.json y resultado.md.
// Codigo de salida 0 si todo coincide, 2 si hay diferencias.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { client, rng } from './lib/lobbylink.mjs';

const here = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(here, '..');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const { values: a } = parseArgs({ options: {
  'base-jar': { type: 'string', default: join(ROOT, 'jars/disenofinal-base.jar') }, 'fix-jar': { type: 'string', default: join(ROOT, 'jars/disenofinal-nplus1-fix.jar') },
  port: { type: 'string', default: '8095' }, out: { type: 'string', default: join(ROOT, `resultados/_equivalencia_${stamp}`) } } });
mkdirSync(a.out, { recursive: true });
const db = `lobbylink_equivalencia_${stamp}`, BASE = `http://localhost:${a.port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`${new Date().toTimeString().slice(0, 8)}  ${m}`);

async function withApp(jar, tag, fn) {
  const out = openSync(join(a.out, `app_${tag}.log`), 'a');
  const p = spawn('java', ['-jar', jar, `--spring.data.mongodb.database=${db}`, `--server.port=${a.port}`], { stdio: ['ignore', out, out], windowsHide: true });
  try {
    for (let i = 0; i < 90; i++) { try { const r = await fetch(`${BASE}/api/videojuegos`, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) break; } catch {} await sleep(1000); if (i === 89) throw new Error(`${tag}: la app no arranco`); }
    log(`${tag}: app lista (${jar})`);
    return await fn(client(BASE, 30000).call);
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); else p.kill('SIGTERM');
    await sleep(3000);
  }
}

// Siembra (solo con el primer jar): 3 videojuegos, 12 usuarios, 45 lobbies con cupos 2..6 y 1..6 participantes,
// algunos llenos (FULL) y 5 cancelados. Semilla fija: la misma base cada vez.
async function sembrar(call) {
  const R = rng(42), run = 'eq' + stamp.slice(-6);
  const games = [];
  for (const g of ['Valor', 'Rocket', 'Minecraft']) games.push((await call('POST', '/api/videojuegos', { nombre: `${g}${run}`, genero: 'X', plataforma: 'PC' })).json);
  const users = [];
  for (let i = 0; i < 12; i++) {
    const email = `e${i}_${run}@t.com`;
    await call('POST', '/api/usuarios/register', { email, gamertag: `e${i}_${run}`, password: 'password123' });
    users.push((await call('POST', '/api/usuarios/login', { email, password: 'password123' })).json.token);
  }
  const lobbies = [];
  for (let i = 0; i < 45; i++) {
    const cupos = 2 + Math.floor(R() * 5), creador = i % users.length;
    const l = (await call('POST', '/api/lobbies', { titulo: `L${i}`, videojuegoId: games[i % 3].id, fechaHora: `2030-01-${String(1 + (i % 28)).padStart(2, '0')}T20:00:00`,
      cuposMaximos: cupos, enlacePrivado: `https://x/${i}` }, users[creador])).json;
    const extra = Math.floor(R() * cupos);   // 0..cupos-1 se unen: con cupos-1 el lobby queda lleno
    for (let k = 1; k <= extra; k++) await call('POST', `/api/lobbies/${l.id}/join`, null, users[(creador + k) % users.length]);
    if (i % 9 === 4) await call('POST', `/api/lobbies/${l.id}/cancel`, null, users[creador]);
    lobbies.push(l.id);
  }
  return { games: games.map((g) => g.nombre), lobbies, tokens: [users[0], users[5]] };
}

async function respuestas(call, s) {
  const out = {};
  const get = async (k, path, tok) => { const r = await call('GET', path, null, tok); out[k] = { status: r.status, body: r.json }; };
  await get('list', '/api/lobbies');
  for (const g of s.games) await get(`list?gameFilter=${g}`, `/api/lobbies?gameFilter=${encodeURIComponent(g)}`);
  await get('list?gameFilter=noexiste', '/api/lobbies?gameFilter=noexiste');
  for (const id of s.lobbies) for (const [i, t] of s.tokens.entries()) await get(`view ${id} u${i}`, `/api/lobbies/${id}`, t);
  return out;
}

// Diferencias campo por campo. Las listas de lobbies se comparan como conjuntos por id (el orden no es parte del contrato,
// pero se informa aparte si cambia).
function diff(x, y, path = '$', acc = []) {
  if (Array.isArray(x) && Array.isArray(y) && x.every((e) => e?.id) && y.every((e) => e?.id)) {
    const mx = new Map(x.map((e) => [e.id, e])), my = new Map(y.map((e) => [e.id, e]));
    for (const id of new Set([...mx.keys(), ...my.keys()])) diff(mx.get(id), my.get(id), `${path}[id=${id}]`, acc);
    if (x.map((e) => e.id).join() !== y.map((e) => e.id).join() && x.length === y.length) acc.push(`${path}: mismo contenido, otro orden`);
    return acc;
  }
  if (typeof x !== typeof y || (x && y && typeof x === 'object' && Array.isArray(x) !== Array.isArray(y))) { acc.push(`${path}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`); return acc; }
  if (x && typeof x === 'object') { for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) diff(x[k], y[k], `${path}.${k}`, acc); return acc; }
  if (x !== y) acc.push(`${path}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`);
  return acc;
}

let s;
const rb = await withApp(a['base-jar'], 'base', async (call) => { s = await sembrar(call); log(`siembra: ${s.lobbies.length} lobbies, ${s.games.length} videojuegos, base ${db}`); return respuestas(call, s); });
const rf = await withApp(a['fix-jar'], 'fix', (call) => respuestas(call, s));
writeFileSync(join(a.out, 'respuestas_base.json'), JSON.stringify(rb, null, 1));
writeFileSync(join(a.out, 'respuestas_fix.json'), JSON.stringify(rf, null, 1));
const d = diff(rb, rf), n = Object.keys(rb).length, nl = rb.list?.body?.length;
const full = rb.list?.body?.filter((l) => l.estado === 'FULL').length;
const md = [`# Equivalencia del arreglo N+1 (${new Date().toISOString()})`, '', `Base \`${db}\` en 127.0.0.1:27017. Jar original: \`${a['base-jar']}\`. Jar corregido: \`${a['fix-jar']}\`.`, '',
  `Peticiones comparadas: ${n} (listado completo, listado filtrado por cada videojuego y por uno inexistente, y el detalle de los ${s.lobbies.length} lobbies con dos usuarios distintos). El listado devuelve ${nl} lobbies, ${full} de ellos llenos (FULL).`, '',
  d.length ? `**${d.length} diferencias:**\n\n${d.slice(0, 200).map((x) => `- ${x}`).join('\n')}` : 'Resultado: **las respuestas son idénticas** campo por campo (estado HTTP y cuerpo).'];
writeFileSync(join(a.out, 'resultado.md'), md.join('\n') + '\n');
console.log(md.join('\n'));
process.exit(d.filter((x) => !x.endsWith('otro orden')).length ? 2 : 0);
