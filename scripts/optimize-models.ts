/**
 * Optimiza los hiperparámetros de los modelos del torneo y del ensamble, y los guarda en
 * data/model-params.json (versionado) junto con la traza de cada evaluación.
 *
 * Uso: npm run models:optimize
 */
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadModelData } from "../src/lib/models/backtest";
import { SPLITS, optimizeSplit, tuneEnsemble, type ParamsFile } from "../src/lib/models/lab";
import { prisma } from "../src/lib/prisma";

async function main() {
  const d = await loadModelData(2018);
  console.log(`\n=== Optimización de modelos: ${d.games.length} partidos, ${d.plays} jugadas ===`);
  const splits: ParamsFile["splits"] = [];
  for (const split of SPLITS) {
    console.log(`\n-> Split "${split.name}": entrenamiento ${split.trainFrom}–${split.trainTo}`);
    const models = optimizeSplit(d, split);
    for (const [k, m] of Object.entries(models)) {
      console.log(`   ${k.padEnd(10)} log-loss ${m.initialLoss.toFixed(4)} → ${m.bestLoss.toFixed(4)} · ${m.evaluations} corridas · ${m.seconds.toFixed(1)} s · ${JSON.stringify(m.best)}`);
    }
    splits.push({ split, models });
  }
  const params = Object.fromEntries(Object.entries(splits[0].models).map(([k, m]) => [k, m.best]));
  const ens = tuneEnsemble(d, params);
  console.log(`\n-> Ensamble (validación 2023): η = ${ens.eta}, γ = ${ens.gamma} · log-loss ${Math.min(...ens.grid.map((g) => g.loss)).toFixed(4)}`);
  console.log(`-> Capa de QB (validación 2023): ventana ${ens.qb.window}, k₀ = ${ens.qb.k0}`);
  for (const w of [0, 8, 12, 17, 24]) console.log(`   ventana ${w}: ${ens.qb.grid.filter((g) => g.window === w).map((g) => `k₀ ${g.k0}: ${g.loss.toFixed(4)}`).join(" · ")}`);
  const file: ParamsFile = {
    createdAt: new Date().toISOString(),
    protocol: "Calentamiento 2018–2019 · entrenamiento 2020–2022 (modelos) · validación 2023 (ensamble) · prueba 2024",
    splits,
    ensemble: { eta: ens.eta, gamma: ens.gamma, grid: ens.grid },
    qb: ens.qb,
  };
  await mkdir(path.join(process.cwd(), "data"), { recursive: true });
  await writeFile(path.join(process.cwd(), "data", "model-params.json"), JSON.stringify(file, null, 1));
  console.log("\nGuardado en data/model-params.json\n");
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
