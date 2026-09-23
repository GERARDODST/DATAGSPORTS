/**
 * Los cinco modelos del torneo. Todos son "en línea": predicen cada fecha solo con los resultados
 * anteriores y después se actualizan. Ninguno usa momios del mercado como entrada.
 *
 *  1. framework — réplica pura del modelo de docs/nfl_framework_v1.md (λ con regresión a la media
 *     y triangulación Log5 / Elo / normal).
 *  2. elo       — Elo al estilo FiveThirtyEight con parámetros optimizables.
 *  3. kalman    — modelo de espacio de estados de Glickman y Stern (1998) con ofensiva y defensa:
 *     filtro de Kalman sobre 66 estados.
 *  4. ridge     — calificaciones de mínimos cuadrados penalizados (Harville 1980 / Massey) sobre los
 *     puntos, con decaimiento exponencial en el tiempo.
 *  5. epa       — EPA/jugada ajustada por rival con regresión ridge (equivalente al modelo multinivel
 *     de Open Source Football), convertida a puntos con una regresión estructural.
 */
import { type MGame, type Model, type Prediction, type TeamGameEpa, normalCdf, solveSpd, OnlineSd, STERN_SD } from "./core";

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86400000;

// ============================================================ 1. Framework (réplica)
export type FrameworkParams = { priorWeight: number; shrinkK: number };
export class FrameworkModel implements Model {
  key = "framework";
  label = "Framework (λ + triangulación)";
  private history: MGame[] = [];
  private elo = new Map<string, number>();
  private eloSeason: number | null = null;
  private cacheDate = "";
  private cache: ReturnType<FrameworkModel["ratings"]> | null = null;
  constructor(public params: FrameworkParams = { priorWeight: 0.5, shrinkK: 6 }) {}

