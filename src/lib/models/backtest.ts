/**
 * Motor walk-forward: recorre las fechas en orden, pide a cada modelo su predicción para todos los
 * partidos de la fecha y solo después le da los resultados. Así ninguna predicción ve el futuro.
 *
 * Sobre esas predicciones se construye el ensamble con pesos exponenciales (Hedge / promedio
 * bayesiano de modelos) y se calculan las métricas por periodo.
 */
import { prisma } from "../prisma";
import { type MGame, type Model, type Prediction, type TeamGameEpa, brier, gaussNll, impliedNoVig, logLoss, normalCdf, normalInv, outcome } from "./core";

export type Records = { g: MGame; preds: Record<string, Prediction> }[];

export async function loadModelData(fromSeason = 2018) {
  const rows = await prisma.game.findMany({
    where: { season: { gte: fromSeason }, homeScore: { not: null }, awayScore: { not: null }, gameDate: { not: null } },
    orderBy: [{ gameDate: "asc" }, { gameId: "asc" }],
  });
  const games: MGame[] = rows.map((r) => ({
    id: r.gameId, season: r.season, week: r.week, type: r.gameType ?? "REG", date: (r.gameDate as Date).toISOString().slice(0, 10),
    home: r.homeTeamAbbr, away: r.awayTeamAbbr, hs: r.homeScore as number, as: r.awayScore as number, neutral: r.location === "Neutral",
    spread: r.spreadLine, total: r.totalLine, mlHome: r.homeMoneyline, mlAway: r.awayMoneyline,
    homeQb: r.homeQbName, awayQb: r.awayQbName, roof: r.roof, temp: r.temp, wind: r.wind,
  }));
  const plays = await prisma.play.findMany({
    where: { season: { gte: fromSeason }, playType: { in: ["pass", "run"] }, epa: { not: null } },
    select: { gameId: true, possessionTeamAbbr: true, defenseTeamAbbr: true, epa: true },
  });
  const bucket = new Map<string, { gameId: string; team: string; opp: string; vals: number[] }>();
  for (const p of plays) {
    if (!p.possessionTeamAbbr || !p.defenseTeamAbbr) continue;
    const k = `${p.gameId}|${p.possessionTeamAbbr}`;
    const b = bucket.get(k) ?? { gameId: p.gameId, team: p.possessionTeamAbbr, opp: p.defenseTeamAbbr, vals: [] };
    b.vals.push(p.epa as number);
    bucket.set(k, b);
  }
  const epaByGame = new Map<string, TeamGameEpa[]>();
  for (const b of bucket.values()) {
    const list = epaByGame.get(b.gameId) ?? [];
    list.push({ gameId: b.gameId, team: b.team, opp: b.opp, epa: Float64Array.from(b.vals) });
    epaByGame.set(b.gameId, list);
  }
  const teams = [...new Set(games.flatMap((g) => [g.home, g.away]))].sort();
  return { games, epaByGame, teams, plays: plays.length };
}

export function runWalkForward(games: MGame[], models: Model[]): Records {
  const out: Records = [];
  let i = 0;
  while (i < games.length) {
    const date = games[i].date;
    const day: MGame[] = [];
    while (i < games.length && games[i].date === date) day.push(games[i++]);
    for (const g of day) {
      const preds: Record<string, Prediction> = {};
      for (const m of models) preds[m.key] = m.predict(g);
      out.push({ g, preds });
    }
    for (const m of models) m.update(day);
  }
  return out;
}

// ------------------------------------------------------------------ Ensamble (Hedge)
export type EnsembleParams = { eta: number; gamma: number; startSeason: number };
export type WeightSnapshot = { date: string; season: number; week: number; win: Record<string, number>; margin: Record<string, number>; total: Record<string, number> };

/**
 * Pesos w_m ∝ exp(−η·L_m), con L_m = Σ γ^(semanas transcurridas)·pérdida. Con η = 1 y la pérdida
 * logarítmica, la mezcla lineal es exactamente el promedio bayesiano de modelos (BMA) con olvido γ.
 * Probabilidad de victoria: mezcla lineal. Margen y total: mezcla de normales (media y varianza de la mezcla).
 */
