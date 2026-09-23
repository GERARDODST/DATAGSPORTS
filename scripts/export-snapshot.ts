/**
 * Exporta una foto de la base de datos a snapshot/dist/ para publicarla como
 * página estática (visor de DATAGSPORTS sin servidor ni base de datos).
 *
 * - snapshot/dist/index.html: snapshot/viewer.html con los datos generales
 *   (equipos, partidos, líderes, modelo EP) embebidos, para que la página
 *   muestre contenido real apenas carga.
 * - snapshot/dist/data/week-XX.json: jugadas, posesiones y comparación EPA de
 *   cada partido, agrupadas por semana y cargadas bajo demanda.
 *
 * Uso: npm run snapshot:export -- --season=2024
 */
import "dotenv/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { buildFieldPositionEpModel, ownEpaForPlay } from "../src/lib/expected-points";
import { buildMarkovModel, pearson } from "../src/lib/markov-model";
import { buildPregameAnalysis, type PregameAnalysis } from "../src/lib/framework-analysis";

// Equipo que seguimos partido a partido y cuántos de sus partidos ya tienen análisis previo.
const FOCUS_TEAM = "KC";
const FOCUS_GAMES_ANALYZED = 1;

const ROOT = path.resolve(__dirname, "..", "snapshot");
const DIST = path.join(ROOT, "dist");
const TEMPLATE_MARKER = "/*__CORE_DATA__*/null";

const round = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined ? null : Number(v.toFixed(digits));


function parseArgs() {
  const seasonArg = process.argv.find((a) => a.startsWith("--season="));
  return { season: seasonArg ? Number(seasonArg.split("=")[1]) : new Date().getFullYear() - 1 };
}

