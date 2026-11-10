'use strict';
// Pestañas añadidas (inspiradas en shareboard_perf): jerarquía de memoria y frecuencia, datos grandes (F7d/F9),
// historias de fallo y documentos crudos. Se carga antes de app.js; app.js la invoca con sus utilidades.
// Todas las cifras salen de window.DATA / window.DOCS (generados por build.mjs desde resultados/); lo que no se puede
// calcular de ahí se cita con su archivo de origen.
window.EXTRA = function (ctx) {
  const { D, A, L, ENV, state, h, fmt, fms, card, empty, table, pass, lineChart, barChart, keyName, colorOf } = ctx;
  const { key } = L;
  const MB = D.membench || { pc: [], docker: [], ec2: [], pcPorHilo: [] };
  const link = (id, text) => h('a', { href: 'visor.html#run=' + encodeURIComponent(id) }, text || 'abrir en el visor →');
  const runsOf = (phase, f) => D.runs.filter((r) => r.phase === phase && state.envs.has(r.env) && state.jars.has(r.jar) && (!f || f(r)));

  // ------------------------------------------------------------ mini renderizador de Markdown (tablas, títulos, listas, código)
  function md(text) {
    const root = h('div', { class: 'md' }); const lines = text.replace(/\r/g, '').split('\n'); let i = 0;
    const inline = (s) => { const out = []; const re = /(\*\*[^*]+\*\*|`[^`]+`)/g; let last = 0, m; while ((m = re.exec(s))) { if (m.index > last) out.push(s.slice(last, m.index)); out.push(m[0].startsWith('**') ? h('b', null, m[0].slice(2, -2)) : h('code', null, m[0].slice(1, -1))); last = m.index + m[0].length; } if (last < s.length) out.push(s.slice(last)); return out; };
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; root.append(h('pre', null, buf.join('\n'))); continue; }
      if (/^\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()); const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        root.append(h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c)))))))));
        continue;
      }
      const hd = l.match(/^(#{1,4})\s+(.*)$/); if (hd) { root.append(h('h' + Math.min(4, hd[1].length + 1), { class: 'mdh' }, inline(hd[2]))); i++; continue; }
      if (/^\s*[-*]\s+/.test(l)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(h('li', null, inline(lines[i++].replace(/^\s*[-*]\s+/, '')))); root.append(h('ul', null, items)); continue; }
      if (!l.trim()) { i++; continue; }
      const para = [l]; i++; while (i < lines.length && lines[i].trim() && !/^(#|```|\||\s*[-*]\s)/.test(lines[i])) para.push(lines[i++]);
      root.append(h('p', null, inline(para.join(' '))));
    }
    return root;
  }
  const docsBy = (re) => (window.DOCS || []).filter((d) => re.test(d.path));

  // ------------------------------------------------------------ MEMORIA Y FRECUENCIA
  const KB = (v) => (v >= 1024 ? v / 1024 + ' MB' : v + ' KB');
  function tabMemoria() {
    const out = [];
    const src = [
      { id: 'pc', name: 'PC · Ryzen 7 7445HS (hilo 0)', color: 'var(--s-pc)', block: MB.pc.find((b) => b.curve.length) },
      { id: 'docker', name: 'Docker · cuota 1 CPU (rep. 1)', color: 'var(--s-docker)', block: MB.docker.find((b) => b.curve.length) },
      { id: 'ec2', name: 't3.small · Xeon 8259CL (hilo 0)', color: 'var(--s-ec2u)', block: MB.ec2.find((b) => b.curve.length) },
    ].filter((s) => s.block && (state.envs.has(s.id === 'ec2' ? 'ec2u' : s.id) || (s.id === 'ec2' && state.envs.has('ec2s'))));
    if (!src.length) return [empty('Sin microbenchmarks en resultados/_microbench_*.')];
    out.push(card('Latencia de acceso a memoria según el tamaño del conjunto de trabajo', 'Cadena de punteros (pointer chasing, líneas de 64 B, páginas de 4 KB, mejor de 3). Cada escalón es un nivel de la jerarquía: L1 → L2 → L3 → RAM. Medido con membench.c en cada máquina (carpetas _microbench_*), no tomado de fichas.',
      lineChart({ series: src.map((s) => ({ name: s.name, color: s.color, pts: s.block.curve.map(([kb, ns]) => [kb, ns]) })), xlog: true, ylog: true, ylabel: 'ns por acceso', xlabel: 'tamaño del conjunto de trabajo (KB)', fmtx: (v) => KB(v), xticks: [4, 32, 256, 1024, 8192, 65536, 262144], fmty: (v) => fmt(v, 1) + ' ns', fmtTip: (v) => fmt(v, 2) + ' ns', xunit: '', markers: false, height: 340 })));
    const at = (b, kb) => { const p = b.curve.find((q) => q[0] === kb); return p ? p[1] : null; };
    const sizes = [16, 256, 4096, 65536, 262144];
    out.push(card('Cifras para citar', 'ns por acceso en cada tamaño. L1 ≈ 4–32 KB, L2 ≈ 256 KB–1 MB, L3 hasta ≈ 8–16 MB, después RAM. Cuanto más grande el salto entre 8 MB y 64 MB, más pesa un fallo de caché para una consulta que recorre muchos documentos (el listado sin paginar).',
      table(['Máquina', ...sizes.map((s) => KB(s)), 'RAM / L1', 'Frecuencia 1 hilo (GHz)'], src.map((s) => [h('b', null, s.name), ...sizes.map((z) => fmt(at(s.block, z), 2)), fmt(at(s.block, 262144) / at(s.block, 16), 0) + '×', fmt(s.block.freq && s.block.freq.mean, 2)]), { num: [1, 2, 3, 4, 5, 6, 7] })));
    // frecuencia efectiva por escenario
    const rows = [];
    const add = (maq, arr) => arr.forEach((b) => { if (b.freq) rows.push([maq, b.title.replace(/, frecuencia.*$/, ''), fmt(b.freq.mean, 2), fmt(b.freq.min, 2) + ' – ' + fmt(b.freq.max, 2), b.freq.n]); });
    add('PC (Ryzen)', MB.pc); add('t3.small', MB.ec2); add('Docker', MB.docker.filter((b) => !/fijado/.test(b.title)));
    out.push(card('Frecuencia efectiva medida con una cadena de sumas dependientes', 'La misma cadena corre en 1, 2 u 8 hilos a la vez. La frecuencia cae cuando hay más núcleos activos (límite de potencia y de turbo). Es la causa medida de que el trabajo por hilo no sea constante al subir la carga.',
      table(['Máquina', 'Escenario', 'GHz medios', 'Rango (GHz)', 'Muestras'], rows, { num: [2, 4] })));
    if (MB.pcPorHilo.length) {
      const g = MB.pcPorHilo.map((t) => ({ label: 'hilo ' + t.hilo, bars: [{ value: t.ghz[0], color: 'var(--s-pc)', name: 'rep. 1' }, { value: t.ghz[1], color: 'var(--axis)', name: 'rep. 2' }] }));
      out.push(card('PC: frecuencia por hilo lógico (dos repeticiones)', 'Cada hilo se fija y se mide con la cadena de sumas dependientes. Los hilos 0 y 1 llegan a ≈ 4,7 GHz, los hilos 2-7, 10 y 11 a ≈ 3,15 GHz, y los hilos 8 y 9 caen a ≈ 0,5 GHz en la segunda repetición.',
        barChart({ groups: g, ymax: 5.5, ylabel: 'GHz', height: 280, legend: [{ name: 'repetición 1', color: 'var(--s-pc)', bar: true }, { name: 'repetición 2', color: 'var(--axis)', bar: true }] })));
    }
    const dk = MB.docker.filter((b) => /fijado/.test(b.title) && b.freq);
    if (dk.length) out.push(card('Docker: frecuencia al fijar el contenedor a un vCPU de la VM', 'El microbenchmark corrió con la cuota de 1 CPU fijado a seis vCPU de la VM WSL2 (0, 2, 4, 6, 8 y 10). Si la frecuencia varía entre ellos, el rendimiento del contenedor depende de en qué vCPU lo ponga el planificador.',
      table(['Fijado a', 'GHz medios', 'Rango (GHz)'], dk.map((b) => [b.title.replace('fijado a ', ''), fmt(b.freq.mean, 2), fmt(b.freq.min, 2) + ' – ' + fmt(b.freq.max, 2)]), { num: [1] })));
    // frecuencia durante F1 (win-sampler)
    const fr = D.frecuencia || [];
    if (fr.length) fr.forEach((run) => run.levels.forEach((lv) => {
      const g = lv.hilos.map((t) => ({ label: 'h' + t.hilo, bars: [{ value: t.mhzW / 1000, color: t.servidor ? 'var(--s-pc)' : 'var(--s-docker)' }] }));
      const nm = run.run.replace(/^\d+_\d+_windows_v3frec-/, '');
      out.push(card(`Frecuencia por hilo durante la corrida ${nm} (${lv.workers} worker)`, `Muestreo de Windows mientras corría la carga (${lv.muestras} muestras; frecuencia base informada ${fmt(lv.baseMHz, 0)} MHz). Azul = hilos 0-7 donde corre el servidor; naranja = hilos 8-11 del generador. Ponderada por ocupación, el servidor trabajó a ${fmt(lv.ponderadaServidor, 0)} MHz.`,
        barChart({ groups: g, ylabel: 'GHz (ponderada por ocupación)', height: 250, ymax: 5 }),
        table(['Hilo', 'Rol', '% ocupado', 'MHz medios', 'MHz ponderados'], lv.hilos.map((t) => [t.hilo, t.servidor ? 'servidor' : 'generador', fmt(t.busy), fmt(t.mhz, 0), fmt(t.mhzW, 0)]), { num: [0, 2, 3, 4] }),
        h('p', { class: 'note' }, link(run.run, 'Abrir la corrida en el visor →'))));
    }));
    return out;
  }

  // ------------------------------------------------------------ DATOS GRANDES: F7d y F9
  function tabDatos2() {
    const out = [];
    const f7d = runsOf('f7d').sort((a, b) => ENV[a.env].slot - ENV[b.env].slot || (a.steps[0].lobbiesNow || 0) - (b.steps[0].lobbiesNow || 0));
    if (f7d.length) {
      out.push(card('F7d · tráfico base con más lobbies', 'Misma tasa (10 req/s) y 10 veces o 100 veces los datos. La predicción de CPU se escribió antes (sección F7 / F8). Falla cuando el resultado deja de depender de la CPU y pasa a depender de la memoria: el listado sin paginar arma una lista del tamaño de la base en el heap.',
        table(['Entorno', 'Jar', 'Corrida', 'Lobbies', 'req/s', 'p95 (ms)', 'p99 (ms)', 'Errores %', 'CPU máq. %', 'app RSS (MB)', 'mongod RSS (MB)', 'Resultado', 'Visor'],
          f7d.map((r) => { const s = r.steps[0] || {}, x = s.res || {}; return [ENV[r.env].short, r.jar === 'fix' ? 'arreglado' : 'base', r.run, fmt(s.lobbiesNow, 0), fmt(s.rps), fms(s.p95), fms(s.p99), fmt((s.errorRate || 0) * 100, 1), fmt(x.busy), fmt(x.appRss, 0), fmt(x.mongoRss, 0), pass(s.pass, s.pass ? 'pasa' : 'no pasa'), link(r.id, 'abrir →')]; }), { num: [3, 4, 5, 6, 7, 8, 9, 10] }),
        h('p', { class: 'note' }, 'Valores de p95 ≥ 10.000 ms son timeouts (el generador cuenta el timeout como latencia). En el visor se ven las pausas de GC y el heap de cada una.')));
      const ok = f7d.filter((r) => r.steps[0] && r.steps[0].p95 < 10000);
      const g = [2000, 20000].map((n) => ({ label: fmt(n, 0) + ' lobbies', bars: f7d.filter((r) => r.steps[0].lobbiesNow === n && !/xmx/.test(r.run)).map((r) => ({ value: Math.min(r.steps[0].p95, 10181), color: colorOf(r.env), name: ENV[r.env].short + (r.jar === 'fix' ? ' · arreglado' : '') })) }));
      out.push(card('p95 con 2.000 y 20.000 lobbies', 'Tope del eje = 10.181 ms (timeout). Una barra al tope es una máquina que dejó de responder.',
        barChart({ groups: g, ylabel: 'p95 (ms)', height: 270, legend: [...new Set(f7d.map((r) => r.env))].map((e) => ({ name: ENV[e].short, color: colorOf(e), bar: true })) })));
      void ok;
    } else out.push(empty('Sin corridas F7d para los filtros elegidos.'));

    const f9 = runsOf('f9');
    if (f9.length) {
      const nm = (r) => (/caliente/.test(r.run) ? '20.000 lobbies (caben en caché)' : '1.000.000 lobbies (3.117 MB, no caben en 1,9 GiB)');
      const col = (r) => (/caliente/.test(r.run) ? 'var(--s-ec2u)' : 'var(--bad)');
      out.push(card('F9 · ver un lobby al azar con datos que no caben en memoria', 'Perfil solo-view a tasa fija, 30 s de calentamiento y 300 s medidos por nivel, en la t3.small Unlimited. Mide qué pasa cuando WiredTiger debe ir al disco: fallos de caché, IOPS y espera de E/S. Los lobbies se insertaron en bloque (lib/bulk.mjs), por eso el conteo del paso no los refleja.',
        lineChart({ series: f9.map((r) => ({ name: nm(r), color: col(r), dash: /frio/.test(r.run) ? '6 4' : null, pts: r.steps.map((s) => [s.rate, s.p95]) })), ylog: true, ymin: 1, xlog: true, ylabel: 'p95 (ms)', xlabel: 'req/s ofrecidos', fmtx: (v) => fmt(v, 0), hlines: [{ y: 1000, label: 'umbral 1.000 ms' }], xticks: [25, 50, 100, 200, 400], fmty: (v) => fmt(v, 0) })));
      out.push(card('F9 · recursos por nivel', 'Compara la columna “CPU máq. %” con “IOPS” y el techo de disco de la tarjeta siguiente para ver qué recurso se llena primero; “fallos caché %” indica cuánto del conjunto ya no cabe en la caché de WiredTiger.',
        table(['Conjunto', 'req/s', 'logrados', 'p50', 'p95', 'p99', 'CPU máq. %', 'app % núcleo', 'mongod % núcleo', 'IOPS', 'disco MB/s', 'fallos caché %', 'Resultado'],
          f9.flatMap((r) => r.steps.map((s) => { const x = s.res || {}; return [nm(r), fmt(s.rate, 0), fmt(s.rps), fms(s.p50), fms(s.p95), fms(s.p99), fmt(x.busy), fmt(x.app, 0), fmt(x.mongo, 0), fmt(x.iops, 0), fmt(x.diskMbs, 2), fmt(x.missPct, 2), pass(s.pass, s.pass ? 'pasa' : 'no pasa')]; })), { num: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }),
        h('p', { class: 'note' }, f9.map((r) => link(r.id, r.run + ' →')).reduce((a, b) => [a, ' · ', b]))));
      const sd = D.sondas[key('ec2u', 'base')] || D.sondas[key('ec2s', 'base')];
      if (sd && sd.randread) out.push(card('F9 · cuánto disco se usó contra su techo (F0)', null, table(['Techo medido (fio)', 'Valor'], [['randread IOPS', fmt(sd.randread.iops, 0)], ['randread latencia p50 / p99 (µs)', `${fmt(sd.randread.latP50us, 0)} / ${fmt(sd.randread.latP99us, 0)}`], ['seqread MB/s', fmt(sd.seqread && sd.seqread.mbs, 0)]], { num: [1] })));
    }
    // fm: -Xmx700m y xmx1g
    const fm = runsOf('fm');
    if (fm.length) out.push(card('¿El heap era la causa? Docker con -Xmx700m (tráfico ×10)', 'Mismo F7 del contenedor con el heap fijado en 700 MB. Si 100 req/s sigue en 100 % de error sin OutOfMemoryError, el heap no era el límite.',
      table(['Entorno', 'Corrida', 'req/s', 'p95 (ms)', 'Errores %', 'app RSS (MB)', 'Resultado'], fm.flatMap((r) => r.steps.map((s) => [ENV[r.env].short, r.run, fmt(s.rate, 0), fms(s.p95), fmt((s.errorRate || 0) * 100, 1), fmt(s.res && s.res.appRss, 0), pass(s.pass, s.pass ? 'pasa' : 'no pasa')])), { num: [2, 3, 4, 5] }), h('p', { class: 'note' }, fm.map((r) => link(r.id)))));
    // sensibilidad
    const sens = docsBy(/sensibilidad_lobbies/);
    sens.forEach((d) => out.push(card('Sensibilidad al número de lobbies (predicho)', 'Cota superior por tamaño de datos; el medido en F5 quedó cerca del 60 % de X_max.', md(d.text))));
    return out;
  }

  // ------------------------------------------------------------ HISTORIAS DE FALLO
  function tabFallos() {
    const out = []; const E = (e) => ENV[e].short;
    const story = (n, title, sintoma, medido, causa, links) => h('section', { class: 'card full story' }, h('h2', null, `${n}. ${title}`),
      h('div', { class: 'cols3' }, h('div', null, h('h3', null, 'Qué se vio'), sintoma), h('div', null, h('h3', null, 'Qué se midió'), medido), h('div', null, h('h3', null, 'Qué componente lo causa'), causa)), links ? h('p', { class: 'note' }, links) : null);
    const ul = (...x) => h('ul', null, x.filter(Boolean).map((t) => h('li', null, t)));
    // 1 N+1
    const rows = ['pc', 'docker', 'ec2u'].map((e) => { const b = A.f1Row(e, 'base', 'list'), f = A.f1Row(e, 'fix', 'list'); return b && f ? [E(e), fmt(b.total), fmt(b.mongoPct, 0) + ' %', fmt(f.total), fmt(f.mongoPct, 0) + ' %', fmt((1 - f.total / b.total) * 100, 0) + ' %'] : null; }).filter(Boolean);
    out.push(story(1, 'Listar lobbies: una consulta por cada lobby (N+1)', 'GET /api/lobbies cuesta mucha más CPU por petición que ver un lobby, por eso la máquina se satura con pocas peticiones por segundo.',
      [ul(`Costo del listado por petición (F1, ms de CPU de app + mongod): ver tabla.`), table(['Entorno', 'Base ms', 'Base % en mongod', 'Arreglado ms', 'Arreglado % en mongod', 'Reducción'], rows, { num: [1, 2, 3, 4, 5] })],
      ul('toSummaryDto consulta el videojuego de cada lobby: 200 lobbies = 200 consultas más a mongod.', 'Una parte grande del costo está en mongod (columna “% en mongod”), no en la app.', 'La corrección agrupa el conteo en una agregación y usa findAllById; las respuestas son idénticas (95 de 95 en el PC y en la t3.small).'),
      'Ver: F1, F2 y “N+1 antes / después”.'));
    // 2 x10 trafico
    const f7 = D.runs.filter((r) => r.phase === 'f7' && /trafico/.test(r.run) && state.envs.has(r.env));
    const x10 = f7.map((r) => { const s = r.steps.find((q) => q.rate >= 50); return s ? [E(r.env), r.jar === 'fix' ? 'arreglado' : 'base', fmt(s.rate, 0), fms(s.p95), fmt((s.errorRate || 0) * 100, 1) + ' %', pass(s.pass, s.pass ? 'pasa' : 'no pasa')] : null; }).filter(Boolean);
    out.push(story(2, 'Diez veces el tráfico: 100 req/s', 'El jar base falla en las tres opciones; el jar con el arreglo lo sostiene con 0 errores.',
      [table(['Entorno', 'Jar', 'req/s', 'p95 (ms)', 'Errores', 'Resultado'], x10)],
      ul('Con el jar base, 100 req/s fallan en las tres opciones; con el arreglado pasan con 0 errores (HANDOFF §8).', 'Un p95 de 10.181 ms es el timeout del generador: la latencia mide la espera, no el servicio.'),
      ul('Compara con el codo medido en F5 y con la predicción escrita antes (sección F7 / F8).', 'Pasado el codo, la cola crece y la latencia deja de medir el servicio.'),
      'Ver: F7 / F8 y F5 (codo medido).'));
    // 3 20.000 lobbies
    const ec = D.runs.find((r) => r.phase === 'f7d' && r.env === 'ec2u' && /datos-20000$/.test(r.run)), pc = D.runs.find((r) => r.phase === 'f7d' && r.env === 'pc' && /20000$/.test(r.run)), dk = D.runs.find((r) => r.phase === 'f7d' && r.env === 'docker' && /20000$/.test(r.run));
    const l3 = [['t3.small', ec], ['Contenedor', dk], ['PC', pc]].filter((x) => x[1]).map(([n, r]) => { const s = r.steps[0], x = s.res || {}; return [n, fmt(s.lobbiesNow, 0), fms(s.p95), fmt((s.errorRate || 0) * 100, 0) + ' %', fmt(x.appRss, 0), pass(s.pass, s.pass ? 'pasa' : 'no pasa'), link(r.id, 'visor →')]; });
    out.push(story(3, '20.000 lobbies: la memoria, no la CPU, manda', 'La t3.small y el contenedor devuelven 100 % de errores aunque la predicción de CPU decía que cabían; el PC lo sostiene.',
      [table(['Máquina', 'Lobbies', 'p95 (ms)', 'Errores', 'app RSS (MB)', 'Resultado', ''], l3, { num: [1, 2, 4] })],
      ul('t3.small: heap por defecto de 478 MB, 95 pausas Full GC y OutOfMemoryError que mata el hilo http-nio-8080-Poller (HANDOFF §11). Con -Xmx1g el kernel mata a Java a los 30 s: 949 MB de Java + ≈ 580 MB de mongod en 1,9 GiB.', 'Contenedor: heap 247 MB, 1.782 Full GC y 178 OutOfMemoryError (HANDOFF §12). El PC pasó con p95 335,7 ms y 1.938 MB de RSS.'),
      ul('RAM física y heap de la JVM: GET /api/lobbies no tiene paginación y construye en memoria toda la lista.', 'F9 muestra aparte que el disco no era el límite.'),
      'Ver: “F7d / F9 Datos”. Antes de 20.000 lobbies hay que paginar el listado (no medido).'));
    // 4 CFS
    const f4 = D.runs.filter((r) => r.phase === 'f4' && r.env === 'docker' && r.jar === 'base');
    const f4r = f4.map((r) => { const s = r.steps[r.steps.length - 1]; const x = s.res || {}; return [r.quota || r.run, fmt(s.workers, 0), fmt(s.rps), fms(s.p95), fmt(x.busy), fmt(x.thrApp, 0), fmt(x.thrMongo, 0)]; });
    out.push(story(4, 'Contenedor frenado con la máquina casi libre', 'El contenedor se satura y la latencia sube mientras el PC dueño de la VM está mayormente libre.',
      [table(['Cuota (app×mongod)', 'Workers', 'req/s', 'p95 (ms)', 'CPU máq. %', 'Frenado app ms/s', 'Frenado mongod ms/s'], f4r, { num: [1, 2, 3, 4, 5, 6] })],
      ul('Se mide el tiempo que el kernel detuvo al contenedor por agotar su cuota (columnas “Frenado”).', 'Compara los repartos de cuota: si dar CPU a mongod mueve el techo y dárselo a la app no, el cuello es mongod.'),
      ul('Cuota CFS (cgroups): 1 CPU = 100 ms de cada 100 ms; al agotarla el hilo espera, aunque haya núcleos libres.'),
      'Ver: F4 Cuotas.'));
    // 5 créditos
    const f8 = D.runs.find((r) => r.phase === 'f8' && r.env === 'ec2s' && r.jar === 'base'), cw = D.cloudwatch && D.cloudwatch.ec2s && D.cloudwatch.ec2s.CPUCreditBalance;
    let zero = null, first = null; if (f8 && cw && f8.startedAtMs) { const w = cw.filter((p) => p.t >= f8.startedAtMs); first = w[0]; zero = w.find((p) => p.avg < 1); }
    const s8 = f8 && f8.steps[0];
    out.push(story(5, 'Créditos de CPU: la t3.small Standard se queda sin gasolina', 'Con λ = 23 req/s sostenidos la instancia Standard devolvió 100 % de errores.',
      [ul(first ? `Saldo al empezar: ${fmt(first.avg)} créditos.` : null, zero ? `Llegó a 0 a los ${fmt((zero.t - f8.startedAtMs) / 60000, 0)} min de carga.` : null, s8 ? `Resultado del paso: p95 ${fms(s8.p95)} ms, errores ${fmt((s8.errorRate || 0) * 100, 0)} %.` : null, 'Unlimited paga los créditos excedentes en lugar de frenar.')],
      ul('1 crédito = 1 vCPU al 100 % durante 1 minuto; sin saldo, la instancia Standard se frena.', 'steal (en F6/F8) mide el CPU que el hipervisor no entregó.'),
      ul('Modelo de créditos de AWS (CPU limitada por tiempo, no por demanda).'),
      'Ver: Créditos (CloudWatch).'));
    // 6 BCrypt
    const lg = ['pc', 'docker', 'ec2u'].map((e) => [E(e), A.f1Row(e, 'base', 'login'), A.f1Row(e, 'base', 'view')]).filter((x) => x[1] && x[2]);
    out.push(story(6, 'Login y registro: BCrypt es trabajo de CPU puro', 'Un login cuesta mucha más CPU que ver un lobby (columna “veces”).',
      [table(['Entorno', 'login ms (app)', 'ver ms (total)', 'veces'], lg.map(([n, l, v]) => [n, fmt(l.app), fmt(v.total, 2), fmt(l.app / v.total, 0) + '×']), { num: [1, 2, 3] })],
      ul('Costo de BCrypt (factor de trabajo fijo) en ms de CPU de la app por petición.', 'En el PC la frecuencia por hilo medida durante F1-login fue 2.126 MHz ponderados y 2.768 MHz en F1-list (HANDOFF §12): no corre a máxima frecuencia.'),
      ul('Ejecución de la ALU: sin esperas de memoria o disco. Más hilos ayudan hasta el número de núcleos (Amdahl, F3).'),
      'Ver: F1, F3 y “Jerarquía de memoria”.'));
    // 7 F9
    const f9 = D.runs.filter((r) => r.phase === 'f9' && /frio/.test(r.run))[0];
    if (f9) { const s = f9.steps[f9.steps.length - 1], x = s.res || {};
      out.push(story(7, 'Datos que no caben en RAM: lo que se esperaba (disco) no fue el límite', '1.000.000 de lobbies (3.117 MB) en una instancia de 1,9 GiB: todos los niveles pasan hasta 400 req/s.',
        [ul(`A ${fmt(s.rate, 0)} req/s: p95 ${fms(s.p95)} ms, fallos de caché ${fmt(x.missPct, 2)} %, ${fmt(x.iops, 0)} IOPS, iowait ${fmt(x.iowait, 1)} %, CPU máquina ${fmt(x.busy)} %.`)],
        ul('Disco: 365 IOPS a 400 req/s son el 12 % de su capacidad medida y wa 3,4 % (HANDOFF §11).', 'La CPU se llena antes que el disco.'),
        ul('Caché de WiredTiger de 440 MB (valor medido de la configuración) frente a un conjunto de 3.117 MB.'), link(f9.id)));
    }
    return out;
  }

  // ------------------------------------------------------------ DOCUMENTOS
  function tabDocs() {
    const docs = window.DOCS || []; if (!docs.length) return [empty('Sin documentos. Regenera con node dashboard/build.mjs.')];
    const groups = [...new Set(docs.map((d) => d.grupo))];
    const q = state.docQ || '';
    const box = h('input', { type: 'search', placeholder: 'Buscar en los documentos (ej.: 3.117, OutOfMemory, BCrypt)', value: q, class: 'search', 'aria-label': 'Buscar documentos', oninput: (e) => { state.docQ = e.target.value; state.docFocus = true; ctx.render(); } });
    const out = [card('Documentos y datos auxiliares', `${docs.length} archivos .md de resultados/ (predicciones, modelos, validaciones, equivalencia, microbenchmarks, costos y precios). Los datos crudos de cada corrida están en las carpetas de resultados/ y se resumen en el visor.`, h('div', { class: 'controls' }, box))];
    const match = (d) => !q || (d.title + ' ' + d.text).toLowerCase().includes(q.toLowerCase());
    for (const g of groups) { const list = docs.filter((d) => d.grupo === g && match(d)); if (!list.length) continue;
      out.push(h('section', { class: 'card full' }, h('h2', null, `${g} (${list.length})`), list.map((d) => h('details', { open: q && list.length < 4 ? true : null }, h('summary', null, d.title, h('span', { class: 'muted' }, '  ·  ' + d.path)), md(d.text)))));
    }
    if (state.docFocus) { state.docFocus = false; setTimeout(() => { const i = document.querySelector('input.search'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); }
    return out;
  }

  const TABS = [['memoria', 'Memoria y frecuencia'], ['datos2', 'F7d / F9 Datos'], ['fallos', 'Historias de fallo'], ['docs', 'Documentos']];
  const RENDER = { memoria: tabMemoria, datos2: tabDatos2, fallos: tabFallos, docs: tabDocs };
  const EXPL = {
    memoria: { que: 'La jerarquía de caché y la frecuencia real del procesador en cada máquina.', como: 'membench.c recorre un conjunto de trabajo de 4 KB a 256 MB siguiendo punteros y cronometra cada acceso; otra cadena de sumas dependientes mide los GHz efectivos con 1, 2 y 8 hilos. El agente de Windows además muestrea los MHz por hilo durante la carga (win-sampler.ps1).', q: [2] },
    datos2: { que: 'Qué pasa cuando crece la base: 2.000 y 20.000 lobbies (F7d) y 1.000.000 de lobbies que no caben en RAM (F9).', como: 'F7d: tasa fija 10 req/s con la base sembrada en bloque; la predicción se escribió antes. F9: ver un lobby al azar con tasa fija de 25 a 400 req/s sobre un conjunto que cabe en caché contra uno de 3.117 MB.', q: [2, 3] },
    fallos: { que: 'Siete casos donde algo se rompió, con el número medido y el componente de hardware o de software que lo explica.', como: 'Cada historia cruza una tabla calculada en vivo de las corridas con la cifra que el informe cita; las cifras de GC y errores del heap vienen de HANDOFF.md y de app.log de la corrida.', q: [1, 2, 3, 4] },
    docs: { que: 'Todos los informes de apoyo en texto: modelos, validaciones, predicciones, equivalencia del arreglo, microbenchmarks, costos y precios.', como: 'Generados por los scripts de telemetry/ y guardados en resultados/. Aquí se leen sin salir del panel y se pueden buscar.', q: [1, 2, 3, 4] },
  };
  return { TABS, RENDER, EXPL, md };
};