  private ratings(season: number) {
    const { priorWeight, shrinkK } = this.params;
    const prior = this.history.filter((g) => g.season === season || g.season === season - 1);
    const w = (g: MGame) => (g.season === season ? 1 : priorWeight);
    let lw = 0, lp = 0;
    for (const g of prior) { lw += 2 * w(g); lp += w(g) * (g.hs + g.as); }
    const mu = lp / lw;
    const home = prior.filter((g) => !g.neutral);
    const hfa = home.reduce((s, g) => s + g.hs - g.as, 0) / Math.max(1, home.length);
    const last = prior.filter((g) => g.season === season - 1);
    const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
    const sigmaM = sd(last.map((g) => g.hs - g.as));
    const sigmaT = sd(last.map((g) => g.hs + g.as));
    const team = new Map<string, { off: number; def: number }>();
    const acc = new Map<string, { w: number; pf: number; pa: number }>();
    for (const g of prior) {
      for (const [t, pf, pa] of [[g.home, g.hs, g.as], [g.away, g.as, g.hs]] as const) {
        const a = acc.get(t) ?? { w: 0, pf: 0, pa: 0 };
        a.w += w(g); a.pf += w(g) * pf; a.pa += w(g) * pa;
        acc.set(t, a);
      }
    }
    for (const [t, a] of acc) {
      const rawOff = a.w ? a.pf / a.w : mu, rawDef = a.w ? a.pa / a.w : mu;
      team.set(t, { off: (a.w * rawOff + shrinkK * mu) / (a.w + shrinkK), def: (a.w * rawDef + shrinkK * mu) / (a.w + shrinkK) });
    }
    return { mu, hfa, sigmaM, sigmaT, team };
  }
  private regressIfNewSeason(season: number) {
    if (this.eloSeason !== null && this.eloSeason !== season) for (const [t, v] of this.elo) this.elo.set(t, v - (v - 1505) / 3);
    this.eloSeason = season;
  }
  predict(g: MGame): Prediction {
    if (this.cacheDate !== g.date) {
      this.regressIfNewSeason(g.season);
      this.cache = this.ratings(g.season);
      this.cacheDate = g.date;
    }
    const r = this.cache as NonNullable<typeof this.cache>;
    const H = r.team.get(g.home) ?? { off: r.mu, def: r.mu };
    const A = r.team.get(g.away) ?? { off: r.mu, def: r.mu };
    const hfa = g.neutral ? 0 : r.hfa;
    const lh = r.mu + (H.off - r.mu) + (A.def - r.mu) + hfa / 2;
    const la = r.mu + (A.off - r.mu) + (H.def - r.mu) - hfa / 2;
    const pyth = (o: number, d: number) => o ** 2.37 / (o ** 2.37 + d ** 2.37);
    const pH = pyth(H.off, H.def), pA = pyth(A.off, A.def);
    const pLog5 = Math.min(0.99, Math.max(0.01, (pH - pH * pA) / (pH + pA - 2 * pH * pA) + normalCdf(hfa / r.sigmaM) - 0.5));
    const eH = this.elo.get(g.home) ?? 1500, eA = this.elo.get(g.away) ?? 1500;
    const pElo = 1 / (1 + 10 ** (-(eH + (g.neutral ? 0 : 48) - eA) / 400));
    const pSim = normalCdf((lh - la) / r.sigmaM);
    return { p: (pLog5 + pElo + pSim) / 3, margin: lh - la, sdMargin: r.sigmaM, total: lh + la, sdTotal: r.sigmaT };
  }
  update(games: MGame[]) {
    for (const g of games) {
      this.regressIfNewSeason(g.season);
      const eH = this.elo.get(g.home) ?? 1500, eA = this.elo.get(g.away) ?? 1500;
      const diff = eH + (g.neutral ? 0 : 48) - eA;
      const exp = 1 / (1 + 10 ** (-diff / 400));
      const m = g.hs - g.as;
      const res = m > 0 ? 1 : m < 0 ? 0 : 0.5;
      const mov = Math.log(Math.abs(m) + 1) * (2.2 / ((m > 0 ? diff : -diff) * 0.001 + 2.2));
      const delta = 20 * mov * (res - exp);
      this.elo.set(g.home, eH + delta);
      this.elo.set(g.away, eA - delta);
      this.history.push(g);
    }
  }
}

// ============================================================ 2. Elo (FiveThirtyEight, optimizable)
export type EloParams = { k: number; hfa: number; revert: number; eloPerPoint: number };
export class EloModel implements Model {
  key = "elo";
  label = "Elo (FiveThirtyEight)";
  private r = new Map<string, number>();
  private season: number | null = null;
  private sd = new OnlineSd(STERN_SD);
  constructor(public params: EloParams = { k: 20, hfa: 65, revert: 1 / 3, eloPerPoint: 25 }) {}
  private newSeason(season: number) {
    if (this.season !== null && this.season !== season) for (const [t, v] of this.r) this.r.set(t, v - (v - 1505) * this.params.revert);
    this.season = season;
  }
  private diff(g: MGame) {
    return (this.r.get(g.home) ?? 1500) - (this.r.get(g.away) ?? 1500) + (g.neutral ? 0 : this.params.hfa);
  }
  predict(g: MGame): Prediction {
    this.newSeason(g.season);
    const d = this.diff(g);
    return { p: 1 / (1 + 10 ** (-d / 400)), margin: d / this.params.eloPerPoint, sdMargin: this.sd.value, total: null, sdTotal: null };
  }
  update(games: MGame[]) {
    for (const g of games) {
      this.newSeason(g.season);
      const d = this.diff(g);
      const exp = 1 / (1 + 10 ** (-d / 400));
      const m = g.hs - g.as;
      const res = m > 0 ? 1 : m < 0 ? 0 : 0.5;
      this.sd.add(m - d / this.params.eloPerPoint);
      // Multiplicador de margen de FiveThirtyEight (forecast.py): corrige la autocorrelación del favorito.
      const mult = Math.log(Math.max(Math.abs(m), 1) + 1) * (2.2 / (res === 0.5 ? 1 : (res === 1 ? d : -d) * 0.001 + 2.2));
      const shift = this.params.k * mult * (res - exp);
      this.r.set(g.home, (this.r.get(g.home) ?? 1500) + shift);
      this.r.set(g.away, (this.r.get(g.away) ?? 1500) - shift);
    }
  }
  rating(t: string) { return this.r.get(t) ?? 1500; }
}

