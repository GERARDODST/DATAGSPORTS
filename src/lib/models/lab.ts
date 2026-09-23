/**
 * Laboratorio de modelos: definición de cada modelo con su rejilla de optimización, corrida final
 * walk-forward, ensamble y resúmenes para la página.
 *
 * Protocolo (sin fuga de información):
 *  - 2018 (y 2019 para EPA) solo calientan los modelos; nunca se puntúan.
 *  - Entrenamiento 2020–2022: se eligen los hiperparámetros de cada modelo.
 *  - Validación 2023: se eligen los parámetros del ensamble (η, γ).
 *  - Prueba 2024: nada se ajusta; es la medición honesta.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type MGame, type Model, type TeamGameEpa, clampP, logit, logLoss, outcome } from "./core";
import { FrameworkModel, EloModel, KalmanModel, RidgeModel, EpaModel, type EloParams } from "./models";
import { addContextLayer, addEnsemble, addQbLayer, mixtureProb, olsWithSe, contextFeatures, runWalkForward, score, withMarket, MARGIN_FEATURES, TOTAL_FEATURES, type ContextInfo, type GameContext, type QbInfo, type Records, type WeightSnapshot } from "./backtest";
import { optimize, type TraceEntry } from "./optimize";

export type LabData = { games: MGame[]; epaByGame: Map<string, TeamGameEpa[]>; teams: string[]; ctx: Map<string, GameContext> };
type Spec = {
  key: string;
  label: string;
  start: Record<string, number>;
  grid: Record<string, number[]>;
  build: (p: Record<string, number>, d: LabData) => Model;
};

const totalSd2018 = (d: LabData) => {
  const xs = d.games.filter((g) => g.season === 2018).map((g) => g.hs + g.as);
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

export const SPECS: Spec[] = [
  {
    key: "framework", label: "Framework (λ + triangulación)",
    start: { priorWeight: 0.5, shrinkK: 6 },
    grid: { priorWeight: [0.2, 0.35, 0.5, 0.65, 0.8, 1], shrinkK: [2, 4, 6, 8, 10, 14, 20, 30] },
    build: (p) => new FrameworkModel(p as never),
  },
  {
    key: "elo", label: "Elo (FiveThirtyEight)",
    start: { k: 20, hfa: 65, revert: 1 / 3, eloPerPoint: 25 },
    grid: { k: [10, 15, 20, 25, 30, 40], hfa: [0, 10, 20, 30, 40, 55, 65], revert: [0.15, 0.25, 1 / 3, 0.4, 0.5, 0.65] },
    build: (p) => new EloModel(p as never),
  },
  {
    key: "kalman", label: "Kalman ofensiva/defensa (Glickman–Stern)",
    start: { sigma: 9.5, rho: 0, omegaWeek: 0.6, betaSeason: 0.7, omegaSeason: 2.5, p0: 4 },
    grid: { sigma: [8, 9, 9.5, 10, 11, 12], omegaWeek: [0.2, 0.4, 0.6, 0.8, 1, 1.4], betaSeason: [0.4, 0.55, 0.7, 0.8, 0.9, 1], omegaSeason: [0.5, 1, 1.5, 2, 2.5, 3.5], p0: [2, 3, 4, 6, 8, 12], rho: [-0.2, -0.1, 0, 0.1, 0.2, 0.3] },
    build: (p, d) => new KalmanModel(d.teams, p as never),
  },
  {
    key: "ridge", label: "Ridge de puntos (Harville–Massey)",
    start: { lambda: 4, halfLife: 20 },
    grid: { lambda: [1, 2, 4, 8, 16, 32], halfLife: [6, 10, 15, 20, 30, 45, 70] },
    build: (p, d) => new RidgeModel(d.teams, p as never, totalSd2018(d)),
  },
  {
    key: "epa", label: "EPA ajustada por rival (ridge)",
    start: { lambda: 400, halfLife: 20, clip: 6 },
    grid: { lambda: [5, 10, 25, 50, 100, 200, 400], halfLife: [6, 10, 15, 20, 30, 45, 70], clip: [0.75, 1, 1.5, 2, 3, 6] },
    build: (p, d) => new EpaModel(d.teams, d.epaByGame, p as never, totalSd2018(d)),
  },
];
export const MODEL_KEYS = SPECS.map((s) => s.key);

export type Split = { name: string; trainFrom: number; trainTo: number };
export const SPLITS: Split[] = [
  { name: "principal", trainFrom: 2020, trainTo: 2022 },
  { name: "estabilidad", trainFrom: 2019, trainTo: 2021 },
];

export type ParamsFile = {
  createdAt: string;
  protocol: string;
  splits: {
    split: Split;
    models: Record<string, { best: Record<string, number>; start: Record<string, number>; initialLoss: number; bestLoss: number; evaluations: number; seconds: number; trace: TraceEntry[] }>;
  }[];
  ensemble: { eta: number; gamma: number; grid: { eta: number; gamma: number; loss: number }[] };
  qb: { k0: number | null; window: number; seasonFirst: boolean; grid: { k0: number | null; window: number; seasonFirst: boolean; loss: number }[] };
  context: { k0: number | null; grid: { k0: number | null; loss: number; lossMargin: number; lossTotal: number }[] };
};

/** Optimiza cada modelo en un split (walk-forward con datos hasta el final del entrenamiento). */
export function optimizeSplit(d: LabData, split: Split) {
  const games = d.games.filter((g) => g.season <= split.trainTo);
  const inTrain = (g: MGame) => g.season >= split.trainFrom && g.season <= split.trainTo;
  const out: ParamsFile["splits"][number]["models"] = {};
  for (const s of SPECS) {
    const t0 = Date.now();
    const r = optimize({ build: (p) => s.build(p, d), start: s.start, grid: s.grid, games, inTrain });
    let best = r.best;
    if (s.key === "elo") best = { ...best, eloPerPoint: fitEloPerPoint(games.filter(inTrain), d, best) };
    out[s.key] = { best, start: s.start, initialLoss: r.initialLoss, bestLoss: r.bestLoss, evaluations: r.evaluations, seconds: (Date.now() - t0) / 1000, trace: r.trace };
  }
  return out;
}

