/**
 * Números clave: distribución DISCRETA del margen y del total.
 *
 * Los modelos dan una mezcla de normales (continua), pero en la NFL los marcadores salen de sumas de
 * 3 y 7: el margen cae en 3 cerca del 15% de las veces y en 7 cerca del 8% (Stern 1991; Wong,
 * Sharp Sports Betting). Aquí la mezcla se discretiza por enteros y se reescala con pesos por número
 * medidos en partidos anteriores:
 *
 *   p₀(k) = Σ_m w_m [Φ((k + ½ − μ_m − c)/σ_m) − Φ((k − ½ − μ_m − c)/σ_m)]
 *   ω_k   = (observados_k + a) / (esperados_k + a)      (a = previa que encoge hacia ω = 1)
 *   p(k)  = p₀(k)·ω_k / Σ_j p₀(j)·ω_j
 *
 * Para el margen ω depende de |k| (simétrico). Con p(k) se obtienen P(gana), P(push) y P(pierde)
 * contra cualquier línea.
 */
import { normalCdf } from "./core";
import type { Records } from "./backtest";

export type Kind = "margin" | "total";
export const RANGE = { margin: { lo: -70, hi: 70 }, total: { lo: 0, hi: 120 } } as const;
type Mixture = { margin: Record<string, number>; total: Record<string, number> };

/** Masa por entero de la mezcla de normales del ensamble, corrida c puntos (capas de QB, bajas…). */
export function basePmf(r: Records[number], kind: Kind, shift: number) {
  const mix = (r as { mixture?: Mixture }).mixture;
  const lo: number = RANGE[kind].lo, hi: number = RANGE[kind].hi;
  const out = new Float64Array(hi - lo + 1);
  if (!mix) return out;
  for (const [key, w] of Object.entries(mix[kind])) {
    const pr = r.preds[key];
    const mu = (kind === "margin" ? pr.margin : pr.total) as number;
    const sd = (kind === "margin" ? pr.sdMargin : pr.sdTotal) as number;
    for (let k = lo; k <= hi; k++) {
      const a = k === lo ? 0 : normalCdf((k - 0.5 - mu - shift) / sd);
      const b = k === hi ? 1 : normalCdf((k + 0.5 - mu - shift) / sd);
      out[k - lo] += w * (b - a);
    }
  }
  return out;
}

export type KeyWeights = { kind: Kind; a: number; weights: number[]; observed: number[]; expected: number[]; games: number };
const idxW = (kind: Kind, k: number) => (kind === "margin" ? Math.abs(k) : k - RANGE.total.lo);

/** ω por número con los partidos que pasan el filtro (todos anteriores a donde se usarán). */
export function fitKeyWeights(records: Records, kind: Kind, filter: (r: Records[number]) => boolean, shiftOf: (r: Records[number]) => number, a: number): KeyWeights {
  const size = kind === "margin" ? RANGE.margin.hi + 1 : RANGE.total.hi - RANGE.total.lo + 1;
  const obs = new Array(size).fill(0), exp = new Array(size).fill(0);
  let games = 0;
  for (const r of records) {
    if (!filter(r)) continue;
    const pmf = basePmf(r, kind, shiftOf(r));
    const { lo } = RANGE[kind];
    pmf.forEach((p, j) => { exp[idxW(kind, j + lo)] += p; });
    const y = kind === "margin" ? r.g.hs - r.g.as : r.g.hs + r.g.as;
    const iy = idxW(kind, Math.max(lo, Math.min(RANGE[kind].hi, y)));
    obs[iy]++;
    games++;
  }
  return { kind, a, weights: obs.map((o, j) => (o + a) / (exp[j] + a)), observed: obs, expected: exp.map((e) => Number(e.toFixed(2))), games };
}

export function weightedPmf(r: Records[number], kind: Kind, shift: number, kw: KeyWeights | null) {
  const pmf = basePmf(r, kind, shift);
  if (!kw) return pmf;
  const { lo } = RANGE[kind];
  let z = 0;
  for (let j = 0; j < pmf.length; j++) { pmf[j] *= kw.weights[idxW(kind, j + lo)] ?? 1; z += pmf[j]; }
  for (let j = 0; j < pmf.length; j++) pmf[j] /= z;
  return pmf;
}

/** P(>línea), P(=línea) y P(<línea) desde la distribución discreta. */
export function lineProbs(pmf: Float64Array, kind: Kind, line: number) {
  const { lo } = RANGE[kind];
  let over = 0, push = 0, under = 0;
  pmf.forEach((p, j) => { const k = j + lo; if (k > line) over += p; else if (k === line) push += p; else under += p; });
  return { over, push, under };
}

/** −log p(observado): regla de puntuación logarítmica para la distribución discreta. */
export function discreteLogScore(pmf: Float64Array, kind: Kind, y: number) {
  const { lo, hi } = RANGE[kind];
  return -Math.log(Math.max(1e-9, pmf[Math.max(lo, Math.min(hi, y)) - lo]));
}
