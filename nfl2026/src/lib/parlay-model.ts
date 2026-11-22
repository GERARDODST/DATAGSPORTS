/**
 * Modelo de piezas de parlay (conservador).
 *
 * Busca en cada partido las piezas más seguras que todavía tienen valor. Además de las 6 líneas con
 * momio (moneyline, spread y total), evalúa líneas alternativas "compradas" a favor de cada lado:
 * spread +3, +6 y +10 (el favorito baja su línea, el perro sube la suya, cruzando los números clave 3
 * y 7) y total −3/−6/−10 para el Over y +3/+6/+10 para el Under.
 *
 *  1. p_mod  — probabilidad del modelo final: la distribución discreta del margen o del total (mezcla
 *              de los 5 modelos del torneo con las capas de QB y los ajustes 5.3, reescalada con los
 *              pesos de los números clave). Condicionada a que no haya push (el push anula la pieza).
 *  2. p_mkt  — probabilidad del mercado: la misma forma centrada en la línea del mercado. En las 6
 *              líneas con momio real se usa la implícita sin margen.
 *  3. p_cons — probabilidad conservadora, la que decide:
 *                logit p_cons = logit p_mkt + β·(logit p_mod − logit p_mkt)
 *                β = clamp(β₀ − β_c·n_dato − β_i·n_info − β_q·QB sin confirmar − β_d·dispersión, 0, 1)
 *              β es cuánto se le cree al modelo cuando se separa del mercado; el análisis completo del
 *              partido lo baja: contradicciones de dato (bajas, presión, clima, divergencia de los
 *              métodos), avisos de información (QB sin confirmar, titulares en duda, edge enorme contra el
 *              cierre, línea que se movió en contra) y la dispersión de los 5 modelos del torneo para esa
 *              pieza. Los β se ajustan con la validación del protocolo (scripts/optimize-parlay.ts).
 *  4. Precio — real en las 6 líneas; estimado en las alternativas (p_mkt + margen de la casa). El
 *              momio mínimo es el justo de p_cons: si la casa paga menos, la pieza no tiene valor.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalCdf } from "./models/core";
import { RANGE, type Kind } from "./models/discrete";

/** b0: confianza base en líneas alternativas; b0m: en las 6 líneas con momio real. */
export type ParlayParams = { b0: number; b0m: number; bc: number; bi: number; bq: number; bd: number; hold: number };
export const DEFAULT_PARLAY_PARAMS: ParlayParams = { b0: 0.5, b0m: 0.5, bc: 0.1, bi: 0.15, bq: 0.1, bd: 1, hold: 0.025 };
/** Probabilidad conservadora mínima para que sea pieza, y la que la vuelve "Conservadora". */
export const PIECE_P = 0.55;
export const PIECE_SAFE = 0.7;
/** Alternativas: puntos que se "compran" a favor del lado. */
export const ALT_STEPS = [3, 6, 10];
/** Momio decimal mínimo de una alternativa (más bajo que ≈ −830 casi no sube el boleto). */
const MIN_DEC_ALT = 1.12;
// Contradicciones que dependen de la línea principal (guion, favorito caro, spread grande) o que ya
// mide la dispersión del torneo: no cuentan contra la pieza.
const LINE_ONLY_REFS = new Set(["6.12", "8.3.13", "7.5", "8.3.9", "Torneo"]);

export type MixComp = { w: number; mu: number; sd: number };
export type PieceDist = {
  margin: MixComp[];
  total: MixComp[];
  omegaMargin: number[] | null;
  omegaTotal: number[] | null;
  base: { key: string; label: string; margin: { mu: number; sd: number } | null; total: { mu: number; sd: number } | null }[];
};
type Contra = { ref: string; text: string; kind: "dato" | "guion" | "info" };
/** Lo que el modelo necesita de cada candidato del framework (las 6 líneas con momio). */
export type CandLike = {
  market: "Moneyline" | "Spread" | "Total"; pick: string; team: string | null; side: "home" | "away" | "over" | "under";
  odds: number; book: string | null; pModel: number; pImplied: number; contradictions: Contra[]; klass: string;
  won: boolean | null; push: boolean;
};
export type PieceInput = {
  home: string; away: string; spread: number | null; total: number | null;
  margin: number; totalProj: number; qbProjected: boolean;
  dist: PieceDist | null;
  result: { margin: number; total: number } | null;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const logit = (p: number) => { const q = clamp(p, 0.001, 0.999); return Math.log(q / (1 - q)); };
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const r3 = (v: number, d = 3) => Number(v.toFixed(d));
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const decOf = (a: number) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const fairAmerican = (p: number) => (p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));
const fmtOdds = (a: number) => (a > 0 ? `+${a}` : `${a}`);
const fmtLine = (v: number) => (v === 0 ? "PK" : v > 0 ? `+${v}` : `${v}`);

