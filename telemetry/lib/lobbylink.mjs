// Cliente HTTP, siembra y operaciones de LobbyLink. Lo comparten load.mjs (bucle cerrado) y rate.mjs (tasa fija).
// Nada de este archivo es un supuesto de uso: las operaciones son los endpoints de la API tal como los define el codigo
// (LobbyController, UsuarioController) y la siembra es el tamano de datos que se declara en cada corrida (--users, --lobbies).

/** Cliente con contador de bytes (cuerpos + ~350 B de cabeceras por peticion). timeoutMs aborta la peticion. */
export function client(BASE, timeoutMs = 60000) {
  let bytesIn = 0, bytesOut = 0;
  async function call(method, path, body, token, count = false) {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = await fetch(BASE + path, { method, signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) }, body: payload });
    const buf = Buffer.from(await r.arrayBuffer());
    if (count) { bytesOut += (payload ? Buffer.byteLength(payload) : 0) + 200; bytesIn += buf.length + 150; }
    let json = null; try { json = buf.length ? JSON.parse(buf.toString()) : null; } catch {}
    return { status: r.status, json, bytes: buf.length };
  }
  return { call, bytes: () => [bytesIn, bytesOut] };
}

/** Siembra con un solo cliente (latencia base sin contencion). Devuelve el contexto que usan las operaciones. */
export async function seed(call, { users, lobbies, run, participants = 1 }) {
  users = Math.max(users, participants);   // un usuario solo puede unirse una vez a cada lobby: hacen falta al menos P usuarios
  const base = { registro: [], login: [], crearLobby: [] };
  const timed = async (k, f) => { const s = performance.now(); const r = await f(); base[k].push(performance.now() - s); return r; };
  const t0 = performance.now();
  const game = (await call('POST', '/api/videojuegos', { nombre: 'Game' + run, genero: 'FPS', plataforma: 'PC' })).json;
  const tokens = [], emails = [];
  for (let i = 0; i < users; i++) {
    const email = `u${i}_${run}@t.com`; emails.push(email);
    await timed('registro', () => call('POST', '/api/usuarios/register', { email, gamertag: `g${i}_${run}`, password: 'password123' }));
    tokens.push((await timed('login', () => call('POST', '/api/usuarios/login', { email, password: 'password123' }))).json.token);
  }
  const ctx = { game, tokens, emails, ids: [], run };
  for (let i = 0; i < lobbies; i++) ctx.ids.push((await timed('crearLobby', () => mkLobby(call, ctx, tokens[i % users]))).json.id);
  // Participantes por lobby (P): el creador ya cuenta como 1; se unen P-1 usuarios mas por la API (join real), 8 en paralelo.
  // Esto ocurre en la siembra, antes de la ventana medida. Lobby i: creador = usuario i % users, se unen los usuarios i+1 ... i+P-1.
  let joinErrors = 0;
  if (participants > 1) {
    const jobs = [];
    for (let i = 0; i < lobbies; i++) for (let k = 1; k < participants; k++) jobs.push([ctx.ids[i], tokens[(i + k) % users]]);
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (next < jobs.length) { const [l, t] = jobs[next++];
      const r = await call('POST', `/api/lobbies/${l}/join`, null, t); if (r.status >= 300) joinErrors++; } }));
  }
  const avg = (x) => (x.length ? +(x.reduce((p, q) => p + q, 0) / x.length).toFixed(1) : null);
  const rtt = [];
  for (let i = 0; i < 30; i++) { const s = performance.now(); await call('GET', '/api/lobbies/' + ctx.ids[0], null, tokens[0]); rtt.push(performance.now() - s); }
  ctx.info = { users, lobbies, participants, joinErrors, seconds: +((performance.now() - t0) / 1000).toFixed(1),
    registroMs: avg(base.registro), loginMs: avg(base.login), crearLobbyMs: avg(base.crearLobby), baseRttMs: avg(rtt) };
  return ctx;
}

const mkLobby = (call, ctx, t, c) => call('POST', '/api/lobbies', { titulo: 'Lobby ' + Math.random(), videojuegoId: ctx.game.id,
  fechaHora: '2030-01-01T20:00:00', cuposMaximos: 1000, enlacePrivado: 'https://x/' + Math.random() }, t, c);

/** Operaciones medibles. `join` recorre pares (usuario, lobby) sin repetir: unirse dos veces al mismo lobby devuelve 400
 *  y mediria el camino de error, no el de la operacion real. Con 20 usuarios × 200 lobbies hay 4.000 pares. */
export function makeOps(call, ctx, rnd = Math.random) {
  const pick = (x) => x[Math.floor(rnd() * x.length)];
  let seq = 0, pair = 0;
  const nPairs = () => ctx.tokens.length * ctx.ids.length;
  return {
    list: () => call('GET', '/api/lobbies', null, null, true),
    view: () => call('GET', '/api/lobbies/' + pick(ctx.ids), null, pick(ctx.tokens), true),
    create: async () => { const r = await mkLobby(call, ctx, pick(ctx.tokens), true); if (r.json?.id) ctx.ids.push(r.json.id); return r; },
    join: () => { const k = pair++ % nPairs(), u = k % ctx.tokens.length, l = Math.floor(k / ctx.tokens.length);
      return call('POST', `/api/lobbies/${ctx.ids[l]}/join`, null, ctx.tokens[u], true); },
    login: () => call('POST', '/api/usuarios/login', { email: pick(ctx.emails), password: 'password123' }, null, true),
    register: () => { const n = `${ctx.run}_${seq++}`; return call('POST', '/api/usuarios/register', { email: `r${n}@t.com`, gamertag: `r${n}`, password: 'password123' }, null, true); },
    joinPairsLeft: () => nPairs() - pair,
  };
}

/** Elige una operacion segun los pesos de la mezcla. */
export function picker(mix, rnd = Math.random) {
  const entries = Object.entries(mix), total = entries.reduce((s, [, p]) => s + p, 0);
  return () => { let r = rnd() * total; for (const [n, p] of entries) if ((r -= p) < 0) return n; return entries[0][0]; };
}

/** PRNG con semilla (mulberry32): la secuencia de llegadas y de operaciones es la misma en todas las maquinas. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