// ============================================================ 3. Kalman (Glickman–Stern, ofensiva/defensa)
export type KalmanParams = {
  sigma: number; // ruido de observación de los puntos de un equipo
  rho: number; // correlación entre los puntos de ambos equipos en el mismo partido
  omegaWeek: number; // sd del cambio semanal de ofensiva/defensa
  betaSeason: number; // cuánto conserva un equipo de una temporada a la siguiente
  omegaSeason: number; // sd del cambio de pretemporada
  p0: number; // sd inicial de ofensiva/defensa
};
export class KalmanModel implements Model {
  key = "kalman";
  label = "Kalman ofensiva/defensa (Glickman–Stern)";
  readonly teams: string[];
  private idx = new Map<string, number>();
  readonly n: number;
  x: Float64Array;
  P: Float64Array[];
  private season: number | null = null;
  private week = 0;
  constructor(teams: string[], public params: KalmanParams = { sigma: 9.5, rho: 0, omegaWeek: 0.6, betaSeason: 0.7, omegaSeason: 2.5, p0: 4 }) {
    this.teams = [...teams].sort();
    this.teams.forEach((t, i) => this.idx.set(t, i));
    const T = this.teams.length;
    this.n = 2 + 2 * T;
    this.x = new Float64Array(this.n);
    this.P = Array.from({ length: this.n }, () => new Float64Array(this.n));
    // Previas: μ ≈ 22 ± 3 puntos por equipo, ventaja local 2 ± 1.5, ofensiva/defensa 0 ± p0.
    this.x[0] = 22; this.P[0][0] = 9;
    this.x[1] = 2; this.P[1][1] = 2.25;
    for (let i = 2; i < this.n; i++) this.P[i][i] = params.p0 ** 2;
  }
  o(t: string) { return 2 + (this.idx.get(t) as number); }
  d(t: string) { return 2 + this.teams.length + (this.idx.get(t) as number); }