export function addEnsemble(records: Records, keys: string[], params: EnsembleParams) {
  const L = { win: new Map<string, number>(), margin: new Map<string, number>(), total: new Map<string, number>() };
  for (const k of keys) { L.win.set(k, 0); L.margin.set(k, 0); L.total.set(k, 0); }
  const weights: WeightSnapshot[] = [];
  const wOf = (map: Map<string, number>, avail: string[]) => {
    const min = Math.min(...avail.map((k) => map.get(k) as number));
    const raw = avail.map((k) => Math.exp(-params.eta * ((map.get(k) as number) - min)));
    const s = raw.reduce((a, b) => a + b, 0);
    return Object.fromEntries(avail.map((k, j) => [k, raw[j] / s]));
  };
  let i = 0;
  let lastWeekIndex: number | null = null;
  while (i < records.length) {
    const date = records[i].g.date;
    const day: Records = [];
    while (i < records.length && records[i].g.date === date) day.push(records[i++]);
    const weekIndex = Math.floor(Date.parse(date) / (7 * 86400000));
    if (lastWeekIndex !== null && weekIndex > lastWeekIndex) {
      const f = params.gamma ** (weekIndex - lastWeekIndex);
      for (const map of Object.values(L)) for (const k of keys) map.set(k, (map.get(k) as number) * f);
    }
    lastWeekIndex = weekIndex;
    const withMargin = keys.filter((k) => day[0].preds[k].margin !== null);
    const withTotal = keys.filter((k) => day[0].preds[k].total !== null);
    const w = { win: wOf(L.win, keys), margin: wOf(L.margin, withMargin), total: wOf(L.total, withTotal) };
    weights.push({ date, season: day[0].g.season, week: day[0].g.week, ...w });
    for (const r of day) {
      const p = keys.reduce((s, k) => s + w.win[k] * r.preds[k].p, 0);
      const mix = (avail: string[], wt: Record<string, number>, mu: (pr: Prediction) => number, sd: (pr: Prediction) => number) => {
        const m = avail.reduce((s, k) => s + wt[k] * mu(r.preds[k]), 0);
        const v = avail.reduce((s, k) => s + wt[k] * (sd(r.preds[k]) ** 2 + (mu(r.preds[k]) - m) ** 2), 0);
        return { m, sd: Math.sqrt(v) };
      };
      const mm = mix(withMargin, w.margin, (x) => x.margin as number, (x) => x.sdMargin as number);
      const tt = mix(withTotal, w.total, (x) => x.total as number, (x) => x.sdTotal as number);
      r.preds.ensemble = { p, margin: mm.m, sdMargin: mm.sd, total: tt.m, sdTotal: tt.sd };
      (r as { mixture?: unknown }).mixture = { win: w.win, margin: w.margin, total: w.total };
    }
    if (day[0].g.season < params.startSeason) continue;
    for (const r of day) {
      const y = outcome(r.g);
      for (const k of keys) {
        const pr = r.preds[k];
        L.win.set(k, (L.win.get(k) as number) + logLoss(pr.p, y));
        if (pr.margin !== null) L.margin.set(k, (L.margin.get(k) as number) + gaussNll(r.g.hs - r.g.as, pr.margin, pr.sdMargin as number));
        if (pr.total !== null) L.total.set(k, (L.total.get(k) as number) + gaussNll(r.g.hs + r.g.as, pr.total, pr.sdTotal as number));
      }
    }
  }
  return weights;
}

/** P(margen > línea) bajo la mezcla de normales del ensamble: Σ w_m Φ((μ_m − línea)/σ_m). */
export function mixtureProb(r: Records[number], line: number, kind: "margin" | "total", shift = 0) {
  const mix = (r as { mixture?: { margin: Record<string, number>; total: Record<string, number> } }).mixture;
  if (!mix) return null;
  const wt = mix[kind];
  return Object.entries(wt).reduce((s, [k, w]) => {
    const pr = r.preds[k];
    const mu = kind === "margin" ? pr.margin : pr.total;
    const sd = kind === "margin" ? pr.sdMargin : pr.sdTotal;
    return s + w * (1 - normalCdf((line - (mu as number) - shift) / (sd as number)));
  }, 0);
}

// ------------------------------------------------------------------ Capa de ajuste por QB titular
export type QbInfo = { usualHome: string | null; usualAway: string | null; changeHome: boolean; changeAway: boolean; delta: number; n: number };

