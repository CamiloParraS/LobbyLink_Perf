// Histograma logarítmico de latencias (resolución desde 0,1 ms): cada cubeta es 4 % más ancha que la anterior,
// así cualquier percentil tiene un error máximo de ~4 %. Se guarda como {cubeta: cuenta}
// para poder sumar segundos y recalcular percentiles de cualquier ventana sin perder exactitud.
const BASE = Math.log(1.04);

export const bucketOf = (ms) => (ms <= 0.1 ? 0 : Math.ceil(Math.log(ms * 10) / BASE));
export const valueOf = (b) => (b === 0 ? 0.1 : Math.exp(b * BASE) / 10);

export function add(h, ms) {
  const b = bucketOf(ms);
  h[b] = (h[b] ?? 0) + 1;
}

export function merge(into, h) {
  for (const b in h) into[b] = (into[b] ?? 0) + h[b];
  return into;
}

/** {n, p50, p95, p99, max} de un histograma; null si está vacío. */
export function summary(h) {
  const keys = Object.keys(h).map(Number).sort((a, b) => a - b);
  let n = 0;
  for (const k of keys) n += h[k];
  if (!n) return null;
  const at = (q) => {
    const target = Math.ceil(q * n);
    let seen = 0;
    for (const k of keys) if ((seen += h[k]) >= target) return round(valueOf(k));
  };
  return { n, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(valueOf(keys.at(-1))) };
}

export const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