  /** Evolución de los estados: x ← β·x, P ← β²·P + Q, solo para ofensiva/defensa (índices ≥ 2). */
  private evolve(beta: number, q: number, qMu: number) {
    const n = this.n;
    for (let i = 2; i < n; i++) this.x[i] *= beta;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const bi = i >= 2 ? beta : 1, bj = j >= 2 ? beta : 1;
        this.P[i][j] *= bi * bj;
      }
      this.P[i][i] += i >= 2 ? q : qMu;
    }
  }
  private advance(g: MGame) {
    if (this.season === null) { this.season = g.season; this.week = g.week; return; }
    if (g.season !== this.season) {
      this.evolve(this.params.betaSeason, this.params.omegaSeason ** 2, 1);
      this.season = g.season; this.week = g.week;
    } else if (g.week > this.week) {
      const k = g.week - this.week;
      this.evolve(1, k * this.params.omegaWeek ** 2, k * 0.01);
      this.week = g.week;
    }
  }
  /** Vectores de observación: puntos del local y de la visita como combinación lineal del estado. */
  private rows(g: MGame) {
    const hc = g.neutral ? 0 : 0.5;
    const home: [number, number][] = [[0, 1], [1, hc], [this.o(g.home), 1], [this.d(g.away), -1]];
    const away: [number, number][] = [[0, 1], [1, -hc], [this.o(g.away), 1], [this.d(g.home), -1]];
    return { home, away };
  }
  private quad(a: [number, number][], b: [number, number][]) {
    let s = 0;
    for (const [i, ai] of a) for (const [j, bj] of b) s += ai * bj * this.P[i][j];
    return s;
  }
  private dot(a: [number, number][]) { return a.reduce((s, [i, v]) => s + v * this.x[i], 0); }
  predict(g: MGame): Prediction {
    this.advance(g);
    const { home, away } = this.rows(g);
    const { sigma, rho } = this.params;
    const mh = this.dot(home), ma = this.dot(away);
    const vhh = this.quad(home, home), vaa = this.quad(away, away), vha = this.quad(home, away);
    const R = sigma * sigma;
    const varMargin = vhh + vaa - 2 * vha + 2 * R * (1 - rho);
    const varTotal = vhh + vaa + 2 * vha + 2 * R * (1 + rho);
    const margin = mh - ma;
    return { p: normalCdf(margin / Math.sqrt(varMargin)), margin, sdMargin: Math.sqrt(varMargin), total: mh + ma, sdTotal: Math.sqrt(varTotal) };
  }
  update(games: MGame[]) {
    const n = this.n;
    const { sigma, rho } = this.params;
    const R = sigma * sigma;
    for (const g of games) {
      this.advance(g);
      const { home, away } = this.rows(g);
      // PHᵀ (n×2), S = HPHᵀ + R (2×2), K = PHᵀS⁻¹, x ← x + K(y − Hx), P ← P − K S Kᵀ.
      const PH = Array.from({ length: n }, (_, i) => [home.reduce((s, [j, v]) => s + this.P[i][j] * v, 0), away.reduce((s, [j, v]) => s + this.P[i][j] * v, 0)]);
      const s11 = home.reduce((s, [i, v]) => s + v * PH[i][0], 0) + R;
      const s22 = away.reduce((s, [i, v]) => s + v * PH[i][1], 0) + R;
      const s12 = home.reduce((s, [i, v]) => s + v * PH[i][1], 0) + rho * R;
      const det = s11 * s22 - s12 * s12;
      const inv = [[s22 / det, -s12 / det], [-s12 / det, s11 / det]];
      const v1 = g.hs - this.dot(home), v2 = g.as - this.dot(away);
      const K = PH.map(([a, b]) => [a * inv[0][0] + b * inv[1][0], a * inv[0][1] + b * inv[1][1]]);
      for (let i = 0; i < n; i++) this.x[i] += K[i][0] * v1 + K[i][1] * v2;
      // P ← P − K·(PHᵀ)ᵀ   (equivale a P − K S Kᵀ)
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) this.P[i][j] -= K[i][0] * PH[j][0] + K[i][1] * PH[j][1];
    }
  }
  /** Calificaciones actuales para mostrarlas (puntos sobre la media de liga). */
  snapshot() {
    return this.teams.map((t) => ({ team: t, off: this.x[this.o(t)], def: this.x[this.d(t)], sdOff: Math.sqrt(this.P[this.o(t)][this.o(t)]), sdDef: Math.sqrt(this.P[this.d(t)][this.d(t)]) }));
  }
}

