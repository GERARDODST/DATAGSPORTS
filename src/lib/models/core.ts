/**
 * Núcleo matemático compartido por los modelos del torneo: tipos, distribución normal,
 * álgebra lineal pequeña (Cholesky) y reglas de puntuación.
 */

export type MGame = {
  id: string;
  season: number;
  week: number;
  type: string;
  date: string; // AAAA-MM-DD
  home: string;
  away: string;
  hs: number;
  as: number;
  neutral: boolean;
  spread: number | null; // positivo = local favorito (convención nflverse)
  total: number | null;
  mlHome: number | null;
  mlAway: number | null;
  homeQb: string | null; // QB titular (nflverse schedules: home_qb_name)
  awayQb: string | null;
  roof: string | null;
  temp: number | null; // °F
  wind: number | null; // mph
};

/** EPA de cada jugada (pase o carrera) de un equipo en un partido. */
export type TeamGameEpa = { gameId: string; team: string; opp: string; epa: Float64Array };

/** Predicción de un modelo para un partido. μ y σ en puntos (margen = local − visita). */
export type Prediction = {
  p: number;
  margin: number | null;
  sdMargin: number | null;
  total: number | null;
  sdTotal: number | null;
};

export interface Model {
  key: string;
  label: string;
  /** Predice sin mirar el resultado. */
  predict(g: MGame): Prediction;
  /** Recibe los resultados de una fecha completa, después de predecir todos sus partidos. */
  update(games: MGame[]): void;
}

// Φ con la aproximación 26.2.17 de Abramowitz y Stegun (error absoluto < 7.5·10⁻⁸).
export function normalCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}
/** Φ⁻¹ con el algoritmo de Acklam (error relativo < 1.2·10⁻⁹). */
export function normalInv(p: number) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q0 = Math.min(1 - 1e-12, Math.max(1e-12, p));
  if (q0 < 0.02425) { const q = Math.sqrt(-2 * Math.log(q0)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (q0 > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - q0)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = q0 - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
export const logit = (p: number) => Math.log(p / (1 - p));
export const clampP = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
export const logLoss = (p: number, y: number) => -(y * Math.log(clampP(p)) + (1 - y) * Math.log(1 - clampP(p)));
export const brier = (p: number, y: number) => (p - y) ** 2;
/** −log de la densidad normal: regla de puntuación propia para márgenes y totales. */
export const gaussNll = (x: number, mu: number, sd: number) => 0.5 * Math.log(2 * Math.PI * sd * sd) + ((x - mu) ** 2) / (2 * sd * sd);
export const outcome = (g: MGame) => (g.hs > g.as ? 1 : g.hs < g.as ? 0 : 0.5);

export function impliedNoVig(mlHome: number | null, mlAway: number | null) {
  if (mlHome === null || mlAway === null) return null;
  const imp = (m: number) => (m < 0 ? -m / (-m + 100) : 100 / (m + 100));
  const h = imp(mlHome), a = imp(mlAway);
  return h / (h + a);
}

/** Resuelve A·x = b con A simétrica definida positiva (Cholesky). A se pasa por filas. */
export function solveSpd(A: Float64Array[], b: Float64Array) {
  const n = b.length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i][j] = s / L[j][j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/**
 * Desviación predictiva medida con los errores pasados del propio modelo (sin mirar el partido que
 * se predice). Mientras hay pocos partidos se mezcla con σ = 13.86, la estimación de Stern (1991).
 */
export class OnlineSd {
  private sum = 0;
  private n = 0;
  constructor(private prior: number, private priorN = 60) {}
  add(err: number) {
    this.sum += err * err;
    this.n++;
  }
  get value() {
    return Math.sqrt((this.sum + this.priorN * this.prior ** 2) / (this.n + this.priorN));
  }
}

export const STERN_SD = 13.86;