/**
 * Puntos por unidad de Elo por mínimos cuadrados sin intercepto: margen ≈ d/c ⇒ c = Σd² / Σ(d·margen).
 * Solo afecta la conversión a margen (spread), no la probabilidad de victoria.
 */
function fitEloPerPoint(trainGames: MGame[], d: LabData, p: Record<string, number>) {
  const m = new EloModel({ ...(p as EloParams), eloPerPoint: 1 });
  const ids = new Set(trainGames.map((g) => g.id));
  const rec = runWalkForward(d.games.filter((g) => g.season <= Math.max(...trainGames.map((x) => x.season))), [m]);
  let sdd = 0, sdm = 0;
  for (const r of rec) if (ids.has(r.g.id)) { const dd = r.preds.elo.margin as number; sdd += dd * dd; sdm += dd * (r.g.hs - r.g.as); }
  return Math.round((sdd / sdm) * 10) / 10;
}

export function buildModels(d: LabData, params: Record<string, Record<string, number>>) {
  return SPECS.map((s) => s.build(params[s.key] ?? s.start, d));
}

/** Ajusta η y γ del ensamble en la validación (2023). */
export function tuneEnsemble(d: LabData, params: Record<string, Record<string, number>>, validSeason = 2023) {
  const base = runWalkForward(d.games.filter((g) => g.season <= validSeason), buildModels(d, params));
  const grid: { eta: number; gamma: number; loss: number }[] = [];
  for (const eta of [0, 0.25, 0.5, 1, 2, 4, 8]) {
    for (const gamma of [0.9, 0.95, 0.98, 0.99, 1]) {
      const rec: Records = base.map((r) => ({ g: r.g, preds: { ...r.preds } }));
      addEnsemble(rec, MODEL_KEYS, { eta, gamma, startSeason: 2019 });
      const vs = rec.filter((r) => r.g.season === validSeason);
      grid.push({ eta, gamma, loss: vs.reduce((s, r) => s + logLoss(r.preds.ensemble.p, outcome(r.g)), 0) / vs.length });
    }
  }
  const best = grid.reduce((a, b) => (b.loss < a.loss ? b : a));
  // Capa de QB: previa k₀ (null = sin capa), elegida también en la validación.
  const rec: Records = base.map((r) => ({ g: r.g, preds: { ...r.preds } }));
  addEnsemble(rec, MODEL_KEYS, { eta: best.eta, gamma: best.gamma, startSeason: 2019 });
  const vs = rec.filter((r) => r.g.season === validSeason);
  const qbGrid: { k0: number | null; window: number; seasonFirst: boolean; loss: number }[] = [{ k0: null, window: 0, seasonFirst: false, loss: vs.reduce((s, r) => s + logLoss(r.preds.ensemble.p, outcome(r.g)), 0) / vs.length }];
  for (const seasonFirst of [false, true]) {
    for (const window of [8, 12, 17, 24]) {
      for (const k0 of [15, 30, 60, 120, 250, 500]) {
        addQbLayer(rec, "ensemble", "qb", k0, window, seasonFirst);
        qbGrid.push({ k0, window, seasonFirst, loss: vs.reduce((s, r) => s + logLoss(r.preds.qb.p, outcome(r.g)), 0) / vs.length });
      }
    }
  }
  const bestQb = qbGrid.reduce((a, b) => (b.loss < a.loss ? b : a));
  // Capa de bajas y clima: previa k₀ elegida en la validación (null = sin capa). Se mide con la
  // log-loss de victoria y, como información, con la pérdida normal del margen y del total.
  addQbLayer(rec, "ensemble", "qb", bestQb.k0 ?? 1e9, bestQb.window || 8, bestQb.seasonFirst);
  const ctxGrid = [null, 10, 30, 100, 300, 1000, 3000].map((k0) => {
    const key = k0 === null ? "qb" : "final";
    if (k0 !== null) addContextLayer(rec, "qb", "final", d.ctx, k0);
    const nll = (x: number, m: number, sd: number) => 0.5 * Math.log(2 * Math.PI * sd * sd) + ((x - m) ** 2) / (2 * sd * sd);
    return {
      k0,
      loss: vs.reduce((s, r) => s + logLoss(r.preds[key].p, outcome(r.g)), 0) / vs.length,
      lossMargin: vs.reduce((s, r) => s + nll(r.g.hs - r.g.as, r.preds[key].margin as number, r.preds[key].sdMargin as number), 0) / vs.length,
      lossTotal: vs.reduce((s, r) => s + nll(r.g.hs + r.g.as, r.preds[key].total as number, r.preds[key].sdTotal as number), 0) / vs.length,
    };
  });
  const bestCtx = ctxGrid.reduce((a, b) => (b.loss < a.loss ? b : a));
  return { eta: best.eta, gamma: best.gamma, grid, qb: { k0: bestQb.k0, window: bestQb.window, seasonFirst: bestQb.seasonFirst, grid: qbGrid }, context: { k0: bestCtx.k0, grid: ctxGrid } };
}

