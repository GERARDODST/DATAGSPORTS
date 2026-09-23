/** Reporte del torneo con los parámetros guardados. Uso: npm run models:report */
import "dotenv/config";
import { loadGameContext, loadModelData } from "../src/lib/models/backtest";
import { readParams, runFinal, labSummary } from "../src/lib/models/lab";
import { prisma } from "../src/lib/prisma";
async function main() {
  const base = await loadModelData(2018);
  const d = { ...base, ctx: await loadGameContext(base.games) };
  const pf = await readParams();
  const run = runFinal(d, pf);
  const s = labSummary(run, pf);
  console.log(`walk-forward final: ${s.games} partidos en ${s.runSeconds} s · ensamble η=${pf?.ensemble.eta} γ=${pf?.ensemble.gamma}`);
  for (const p of s.leaderboard) {
    console.log(`\n== ${p.label}`);
    console.log("modelo".padEnd(40), "n    logloss  brier   acierto  MAEm   MAEt   vsMercado(z)   ATS");
    for (const r of p.rows) console.log(r.label.padEnd(40), String(r.n).padEnd(4), String(r.logLoss).padEnd(8), String(r.brier).padEnd(7), String(r.accuracy).padEnd(8), String(r.marginMae).padEnd(6), String(r.totalMae).padEnd(6), (r.vsMarket ? `${r.vsMarket.diff} (${r.vsMarket.z})` : "").padEnd(14), r.ats ? `${r.ats.wins}-${r.ats.losses} ${((r.ats.rate ?? 0) * 100).toFixed(1)}%±${((r.ats.se ?? 0) * 100).toFixed(1)}` : "");
  }
  console.log("\ncalibración final 2023-24:", JSON.stringify(s.calibration.final));
  console.log("QB:", JSON.stringify(s.qbStats), "k0", run.k0);
  console.log("Bajas y clima (MCO 2019-2024):");
  for (const e of [...(s.context?.margin ?? []), ...(s.context?.total ?? [])]) console.log(`   ${e.name.padEnd(28)} ${String(e.beta).padStart(6)} ± ${e.se} (z ${e.z}, n ${e.n}) · framework: ${e.framework}`);
}
main().finally(() => prisma.$disconnect());
