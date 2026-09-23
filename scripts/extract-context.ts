/**
 * Extrae el contexto previo al partido que pide el framework y que no viene en
 * el play-by-play:
 * - injuries_{season}.csv: reporte oficial de lesiones (secciones 4.2 y 9.3)
 * - depth_charts_{season}.csv: alineación proyectada de cada semana (sección 6.1)
 * - advstats_week_def_{season}.csv (PFR): presiones al QB por partido (sección 4)
 *
 * Uso: npm run data:extract-context -- --season=2024
 */
import "dotenv/config";
import { parse } from "csv-parse/sync";
import { prisma } from "../src/lib/prisma";

const RELEASES_BASE = "https://github.com/nflverse/nflverse-data/releases/download";
type CsvRow = Record<string, string>;

async function fetchCsv(url: string): Promise<CsvRow[] | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return parse(await res.text(), { columns: true, skip_empty_lines: true }) as CsvRow[];
}
const toInt = (v?: string) => (v === undefined || v === "" || v === "NA" ? null : Math.round(Number(v)));
const toNum = (v?: string) => (v === undefined || v === "" || v === "NA" ? 0 : Number(v) || 0);

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 1000) await insert(rows.slice(i, i + 1000));
}

async function main() {
  const seasonArg = process.argv.find((a) => a.startsWith("--season="));
  const season = seasonArg ? Number(seasonArg.split("=")[1]) : new Date().getFullYear() - 1;
  console.log(`\n=== Contexto previo al partido (temporada ${season}) ===\n`);

  const injuries = await fetchCsv(`${RELEASES_BASE}/injuries/injuries_${season}.csv`);
  await prisma.injuryReport.deleteMany({ where: { season } });
  if (injuries) {
    const rows = injuries.map((r, i) => ({
      id: `${season}_${r.week}_${r.team}_${r.gsis_id || i}_${i}`,
      season,
      week: toInt(r.week) ?? 0,
      gameType: r.game_type || null,
      teamAbbr: r.team,
      gsisId: r.gsis_id || null,
      fullName: r.full_name,
      position: r.position || null,
      reportStatus: r.report_status && r.report_status !== "NA" ? r.report_status : null,
      practiceStatus: r.practice_status && r.practice_status !== "NA" ? r.practice_status : null,
      primaryInjury: r.report_primary_injury && r.report_primary_injury !== "NA" ? r.report_primary_injury : null,
      dateModified: r.date_modified ? new Date(r.date_modified) : null,
    }));
    await insertChunks(rows, (chunk) => prisma.injuryReport.createMany({ data: chunk }));
    console.log(`-> Reporte de lesiones: ${rows.length} registros`);
  } else console.log("-> Reporte de lesiones: no publicado para esta temporada");

  const depth = await fetchCsv(`${RELEASES_BASE}/depth_charts/depth_charts_${season}.csv`);
  await prisma.depthChartEntry.deleteMany({ where: { season } });
  if (depth) {
    const rows = depth.map((r, i) => ({
      id: `${season}_${r.week}_${r.club_code}_${i}`,
      season,
      week: toInt(r.week) ?? 0,
      gameType: r.game_type || null,
      teamAbbr: r.club_code,
      gsisId: r.gsis_id || null,
      fullName: r.full_name || `${r.first_name} ${r.last_name}`,
      position: r.position || null,
      depthPosition: r.depth_position || null,
      depthTeam: toInt(r.depth_team),
      formation: r.formation || null,
    }));
    await insertChunks(rows, (chunk) => prisma.depthChartEntry.createMany({ data: chunk }));
    console.log(`-> Depth charts: ${rows.length} registros`);
  } else console.log("-> Depth charts: no publicados para esta temporada");

  const pfr = await fetchCsv(`${RELEASES_BASE}/pfr_advstats/advstats_week_def_${season}.csv`);
  await prisma.teamGamePressure.deleteMany({ where: { season } });
  if (pfr) {
    const agg = new Map<string, { gameId: string; week: number; team: string; pressures: number; hurries: number; qbHits: number; sacks: number; blitzes: number; missedTackles: number }>();
    for (const r of pfr) {
      const key = `${r.game_id}_${r.team}`;
      const a = agg.get(key) ?? { gameId: r.game_id, week: toInt(r.week) ?? 0, team: r.team, pressures: 0, hurries: 0, qbHits: 0, sacks: 0, blitzes: 0, missedTackles: 0 };
      a.pressures += toNum(r.def_pressures);
      a.missedTackles += toNum(r.def_missed_tackles);
      a.hurries += toNum(r.def_times_hurried);
      a.qbHits += toNum(r.def_times_hitqb);
      a.sacks += toNum(r.def_sacks);
      a.blitzes += toNum(r.def_times_blitzed);
      agg.set(key, a);
    }
    const rows = [...agg.entries()].map(([id, a]) => ({
      id,
      gameId: a.gameId,
      season,
      week: a.week,
      teamAbbr: a.team,
      pressures: Math.round(a.pressures),
      hurries: Math.round(a.hurries),
      qbHits: Math.round(a.qbHits),
      sacks: a.sacks,
      blitzes: Math.round(a.blitzes),
      missedTackles: Math.round(a.missedTackles),
    }));
    await insertChunks(rows, (chunk) => prisma.teamGamePressure.createMany({ data: chunk }));
    console.log(`-> Presión defensiva (PFR): ${rows.length} equipo-partido`);
  } else console.log("-> Presión defensiva (PFR): no publicada para esta temporada");

  console.log("\nContexto cargado.\n");
}

main()
  .catch((err) => {
    console.error("Error extrayendo contexto:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