export async function readParams(): Promise<ParamsFile | null> {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), "data", "model-params.json"), "utf8")) as ParamsFile;
  } catch {
    return null;
  }
}

/** Corrida final: todos los modelos con sus parámetros optimizados, ensamble y mercado. */
export function runFinal(d: LabData, pf: ParamsFile | null) {
  const params = Object.fromEntries(SPECS.map((s) => [s.key, pf?.splits[0]?.models[s.key]?.best ?? s.start]));
  const t0 = Date.now();
  const records = runWalkForward(d.games, buildModels(d, params));
  const weights = addEnsemble(records, MODEL_KEYS, { eta: pf?.ensemble.eta ?? 1, gamma: pf?.ensemble.gamma ?? 0.98, startSeason: 2019 });
  const k0 = pf?.qb?.k0 ?? null;
  const qb = addQbLayer(records, "ensemble", "qb", k0 ?? 1e9, pf?.qb?.window || 8, pf?.qb?.seasonFirst ?? false);
  const ctxK0 = pf?.context?.k0 ?? null;
  const context = addContextLayer(records, "qb", "final", d.ctx, ctxK0 ?? 1e12);
  withMarket(records);
  return { records, weights, params, qb, k0, context, ctxK0, ctx: d.ctx, seconds: (Date.now() - t0) / 1000 };
}

export type FinalRun = ReturnType<typeof runFinal>;

