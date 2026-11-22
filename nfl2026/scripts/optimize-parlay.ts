/**
 * Ajusta el modelo de piezas de parlay (src/lib/parlay-model.ts) con el protocolo de la edición:
 *
 *   - Ajuste: validación (2025 semana 10+ y 2026 jugado hasta el corte). Para cada partido se corre el
 *     análisis completo del framework y se evalúan todas sus piezas (6 líneas con momio y las
 *     alternativas), con su resultado real.
 *   - Se eligen β₀, β_c, β_i, β_q y β_d minimizando la pérdida logarítmica de la probabilidad
 *     conservadora de todas las piezas.
 *   - En vivo (2026 después del corte) solo se mide: no se usa para elegir nada.
 *
 * Uso: npm run models:parlay        → data/parlay-params.json
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { buildPregameAnalysis } from "../src/lib/framework-analysis";
import { loadGameContext, loadModelData } from "../src/lib/models/backtest";
import { gameModels, readParams, runFinal } from "../src/lib/models/lab";
import { inLive, inValid, inValidAux, VALID_CUTOFF } from "../src/lib/models/protocol";
import { betaOf, consProb, DEFAULT_PARLAY_PARAMS, PIECE_P, type ParlayParams, type Piece } from "../src/lib/parlay-model";

type Row = { lm: number; lk: number; nDato: number; nInfo: number; qb: number; disp: number; y: number; pModel: number; pMarket: number; dec: number; alt: boolean; gameId: string };
const clampP = (p: number) => Math.min(0.999, Math.max(0.001, p));
const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));
const r4 = (v: number) => Number(v.toFixed(4));

function rowsOf(gameId: string, pieces: Piece[]): Row[] {
  return pieces.filter((p) => p.won !== null && !p.push).map((p) => ({
    lm: logit(p.pModel), lk: logit(p.pMarket), nDato: p.nDato, nInfo: p.nInfo, qb: p.qb, disp: p.disp,
    y: p.won ? 1 : 0, pModel: p.pModel, pMarket: p.pMarket, dec: p.dec, alt: p.alt, gameId,
  }));
}
const lossOf = (rows: Row[], f: (r: Row) => number) => rows.reduce((s, r) => { const p = clampP(f(r)); return s - (r.y ? Math.log(p) : Math.log(1 - p)); }, 0) / Math.max(1, rows.length);
const consOf = (params: ParlayParams) => (r: Row) => consProb(r.pMarket, r.pModel, betaOf(params, r));

function buckets(rows: Row[], params: ParlayParams) {
  const cut = [PIECE_P, 0.65, 0.75, 0.85, 1.01];
  return cut.slice(0, -1).map((lo, i) => {
    const hi = cut[i + 1];
    const sel = rows.filter((r) => { const p = consOf(params)(r); return p >= lo && p < hi; });
    const p = sel.reduce((s, r) => s + consOf(params)(r), 0) / Math.max(1, sel.length);
    return { range: `${Math.round(lo * 100)}–${hi > 1 ? 100 : Math.round(hi * 100)}%`, n: sel.length, won: sel.filter((r) => r.y).length, pMean: r4(p), hit: sel.length ? r4(sel.filter((r) => r.y).length / sel.length) : null };
  });
}

async function main() {
  console.log("\n=== Modelo de piezas de parlay: ajuste con la validación del protocolo ===\n");
  const base = await loadModelData();
  const data = { ...base, ctx: await loadGameContext(base.games) };
  const run = runFinal(data, await readParams());
  const valid = run.records.filter((r) => (inValid(r.g) || inValidAux(r.g)) && r.g.spread !== null);
  const live = run.records.filter((r) => r.g.played && inLive(r.g) && r.g.spread !== null);
  const collect = async (recs: typeof valid, label: string) => {
    const rows: Row[] = [];
    for (const [i, r] of recs.entries()) {
      const a = await buildPregameAnalysis(r.g.id, gameModels(run, r.g.id));
      rows.push(...rowsOf(r.g.id, a.bestPick.parlayPieces));
      process.stdout.write(`\r   ${label}: ${i + 1}/${recs.length} partidos`);
    }
    console.log(` · ${rows.length} piezas con resultado`);
    return rows;
  };
  const vRows = await collect(valid, "validación");
  const lRows = await collect(live, "en vivo (solo se mide)");

  const grid = {
    b0: Array.from({ length: 21 }, (_, i) => i / 20),
    b0m: Array.from({ length: 21 }, (_, i) => i / 20),
    bc: [0, 0.05, 0.1, 0.2],
    bi: [0, 0.05, 0.1, 0.2],
    bq: [0, 0.1, 0.2],
    bd: [0, 0.5, 1, 1.5, 2],
  };
  let best: { params: ParlayParams; loss: number } | null = null;
  for (const b0 of grid.b0) for (const b0m of grid.b0m) for (const bc of grid.bc) for (const bi of grid.bi) for (const bq of grid.bq) for (const bd of grid.bd) {
    const params = { ...DEFAULT_PARLAY_PARAMS, b0, b0m, bc, bi, bq, bd };
    const loss = lossOf(vRows, consOf(params));
    if (!best || loss < best.loss - 1e-12) best = { params, loss };
  }
  const params = best!.params;
  const ll = (rows: Row[]) => ({ n: rows.length, model: r4(lossOf(rows, (r) => r.pModel)), market: r4(lossOf(rows, (r) => r.pMarket)), conservative: r4(lossOf(rows, consOf(params))) });
  const metrics = (rows: Row[]) => ({
    pieces: rows.length, games: new Set(rows.map((r) => r.gameId)).size,
    logLoss: ll(rows), main: ll(rows.filter((r) => !r.alt)), alt: ll(rows.filter((r) => r.alt)),
    buckets: buckets(rows, params),
  });
  const out = {
    params,
    fittedAt: new Date().toISOString(),
    protocol: `Ajuste: validación (2025 semana 10+ y 2026 jugado hasta el ${VALID_CUTOFF}). En vivo: 2026 después del corte, solo medición.`,
    grid,
    valid: metrics(vRows),
    live: metrics(lRows),
  };
  await writeFile(path.join(process.cwd(), "data", "parlay-params.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n   β₀ alternativas ${params.b0} · β₀ líneas con momio ${params.b0m} · β_c ${params.bc} · β_i ${params.bi} · β_q ${params.bq} · β_d ${params.bd}`);
  for (const [k, m] of [["validación", out.valid], ["en vivo", out.live]] as const) {
    console.log(`   ${k}: ${m.pieces} piezas de ${m.games} partidos · log-loss modelo ${m.logLoss.model} · mercado ${m.logLoss.market} · conservadora ${m.logLoss.conservative}`);
    console.log(`      líneas con momio: modelo ${m.main.model} · mercado ${m.main.market} · conservadora ${m.main.conservative} (${m.main.n}) · alternativas: modelo ${m.alt.model} · mercado ${m.alt.market} · conservadora ${m.alt.conservative} (${m.alt.n})`);
    for (const b of m.buckets) console.log(`      p_cons ${b.range.padEnd(8)} n ${String(b.n).padStart(4)} · ganaron ${b.hit === null ? "—" : (b.hit * 100).toFixed(1) + "%"} · p media ${(b.pMean * 100).toFixed(1)}%`);
  }
  console.log("\n   Guardado en data/parlay-params.json\n");
}

main()
  .catch((err) => { console.error("Error ajustando el modelo de piezas:", err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
