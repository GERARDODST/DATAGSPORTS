/**
 * Optimización de hiperparámetros por descenso de coordenadas sobre rejillas.
 *
 * Objetivo: pérdida logarítmica media de P(gana local) en el periodo de entrenamiento. Cada
 * evaluación es un walk-forward completo (el modelo se reconstruye fecha por fecha), así que el
 * objetivo mide exactamente lo que el modelo haría en vivo, sin mirar el futuro.
 */
import type { MGame, Model } from "./core";
import { logLoss, outcome } from "./core";
import { runWalkForward } from "./backtest";

export type Grid<P> = { [K in keyof P]?: number[] };
export type TraceEntry = { pass: number; param: string; value: number; loss: number; chosen: boolean };

export function optimize<P extends Record<string, number>>(opts: {
  build: (p: P) => Model;
  start: P;
  grid: Grid<P>;
  games: MGame[];
  inTrain: (g: MGame) => boolean;
  maxPasses?: number;
}) {
  const cache = new Map<string, number>();
  const evaluate = (p: P) => {
    const key = JSON.stringify(p);
    if (cache.has(key)) return cache.get(key) as number;
    const m = opts.build(p);
    const rec = runWalkForward(opts.games, [m]);
    let s = 0, n = 0;
    for (const r of rec) if (opts.inTrain(r.g)) { s += logLoss(r.preds[m.key].p, outcome(r.g)); n++; }
    const loss = s / n;
    cache.set(key, loss);
    return loss;
  };
  let best = { ...opts.start };
  let bestLoss = evaluate(best);
  const initialLoss = bestLoss;
  const trace: TraceEntry[] = [];
  const passes = opts.maxPasses ?? 4;
  for (let pass = 1; pass <= passes; pass++) {
    let changed = false;
    for (const param of Object.keys(opts.grid) as (keyof P & string)[]) {
      const values = opts.grid[param] as number[];
      const results = values.map((v) => ({ v, loss: evaluate({ ...best, [param]: v }) }));
      const top = results.reduce((a, b) => (b.loss < a.loss - 1e-9 ? b : a), { v: best[param] as number, loss: bestLoss });
      for (const r of results) trace.push({ pass, param, value: r.v, loss: r.loss, chosen: r.v === top.v });
      if (top.v !== best[param]) { best = { ...best, [param]: top.v }; bestLoss = top.loss; changed = true; }
    }
    if (!changed) break;
  }
  return { best, bestLoss, initialLoss, evaluations: cache.size, trace };
}