/**
 * Si un equipo arranca con un QB distinto a su titular habitual (el que más partidos inició de sus
 * últimos N; N se elige en la validación), el margen se corrige δ puntos en su contra. δ se estima en línea con los residuos de
 * partidos anteriores con cambio de QB, con una previa de k₀ partidos en δ = 0:
 *   δ̂ = Σ residuos / (n + k₀).
 * Cada modelo se desplaza en su escala: μ' = μ − δ·s y P' = Φ(Φ⁻¹(P) − δ·s/σ), s = +1 local, −1 visita.
 */
export function addQbLayer(records: Records, base: string, out: string, k0: number, window = 8, seasonFirst = false, startSeason = 2019) {
  const hist = new Map<string, string[]>();
  const seasonHist = new Map<string, string[]>(); // clave equipo_temporada
  let curSeason = 0;
  const usual = (t: string) => {
    // Regla "temporada primero": con 2+ partidos jugados en la temporada, el habitual es el que más inició en ella.
    const sh = seasonHist.get(`${t}_${curSeason}`) ?? [];
    const h = seasonFirst && sh.length >= 2 ? sh : (hist.get(t) ?? []).slice(-window);
    if (h.length < 3) return null;
    const c = new Map<string, number>();
    h.forEach((q) => c.set(q, (c.get(q) ?? 0) + 1));
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  let sum = 0, n = 0;
  const info = new Map<string, QbInfo>();
  let i = 0;
  while (i < records.length) {
    const date = records[i].g.date;
    const day: Records = [];
    while (i < records.length && records[i].g.date === date) day.push(records[i++]);
    const delta = n + k0 > 0 ? sum / (n + k0) : 0;
    curSeason = day[0].g.season;
    const pending: { res: number }[] = [];
    for (const r of day) {
      const g = r.g;
      const uh = usual(g.home), ua = usual(g.away);
      const ch = Boolean(uh && g.homeQb && g.homeQb !== uh), ca = Boolean(ua && g.awayQb && g.awayQb !== ua);
      const s = (ch ? 1 : 0) - (ca ? 1 : 0); // +1: solo el local cambió; −1: solo la visita
      const pr = r.preds[base];
      const shift = -delta * s;
      const sd = pr.sdMargin ?? 13.5;
      r.preds[out] = { ...pr, p: s ? normalCdf(normalInv(pr.p) + shift / sd) : pr.p, margin: pr.margin === null ? null : pr.margin + shift };
      info.set(g.id, { usualHome: uh, usualAway: ua, changeHome: ch, changeAway: ca, delta, n });
      if (s && g.season >= startSeason && pr.margin !== null) pending.push({ res: -(g.hs - g.as - pr.margin) * s });
    }
    for (const p of pending) { sum += p.res; n++; }
    for (const r of day) {
      if (r.g.homeQb) { hist.set(r.g.home, [...(hist.get(r.g.home) ?? []), r.g.homeQb]); seasonHist.set(`${r.g.home}_${r.g.season}`, [...(seasonHist.get(`${r.g.home}_${r.g.season}`) ?? []), r.g.homeQb]); }
      if (r.g.awayQb) { hist.set(r.g.away, [...(hist.get(r.g.away) ?? []), r.g.awayQb]); seasonHist.set(`${r.g.away}_${r.g.season}`, [...(seasonHist.get(`${r.g.away}_${r.g.season}`) ?? []), r.g.awayQb]); }
    }
  }
  return info;
}

// ------------------------------------------------------------------ Capa de bajas y clima (tabla 5.3 medida con datos)
export const AVAIL_GROUPS = ["ol", "skill", "front", "db"] as const;
export type AvailGroup = (typeof AVAIL_GROUPS)[number];
const POS_GROUP: Record<string, AvailGroup> = { T: "ol", G: "ol", C: "ol", WR: "skill", TE: "skill", RB: "skill", FB: "skill", DE: "front", DT: "front", NT: "front", OLB: "front", ILB: "front", MLB: "front", LB: "front", CB: "db", FS: "db", SS: "db", DB: "db", S: "db" };
export type TeamAvail = { counts: Record<AvailGroup, number>; out: { name: string; group: AvailGroup; status: string }[] };
export type GameContext = { home: TeamAvail; away: TeamAvail; wind: boolean; dome: boolean; cold: boolean };

/**
 * Titulares habituales fuera en cada partido. "Titular habitual" = depth_team 1 en al menos la mitad
 * de las últimas 8 semanas publicadas por su equipo ANTES del partido (sin QB: lo cubre la capa de QB).
 * "Fuera" = inactivo del día del partido (INA) o en lista de reserva (RES: lesionados, PUP…) esa semana.
 */
export async function loadGameContext(games: MGame[]) {
  const depth = await prisma.depthChartEntry.findMany({ where: { depthTeam: 1 }, select: { season: true, week: true, teamAbbr: true, gsisId: true, position: true } });
  const rs = await prisma.rosterStatus.findMany({ where: { status: { in: ["INA", "RES"] } }, select: { season: true, week: true, teamAbbr: true, gsisId: true, status: true, fullName: true } });
  const wk = (season: number, week: number) => `${season}_${String(week).padStart(2, "0")}`;
  const byTeam = new Map<string, Map<string, Map<string, AvailGroup>>>();
  for (const r of depth) {
    const g = POS_GROUP[r.position ?? ""];
    if (!r.gsisId || !g) continue;
    const t = byTeam.get(r.teamAbbr) ?? new Map<string, Map<string, AvailGroup>>();
    const m = t.get(wk(r.season, r.week)) ?? new Map<string, AvailGroup>();
    m.set(r.gsisId, g);
    t.set(wk(r.season, r.week), m);
    byTeam.set(r.teamAbbr, t);
  }
  const sortedKeys = new Map([...byTeam.entries()].map(([t, m]) => [t, [...m.keys()].sort()]));
  const outMap = new Map(rs.map((o) => [`${o.season}_${o.week}_${o.teamAbbr}_${o.gsisId}`, o]));
  const starters = (team: string, season: number, week: number) => {
    const t = byTeam.get(team);
    if (!t) return null;
    const cur = wk(season, week);
    const prev = (sortedKeys.get(team) ?? []).filter((k) => k < cur).slice(-8);
    if (prev.length < 4) return null;
    const cnt = new Map<string, { n: number; g: AvailGroup }>();
    for (const k of prev) for (const [id, g] of t.get(k) as Map<string, AvailGroup>) { const c = cnt.get(id) ?? { n: 0, g }; c.n++; cnt.set(id, c); }
    return [...cnt.entries()].filter(([, c]) => c.n >= prev.length / 2).map(([id, c]) => ({ id, g: c.g }));
  };
  const avail = (g: MGame, team: string): TeamAvail | null => {
    const list = starters(team, g.season, g.week);
    if (!list) return null;
    const counts = { ol: 0, skill: 0, front: 0, db: 0 } as Record<AvailGroup, number>;
    const out: TeamAvail["out"] = [];
    for (const p of list) {
      const o = outMap.get(`${g.season}_${g.week}_${team}_${p.id}`);
      if (o) { counts[p.g]++; out.push({ name: o.fullName, group: p.g, status: o.status }); }
    }
    return { counts, out };
  };
  const ctx = new Map<string, GameContext>();
  for (const g of games) {
    const h = avail(g, g.home), a = avail(g, g.away);
    if (!h || !a) continue;
    const outdoors = g.roof === "outdoors" || g.roof === "open";
    ctx.set(g.id, { home: h, away: a, wind: outdoors && (g.wind ?? 0) > 15.5, dome: g.roof === "dome" || g.roof === "closed", cold: outdoors && g.temp !== null && g.temp < 32 });
  }
  return ctx;
}

export const MARGIN_FEATURES = AVAIL_GROUPS.map((gr) => `margen · ${gr}`);
export const TOTAL_FEATURES = ["total · bajas ofensivas", "total · bajas defensivas", "total · viento > 25 km/h", "total · domo/techo cerrado", "total · frío < 0 °C"];
export function contextFeatures(c: GameContext) {
  const off = (t: TeamAvail) => t.counts.ol + t.counts.skill, def = (t: TeamAvail) => t.counts.front + t.counts.db;
  return {
    // Margen: diferencia local − visita de titulares fuera por grupo (β < 0 esperado).
    margin: AVAIL_GROUPS.map((gr) => c.home.counts[gr] - c.away.counts[gr]),
    // Total: bajas ofensivas y defensivas de ambos equipos, y condiciones de clima de la tabla 5.3.
    total: [off(c.home) + off(c.away), def(c.home) + def(c.away), c.wind ? 1 : 0, c.dome ? 1 : 0, c.cold ? 1 : 0],
  };
}

export type ContextInfo = { betaMargin: number[]; betaTotal: number[]; xMargin: number[]; xTotal: number[]; shiftMargin: number; shiftTotal: number; n: number };

/**
 * Regresión ridge en línea sobre los residuos del modelo anterior (sin mirar el partido que se predice):
 *   β̂ = (XᵀX + k₀I)⁻¹ Xᵀr   para el margen (4 grupos) y para el total (bajas y clima).
 * La previa k₀ encoge hacia 0 (sin efecto) hasta que hay evidencia. Después: μ' = μ + xᵀβ̂ y
 * P' = Φ(Φ⁻¹(P) + xᵀβ̂/σ).
 */
export function addContextLayer(records: Records, base: string, out: string, ctx: Map<string, GameContext>, k0: number, startSeason = 2019) {
  const pm = MARGIN_FEATURES.length, pt = TOTAL_FEATURES.length;
  const A = { m: Array.from({ length: pm }, () => new Float64Array(pm)), t: Array.from({ length: pt }, () => new Float64Array(pt)) };
  const b = { m: new Float64Array(pm), t: new Float64Array(pt) };
  let n = 0;
  const solve = (M: Float64Array[], v: Float64Array) => {
    const R = M.map((row, i) => { const r = Float64Array.from(row); r[i] += k0; return r; });
    return Array.from(solveGeneral(R, v));
  };
  const info = new Map<string, ContextInfo>();
  let i = 0;
  while (i < records.length) {
    const date = records[i].g.date;
    const day: Records = [];
    while (i < records.length && records[i].g.date === date) day.push(records[i++]);
    const bm = solve(A.m, b.m), bt = solve(A.t, b.t);
    const pending: { xm: number[]; xt: number[]; rm: number; rt: number }[] = [];
    for (const r of day) {
      const pr = r.preds[base];
      const c = ctx.get(r.g.id);
      if (!c || pr.margin === null) { r.preds[out] = { ...pr }; continue; }
      const f = contextFeatures(c);
      const sm = f.margin.reduce((s, x, j) => s + x * bm[j], 0);
      const st = pr.total === null ? 0 : f.total.reduce((s, x, j) => s + x * bt[j], 0);
      r.preds[out] = {
        ...pr,
        p: sm ? normalCdf(normalInv(pr.p) + sm / (pr.sdMargin ?? 13.5)) : pr.p,
        margin: pr.margin + sm,
        total: pr.total === null ? null : pr.total + st,
      };
      info.set(r.g.id, { betaMargin: bm, betaTotal: bt, xMargin: f.margin, xTotal: f.total, shiftMargin: sm, shiftTotal: st, n });
      if (r.g.season >= startSeason && pr.total !== null) pending.push({ xm: f.margin, xt: f.total, rm: r.g.hs - r.g.as - pr.margin, rt: r.g.hs + r.g.as - pr.total });
    }
    for (const p of pending) {
      for (let a = 0; a < pm; a++) { b.m[a] += p.xm[a] * p.rm; for (let c = 0; c < pm; c++) A.m[a][c] += p.xm[a] * p.xm[c]; }
      for (let a = 0; a < pt; a++) { b.t[a] += p.xt[a] * p.rt; for (let c = 0; c < pt; c++) A.t[a][c] += p.xt[a] * p.xt[c]; }
      n++;
    }
  }
  return info;
}

/** Mínimos cuadrados ordinarios con errores estándar (para mostrar la evidencia de cada efecto). */
export function olsWithSe(X: number[][], y: number[]) {
  const p = X[0].length;
  const M = Array.from({ length: p }, () => new Float64Array(p));
  const v = new Float64Array(p);
  X.forEach((x, i) => { for (let a = 0; a < p; a++) { v[a] += x[a] * y[i]; for (let c = 0; c < p; c++) M[a][c] += x[a] * x[c]; } });
  const beta = Array.from(solveGeneral(M, v));
  const res = y.map((yi, i) => yi - X[i].reduce((s, xv, j) => s + xv * beta[j], 0));
  const s2 = res.reduce((s, r) => s + r * r, 0) / Math.max(1, y.length - p);
  const inv = invert(M);
  return beta.map((bj, j) => ({ beta: bj, se: Math.sqrt(s2 * inv[j][j]) }));
}
function solveGeneral(M: Float64Array[], v: Float64Array) {
  const p = v.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= p; k++) A[r][k] -= f * A[c][k]; }
  }
  return Float64Array.from(A.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[p] / r[i])));
}
function invert(M: Float64Array[]) {
  const n = M.length;
  const A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let pv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pv][c])) pv = r;
    [A[c], A[pv]] = [A[pv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let k = 0; k < 2 * n; k++) A[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((r) => r.slice(n));
}

// ------------------------------------------------------------------ Métricas
export function marketPrediction(g: MGame, sd = 13.45): Prediction | null {
  const p = impliedNoVig(g.mlHome, g.mlAway) ?? (g.spread !== null ? normalCdf(g.spread / sd) : null);
  if (p === null) return null;
  return { p, margin: g.spread, sdMargin: sd, total: g.total, sdTotal: sd };
}

export type Score = {
  n: number; logLoss: number; brier: number; accuracy: number;
  marginMae: number | null; marginRmse: number | null; totalMae: number | null; marginNll: number | null;
  vsMarket: { diff: number; se: number; z: number } | null;
  ats: { n: number; wins: number; losses: number; pushes: number; rate: number; se: number } | null;
  calibration: { bin: number; n: number; predicted: number; observed: number }[];
};

export function score(records: Records, key: string, filter: (g: MGame) => boolean, atsThreshold = 1.5): Score {
  const rs = records.filter((r) => filter(r.g) && r.preds[key]);
  let ll = 0, br = 0, acc = 0, mae = 0, mse = 0, tmae = 0, nll = 0, nm = 0, nt = 0;
  const diffs: number[] = [];
  const bins = Array.from({ length: 10 }, (_, b) => ({ bin: b, n: 0, sp: 0, so: 0 }));
  const ats = { n: 0, wins: 0, losses: 0, pushes: 0 };
  for (const r of rs) {
    const pr = r.preds[key];
    const y = outcome(r.g);
    ll += logLoss(pr.p, y); br += brier(pr.p, y);
    acc += y === 0.5 ? 0.5 : (pr.p >= 0.5) === (y === 1) ? 1 : 0;
    const b = bins[Math.min(9, Math.floor(pr.p * 10))];
    b.n++; b.sp += pr.p; b.so += y;
    const mk = marketPrediction(r.g);
    if (mk) diffs.push(logLoss(pr.p, y) - logLoss(mk.p, y));
    const m = r.g.hs - r.g.as;
    if (pr.margin !== null) {
      mae += Math.abs(m - pr.margin); mse += (m - pr.margin) ** 2; nll += gaussNll(m, pr.margin, pr.sdMargin as number); nm++;
      if (r.g.spread !== null && key !== "market" && Math.abs(pr.margin - r.g.spread) >= atsThreshold) {
        ats.n++;
        const side = pr.margin > r.g.spread ? 1 : -1;
        const res = (m - r.g.spread) * side;
        if (res > 0) ats.wins++; else if (res < 0) ats.losses++; else ats.pushes++;
      }
    }
    if (pr.total !== null) { tmae += Math.abs(r.g.hs + r.g.as - pr.total); nt++; }
  }
  const n = rs.length;
  const md = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
  const sdd = Math.sqrt(diffs.reduce((a, b) => a + (b - md) ** 2, 0) / Math.max(1, diffs.length - 1));
  const decided = ats.wins + ats.losses;
  const rate = decided ? ats.wins / decided : 0;
  return {
    n, logLoss: ll / n, brier: br / n, accuracy: acc / n,
    marginMae: nm ? mae / nm : null, marginRmse: nm ? Math.sqrt(mse / nm) : null, totalMae: nt ? tmae / nt : null, marginNll: nm ? nll / nm : null,
    vsMarket: diffs.length && key !== "market" ? { diff: md, se: sdd / Math.sqrt(diffs.length), z: md / (sdd / Math.sqrt(diffs.length)) } : null,
    ats: ats.n ? { ...ats, rate, se: Math.sqrt((rate * (1 - rate)) / Math.max(1, decided)) } : null,
    calibration: bins.filter((b) => b.n).map((b) => ({ bin: b.bin, n: b.n, predicted: b.sp / b.n, observed: b.so / b.n })),
  };
}

export function withMarket(records: Records) {
  for (const r of records) {
    const mk = marketPrediction(r.g);
    if (mk) r.preds.market = mk;
  }
  return records;
}
