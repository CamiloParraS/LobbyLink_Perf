// Cliente minimo del protocolo de MongoDB (OP_MSG) para pedir serverStatus SIN dependencias de npm ni mongosh.
// Lo usa agent.mjs para medir lo que pasa DENTRO de mongod: consultas/s (prueba del N+1), documentos devueltos,
// cache de WiredTiger (si el conjunto de datos cabe en RAM, el disco no se toca) y latencia interna por operacion.
// Costo: un serverStatus cada 1-2 s, del orden de 1 ms de CPU de mongod; despreciable frente a la carga.
import { connect } from 'node:net';

// ---------- BSON: solo lo necesario ----------
function encodeDoc(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = Buffer.from(k + '\0');
    if (typeof v === 'number') { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(Buffer.from([0x10]), key, b); }
    else if (typeof v === 'string') { const s = Buffer.from(v + '\0'); const l = Buffer.alloc(4); l.writeInt32LE(s.length); parts.push(Buffer.from([0x02]), key, l, s); }
    else throw new Error('tipo BSON no soportado: ' + typeof v);
  }
  const body = Buffer.concat([...parts, Buffer.from([0])]); const len = Buffer.alloc(4); len.writeInt32LE(body.length + 4);
  return Buffer.concat([len, body]);
}
function decodeDoc(buf, off = 0, asArray = false) {
  const end = off + buf.readInt32LE(off); let p = off + 4; const out = asArray ? [] : {};
  while (p < end - 1) {
    const type = buf[p++]; const z = buf.indexOf(0, p); const key = buf.toString('utf8', p, z); p = z + 1; let v;
    switch (type) {
      case 0x01: v = buf.readDoubleLE(p); p += 8; break;
      case 0x02: case 0x0D: case 0x0E: { const l = buf.readInt32LE(p); v = buf.toString('utf8', p + 4, p + 3 + l); p += 4 + l; break; }
      case 0x03: case 0x04: { v = decodeDoc(buf, p, type === 0x04); p += buf.readInt32LE(p); break; }
      case 0x05: { const l = buf.readInt32LE(p); v = null; p += 5 + l; break; }               // binario: se omite
      case 0x06: case 0x0A: case 0x7F: case 0xFF: v = null; break;
      case 0x07: v = buf.toString('hex', p, p + 12); p += 12; break;
      case 0x08: v = buf[p++] === 1; break;
      case 0x09: v = Number(buf.readBigInt64LE(p)); p += 8; break;                           // fecha (ms)
      case 0x0B: { const a = buf.indexOf(0, p); const b = buf.indexOf(0, a + 1); v = null; p = b + 1; break; }
      case 0x10: v = buf.readInt32LE(p); p += 4; break;
      case 0x11: v = buf.readUInt32LE(p + 4); p += 8; break;                                 // timestamp: segundos
      case 0x12: v = Number(buf.readBigInt64LE(p)); p += 8; break;
      case 0x13: v = null; p += 16; break;                                                   // decimal128: se omite
      default: throw new Error(`tipo BSON 0x${type.toString(16)} no soportado`);
    }
    if (asArray) out.push(v); else out[key] = v;
  }
  return out;
}

// ---------- conexion persistente con una peticion a la vez ----------
export function mongoClient(host = '127.0.0.1', port = 27017) {
  let sock = null, buf = Buffer.alloc(0), pending = null, reqId = 1;
  const open = () => new Promise((res, rej) => {
    const s = connect({ host, port }, () => { sock = s; res(); });
    s.setNoDelay(true);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0), msg = buf.subarray(0, len); buf = buf.subarray(len);
        const p = pending; pending = null;
        try { if (msg.readInt32LE(12) !== 2013 || msg[20] !== 0) throw new Error('respuesta inesperada'); p?.res(decodeDoc(msg, 21)); } catch (e) { p?.rej(e); }
      }
    });
    s.on('error', (e) => { sock = null; pending?.rej(e); pending = null; rej(e); });
    s.on('close', () => { sock = null; pending?.rej(new Error('conexion cerrada')); pending = null; });
  });
  async function command(cmd, timeoutMs = 5000) {
    if (!sock) await open();
    const doc = encodeDoc(cmd), head = Buffer.alloc(20);
    head.writeInt32LE(16 + 4 + 1 + doc.length, 0); head.writeInt32LE(reqId++, 4); head.writeInt32LE(0, 8); head.writeInt32LE(2013, 12); head.writeUInt32LE(0, 16);
    const msg = Buffer.concat([head, Buffer.from([0]), doc]);
    return new Promise((res, rej) => {
      const t = setTimeout(() => { pending = null; sock?.destroy(); sock = null; rej(new Error('timeout de serverStatus')); }, timeoutMs);
      pending = { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } };
      sock.write(msg);
    });
  }
  return { command, close: () => sock?.destroy() };
}

// Extrae los contadores acumulados que interesan (se convierten a tasas en agent.mjs).
export function pickStatus(s) {
  const c = s.wiredTiger?.cache ?? {}, m = s.metrics ?? {}, ol = s.opLatencies ?? {}, mc = m.commands ?? {};
  // metrics.commands.<cmd>.total existe en Mongo 7 y 9 (opcounters cambia: en 8+/9 los aggregate tienen contador propio).
  // countByLobbyId de Spring Data = countDocuments = comando aggregate ($match + $group); en versiones viejas puede ser "count".
  return {
    find: mc.find?.total, aggregate: mc.aggregate?.total, count: mc.count?.total,
    query: s.opcounters?.query, getmore: s.opcounters?.getmore, command: s.opcounters?.command, insert: s.opcounters?.insert, update: s.opcounters?.update,
    docsReturned: m.document?.returned, keysExamined: m.queryExecutor?.scanned, docsExamined: m.queryExecutor?.scannedObjects,
    readLatUs: ol.reads?.latency, readOps: ol.reads?.ops,
    cacheBytes: c['bytes currently in the cache'], cacheMax: c['maximum bytes configured'],
    pagesRequested: c['pages requested from the cache'], pagesReadInto: c['pages read into cache'], bytesReadInto: c['bytes read into cache'],
    conns: s.connections?.current, residentMB: s.mem?.resident,
  };
}