async function main() {
  const { season } = parseArgs();
  console.log(`\n=== Exportando snapshot de DATAGSPORTS (temporada ${season}) ===\n`);

  const [teams, games, model, driveGroups, playTypeGroups, leadersRaw, counts] = await Promise.all([
    prisma.team.findMany({ orderBy: { abbr: "asc" } }),
    prisma.game.findMany({ where: { season }, orderBy: [{ week: "asc" }, { gameDate: "asc" }, { gameId: "asc" }] }),
    buildFieldPositionEpModel(season),
    prisma.drive.groupBy({ by: ["result"], where: { season }, _count: { _all: true } }),
    prisma.play.groupBy({
      by: ["playType"],
      where: { season, playType: { in: ["pass", "run", "punt", "field_goal"] } },
      _count: { _all: true },
      _avg: { epa: true },
    }),
    prisma.playerWeekStat.groupBy({
      by: ["playerId"],
      where: { season },
      _sum: { fantasyPointsPpr: true },
      orderBy: { _sum: { fantasyPointsPpr: "desc" } },
      take: 10,
    }),
    Promise.all([
      prisma.player.count(),
      prisma.play.count({ where: { season } }),
      prisma.drive.count({ where: { season } }),
    ]),
  ]);

  if (games.length === 0) {
    throw new Error(`No hay partidos para ${season}. Corre primero data:extract y data:extract-pbp.`);
  }

  const leaderPlayers = await prisma.player.findMany({
    where: { gsisId: { in: leadersRaw.map((l) => l.playerId) } },
  });
  const playerById = new Map(leaderPlayers.map((p) => [p.gsisId, p]));

  const usedTeams = new Set(games.flatMap((g) => [g.homeTeamAbbr, g.awayTeamAbbr]));
  const core = {
    season,
    generatedAt: new Date().toISOString(),
    counts: {
      teams: usedTeams.size,
      players: counts[0],
      games: games.length,
      plays: counts[1],
      drives: counts[2],
    },
    teams: Object.fromEntries(
      teams
        .filter((t) => usedTeams.has(t.abbr))
        .map((t) => [
          t.abbr,
          { name: t.name, conf: t.conference, div: t.division, c1: t.primaryColor, c2: t.secondaryColor },
        ])
    ),
    games: games.map((g) => ({
      id: g.gameId,
      week: g.week,
      type: g.gameType,
      date: g.gameDate ? g.gameDate.toISOString().slice(0, 10) : null,
      home: g.homeTeamAbbr,
      away: g.awayTeamAbbr,
      hs: g.homeScore,
      as: g.awayScore,
      spread: g.spreadLine,
      total: g.totalLine,
      stadium: g.stadium,
      roof: g.roof,
    })),
    leaders: leadersRaw.map((l) => {
      const p = playerById.get(l.playerId);
      return {
        name: p?.fullName ?? l.playerId,
        pos: p?.position ?? null,
        team: p?.teamAbbr ?? null,
        pts: round(l._sum.fantasyPointsPpr, 1),
      };
    }),
    epModel: model.map((b) => ({ bucket: b.bucket, ep: round(b.avgExpectedPoints, 3), n: b.sampleSize })),
    driveResults: driveGroups
      .map((d) => ({ result: d.result ?? "Desconocido", n: d._count._all }))
      .sort((a, b) => b.n - a.n),
    playTypeEpa: playTypeGroups
      .map((p) => ({ type: p.playType, n: p._count._all, epa: round(p._avg.epa, 3) }))
      .sort((a, b) => (b.epa ?? 0) - (a.epa ?? 0)),
    epCompare: null as null | { n: number; r: number | null; mae: number },
    markov: null as null | { n: number; r: number | null; mae: number; iterations: number },
    focus: { team: FOCUS_TEAM, analyzed: [] as string[] },
    pregame: {} as Record<string, PregameAnalysis>,
  };

  console.log("-> Resolviendo la cadena de Markov (iteración de valor)");
  const markov = await buildMarkovModel(season);
  core.markov = {
    n: markov.epa.n,
    r: round(markov.epa.r, 3),
    mae: round(markov.epa.mae, 3) ?? 0,
    iterations: markov.iterations.length,
  };
  console.log(
    `   ${markov.iterations.length} iteraciones · EPA v2 vs nflverse en ${markov.epa.n} jugadas: r=${core.markov.r}`
  );

  const ownEpas: number[] = [];
  const nflverseEpas: number[] = [];

  await rm(DIST, { recursive: true, force: true });
  await mkdir(path.join(DIST, "data"), { recursive: true });

  const weeks = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
  let totalBytes = 0;
  for (const week of weeks) {
    const weekGames = games.filter((g) => g.week === week);
    const payload: Record<string, unknown> = {};
    for (const g of weekGames) {
      const [plays, drives] = await Promise.all([
        prisma.play.findMany({
          where: { gameId: g.gameId },
          orderBy: [{ gameSecondsRemaining: "desc" }, { id: "asc" }],
          select: {
            id: true,
            playType: true,
            quarter: true,
            down: true,
            gameSecondsRemaining: true,
            homeWinProbability: true,
            possessionTeamAbbr: true,
            yardLine100: true,
            yardsGained: true,
            isTouchdown: true,
            isInterception: true,
            isFumbleLost: true,
            epa: true,
            description: true,
          },
        }),
        prisma.drive.findMany({ where: { gameId: g.gameId }, orderBy: { driveNumber: "asc" } }),
      ]);

      // [segundos transcurridos, cuarto, prob. victoria local, descripción]
      // En tiempo extra nflverse reinicia gameSecondsRemaining en 600, así que
      // el tiempo transcurrido se cuenta a partir de 3600 por cada periodo extra.
      const wp = plays
        .filter((p) => p.gameSecondsRemaining !== null && p.homeWinProbability !== null)
        .map((p) => {
          const gsr = p.gameSecondsRemaining as number;
          const q = p.quarter ?? 1;
          const elapsed = q >= 5 ? 3600 + 600 * (q - 5) + (600 - gsr) : 3600 - gsr;
          return [elapsed, q, round(p.homeWinProbability, 3), p.description];
        })
        .sort((a, b) => (a[0] as number) - (b[0] as number));

      // [cuarto, equipo, yardline100, descripción, EP antes, EP después, EPA propio, EPA nflverse]
      const firstDown = plays
        .filter((p) => p.down === 1 && p.yardLine100 !== null)
        .map((p) => {
          const own = ownEpaForPlay(model, { ...p, yardLine100: p.yardLine100 as number });
          if (own.epaHat !== null && p.epa !== null) {
            ownEpas.push(own.epaHat);
            nflverseEpas.push(p.epa);
          }
          return [
            p.quarter,
            p.possessionTeamAbbr,
            p.yardLine100,
            p.description,
            round(own.epBefore, 2),
            round(own.epAfter, 2),
            round(own.epaHat, 2),
            round(p.epa, 2),
          ];
        })
        .sort((a, b) => ((a[0] as number) ?? 0) - ((b[0] as number) ?? 0));

      // [nº, equipo, cuarto, inicio, fin, jugadas, resultado]
      const driveRows = drives.map((d) => [
        d.driveNumber,
        d.possessionTeamAbbr,
        d.quarterStart,
        d.startYardLine,
        d.endYardLine,
        d.playCount,
        d.result,
      ]);

      const v2Own: number[] = [];
      const v2Ref: number[] = [];
      for (const p of plays) {
        const own = markov.ownEpaByPlay.get(p.id);
        if (own === undefined || p.epa === null || p.playType === "no_play") continue;
        v2Own.push(own);
        v2Ref.push(p.epa);
      }
      const v2 = { n: v2Own.length, r: round(pearson(v2Own, v2Ref), 3) };

      payload[g.gameId] = { wp, firstDown, drives: driveRows, v2 };
    }
    const json = JSON.stringify(payload);
    totalBytes += json.length;
    await writeFile(path.join(DIST, "data", `week-${String(week).padStart(2, "0")}.json`), json);
    process.stdout.write(`\r   semana ${week}/${weeks[weeks.length - 1]} exportada`);
  }

  const focusGames = games
    .filter((g) => g.homeTeamAbbr === FOCUS_TEAM || g.awayTeamAbbr === FOCUS_TEAM)
    .slice(0, FOCUS_GAMES_ANALYZED);
  for (const g of focusGames) {
    console.log(`\n-> Modelo previo al partido: ${g.gameId} (solo datos antes del ${g.gameDate?.toISOString().slice(0, 10)})`);
    const analysis = await buildPregameAnalysis(g.gameId);
    core.pregame[g.gameId] = analysis;
    core.focus.analyzed.push(g.gameId);
    console.log(
      `   P(${analysis.home} gana)=${analysis.pHome} · proyección ${analysis.home} ${analysis.projection.home} - ${analysis.away} ${analysis.projection.away}` +
        (analysis.postgame ? ` · real ${analysis.postgame.homeScore}-${analysis.postgame.awayScore}` : "")
    );
  }

  core.epCompare = {
    n: ownEpas.length,
    r: round(pearson(ownEpas, nflverseEpas), 3),
    mae: round(ownEpas.reduce((s, v, i) => s + Math.abs(v - nflverseEpas[i]), 0) / ownEpas.length, 3) ?? 0,
  };
  console.log(
    `\n   EPA propio vs nflverse en ${core.epCompare.n} jugadas de 1er down: r=${core.epCompare.r}, diferencia media=${core.epCompare.mae}`
  );

  const lab = {
    ep: markov.ep.map((v) => round(v, 3)),
    n: markov.n,
    iterations: markov.iterations.map((v) => round(v, 5)),
    transitions: markov.transitions.map((t) => [t.yards, t.codes]),
    driveStarts: markov.driveStarts,
  };
  const labJson = JSON.stringify(lab);
  await writeFile(path.join(DIST, "data", "lab.json"), labJson);
  console.log(`   lab.json: ${(labJson.length / 1024).toFixed(0)} KB (estados, iteraciones y transiciones)`);

  const template = await readFile(path.join(ROOT, "viewer.html"), "utf-8");
  if (!template.includes(TEMPLATE_MARKER)) {
    throw new Error(`snapshot/viewer.html no contiene el marcador ${TEMPLATE_MARKER}`);
  }
  const coreJson = JSON.stringify(core).replace(/</g, "\\u003c");
  const html = template.replace(TEMPLATE_MARKER, coreJson);
  await writeFile(path.join(DIST, "index.html"), html);

  console.log(
    `\n   index.html: ${(html.length / 1024).toFixed(0)} KB · jugadas por semana: ${(totalBytes / 1024 / 1024).toFixed(1)} MB en ${weeks.length} archivos`
  );
  console.log(`\nSnapshot listo en ${path.relative(process.cwd(), DIST)}/\n`);
}

main()
  .catch((err) => {
    console.error("Error exportando el snapshot:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