let cached: { params: ParlayParams; meta: unknown } | null = null;
/** Parámetros ajustados (data/parlay-params.json); si no existen, los iniciales. */
export function loadParlayParams(): { params: ParlayParams; meta: unknown } {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "data", "parlay-params.json"), "utf8"));
    cached = { params: { ...DEFAULT_PARLAY_PARAMS, ...raw.params }, meta: raw };
  } catch {
    cached = { params: DEFAULT_PARLAY_PARAMS, meta: null };
  }
  return cached;
}

/** Masa por entero de una mezcla de normales corrida `shift` puntos y reescalada por números clave. */
export function pmfFrom(comps: MixComp[], kind: Kind, shift: number, omega: number[] | null) {
  const lo: number = RANGE[kind].lo, hi: number = RANGE[kind].hi;
  const out = new Float64Array(hi - lo + 1);
  for (const c of comps) {
    if (!(c.sd > 0) || !Number.isFinite(c.mu)) continue;
    for (let k = lo; k <= hi; k++) {
      const a = k === lo ? 0 : normalCdf((k - 0.5 - c.mu - shift) / c.sd);
      const b = k === hi ? 1 : normalCdf((k + 0.5 - c.mu - shift) / c.sd);
      out[k - lo] += c.w * (b - a);
    }
  }
  if (omega) for (let j = 0; j < out.length; j++) out[j] *= omega[kind === "margin" ? Math.abs(j + lo) : j] ?? 1;
  const z = out.reduce((s, v) => s + v, 0) || 1;
  for (let j = 0; j < out.length; j++) out[j] /= z;
  return out;
}
const meanOf = (pmf: Float64Array, kind: Kind) => pmf.reduce((s, p, j) => s + p * (j + RANGE[kind].lo), 0);
/** Distribución centrada en `target` (media), con la forma de la mezcla. */
function centered(comps: MixComp[], kind: Kind, target: number, omega: number[] | null) {
  const m0 = meanOf(pmfFrom(comps, kind, 0, omega), kind);
  let shift = target - m0;
  const m1 = meanOf(pmfFrom(comps, kind, shift, omega), kind);
  shift += target - m1; // segunda vuelta: los pesos de números clave mueven un poco la media
  return { pmf: pmfFrom(comps, kind, shift, omega), shift };
}

/** Pieza: gana si s·valor + L > 0 (margen: s = +1 local, −1 visita; total: s = +1 Over con L = −T, −1 Under con L = T). */
type Def = { kind: Kind; s: 1 | -1; L: number };
function probOf(pmf: Float64Array, kind: Kind, d: Def) {
  const { lo } = RANGE[kind];
  let win = 0, push = 0, lose = 0;
  pmf.forEach((p, j) => { const v = d.s * (j + lo) + d.L; if (v > 0) win += p; else if (v === 0) push += p; else lose += p; });
  return { p: win / Math.max(1e-12, win + lose), push };
}
const outcomeOf = (res: { margin: number; total: number } | null, d: Def) => {
  if (!res) return { won: null as boolean | null, push: false };
  const v = d.s * (d.kind === "margin" ? res.margin : res.total) + d.L;
  return { won: v > 0, push: v === 0 };
};

export type Piece = {
  family: string; market: "Moneyline" | "Spread" | "Total"; pick: string; team: string | null; alt: boolean; line: number | null;
  odds: number; estimated: boolean; book: string | null; dec: number;
  pModel: number; pMarket: number; p: number; pFloor: number | null; disp: number; beta: number;
  nDato: number; nInfo: number; qb: number; ev: number; minOdds: number;
  status: "Conservadora" | "Sólida" | "Precio a revisar" | "Cara" | "Contradicción alta" | "Poco probable"; usable: boolean; wait: boolean;
  why: string[]; note: string; won: boolean | null; push: boolean;
};

export function betaOf(params: ParlayParams, f: { nDato: number; nInfo: number; qb: number; disp: number; alt: boolean }) {
  return clamp((f.alt ? params.b0 : params.b0m) - params.bc * f.nDato - params.bi * f.nInfo - params.bq * f.qb - params.bd * f.disp, 0, 1);
}
export const consProb = (pMkt: number, pMod: number, beta: number) => sigmoid(logit(pMkt) + beta * (logit(pMod) - logit(pMkt)));