// ============================================================ 4. Ridge sobre puntos (Harville / Massey)
export type RidgeParams = { lambda: number; halfLife: number };
export class RidgeModel implements Model {
  key = "ridge";
  label = "Ridge de puntos (Harville–Massey)";
  private history: MGame[] = [];
  private idx = new Map<string, number>();
  private beta: Float64Array | null = null;
  private fitDate = "";
  private sdM = new OnlineSd(STERN_SD);
  private sdT: OnlineSd;
  constructor(teams: string[], public params: RidgeParams = { lambda: 4, halfLife: 20 }, priorSdTotal = STERN_SD) {
    [...teams].sort().forEach((t, i) => this.idx.set(t, i));
    this.sdT = new OnlineSd(priorSdTotal);
  }
  /** β = (XᵀWX + Λ)⁻¹ XᵀWy con incógnitas [μ, h, o₁..o₃₂, d₁..d₃₂]. */
  private fit(date: string) {
    const T = this.idx.size, n = 2 + 2 * T;
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const b = new Float64Array(n);
    const lnHalf = Math.log(2) / (this.params.halfLife * 7);
    for (const g of this.history) {
      const age = daysBetween(g.date, date);
      if (age > this.params.halfLife * 7 * 8) continue;
      const w = Math.exp(-lnHalf * age);
      const hc = g.neutral ? 0 : 0.5;
      const oh = 2 + (this.idx.get(g.home) as number), oa = 2 + (this.idx.get(g.away) as number);
      for (const [row, y] of [[[[0, 1], [1, hc], [oh, 1], [oa + T, -1]], g.hs], [[[0, 1], [1, -hc], [oa, 1], [oh + T, -1]], g.as]] as const) {
        for (const [i, vi] of row) {
          b[i] += w * vi * y;
          for (const [j, vj] of row) A[i][j] += w * vi * vj;
        }
      }
    }
    A[0][0] += 1e-4; A[1][1] += 1e-3;
    for (let i = 2; i < n; i++) A[i][i] += this.params.lambda;
    this.beta = solveSpd(A, b);
  }
  private points(g: MGame) {
    const B = this.beta as Float64Array, T = this.idx.size;
    const hc = g.neutral ? 0 : 0.5;
    const oh = 2 + (this.idx.get(g.home) as number), oa = 2 + (this.idx.get(g.away) as number);
    return { h: B[0] + hc * B[1] + B[oh] - B[oa + T], a: B[0] - hc * B[1] + B[oa] - B[oh + T] };
  }
  predict(g: MGame): Prediction {
    if (!this.history.length) return { p: 0.5, margin: 0, sdMargin: this.sdM.value, total: 44, sdTotal: this.sdT.value };
    if (this.fitDate !== g.date) { this.fit(g.date); this.fitDate = g.date; }
    const { h, a } = this.points(g);
    const sd = this.sdM.value;
    return { p: normalCdf((h - a) / sd), margin: h - a, sdMargin: sd, total: h + a, sdTotal: this.sdT.value };
  }
  update(games: MGame[]) {
    if (this.history.length) {
      if (this.fitDate !== games[0].date) { this.fit(games[0].date); this.fitDate = games[0].date; }
      for (const g of games) {
        const { h, a } = this.points(g);
        this.sdM.add(g.hs - g.as - (h - a));
        this.sdT.add(g.hs + g.as - (h + a));
      }
    }
    this.history.push(...games);
    this.fitDate = "";
  }
}