export const LABELS_EXTRA = { ensemble: "Ensamble (Hedge)", qb: "Ensamble + capa de QB", final: "Final: ensamble + QB + bajas y clima", market: "Mercado (momios de cierre)" };

const PERIODS: { key: string; label: string; test: (g: MGame) => boolean }[] = [
  { key: "train", label: "Entrenamiento 2020–2022", test: (g) => g.season >= 2020 && g.season <= 2022 },
  { key: "valid", label: "Validación 2023", test: (g) => g.season === 2023 },
  { key: "test", label: "Prueba 2024", test: (g) => g.season === 2024 },
];
const r4 = (v: number | null | undefined, d = 4) => (v === null || v === undefined ? null : Number(v.toFixed(d)));

/** Resumen para la página del laboratorio. */
export function labSummary(run: FinalRun, pf: ParamsFile | null) {
  const keys = [...MODEL_KEYS, "ensemble", "qb", "final", "market"];
  const labels: Record<string, string> = { ...Object.fromEntries(SPECS.map((s) => [s.key, s.label])), ...LABELS_EXTRA };
  const leaderboard = PERIODS.map((p) => ({
    period: p.key, label: p.label,
    rows: keys.map((k) => {
      const s = score(run.records, k, p.test);
      return {
        key: k, label: labels[k], n: s.n, logLoss: r4(s.logLoss), brier: r4(s.brier), accuracy: r4(s.accuracy, 3),
        marginMae: r4(s.marginMae, 2), marginRmse: r4(s.marginRmse, 2), totalMae: r4(s.totalMae, 2),
        vsMarket: s.vsMarket ? { diff: r4(s.vsMarket.diff), se: r4(s.vsMarket.se), z: r4(s.vsMarket.z, 2) } : null,
        ats: s.ats ? { ...s.ats, rate: r4(s.ats.rate, 3), se: r4(s.ats.se, 3) } : null,
      };
    }),
  }));
  const calibration = Object.fromEntries(["final", "market"].map((k) => [k, score(run.records, k, (g) => g.season >= 2023).calibration.map((b) => ({ ...b, predicted: r4(b.predicted, 3), observed: r4(b.observed, 3) }))]));
  const weights2024 = run.weights.filter((w) => w.season === 2024).map((w) => ({ date: w.date, week: w.week, win: Object.fromEntries(Object.entries(w.win).map(([k, v]) => [k, r4(v, 3)])) }));
  // Pérdida acumulada por semana en 2024 (para ver quién va ganando el torneo).
  const cumulative: { week: number; loss: Record<string, number> }[] = [];
  const acc: Record<string, { s: number; n: number }> = Object.fromEntries(keys.map((k) => [k, { s: 0, n: 0 }]));
  const weeks = [...new Set(run.records.filter((r) => r.g.season === 2024).map((r) => r.g.week))].sort((a, b) => a - b);
  for (const w of weeks) {
    for (const r of run.records.filter((x) => x.g.season === 2024 && x.g.week === w)) {
      for (const k of keys) if (r.preds[k]) { acc[k].s += logLoss(r.preds[k].p, outcome(r.g)); acc[k].n++; }
    }
    cumulative.push({ week: w, loss: Object.fromEntries(keys.map((k) => [k, r4(acc[k].s / Math.max(1, acc[k].n))])) as Record<string, number> });
  }
  return {
    protocol: PERIODS.map((p) => p.label),
    labels,
    params: run.params,
    ensemble: pf ? { eta: pf.ensemble.eta, gamma: pf.ensemble.gamma, grid: pf.ensemble.grid.map((g) => ({ ...g, loss: r4(g.loss, 5) })) } : null,
    qb: pf?.qb ? { k0: pf.qb.k0, window: pf.qb.window, seasonFirst: pf.qb.seasonFirst, grid: pf.qb.grid.map((g) => ({ ...g, loss: r4(g.loss, 5) })) } : null,
    qbStats: qbStats(run),
    context: contextEvidence(run, pf),
    experiments: experiments(run),
    optimization: pf?.splits.map((s) => ({
      split: s.split,
      models: Object.fromEntries(Object.entries(s.models).map(([k, m]) => [k, { best: m.best, start: m.start, initialLoss: r4(m.initialLoss), bestLoss: r4(m.bestLoss), evaluations: m.evaluations, seconds: r4(m.seconds, 1), trace: m.trace.map((t) => ({ ...t, loss: r4(t.loss, 5) })) }])),
    })) ?? [],
    optimizedAt: pf?.createdAt ?? null,
    runSeconds: r4(run.seconds, 2),
    games: run.records.length,
    leaderboard, calibration, weights2024, cumulative,
  };
}