/** Todas las piezas evaluadas del partido (principales + alternativas), ordenadas para el parlay. */
export function buildParlayPieces(x: PieceInput, cands: CandLike[], params: ParlayParams): Piece[] {
  const { home, away } = x;
  const D = x.dist;
  const pieces: Piece[] = [];
  const qb = x.qbProjected ? 1 : 0;
  const mk: Record<Kind, { model: Float64Array; market: Float64Array | null; base: { label: string; pmf: Float64Array }[] } | null> = { margin: null, total: null };
  if (D) for (const kind of ["margin", "total"] as Kind[]) {
    const comps = kind === "margin" ? D.margin : D.total;
    const omega = kind === "margin" ? D.omegaMargin : D.omegaTotal;
    if (!comps.length) continue;
    const target = kind === "margin" ? x.margin : x.totalProj;
    const { pmf, shift } = centered(comps, kind, target, omega);
    const line = kind === "margin" ? x.spread : x.total;
    // Cada modelo del torneo con su propia media y desviación, con el mismo corrimiento de las capas.
    const base = D.base.flatMap((b) => {
      const c = kind === "margin" ? b.margin : b.total;
      return c && c.sd > 0 ? [{ label: b.label, pmf: pmfFrom([{ w: 1, mu: c.mu, sd: c.sd }], kind, shift, omega) }] : [];
    });
    mk[kind] = { model: pmf, market: line === null ? null : centered(comps, kind, line, omega).pmf, base };
  }
  const signals = (c: CandLike | undefined) => {
    const k = c?.contradictions ?? [];
    const dato = k.filter((z) => z.kind === "dato" && !LINE_ONLY_REFS.has(z.ref));
    const info = k.filter((z) => z.kind === "info");
    return { nDato: dato.length, nInfo: info.length, why: [...dato, ...info].map((z) => `${z.ref}: ${z.text}`) };
  };
  const cand = (market: string, side: string) => cands.find((c) => c.market === market && c.side === side);

  const add = (o: { family: string; market: Piece["market"]; pick: string; team: string | null; alt: boolean; line: number | null; def: Def; parent: CandLike | undefined; real: CandLike | null }) => {
    const dist = mk[o.def.kind];
    const fromPmf = dist ? probOf(dist.model, o.def.kind, o.def) : null;
    const pModel = o.real ? o.real.pModel : fromPmf?.p ?? null;
    const pMarket = o.real ? o.real.pImplied : dist?.market ? probOf(dist.market, o.def.kind, o.def).p : null;
    if (pModel === null || pMarket === null) return;
    const baseP = dist ? dist.base.map((b) => probOf(b.pmf, o.def.kind, o.def).p).sort((a, b) => a - b) : [];
    const pFloor = baseP.length >= 3 ? baseP[1] : baseP[0] ?? null; // 2.º más pesimista
    const disp = baseP.length >= 2 ? baseP[baseP.length - 1] - baseP[0] : 0;
    const sig = signals(o.parent);
    const beta = betaOf(params, { nDato: sig.nDato, nInfo: sig.nInfo, qb, disp, alt: o.alt });
    const p = consProb(pMarket, pModel, beta);
    const estimated = !o.real;
    const odds = o.real ? o.real.odds : fairAmerican(clamp(pMarket + params.hold, 0.02, 0.995));
    const dec = decOf(odds);
    if (estimated && (dec < MIN_DEC_ALT || pModel > 0.985)) return;
    const ev = p * dec - 1;
    const out = o.real ? { won: o.real.won, push: o.real.push } : outcomeOf(x.result, o.def);
    const veto = sig.nDato + sig.nInfo >= 2;
    // Con precio estimado (alternativas) y sin valor a ese precio, la pieza depende de lo que pague tu casa.
    const status: Piece["status"] = veto ? "Contradicción alta" : p < PIECE_P ? "Poco probable" : ev < 0 ? (estimated ? "Precio a revisar" : "Cara") : p >= PIECE_SAFE ? "Conservadora" : "Sólida";
    const usable = status === "Conservadora" || status === "Sólida";
    pieces.push({
      family: o.family, market: o.market, pick: o.pick, team: o.team, alt: o.alt, line: o.line,
      odds, estimated, book: o.real?.book ?? null, dec: r3(dec), pModel: r3(pModel), pMarket: r3(pMarket), p: r3(p),
      pFloor: pFloor === null ? null : r3(pFloor), disp: r3(disp), beta: r3(beta, 2), nDato: sig.nDato, nInfo: sig.nInfo, qb,
      ev: r3(ev), minOdds: fairAmerican(clamp(p, 0.01, 0.995)), status, usable, wait: usable && sig.nInfo > 0, why: sig.why,
      note: noteOf(status, { p: r3(p), pModel: r3(pModel), pMarket: r3(pMarket), odds, dec, estimated, beta, why: sig.why, pFloor: pFloor === null ? null : r3(pFloor) }),
      won: out.won, push: out.push,
    });
  };

  // Lados (moneyline, spread principal y alternativas): familia = equipo.
  for (const [team, side, s] of [[home, "home", 1], [away, "away", -1]] as const) {
    const ml = cand("Moneyline", side), sp = cand("Spread", side);
    const parent = sp ?? ml;
    if (ml) add({ family: team, market: "Moneyline", pick: ml.pick, team, alt: false, line: null, def: { kind: "margin", s, L: 0 }, parent: ml, real: ml });
    if (x.spread !== null) {
      const teamLine = s === 1 ? -x.spread : x.spread; // línea del equipo (−3.5 favorito, +3.5 perro)
      if (sp) add({ family: team, market: "Spread", pick: sp.pick, team, alt: false, line: teamLine, def: { kind: "margin", s, L: teamLine }, parent: sp, real: sp });
      for (const d of ALT_STEPS) {
        const L = teamLine + d;
        add({ family: team, market: "Spread", pick: `${team} ${fmtLine(L)}`, team, alt: true, line: L, def: { kind: "margin", s, L }, parent, real: null });
      }
    }
  }
  // Totales: familia = Over / Under.
  if (x.total !== null) {
    const T = x.total;
    for (const [side, s] of [["over", 1], ["under", -1]] as const) {
      const c = cand("Total", side);
      const name = side === "over" ? "Over" : "Under";
      if (c) add({ family: name, market: "Total", pick: c.pick, team: null, alt: false, line: T, def: { kind: "total", s, L: -s * T }, parent: c, real: c });
      for (const d of ALT_STEPS) {
        const line = side === "over" ? T - d : T + d;
        add({ family: name, market: "Total", pick: `${name} ${line}`, team: null, alt: true, line, def: { kind: "total", s, L: -s * line }, parent: c, real: null });
      }
    }
  }
  // Con valor: la más segura primero. Sin valor: la que más cerca está de tenerlo (mayor valor esperado).
  const rank = (p: Piece) => (p.usable ? 0 : p.status === "Precio a revisar" || p.status === "Cara" ? 1 : p.status === "Contradicción alta" ? 2 : 3);
  return pieces.sort((a, b) => rank(a) - rank(b) || (a.usable ? b.p - a.p : b.ev - a.ev));
}

