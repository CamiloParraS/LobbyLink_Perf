import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.window = {}; require('./data.js'); const L = require('./lib.js'); const A = L.make(globalThis.window.DATA);
for (const k of A.keys().sort()) { const [e, j] = k.split('|');
  const kn = A.kneeOf(e, j, 'mezcla-lectura'); const mx = A.maxPassingLevel(e, j); const mg = A.marginLevel(e, j, kn?.knee);
  console.log(k.padEnd(12), 'xmax', A.xmaxOf(e, j, 'mezcla-lectura'), 'knee', kn && kn.knee, 'firstFail', kn && kn.firstFail, 'F6max', mx && mx.rate, mx && mx.p95, 'margin', mg && mg.rate, 'list ms', A.f1Row(e, j, 'list')?.total); }
console.log(JSON.stringify(A.coverage().map(r => r.env + '|' + r.jar + ':' + Object.entries(r.cells).map(([p, c]) => p + c.n).join(','))));