export type GameModels = NonNullable<ReturnType<typeof gameModels>>;

/** Todo lo que el análisis de un partido necesita del torneo: predicciones, pesos y tabla a la fecha. */
export function gameModels(run: FinalRun, gameId: string) {
  const r = run.records.find((x) => x.g.id === gameId);
  if (!r) return null;
  const mix = (r as { mixture?: { win: Record<string, number>; margin: Record<string, number>; total: Record<string, number> } }).mixture;
  const season = r.g.season;
  const before = run.records.filter((x) => x.g.date < r.g.date && x.g.season === season);
  const sample = before.length >= 16 ? before : run.records.filter((x) => x.g.season === season - 1);
  const sampleLabel = before.length >= 16 ? `${season} antes de este partido (${before.length} partidos)` : `temporada ${season - 1} completa (${sample.length} partidos): todavía no hay suficientes partidos de ${season}`;
  const keys = [...MODEL_KEYS, "ensemble", "qb", "final", "market"];
  const table = keys.map((k) => {
    const rows = sample.filter((x) => x.preds[k]);
    const ll = rows.reduce((s, x) => s + logLoss(x.preds[k].p, outcome(x.g)), 0) / Math.max(1, rows.length);
    const acc = rows.reduce((s, x) => s + ((x.preds[k].p >= 0.5) === x.g.hs > x.g.as ? 1 : 0), 0) / Math.max(1, rows.length);
    return { key: k, logLoss: r4(ll), accuracy: r4(acc, 3), n: rows.length };
  });
  const qb = run.qb.get(gameId) ?? null;
  const shift = r.preds.final && r.preds.ensemble.margin !== null && r.preds.final.margin !== null ? r.preds.final.margin - r.preds.ensemble.margin : 0;
  const shiftQb = r.preds.qb && r.preds.ensemble.margin !== null && r.preds.qb.margin !== null ? r.preds.qb.margin - r.preds.ensemble.margin : 0;
  const shiftTotal = r.preds.final?.total !== null && r.preds.ensemble.total !== null ? (r.preds.final.total as number) - r.preds.ensemble.total : 0;
  const lineProb = (line: number | null, kind: "margin" | "total") => (line === null ? null : r4(mixtureProb(r, line, kind, kind === "margin" ? shift : shiftTotal), 4));
  return {
    preds: Object.fromEntries(keys.filter((k) => r.preds[k]).map((k) => [k, { p: r4(r.preds[k].p), margin: r4(r.preds[k].margin, 2), sdMargin: r4(r.preds[k].sdMargin, 2), total: r4(r.preds[k].total, 2), sdTotal: r4(r.preds[k].sdTotal, 2) }])),
    weights: mix ? { win: rnd(mix.win), margin: rnd(mix.margin), total: rnd(mix.total) } : null,
    table, sampleLabel,
    ensemble: {
      pHome: r4(r.preds.final.p) as number, pHomeNoQb: r4(r.preds.ensemble.p) as number, pHomeQb: r4(r.preds.qb.p) as number,
      margin: r4(r.preds.final.margin, 2) as number, sdMargin: r4(r.preds.final.sdMargin, 2) as number,
      total: r4(r.preds.final.total, 2) as number, sdTotal: r4(r.preds.final.sdTotal, 2) as number,
      pCover: lineProb(r.g.spread, "margin"), pOver: lineProb(r.g.total, "total"),
    },
    qb: qb ? { ...qb, delta: r4(qb.delta, 2), shift: r4(shiftQb, 2), homeQb: r.g.homeQb, awayQb: r.g.awayQb } : null,
    context: contextForGame(run, gameId),
    overLines: r.g.total === null ? [] : [-3, -1.5, 0, 1.5, 3].map((dl) => ({ line: (r.g.total as number) + dl, pOver: lineProb((r.g.total as number) + dl, "total") as number })),
  };
}
/** Regresión logística por Newton–Raphson (IRLS) con penalización ridge l2 (sin penalizar el intercepto). */
function fitLogit(X: number[][], y: number[], l2: number) {
  const p = X[0].length;
  let b = new Array(p).fill(0);
  for (let it = 0; it < 50; it++) {
    const g = new Array(p).fill(0);
    const H = Array.from({ length: p }, () => new Float64Array(p));
    X.forEach((x, i) => {
      const m = 1 / (1 + Math.exp(-x.reduce((s, v, j) => s + v * b[j], 0)));
      for (let j = 0; j < p; j++) { g[j] += (y[i] - m) * x[j]; for (let k = 0; k < p; k++) H[j][k] += m * (1 - m) * x[j] * x[k]; }
    });
    for (let j = 1; j < p; j++) { g[j] -= l2 * b[j]; H[j][j] += l2; }
    const step = solveSym(H, g);
    b = b.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return b;
}
function solveSym(H: Float64Array[], g: number[]) {
  const p = g.length;
  const A = H.map((r, i) => [...r, g[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r, i) => r[p] / r[i]);
}

/**
 * Alternativas al ensamble que se probaron y se decidieron con la validación 2023 (no con 2024):
 * recalibración de Platt y stacking logístico, ajustados con las predicciones walk-forward de 2019–2022.
 */
export function experiments(run: FinalRun) {
  const tr = run.records.filter((r) => r.g.season >= 2019 && r.g.season <= 2022 && outcome(r.g) !== 0.5);
  const y = tr.map((r) => (outcome(r.g) === 1 ? 1 : 0));
  const ll = (season: number, f: (r: Records[number]) => number) => {
    const v = run.records.filter((r) => r.g.season === season);
    return r4(v.reduce((a, r) => a + logLoss(f(r), outcome(r.g)), 0) / v.length);
  };
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  const platt = fitLogit(tr.map((r) => [1, logit(clampP(r.preds.final.p))]), y, 1e-3);
  const feats = (r: Records[number]) => [1, ...MODEL_KEYS.map((k) => logit(clampP(r.preds[k].p)))];
  const stack = fitLogit(tr.map(feats), y, 1);
  const base = { valid: ll(2023, (r) => r.preds.final.p), test: ll(2024, (r) => r.preds.final.p) };
  const rows = [
    { key: "final", label: "Final elegido: ensamble Hedge + capa de QB", formula: "p = Σ w_m p_m, con corrección por QB", coef: null as number[] | null, ...base },
    { key: "platt", label: "Recalibración de Platt", formula: "p' = σ(a + b·logit p)", coef: platt.map((v) => r4(v, 3) as number), valid: ll(2023, (r) => sig(platt[0] + platt[1] * logit(clampP(r.preds.final.p)))), test: ll(2024, (r) => sig(platt[0] + platt[1] * logit(clampP(r.preds.final.p)))) },
    { key: "stack", label: "Stacking logístico de los 5 modelos", formula: "p' = σ(b₀ + Σ b_m·logit p_m)", coef: stack.map((v) => r4(v, 3) as number), valid: ll(2023, (r) => sig(feats(r).reduce((s, v, j) => s + v * stack[j], 0))), test: ll(2024, (r) => sig(feats(r).reduce((s, v, j) => s + v * stack[j], 0))) },
  ];
  return rows.map((r) => ({ ...r, decision: r.key === "final" ? "Se usa" : (r.valid as number) < (base.valid as number) ? "Mejora la validación" : "Descartado: empeora la validación" }));
}

function contextForGame(run: FinalRun, gameId: string) {
  const c = run.ctx.get(gameId);
  const info = run.context.get(gameId) as ContextInfo | undefined;
  if (!c || !info) return null;
  return {
    home: c.home, away: c.away, wind: c.wind, dome: c.dome, cold: c.cold, n: info.n,
    marginFeatures: MARGIN_FEATURES.map((name, j) => ({ name, x: info.xMargin[j], beta: r4(info.betaMargin[j], 3) as number })),
    totalFeatures: TOTAL_FEATURES.map((name, j) => ({ name, x: info.xTotal[j], beta: r4(info.betaTotal[j], 3) as number })),
    shiftMargin: r4(info.shiftMargin, 2) as number, shiftTotal: r4(info.shiftTotal, 2) as number,
  };
}

/**
 * Evidencia de la tabla 5.3 medida con datos: MCO de los residuos del modelo (ensamble + QB) sobre
 * titulares fuera y clima en 2019–2024, con errores estándar. Junto a cada efecto, lo que asumía el
 * factor fijo del framework, traducido a puntos con la liga promedio (≈ 22 puntos por equipo).
 */
function contextEvidence(run: FinalRun, pf: ParamsFile | null) {
  const rows = run.records.filter((r) => r.g.season >= 2019 && run.ctx.has(r.g.id) && r.preds.qb?.margin !== null && r.preds.qb?.total !== null);
  if (rows.length < 50) return null;
  const F = rows.map((r) => contextFeatures(run.ctx.get(r.g.id) as GameContext));
  const m = olsWithSe(F.map((f) => f.margin), rows.map((r) => r.g.hs - r.g.as - (r.preds.qb.margin as number)));
  const t = olsWithSe(F.map((f) => f.total), rows.map((r) => r.g.hs + r.g.as - (r.preds.qb.total as number)));
  const n = (j: number, kind: "margin" | "total") => F.filter((f) => (kind === "margin" ? f.margin[j] : f.total[j]) !== 0).length;
  const framework: Record<string, string> = {
    "margen · ol": "×0.92 a los puntos propios ≈ −1.8 pts por condición",
    "margen · skill": "×0.92 a los puntos propios ≈ −1.8 pts por condición",
    "margen · front": "×1.08 a los puntos del rival ≈ −1.8 pts por condición",
    "margen · db": "×1.08 a los puntos del rival ≈ −1.8 pts por condición",
    "total · bajas ofensivas": "×0.92 ≈ −1.8 pts",
    "total · bajas defensivas": "×1.08 ≈ +1.8 pts",
    "total · viento > 25 km/h": "×0.90 ≈ −4.4 pts",
    "total · domo/techo cerrado": "×1.05 ≈ +2.2 pts",
    "total · frío < 0 °C": "×0.93 ≈ −3.1 pts",
  };
  const fmt = (name: string, e: { beta: number; se: number }, j: number, kind: "margin" | "total") => ({ name, beta: r4(e.beta, 2), se: r4(e.se, 2), z: r4(e.beta / e.se, 2), n: n(j, kind), framework: framework[name] ?? "" });
  return {
    games: rows.length,
    k0: pf?.context?.k0 ?? null,
    grid: pf?.context?.grid.map((g) => ({ ...g, loss: r4(g.loss, 5), lossMargin: r4(g.lossMargin, 4), lossTotal: r4(g.lossTotal, 4) })) ?? [],
    margin: MARGIN_FEATURES.map((name, j) => fmt(name, m[j], j, "margin")),
    total: TOTAL_FEATURES.map((name, j) => fmt(name, t[j], j, "total")),
  };
}

/** Residuos por tipo de partido según el QB: la evidencia que justifica la capa. */
function qbStats(run: FinalRun) {
  const b: Record<string, number[]> = { ninguno: [], local: [], visita: [], ambos: [] };
  for (const r of run.records) {
    const q = run.qb.get(r.g.id);
    if (!q || r.g.season < 2019 || !q.usualHome || !q.usualAway || r.preds.ensemble.margin === null) continue;
    const k = q.changeHome && q.changeAway ? "ambos" : q.changeHome ? "local" : q.changeAway ? "visita" : "ninguno";
    b[k].push(r.g.hs - r.g.as - r.preds.ensemble.margin);
  }
  return Object.entries(b).map(([k, xs]) => {
    const m = xs.reduce((a, c) => a + c, 0) / Math.max(1, xs.length);
    const sd = Math.sqrt(xs.reduce((a, c) => a + (c - m) ** 2, 0) / Math.max(1, xs.length - 1));
    return { case: k, n: xs.length, mean: r4(m, 2), se: r4(sd / Math.sqrt(Math.max(1, xs.length)), 2) };
  });
}
const rnd = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number(v.toFixed(3))]));

export type WeightsTimeline = WeightSnapshot[];
export type QbMap = Map<string, QbInfo>;