// ============================================================ 5. EPA ajustada por rival (ridge)
export type EpaParams = { lambda: number; halfLife: number; clip: number };
export class EpaModel implements Model {
  key = "epa";
  label = "EPA ajustada por rival (ridge)";
  private rows: { date: string; team: number; opp: number; home: number; plays: number; epa: number; points: number }[] = [];
  private idx = new Map<string, number>();
  private beta: Float64Array | null = null;
  private map = { a: 22, b: 60, c: 0 };
  private fitDate = "";
  private sdM = new OnlineSd(STERN_SD);
  private sdT: OnlineSd;
  constructor(teams: string[], private epaByGame: Map<string, TeamGameEpa[]>, public params: EpaParams = { lambda: 400, halfLife: 20, clip: 6 }, priorSdTotal = STERN_SD) {
    [...teams].sort().forEach((t, i) => this.idx.set(t, i));
    this.sdT = new OnlineSd(priorSdTotal);
  }
  /**
   * y = c + o_ofensiva + d_defensa + h·lado, ponderado por jugadas × decaimiento; penalización λ
   * (en jugadas) sobre o y d. Después, puntos ≈ a + b·EPA/jugada (mínimos cuadrados ponderados).
   */
  private fit(date: string) {
    const T = this.idx.size, n = 2 + 2 * T;
    const A = Array.from({ length: n }, () => new Float64Array(n));
    const bv = new Float64Array(n);
    const lnHalf = Math.log(2) / (this.params.halfLife * 7);
    // Conversión a puntos: puntos = a + b·EPA/jugada + c·lado (mínimos cuadrados ponderados, 3×3).
    // El término c recoge la ventaja de local que no pasa por el EPA (penalidades, equipos especiales).
    const M = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
    const mv = new Float64Array(3);
    let sw = 0;
    for (const r of this.rows) {
      const age = daysBetween(r.date, date);
      if (age > this.params.halfLife * 7 * 8) continue;
      const decay = Math.exp(-lnHalf * age);
      const w = decay * r.plays;
      const row: [number, number][] = [[0, 1], [1, r.home], [2 + r.team, 1], [2 + T + r.opp, 1]];
      for (const [i, vi] of row) {
        bv[i] += w * vi * r.epa;
        for (const [j, vj] of row) A[i][j] += w * vi * vj;
      }
      const z = [1, r.epa, r.home];
      for (let i = 0; i < 3; i++) {
        mv[i] += decay * z[i] * r.points;
        for (let j = 0; j < 3; j++) M[i][j] += decay * z[i] * z[j];
      }
      sw += decay;
    }
    A[0][0] += 1e-3; A[1][1] += 1e-3;
    for (let i = 2; i < n; i++) A[i][i] += this.params.lambda;
    this.beta = solveSpd(A, bv);
    if (sw > 50) {
      M[2][2] += 1e-6;
      const [a, b, c] = solveSpd(M, mv);
      this.map = { a, b, c };
    }
  }
  private expected(g: MGame) {
    const B = this.beta as Float64Array, T = this.idx.size;
    const hs = g.neutral ? 0 : 0.5;
    const h = this.idx.get(g.home) as number, a = this.idx.get(g.away) as number;
    const eH = B[0] + hs * B[1] + B[2 + h] + B[2 + T + a];
    const eA = B[0] - hs * B[1] + B[2 + a] + B[2 + T + h];
    return { h: this.map.a + this.map.b * eH + this.map.c * hs, a: this.map.a + this.map.b * eA - this.map.c * hs, eH, eA };
  }
  predict(g: MGame): Prediction {
    if (!this.rows.length) return { p: 0.5, margin: 0, sdMargin: this.sdM.value, total: 44, sdTotal: this.sdT.value };
    if (this.fitDate !== g.date) { this.fit(g.date); this.fitDate = g.date; }
    const { h, a } = this.expected(g);
    const sd = this.sdM.value;
    return { p: normalCdf((h - a) / sd), margin: h - a, sdMargin: sd, total: h + a, sdTotal: this.sdT.value };
  }
  update(games: MGame[]) {
    if (this.rows.length) {
      if (this.fitDate !== games[0].date) { this.fit(games[0].date); this.fitDate = games[0].date; }
      for (const g of games) {
        const { h, a } = this.expected(g);
        this.sdM.add(g.hs - g.as - (h - a));
        this.sdT.add(g.hs + g.as - (h + a));
      }
    }
    const c = this.params.clip;
    for (const g of games) {
      for (const tg of this.epaByGame.get(g.id) ?? []) {
        if (!this.idx.has(tg.team) || !this.idx.has(tg.opp) || !tg.epa.length) continue;
        let s = 0;
        for (const v of tg.epa) s += Math.max(-c, Math.min(c, v));
        const isHome = tg.team === g.home;
        this.rows.push({ date: g.date, team: this.idx.get(tg.team) as number, opp: this.idx.get(tg.opp) as number, home: g.neutral ? 0 : isHome ? 0.5 : -0.5, plays: tg.epa.length, epa: s / tg.epa.length, points: isHome ? g.hs : g.as });
      }
    }
    this.fitDate = "";
  }
}
