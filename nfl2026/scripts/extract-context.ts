/**
 * Extrae el contexto previo al partido que pide el framework y que no viene en
 * el play-by-play:
 * - injuries_{season}.csv: reporte oficial de lesiones (secciones 4.2 y 9.3)
 * - depth_charts_{season}.csv: alineación proyectada de cada semana (sección 6.1)
 * - advstats_week_def_{season}.csv (PFR): presiones al QB por partido (sección 4)
 * - espn_data/qbr_*_level.csv: QBR de ESPN por partido y por temporada (sección 3.4)
 * - roster_weekly_{season}.csv: inactivos oficiales del día del partido (sección 6.1, regla 8.3.12)
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

/** Posición del depth chart de ESPN → posición del formato anterior de nflverse (LT → T, LCB/NB → CB…). */
const ESPN_POS: Record<string, string> = {
  QB: "QB", RB: "RB", FB: "FB", WR: "WR", TE: "TE", LT: "T", RT: "T", LG: "G", RG: "G", C: "C",
  LDE: "DE", RDE: "DE", LDT: "DT", RDT: "DT", NT: "NT", WLB: "OLB", SLB: "OLB", MLB: "MLB", LILB: "ILB", RILB: "ILB",
  LCB: "CB", RCB: "CB", NB: "CB", FS: "FS", SS: "SS",
};

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 1000) await insert(rows.slice(i, i + 1000));
}

async function main() {
  const seasonArg = process.argv.find((a) => a.startsWith("--season="));
  const season = seasonArg ? Number(seasonArg.split("=")[1]) : 2026;
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
  if (depth && depth[0] && "dt" in depth[0]) {
    // Formato nuevo (desde 2025): capturas diarias del depth chart de ESPN, sin semana. Para cada
    // partido de cada equipo se toma la última captura anterior a la patada (antes de las 13:00 UTC
    // del día del partido, la hora más temprana de juego) y se guarda como el depth chart de esa semana.
    const games = await prisma.game.findMany({ where: { season, gameDate: { not: null } }, select: { week: true, gameType: true, gameDate: true, homeTeamAbbr: true, awayTeamAbbr: true } });
    const byTeamDt = new Map<string, Map<string, CsvRow[]>>();
    for (const r of depth) {
      const m = byTeamDt.get(r.team) ?? new Map<string, CsvRow[]>();
      const list = m.get(r.dt) ?? [];
      list.push(r);
      m.set(r.dt, list);
      byTeamDt.set(r.team, m);
    }
    const rows: { id: string; season: number; week: number; gameType: string | null; teamAbbr: string; gsisId: string | null; fullName: string; position: string | null; depthPosition: string | null; depthTeam: number | null; formation: string | null }[] = [];
    for (const g of games) {
      const cutoff = `${(g.gameDate as Date).toISOString().slice(0, 10)}T13:00:00Z`;
      for (const team of [g.homeTeamAbbr, g.awayTeamAbbr]) {
        const snaps = byTeamDt.get(team);
        if (!snaps) continue;
        const dt = [...snaps.keys()].filter((d) => d < cutoff).sort().at(-1);
        if (!dt) continue;
        const best = new Map<string, CsvRow>();
        for (const r of snaps.get(dt) as CsvRow[]) {
          const pos = ESPN_POS[r.pos_abb];
          if (!pos || !r.gsis_id || r.gsis_id === "NA") continue;
          const prev = best.get(r.gsis_id);
          if (!prev || Number(r.pos_rank) < Number(prev.pos_rank)) best.set(r.gsis_id, r);
        }
        for (const r of best.values()) rows.push({
          id: `${season}_${g.week}_${team}_${r.gsis_id}`, season, week: g.week, gameType: g.gameType, teamAbbr: team, gsisId: r.gsis_id,
          fullName: r.player_name, position: ESPN_POS[r.pos_abb], depthPosition: r.pos_abb, depthTeam: toInt(r.pos_rank), formation: r.pos_grp || null,
        });
      }
    }
    await insertChunks(rows, (chunk) => prisma.depthChartEntry.createMany({ data: chunk, skipDuplicates: true }));
    console.log(`-> Depth charts (capturas diarias de ESPN → semana de cada partido): ${rows.length} registros`);
  } else if (depth) {
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

  // QBR de ESPN: por semana y por temporada (la de la temporada se guarda con week = 0).
  const qbrWeek = await fetchCsv(`${RELEASES_BASE}/espn_data/qbr_week_level.csv`);
  const qbrSeason = await fetchCsv(`${RELEASES_BASE}/espn_data/qbr_season_level.csv`);
  await prisma.qbrEntry.deleteMany({ where: { season } });
  const qbrRows = [
    ...(qbrWeek ?? []).filter((r) => toInt(r.season) === season).map((r) => ({ r, week: toInt(r.week_num ?? r.game_week) ?? 0 })),
    ...(qbrSeason ?? []).filter((r) => toInt(r.season) === season).map((r) => ({ r, week: 0 })),
  ]
    .filter(({ r }) => r.qbr_total && r.qbr_total !== "NA")
    .map(({ r, week }) => ({
      id: `${season}_${r.season_type}_${week}_${r.player_id}_${r.team_abb}`,
      season,
      seasonType: r.season_type,
      week,
      teamAbbr: r.team_abb,
      espnId: r.player_id,
      name: r.name_display,
      qbrTotal: Number(r.qbr_total),
      qbPlays: toInt(r.qb_plays) ?? 0,
      epaTotal: r.epa_total && r.epa_total !== "NA" ? Number(r.epa_total) : null,
    }));
  const seen = new Set<string>();
  const qbrUnique = qbrRows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  await insertChunks(qbrUnique, (chunk) => prisma.qbrEntry.createMany({ data: chunk }));
  console.log(`-> QBR de ESPN: ${qbrUnique.filter((r) => r.week > 0).length} QB-partido y ${qbrUnique.filter((r) => r.week === 0).length} QB-temporada`);

  // Roster semanal: estado de cada jugador (ACT, INA, RES...). INA son los inactivos oficiales del partido.
  const roster = await fetchCsv(`${RELEASES_BASE}/weekly_rosters/roster_weekly_${season}.csv`);
  await prisma.rosterStatus.deleteMany({ where: { season } });
  if (roster) {
    const rows = roster
      .filter((r) => r.status && r.status !== "ACT")
      .map((r, i) => ({
        id: `${season}_${r.week}_${r.team}_${r.gsis_id || i}_${i}`,
        season,
        week: toInt(r.week) ?? 0,
        teamAbbr: r.team,
        gsisId: r.gsis_id && r.gsis_id !== "NA" ? r.gsis_id : null,
        fullName: r.full_name,
        position: r.position || null,
        status: r.status,
        statusDescription: r.status_description_abbr && r.status_description_abbr !== "NA" ? r.status_description_abbr : null,
      }));
    await insertChunks(rows, (chunk) => prisma.rosterStatus.createMany({ data: chunk }));
    console.log(`-> Roster semanal: ${rows.length} jugadores no activos (${rows.filter((r) => r.status === "INA").length} inactivos del día del partido)`);
  } else console.log("-> Roster semanal: no publicado para esta temporada");

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