function noteOf(status: Piece["status"], v: { p: number; pModel: number; pMarket: number; odds: number; dec: number; estimated: boolean; beta: number; why: string[]; pFloor: number | null }) {
  const price = `${v.estimated ? "≈" : ""}${fmtOdds(v.odds)}`;
  const base = `Conservadora ${pct(v.p)} (modelo ${pct(v.pModel)}, mercado ${pct(v.pMarket)}, confianza en el modelo β = ${v.beta.toFixed(2)}${v.pFloor !== null ? `, piso del torneo ${pct(v.pFloor)}` : ""}).`;
  const est = v.estimated ? " (momio estimado: confírmalo en tu casa)" : "";
  if (status === "Conservadora") return `${base} Muy probable y con valor a ${price}${est}: multiplica el boleto ×${v.dec.toFixed(2)}.`;
  if (status === "Sólida") return `${base} Probable y con valor a ${price}${est}: multiplica ×${v.dec.toFixed(2)}.`;
  if (status === "Cara") return `${base} A ${price} el precio no paga esa probabilidad: le resta valor al boleto.`;
  if (status === "Precio a revisar") return `${base} Al precio estimado (${price}) no alcanza; tiene valor solo si tu casa paga ${fmtOdds(fairAmerican(clamp(v.p, 0.01, 0.995)))} o mejor.`;
  if (status === "Contradicción alta") return `${base} El análisis del partido tiene dos o más datos en contra: ${v.why.join(" ")}`;
  return `${base} Demasiado incierta para un parlay (se pide ${Math.round(PIECE_P * 100)}%).`;
}

/** Las 2 piezas del partido: la mejor y la mejor de otra familia que no sea el rival (un lado y un total). */
export function pickLegs(pieces: Piece[], home: string, away: string) {
  const leg1 = pieces[0] ?? null;
  if (!leg1) return [];
  const rival = leg1.family === home ? away : leg1.family === away ? home : null;
  const sameDir = (f: string) => (leg1.family === "Over" || leg1.family === "Under") && (f === "Over" || f === "Under");
  const leg2 = pieces.find((p) => p.family !== leg1.family && p.family !== rival && !sameDir(p.family)) ?? null;
  return [leg1, leg2].filter((p): p is Piece => p !== null);
}
