/**
 * Optimiza los hiperparámetros de los modelos del torneo y del ensamble, y los guarda en
 * data/model-params.json (versionado) junto con la traza de cada evaluación.
 *
 * Uso: npm run models:optimize
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGameContext, loadModelData } from "../src/lib/models/backtest";
import { SPLITS, optimizeSplit, tuneEnsemble, type ParamsFile } from "../src/lib/models/lab";
import { PROTOCOL_TEXT, VALID_CUTOFF, inValid } from "../src/lib/models/protocol";
import { prisma } from "../src/lib/prisma";

async function main() {
  const base = await loadModelData();
  const d = { ...base, ctx: await loadGameContext(base.games) };
  const played = d.games.filter((g) => g.played);
  console.log(`\n=== Optimización de modelos (edición 2026): ${played.length} partidos jugados, ${d.plays} jugadas ===`);
  console.log(`   ${PROTOCOL_TEXT}`);
  console.log(`   Validación 2026: ${played.filter(inValid).length} partidos jugados hasta ${VALID_CUTOFF}`);
  const splits: ParamsFile["splits"] = [];
  for (const split of SPLITS) {
    console.log(`\n-> Split "${split.name}": entrenamiento ${split.label}`);
    const models = optimizeSplit(d, split);
    for (const [k, m] of Object.entries(models)) {
      console.log(`   ${k.padEnd(10)} log-loss ${m.initialLoss.toFixed(4)} → ${m.bestLoss.toFixed(4)} · ${m.evaluations} corridas · ${m.seconds.toFixed(1)} s · ${JSON.stringify(m.best)}`);
    }
    splits.push({ split, models });
  }
  const params = Object.fromEntries(Object.entries(splits[0].models).map(([k, m]) => [k, m.best]));
  const ens = tuneEnsemble(d, params);
  console.log(`\n-> Ensamble (validación): η = ${ens.eta}, γ = ${ens.gamma} · log-loss ${Math.min(...ens.grid.map((g) => g.loss)).toFixed(4)}`);
  console.log(`-> Valor por QB (validación): ${JSON.stringify(ens.qbValue.params)} · log-loss ${Math.min(...ens.qbValue.grid.map((g) => g.loss)).toFixed(4)} (sin capa ${ens.qbValue.offLoss.toFixed(4)})`);
  console.log(`-> Capa de QB (validación): ventana ${ens.qb.window}, k₀ = ${ens.qb.k0}, temporada primero = ${ens.qb.seasonFirst}`);
  for (const sf of [false, true]) for (const w of [8, 12, 17, 24]) console.log(`   ${sf ? "temporada primero" : "solo ventana"} · ventana ${w}: ${ens.qb.grid.filter((g) => g.window === w && g.seasonFirst === sf).map((g) => `k₀ ${g.k0}: ${g.loss.toFixed(4)}`).join(" · ")}`);
  console.log(`-> Capa de bajas y clima (validación): k₀ = ${ens.context.k0} · ${ens.context.grid.map((g) => `${g.k0}: ${g.loss.toFixed(4)} (margen ${g.lossMargin.toFixed(4)}, total ${g.lossTotal.toFixed(4)})`).join(" · ")}`);
  console.log(`-> Números clave (validación): margen a = ${ens.keyNumbers.margin.a} · total a = ${ens.keyNumbers.total.a} · ${(["margin", "total"] as const).map((k) => ens.keyNumbers[k].grid.map((g) => `${k} ${g.a}: ${g.score.toFixed(4)}`).join(" · ")).join(" | ")}`);
  const file: ParamsFile = {
    createdAt: new Date().toISOString(),
    protocol: PROTOCOL_TEXT,
    splits,
    ensemble: { eta: ens.eta, gamma: ens.gamma, grid: ens.grid },
    qbValue: ens.qbValue,
    qb: ens.qb,
    context: ens.context,
    keyNumbers: ens.keyNumbers,
  };
  await mkdir(path.join(process.cwd(), "data"), { recursive: true });
  await writeFile(path.join(process.cwd(), "data", "model-params.json"), JSON.stringify(file, null, 1));
  console.log("\nGuardado en data/model-params.json\n");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
