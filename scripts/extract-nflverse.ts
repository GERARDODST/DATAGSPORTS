/**
 * Extrae datos abiertos de NFL (equipos, jugadores, calendario y estadísticas
 * semanales) desde los releases de nflverse-data y los carga en la base de
 * datos local vía Prisma.
 *
 * Uso: npm run data:extract -- --season=2024
 */
import "dotenv/config";
import { parse } from "csv-parse/sync";
import { prisma } from "../src/lib/prisma";

const RELEASES_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

type CsvRow = Record<string, string>;

async function fetchCsv(url: string): Promise<CsvRow[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true }) as CsvRow[];
}

function toInt(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toFloat(value: string | undefined | null): number | null {
  if (value === undefined || value === null || value === "" || value === "NA") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function gameKey(season: number, week: string | number, teamA: string, teamB: string): string {
  const [a, b] = [teamA, teamB].sort();
  return `${season}|${week}|${a}-${b}`;
}

function parseArgs() {
  const seasonArg = process.argv.find((a) => a.startsWith("--season="));
  const season = seasonArg ? Number(seasonArg.split("=")[1]) : new Date().getFullYear() - 1;
  return { season };
}

async function loadTeams(): Promise<Set<string>> {
  console.log("-> Equipos (teams_colors_logos.csv)");
  const rows = await fetchCsv(`${RELEASES_BASE}/teams/teams_colors_logos.csv`);
  const abbrs = new Set<string>();
  for (const row of rows) {
    if (!row.team_abbr) continue;
    await prisma.team.upsert({
      where: { abbr: row.team_abbr },
      update: {
        name: row.team_name,
        nickname: row.team_nick || null,
        conference: row.team_conf || null,
        division: row.team_division || null,
        primaryColor: row.team_color || null,
        secondaryColor: row.team_color2 || null,
        logoUrl: row.team_logo_espn || row.team_logo_squared || null,
      },
      create: {
        abbr: row.team_abbr,
        name: row.team_name,
        nickname: row.team_nick || null,
        conference: row.team_conf || null,
        division: row.team_division || null,
        primaryColor: row.team_color || null,
        secondaryColor: row.team_color2 || null,
        logoUrl: row.team_logo_espn || row.team_logo_squared || null,
      },
    });
    abbrs.add(row.team_abbr);
  }
  console.log(`   ${abbrs.size} equipos cargados`);
  return abbrs;
}

async function loadRosterPlayers(season: number, knownTeams: Set<string>): Promise<Set<string>> {
  console.log(`-> Jugadores (roster_${season}.csv)`);
  const rows = await fetchCsv(`${RELEASES_BASE}/rosters/roster_${season}.csv`);

  // El roster viene una fila por jugador/semana; nos quedamos con la fila
  // de mayor semana (snapshot mas reciente) por gsis_id.
  const latestByPlayer = new Map<string, CsvRow>();
  for (const row of rows) {
    if (!row.gsis_id) continue;
    const week = toInt(row.week) ?? 0;
    const existing = latestByPlayer.get(row.gsis_id);
    const existingWeek = existing ? toInt(existing.week) ?? 0 : -1;
    if (week >= existingWeek) {
      latestByPlayer.set(row.gsis_id, row);
    }
  }

  const knownPlayers = new Set<string>();
  for (const row of latestByPlayer.values()) {
    const teamAbbr = row.team && knownTeams.has(row.team) ? row.team : null;
    await prisma.player.upsert({
      where: { gsisId: row.gsis_id },
      update: {
        fullName: row.full_name,
        position: row.position || null,
        teamAbbr,
        birthDate: toDate(row.birth_date),
        heightIn: toInt(row.height),
        weightLb: toInt(row.weight),
        college: row.college || null,
        jerseyNumber: toInt(row.jersey_number),
        status: row.status || null,
        headshotUrl: row.headshot_url || null,
      },
      create: {
        gsisId: row.gsis_id,
        fullName: row.full_name,
        position: row.position || null,
        teamAbbr,
        birthDate: toDate(row.birth_date),
        heightIn: toInt(row.height),
        weightLb: toInt(row.weight),
        college: row.college || null,
        jerseyNumber: toInt(row.jersey_number),
        status: row.status || null,
        headshotUrl: row.headshot_url || null,
      },
    });
    knownPlayers.add(row.gsis_id);
  }
  console.log(`   ${knownPlayers.size} jugadores cargados`);
  return knownPlayers;
}

const FRANCHISE: Record<string, string> = { OAK: "LV", SD: "LAC", STL: "LA" };

async function loadGames(season: number, knownTeams: Set<string>): Promise<Map<string, string>> {
  console.log("-> Calendario (games.csv)");
  const rows = await fetchCsv(`${RELEASES_BASE}/schedules/games.csv`);
  const seasonRows = rows.filter((r) => toInt(r.season) === season);

  const lookup = new Map<string, string>();
  let loaded = 0;
  let skipped = 0;
  for (const raw of seasonRows) {
    // Franquicias que cambiaron de ciudad: se guardan con su abreviatura actual para que el Elo y el historial sigan al mismo equipo.
    const row: CsvRow = { ...raw, home_team: FRANCHISE[raw.home_team] ?? raw.home_team, away_team: FRANCHISE[raw.away_team] ?? raw.away_team };
    if (!knownTeams.has(row.home_team) || !knownTeams.has(row.away_team)) {
      skipped++;
      continue;
    }
    const fields = {
      season,
      week: toInt(row.week) ?? 0,
      gameType: row.game_type || null,
      gameDate: toDate(row.gameday),
      homeTeamAbbr: row.home_team,
      awayTeamAbbr: row.away_team,
      homeScore: toInt(row.home_score),
      awayScore: toInt(row.away_score),
      stadium: row.stadium || null,
      roof: row.roof || null,
      surface: row.surface || null,
      spreadLine: toFloat(row.spread_line),
      totalLine: toFloat(row.total_line),
      location: row.location || null,
      divGame: row.div_game === "" ? null : row.div_game === "1",
      homeRest: toInt(row.home_rest),
      awayRest: toInt(row.away_rest),
      homeMoneyline: toInt(row.home_moneyline),
      awayMoneyline: toInt(row.away_moneyline),
      homeSpreadOdds: toInt(row.home_spread_odds),
      awaySpreadOdds: toInt(row.away_spread_odds),
      overOdds: toInt(row.over_odds),
      underOdds: toInt(row.under_odds),
      temp: toInt(row.temp),
      wind: toInt(row.wind),
      homeQbName: row.home_qb_name || null,
      awayQbName: row.away_qb_name || null,
      homeQbId: row.home_qb_id && row.home_qb_id !== "NA" ? row.home_qb_id : null,
      awayQbId: row.away_qb_id && row.away_qb_id !== "NA" ? row.away_qb_id : null,
    };
    await prisma.game.upsert({
      where: { gameId: row.game_id },
      update: fields,
      create: { gameId: row.game_id, ...fields },
    });
    lookup.set(gameKey(season, row.week, row.home_team, row.away_team), row.game_id);
    loaded++;
  }
  console.log(`   ${loaded} partidos cargados (${skipped} omitidos por equipo desconocido)`);
  return lookup;
}

async function loadWeeklyStats(
  season: number,
  knownPlayers: Set<string>,
  knownTeams: Set<string>,
  gameLookup: Map<string, string>
) {
  console.log(`-> Estadísticas semanales de jugadores (temporada ${season})`);
  let rows: CsvRow[];
  try {
    rows = await fetchCsv(`${RELEASES_BASE}/player_stats/stats_player_week_${season}.csv`);
  } catch {
    console.log("   (sin archivo por temporada, descargando player_stats.csv completo y filtrando)");
    const all = await fetchCsv(`${RELEASES_BASE}/player_stats/player_stats.csv`);
    rows = all.filter((r) => toInt(r.season) === season);
  }

  let processed = 0;
  for (const row of rows) {
    if (!row.player_id) continue;

    // Si el jugador no vino en el snapshot de roster (ej. corte/trade),
    // lo damos de alta con los datos mínimos disponibles en las stats.
    if (!knownPlayers.has(row.player_id)) {
      const teamAbbr = (row.team ?? row.recent_team) && knownTeams.has((row.team ?? row.recent_team)) ? (row.team ?? row.recent_team) : null;
      await prisma.player.upsert({
        where: { gsisId: row.player_id },
        update: {},
        create: {
          gsisId: row.player_id,
          fullName: row.player_display_name || row.player_name || row.player_id,
          position: row.position || null,
          teamAbbr,
          headshotUrl: row.headshot_url || null,
        },
      });
      knownPlayers.add(row.player_id);
    }

    const gameId =
      (row.team ?? row.recent_team) && row.opponent_team
        ? gameLookup.get(gameKey(season, row.week, (row.team ?? row.recent_team), row.opponent_team)) ?? null
        : null;
    const seasonType = row.season_type || "REG";

    await prisma.playerWeekStat.upsert({
      where: {
        playerId_season_week_seasonType: {
          playerId: row.player_id,
          season,
          week: toInt(row.week) ?? 0,
          seasonType,
        },
      },
      update: {
        gameId,
        teamAbbr: (row.team ?? row.recent_team) || null,
        opponentAbbr: row.opponent_team || null,
        completions: toInt(row.completions),
        attempts: toInt(row.attempts),
        passingYards: toInt(row.passing_yards),
        passingTds: toInt(row.passing_tds),
        interceptions: toInt(row.passing_interceptions ?? row.interceptions),
        carries: toInt(row.carries),
        rushingYards: toInt(row.rushing_yards),
        rushingTds: toInt(row.rushing_tds),
        receptions: toInt(row.receptions),
        targets: toInt(row.targets),
        receivingYards: toInt(row.receiving_yards),
        receivingTds: toInt(row.receiving_tds),
        fantasyPoints: toFloat(row.fantasy_points),
        fantasyPointsPpr: toFloat(row.fantasy_points_ppr),
      },
      create: {
        playerId: row.player_id,
        gameId,
        season,
        week: toInt(row.week) ?? 0,
        seasonType,
        teamAbbr: (row.team ?? row.recent_team) || null,
        opponentAbbr: row.opponent_team || null,
        completions: toInt(row.completions),
        attempts: toInt(row.attempts),
        passingYards: toInt(row.passing_yards),
        passingTds: toInt(row.passing_tds),
        interceptions: toInt(row.passing_interceptions ?? row.interceptions),
        carries: toInt(row.carries),
        rushingYards: toInt(row.rushing_yards),
        rushingTds: toInt(row.rushing_tds),
        receptions: toInt(row.receptions),
        targets: toInt(row.targets),
        receivingYards: toInt(row.receiving_yards),
        receivingTds: toInt(row.receiving_tds),
        fantasyPoints: toFloat(row.fantasy_points),
        fantasyPointsPpr: toFloat(row.fantasy_points_ppr),
      },
    });
    processed++;
  }
  console.log(`   ${processed} registros semana-jugador procesados`);
}

async function main() {
  const { season } = parseArgs();
  console.log(`\n=== Extracción NFLverse -> DATAGSPORTS (temporada ${season}) ===\n`);

  const knownTeams = await loadTeams();
  // --games-only: solo resultados y momios de esa temporada (historial para H2H y Elo), sin rosters ni stats.
  if (process.argv.includes("--games-only")) {
    await loadGames(season, knownTeams);
    console.log("\nExtracción completa (solo calendario).\n");
    return;
  }
  const knownPlayers = await loadRosterPlayers(season, knownTeams);
  const gameLookup = await loadGames(season, knownTeams);
  await loadWeeklyStats(season, knownPlayers, knownTeams, gameLookup);

  console.log("\nExtracción completa.\n");
}

main()
  .catch((err) => {
    console.error("Error en la extracción:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
