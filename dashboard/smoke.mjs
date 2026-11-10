// Prueba de humo sin navegador: DOM falso, recorre todas las pestanas y avisa de excepciones.
import { createRequire } from 'node:module'; import { readFileSync } from 'node:fs'; const require = createRequire(import.meta.url);
class El { constructor(t) { this.tag = t; this.kids = []; this.attrs = {}; this.style = {}; this.dataset = {}; this.className = ''; this.textContent = ''; }
  setAttribute(k, v) { this.attrs[k] = v; } addEventListener() {} append(...k) { this.kids.push(...k); } replaceChildren(...k) { this.kids = k; } click() {}
  get nodeType() { return 1; } getBoundingClientRect() { return { left: 0, width: 500 }; } set innerHTML(v) { this.html = v; } }
const els = {}; globalThis.document = { createElement: (t) => new El(t), createElementNS: (n, t) => new El(t), createTextNode: (t) => ({ nodeType: 3, t }), getElementById: (id) => (els[id] ??= new El(id)), documentElement: new El('html') };
globalThis.window = globalThis; globalThis.localStorage = { getItem: () => null, setItem() {} }; globalThis.matchMedia = () => ({ matches: false }); globalThis.addEventListener = () => {}; globalThis.innerWidth = 1200; globalThis.innerHeight = 800; globalThis.scrollTo = () => {};
require('./data.js'); require('./docs.js'); require('./ui.js'); globalThis.LIB = require('./lib.js'); (0, eval)(readFileSync(new URL('./extra.js', import.meta.url), 'utf8')); document.querySelectorAll = () => []; document.addEventListener = () => {};
// capturar el render por pestana: reejecutar app.js cambiando state.tab no es posible, asi que se evalua con un hook
let code = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
code = code.replace(/render\(\); activeTab\(\);\s*\}\)\(\);\s*$/, "globalThis.__t = { TABS, state, render, RENDER };})();");
(0, eval)(code);
const { TABS, state, RENDER, render } = globalThis.__t; let bad = 0;
for (const [id] of TABS) { try { const n = RENDER[id](); console.log('ok ', id.padEnd(9), n.length, 'nodos'); } catch (e) { bad++; console.log('ERR', id, e.stack.split('\n').slice(0, 3).join(' | ')); } }
for (const mix of ['mezcla-postman']) { state.mix = mix; try { RENDER.f5(); console.log('ok  f5', mix); } catch (e) { bad++; console.log('ERR f5', e.message); } }
state.amdahl = 'login'; try { RENDER.f3(); console.log('ok  f3 login'); } catch (e) { bad++; console.log('ERR f3', e.message); }
state.endpoint = 'view'; try { RENDER.f1(); console.log('ok  f1 view'); } catch (e) { bad++; console.log('ERR f1', e.message); }
try { render(); const m = document.getElementById('main'); console.log('ok  render completo:', m.kids.length, 'bloques;', m.kids.filter((k) => k.className && String(k.className).includes('sec')).length, 'secciones'); } catch (e) { bad++; console.log('ERR render', e.message); }

if (process.argv.includes('--texto')) { const tx = (n) => (n.t != null ? n.t : (n.kids || []).map(tx).join('')); for (const c of RENDER.preguntas()) console.log('\n' + tx(c).slice(0, 2600)); }
process.exit(bad ? 1 : 0);
