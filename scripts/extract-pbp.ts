/**
 * Extrae play-by-play (jugada por jugada) de nflverse-data y lo carga como
 * Drive + Play. Esta es la capa granular que necesita el modelo de procesos
 * estocásticos del framework (docs/nfl_framework_v1.md, sección 5.3-5.7.3):
 * cada Play es un estado (down, distancia, yardas, tiempo) y cada Drive es
 * una trayectoria hasta un resultado absorbente (touchdown, gol de campo,
 * pérdida de balón, punto, fin de cuarto).
 *
 * Uso: npm run data:extract-pbp -- --season=2024
 */
import "dotenv/config";
import { gunzipSync } from "node:zlib";
import { parse } from "csv-parse/sync";
import { prisma } from "../src/lib/prisma";

const RELEASES_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

type CsvRow = Record<string, string>;

async function fetchGzipCsv(url: string): Promise<CsvRow[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = gunzipSync(buf).toString("utf-8");
  return parse(text, { columns: true, skip_empty_lines: true }) as CsvRow[];
}

function toInt(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === "" || v === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toFloat(v: string | undefined | null): number | null {
  if (v === undefined || v === null || v === "" || v === "NA") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: string | undefined | null): boolean {
  return v === "1" || v === "true" || v === "TRUE";
}

function parseArgs() {
  const seasonArg = process.argv.find((a) => a.startsWith("--season="));
  const season = seasonArg ? Number(seasonArg.split("=")[1]) : new Date().getFullYear() - 1;
  return { season };
}

async function main() {
  const { season } = parseArgs();
  console.log(`\n=== Extracción play-by-play (nflverse) -> DATAGSPORTS (temporada ${season}) ===\n`);

  console.log(`-> Descargando play_by_play_${season}.csv.gz`);
  const rows = await fetchGzipCsv(`${RELEASES_BASE}/pbp/play_by_play_${season}.csv.gz`);
  console.log(`   ${rows.length} jugadas descargadas`);

  const validGameIds = new Set(
    (await prisma.game.findMany({ where: { season }, select: { gameId: true } })).map((g) => g.gameId)
  );
  if (validGameIds.size === 0) {
    throw new Error(
      `No hay partidos cargados para la temporada ${season}. Corre primero: npm run data:extract -- --season=${season}`
    );
  }

  // Reconstruimos drives a partir de la primera jugada de cada (game_id, drive).
  type DriveAgg = {
    id: string;
    gameId: string;
    driveNumber: number;
    season: number;
    possessionTeamAbbr: string | null;
    quarterStart: number | null;
    playCount: number | null;
    timeOfPossession: string | null;
    firstDowns: number | null;
    reachedRedZone: boolean | null;
    endedWithScore: boolean | null;
    startYardLine: string | null;
    endYardLine: string | null;
    result: string | null;
  };
  const drives = new Map<string, DriveAgg>();
  const plays: {
    id: string;
    gameId: string;
    driveId: string | null;
    season: number;
    week: number;
    quarter: number | null;
    down: number | null;
    yardsToGo: number | null;
    yardLine100: number | null;
    gameSecondsRemaining: number | null;
    possessionTeamAbbr: string | null;
    defenseTeamAbbr: string | null;
    playType: string | null;
    yardsGained: number | null;
    epa: number | null;
    winProbability: number | null;
    homeWinProbability: number | null;
    scoreDifferential: number | null;
    isTouchdown: boolean;
    isInterception: boolean;
    isFumbleLost: boolean;
    isSack: boolean;
    isSuccess: boolean | null;
    isDropback: boolean | null;
    isPassAttempt: boolean | null;
    isRushAttempt: boolean | null;
    isQbHit: boolean | null;
    thirdDownConverted: boolean | null;
    thirdDownFailed: boolean | null;
    cpoe: number | null;
    passerPlayerId: string | null;
    rusherPlayerId: string | null;
    receiverPlayerId: string | null;
    description: string | null;
  }[] = [];

  let skippedUnknownGame = 0;
  for (const row of rows) {
    if (!row.game_id || !row.play_id) continue;
    if (!validGameIds.has(row.game_id)) {
      skippedUnknownGame++;
      continue;
    }

    const driveNum = toInt(row.drive);
    let driveId: string | null = null;
    if (driveNum !== null) {
      driveId = `${row.game_id}_D${driveNum}`;
      if (!drives.has(driveId)) {
        drives.set(driveId, {
          id: driveId,
          gameId: row.game_id,
          driveNumber: driveNum,
          season,
          possessionTeamAbbr: row.posteam || null,
          quarterStart: toInt(row.qtr),
          playCount: toInt(row.drive_play_count),
          timeOfPossession: row.drive_time_of_possession || null,
          firstDowns: toInt(row.drive_first_downs),
          reachedRedZone: row.drive_inside20 ? toBool(row.drive_inside20) : null,
          endedWithScore: row.drive_ended_with_score ? toBool(row.drive_ended_with_score) : null,
          startYardLine: row.drive_start_yard_line || null,
          endYardLine: row.drive_end_yard_line || null,
          result: row.fixed_drive_result || null,
        });
      }
    }

    plays.push({
      id: `${row.game_id}_${row.play_id}`,
      gameId: row.game_id,
      driveId,
      season,
      week: toInt(row.week) ?? 0,
      quarter: toInt(row.qtr),
      down: toInt(row.down),
      yardsToGo: toInt(row.ydstogo),
      yardLine100: toInt(row.yardline_100),
      gameSecondsRemaining: toInt(row.game_seconds_remaining),
      possessionTeamAbbr: row.posteam || null,
      defenseTeamAbbr: row.defteam || null,
      playType: row.play_type || null,
      yardsGained: toInt(row.yards_gained),
      epa: toFloat(row.epa),
      winProbability: toFloat(row.wp),
      homeWinProbability: toFloat(row.home_wp),
      scoreDifferential: toInt(row.score_differential),
      isTouchdown: toBool(row.touchdown),
      isInterception: toBool(row.interception),
      isFumbleLost: toBool(row.fumble_lost),
      isSack: toBool(row.sack),
      isSuccess: row.success === "" ? null : toBool(row.success),
      isDropback: row.qb_dropback === "" ? null : toBool(row.qb_dropback),
      isPassAttempt: row.pass_attempt === "" ? null : toBool(row.pass_attempt),
      isRushAttempt: row.rush_attempt === "" ? null : toBool(row.rush_attempt),
      isQbHit: row.qb_hit === "" ? null : toBool(row.qb_hit),
      thirdDownConverted: row.third_down_converted === "" ? null : toBool(row.third_down_converted),
      thirdDownFailed: row.third_down_failed === "" ? null : toBool(row.third_down_failed),
      cpoe: toFloat(row.cpoe),
      passerPlayerId: row.passer_player_id || null,
      rusherPlayerId: row.rusher_player_id || null,
      receiverPlayerId: row.receiver_player_id || null,
      description: row.desc || null,
    });
  }

  console.log(`   ${drives.size} posesiones (drives) reconstruidas`);
  console.log(`   ${plays.length} jugadas dentro de partidos conocidos (${skippedUnknownGame} omitidas)`);

  console.log("-> Limpiando datos previos de la temporada");
  await prisma.play.deleteMany({ where: { season } });
  await prisma.drive.deleteMany({ where: { season } });

  console.log("-> Insertando drives");
  const driveList = Array.from(drives.values());
  for (let i = 0; i < driveList.length; i += 1000) {
    await prisma.drive.createMany({ data: driveList.slice(i, i + 1000), skipDuplicates: true });
  }

  console.log("-> Insertando jugadas");
  for (let i = 0; i < plays.length; i += 1000) {
    await prisma.play.createMany({ data: plays.slice(i, i + 1000), skipDuplicates: true });
    process.stdout.write(`\r   ${Math.min(i + 1000, plays.length)} / ${plays.length}`);
  }
  console.log("\nExtracción de play-by-play completa.\n");
}

main()
  .catch((err) => {
    console.error("Error en la extracción de play-by-play:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
