// Funciones puras sobre window.DATA (sin DOM). Se prueban con node: node dashboard/test.mjs
(function (root) {
  const ENVS = [
    { id: 'pc', name: 'PC (Windows)', short: 'PC', slot: 1 },
    { id: 'docker', name: 'Docker (WSL2)', short: 'Docker', slot: 2 },
    { id: 'ec2u', name: 'EC2 t3.small Unlimited', short: 'EC2 Unlimited', slot: 3 },
    { id: 'ec2s', name: 'EC2 t3.small Standard', short: 'EC2 Standard', slot: 4 },
  ];
  const JARS = [{ id: 'base', name: 'Jar base' }, { id: 'fix', name: 'Jar con arreglo N+1' }, { id: 'thr', name: 'Standard con saldo 0' }];
  const key = (env, jar) => env + '|' + jar;
  const median = (a) => { const v = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const THRESH_P95 = 1000, THRESH_ERR = 0.01, MARGIN = 0.6;

  function make(D) {
    const runs = D.runs;
    const runsOf = (env, jar, phase, nameTest) => runs.filter((r) => r.env === env && r.jar === jar && (!phase || r.phase === phase) && (!nameTest || nameTest(r.run)));
    const keys = () => { const s = new Set(); runs.forEach((r) => s.add(key(r.env, r.jar))); Object.keys(D.models).forEach((k) => s.add(k)); Object.keys(D.sondas).forEach((k) => s.add(k)); return [...s]; };

    // ---- F5: pasos de una rampa por mezcla
    function rampSteps(env, jar, mix) {
      const r = runsOf(env, jar, 'f5', (n) => n === 'f5-' + mix)[0]; if (!r) return null;
      return r.steps.filter((s) => s.rate != null).sort((a, b) => a.rate - b.rate);
    }
    function xmaxOf(env, jar, mix) { const m = D.models[key(env, jar)]; const x = m?.f1?.xmax?.find((r) => r.mix === mix || r.mix.startsWith(mix)); return x && x.xmax != null ? x.xmax : null; }
    function kneeOf(env, jar, mix) {
      const st = rampSteps(env, jar, mix); if (!st) return null;
      const ok = st.filter((s) => s.pass && s.genOk !== false); if (!ok.length) return { knee: 0, firstFail: st[0].rate, complete: true };
      const best = ok.reduce((a, b) => (b.rps > a.rps ? b : a));
      const nextFail = st.find((s) => s.rate > best.rate && !s.pass);
      const allPass = st.every((s) => s.pass);
      return { knee: best.rps, kneeRate: best.rate, p95: best.p95, firstFail: nextFail ? nextFail.rate : null, allPass, top: st[st.length - 1].rate };
    }
    // ---- F6: niveles por repetición
    function f6Levels(env, jar) {
      const reps = runsOf(env, jar, 'f6', (n) => /^f6-mezcla-lectura-r\d+$/.test(n)); const byRate = new Map();
      for (const r of reps) for (const s of r.steps) { if (s.rate == null) continue; if (!byRate.has(s.rate)) byRate.set(s.rate, []); byRate.get(s.rate).push({ run: r.run, ...s }); }
      return [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([rate, arr]) => ({
        rate, reps: arr, nReps: arr.length, p95: median(arr.map((x) => x.p95)), p95min: Math.min(...arr.map((x) => x.p95)), p95max: Math.max(...arr.map((x) => x.p95)),
        rps: median(arr.map((x) => x.rps)), errorRate: median(arr.map((x) => x.errorRate)), allPass: arr.every((x) => x.pass), anyPass: arr.some((x) => x.pass),
        spread: arr.length > 1 ? (Math.max(...arr.map((x) => x.p95)) - Math.min(...arr.map((x) => x.p95))) / Math.min(...arr.map((x) => x.p95)) : null,
        res: arr[0].res,
      }));
    }
    function f6Own(env, jar) { const r = runsOf(env, jar, 'f6', (n) => n === 'f6-propio')[0]; return r ? r.steps.filter((s) => s.rate != null) : []; }
    function maxPassingLevel(env, jar) { const lv = f6Levels(env, jar).filter((l) => l.allPass); return lv.length ? lv[lv.length - 1] : null; }
    function marginLevel(env, jar, knee) { // mayor nivel (F6 o propio) que pasa y está a <= 60 % del codo medido
      if (!knee) return null;
      const all = [...f6Levels(env, jar).filter((l) => l.allPass).map((l) => ({ rate: l.rate, rps: l.rps, p95: l.p95 })), ...f6Own(env, jar).filter((s) => s.pass).map((s) => ({ rate: s.rate, rps: s.rps, p95: s.p95 }))];
      const ok = all.filter((l) => l.rps <= MARGIN * knee); return ok.length ? ok.reduce((a, b) => (b.rps > a.rps ? b : a)) : null;
    }
    function f1Row(env, jar, endpoint) { return D.models[key(env, jar)]?.f1?.f1?.find((r) => r.endpoint === endpoint) || null; }
    function coverage() {
      const phases = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8']; const out = [];
      for (const k of keys().sort()) { const [env, jar] = k.split('|'); const row = { env, jar, cells: {} };
        for (const p of phases) { const rr = runs.filter((r) => r.env === env && r.jar === jar && r.phase === p); const n = rr.length + (p === 'f0' && D.sondas[k] ? 1 : 0); row.cells[p] = { n, partial: rr.some((r) => !r.ended) }; }
        out.push(row); }
      return out;
    }
    return { runsOf, keys, rampSteps, xmaxOf, kneeOf, f6Levels, f6Own, maxPassingLevel, marginLevel, f1Row, coverage };
  }
  const api = { ENVS, JARS, key, median, make, THRESH_P95, THRESH_ERR, MARGIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LIB = api;
})(typeof window !== 'undefined' ? window : globalThis);
