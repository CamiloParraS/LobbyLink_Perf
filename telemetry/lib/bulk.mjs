// Siembra EN BLOQUE para la prueba "los datos no caben en la cache" (fase f9 de campana.sh).
// Por la API, un lobby tarda ~13 ms en crearse: un millon serian ~4 h. Aqui se insertan directo en mongod, por OP_MSG
// (lib/mongostat.mjs, sin dependencias), lotes de 1.000 documentos.
//
// Cada lobby en bloque:
//   _id "bk0000000".."bk0999999" (String: Spring Data lo deja como texto porque no es un ObjectId valido), asi el generador
//   puede pedir uno al azar con GET /api/lobbies/{id} sin conocer la lista;
//   estado CANCELLED, para que GET /api/lobbies (PUBLISHED y FULL) no los devuelva;
//   videojuegoId del videojuego sembrado y "relleno": texto aleatorio de --bulk-pad bytes que Spring ignora al leer.
//   El relleno es base64 de bytes aleatorios: snappy (la compresion de WiredTiger) casi no lo reduce, asi que el tamano en
//   disco es ~ n × relleno. Con eso se controla cuanto excede la cache de WiredTiger y la RAM.
// La base la crea run.mjs con un nombre por corrida que el generador no conoce: se busca la base lobbylink_* que tiene el
// videojuego "Game<run>" que acaba de sembrar la API.
import { randomBytes } from 'node:crypto';
import { mongoClient } from './mongostat.mjs';

export const bulkId = (i) => 'bk' + String(i).padStart(7, '0');

export async function bulkLobbies({ mongo, run, n, pad = 3000, batch = 1000, log = console.log }) {
  const [host, port] = mongo.split(':');
  const cli = mongoClient(host, +(port || 27017));
  try {
    const dbs = (await cli.command({ listDatabases: 1, nameOnly: true, $db: 'admin' }, 30000)).databases?.map((d) => d.name).filter((x) => x.startsWith('lobbylink')) ?? [];
    let db = null, game = null;
    for (const name of dbs) {
      const r = await cli.command({ find: 'videojuegos', filter: { nombre: 'Game' + run }, limit: 1, $db: name }, 30000);
      if (r.cursor?.firstBatch?.length) { db = name; game = r.cursor.firstBatch[0]; break; }
    }
    if (!db) throw new Error(`no encontre la base con el videojuego Game${run} en ${mongo} (bases: ${dbs.join(', ')})`);
    const gameId = typeof game._id === 'string' ? game._id : String(game._id);
    log(`siembra en bloque: ${n} lobbies × ${pad} B de relleno (~${Math.round((n * (pad + 250)) / 1048576)} MB) en ${mongo}/${db}`);
    const t0 = Date.now(), fecha = new Date('2030-01-01T20:00:00Z');
    for (let i = 0; i < n; i += batch) {
      const docs = [];
      for (let k = i; k < Math.min(n, i + batch); k++) docs.push({ _id: bulkId(k), titulo: 'Bulk ' + k, fechaHora: fecha, cuposMaximos: 1000,
        enlacePrivado: 'https://x/bk' + k, estado: 'CANCELLED', creadorId: 'bulk', videojuegoId: gameId,
        relleno: randomBytes(Math.ceil((pad * 3) / 4)).toString('base64').slice(0, pad), _class: 'com.jefer.disenofinal.model.Lobby' });
      const r = await cli.command({ insert: 'lobbies', documents: docs, ordered: false, $db: db }, 120000);
      if (r.ok !== 1 && r.ok !== true) throw new Error('insert fallo: ' + JSON.stringify(r).slice(0, 300));
      if ((i / batch) % 50 === 0) log(`  ${i + docs.length} / ${n} (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
    const st = await cli.command({ collStats: 'lobbies', $db: db }, 60000).catch(() => ({}));
    const info = { db, n, pad, seconds: +((Date.now() - t0) / 1000).toFixed(1), count: st.count, sizeMB: st.size ? +(st.size / 1048576).toFixed(1) : null,
      storageMB: st.storageSize ? +(st.storageSize / 1048576).toFixed(1) : null, indexMB: st.totalIndexSize ? +(st.totalIndexSize / 1048576).toFixed(1) : null };
    log(`siembra en bloque lista: ${JSON.stringify(info)}`);
    return info;
  } finally { cli.close(); }
}
