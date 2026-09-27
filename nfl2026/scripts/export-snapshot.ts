/**
 * Exporta una foto de la base de datos a snapshot/dist/ para publicarla como
 * página estática (visor de DATAGSPORTS sin servidor ni base de datos).
 *
 * - snapshot/dist/index.html: snapshot/viewer.html con los datos generales
 *   (equipos, partidos, líderes, modelo EP) embebidos, para que la página
 *   muestre contenido real apenas carga.
 * - snapshot/dist/data/week-XX.json: jugadas, posesiones y comparación EPA de
 *   cada partido jugado, agrupadas por semana y cargadas bajo demanda.
 * - snapshot/dist/data/pregame/<gameId>.json: análisis previo completo de cada
 *   partido de 2026 con línea del mercado publicada (cargado bajo demanda).
 * - Los picks de TODOS los partidos de 2026 (jugados y por jugar) van en el
 *   CORE: probabilidad del modelo, mercado, spread, total y resultado.
 *
 * Edición NFL 2026: historia solo desde 2025 (ver src/lib/models/protocol.ts).
 * Uso: npm run snapshot:export
 */
import "dotenv/config";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/prisma";
import { buildFieldPositionEpModel, ownEpaForPlay } from "../src/lib/expected-points";
import { buildMarkovModel, pearson } from "../src/lib/markov-model";
import { buildPregameAnalysis, type PregameAnalysis } from "../src/lib/framework-analysis";
import { loadGameContext, loadModelData } from "../src/lib/models/backtest";
import { gameModels, labSummary, readParams, runFinal } from "../src/lib/models/lab";
import { impliedNoVig, logLoss, brier, normalCdf, outcome } from "../src/lib/models/core";
import { inLive, inValid, VALID_CUTOFF } from "../src/lib/models/protocol";

// Modelo de puntos esperados y cadena de Markov: se construyen con la temporada completa anterior
// (2025), que ya existía antes del primer partido de 2026.
const MODEL_SEASON = 2025;

const ROOT = path.resolve(__dirname, "..", "snapshot");
const DIST = path.join(ROOT, "dist");
const TEMPLATE_MARKER = "/*__CORE_DATA__*/null";

const round = (v: number | null | undefined, digits: number) =>
  v === null || v === undefined ? null : Number(v.toFixed(digits));


function parseArgs() {
  const seasonArg = process.argv.find((a) => a.startsWith("--season="));
  return { season: seasonArg ? Number(seasonArg.split("=")[1]) : 2026 };
}

async function main() {
  const { season } = parseArgs();
  console.log(`\n=== Exportando snapshot de DATAGSPORTS (temporada ${season}) ===\n`);

  const [teams, games, model, driveGroups, playTypeGroups, leadersRaw, counts] = await Promise.all([
    prisma.team.findMany({ orderBy: { abbr: "asc" } }),
    prisma.game.findMany({ where: { season }, orderBy: [{ week: "asc" }, { gameDate: "asc" }, { gameId: "asc" }] }),
    buildFieldPositionEpModel(MODEL_SEASON),
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
    edition: 2026,
    modelSeason: MODEL_SEASON,
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
    picks: [] as Record<string, unknown>[],
    record: null as unknown,
    validCutoff: VALID_CUTOFF,
    analyzed: [] as string[],
  };

  console.log("-> Resolviendo la cadena de Markov (iteración de valor)");
  const markov = await buildMarkovModel(MODEL_SEASON);
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

  // Solo semanas con jugadas (partidos ya jugados).
  const weeks = [...new Set(games.filter((g) => g.homeScore !== null).map((g) => g.week))].sort((a, b) => a - b);
  let totalBytes = 0;
  for (const week of weeks) {
    const weekGames = games.filter((g) => g.week === week && g.homeScore !== null);
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

  // Torneo de modelos: walk-forward desde 2025 con los parámetros optimizados (data/model-params.json).
  console.log("\n-> Torneo de modelos (walk-forward)");
  const modelBase = await loadModelData();
  const modelData = { ...modelBase, ctx: await loadGameContext(modelBase.games) };
  const modelParams = await readParams();
  if (!modelParams) console.log("   Sin data/model-params.json: se usan los parámetros iniciales (corre npm run models:optimize)");
  const modelRun = runFinal(modelData, modelParams);
  const modelsLab = labSummary(modelRun, modelParams);
  const modelsJson = JSON.stringify(modelsLab);
  await writeFile(path.join(DIST, "data", "models.json"), modelsJson);
  // Biblioteca de investigación (fuentes, bitácora y hoja de ruta): se publica tal cual.
  await writeFile(path.join(DIST, "data", "research.json"), await readFile(path.join(process.cwd(), "data", "research.json"), "utf8"));
  const test = modelsLab.leaderboard.find((p) => p.period === "test");
  console.log(`   ${modelsLab.games} partidos en ${modelsLab.runSeconds} s · models.json ${(modelsJson.length / 1024).toFixed(0)} KB`);
  for (const r of test?.rows ?? []) if (r.n) console.log(`   en vivo · ${r.label.padEnd(40)} log-loss ${r.logLoss} · acierto ${r.accuracy}`);

  // Picks de todos los partidos de la temporada: cada uno con lo que el modelo sabía antes de jugarse.
  console.log(`\n-> Picks de los ${games.length} partidos de ${season}`);
  const bySeasonGame = new Map(modelRun.records.filter((r) => r.g.season === season).map((r) => [r.g.id, r]));
  for (const g of games) {
    const r = bySeasonGame.get(g.gameId);
    const gm = r ? gameModels(modelRun, g.gameId) : null;
    if (!r || !gm) continue;
    const mkt = impliedNoVig(g.homeMoneyline, g.awayMoneyline) ?? (g.spreadLine !== null ? normalCdf(g.spreadLine / 13.45) : null);
    const sp = gm.discrete?.spread ?? null, to = gm.discrete?.total ?? null;
    const cond = (x: { over: number; push: number; under: number } | null) => (x ? round(x.over / Math.max(1e-9, 1 - x.push), 4) : null);
    core.picks.push({
      id: g.gameId,
      p: gm.ensemble.pHome,
      pMkt: round(mkt, 4),
      margin: gm.ensemble.margin,
      total: gm.ensemble.total,
      pCover: cond(sp) ?? gm.ensemble.pCover,
      pushSpread: sp ? round(sp.push, 4) : null,
      pOver: cond(to) ?? gm.ensemble.pOver,
      homeQb: r.g.homeQb,
      awayQb: r.g.awayQb,
      qbProjected: r.g.qbProjected,
      mlHome: g.homeMoneyline,
      mlAway: g.awayMoneyline,
      period: inValid(r.g) ? "valid" : inLive(r.g) ? "live" : "other",
    });
  }
  // Marcador de la temporada: modelo contra mercado en los partidos ya jugados, por periodo.
  const recordFor = (period: "valid" | "live") => {
    const rs = modelRun.records.filter((r) => r.g.season === season && r.g.played && (period === "valid" ? inValid(r.g) : inLive(r.g)));
    let hit = 0, hitM = 0, ll = 0, llM = 0, br = 0, brM = 0, nM = 0;
    let atsW = 0, atsL = 0, atsP = 0, ouW = 0, ouL = 0, ouP = 0;
    for (const r of rs) {
      const y = outcome(r.g), p = r.preds.final.p;
      hit += y === 0.5 ? 0.5 : (p >= 0.5) === (y === 1) ? 1 : 0;
      ll += logLoss(p, y); br += brier(p, y);
      const m = r.preds.market;
      if (m) { nM++; hitM += y === 0.5 ? 0.5 : (m.p >= 0.5) === (y === 1) ? 1 : 0; llM += logLoss(m.p, y); brM += brier(m.p, y); }
      const pk = core.picks.find((x) => x.id === r.g.id) as { pCover: number | null; pOver: number | null } | undefined;
      if (pk?.pCover !== null && pk?.pCover !== undefined && r.g.spread !== null) {
        const res = (r.g.hs - r.g.as - r.g.spread) * (pk.pCover >= 0.5 ? 1 : -1);
        if (res > 0) atsW++; else if (res < 0) atsL++; else atsP++;
      }
      if (pk?.pOver !== null && pk?.pOver !== undefined && r.g.total !== null) {
        const res = (r.g.hs + r.g.as - r.g.total) * (pk.pOver >= 0.5 ? 1 : -1);
        if (res > 0) ouW++; else if (res < 0) ouL++; else ouP++;
      }
    }
    const n = rs.length;
    return {
      n,
      model: { hits: hit, accuracy: n ? round(hit / n, 3) : null, logLoss: n ? round(ll / n, 4) : null, brier: n ? round(br / n, 4) : null },
      market: { n: nM, hits: hitM, accuracy: nM ? round(hitM / nM, 3) : null, logLoss: nM ? round(llM / nM, 4) : null, brier: nM ? round(brM / nM, 4) : null },
      ats: { w: atsW, l: atsL, p: atsP },
      ou: { w: ouW, l: ouL, p: ouP },
    };
  };
  core.record = { valid: recordFor("valid"), live: recordFor("live") };
  console.log(`   validación: ${JSON.stringify((core.record as { valid: unknown }).valid)}`);

  // Análisis previo completo (framework + torneo) de cada partido con línea publicada, bajo demanda.
  await mkdir(path.join(DIST, "data", "pregame"), { recursive: true });
  const withLine = games.filter((g) => g.spreadLine !== null && bySeasonGame.has(g.gameId));
  let preBytes = 0;
  for (const [i, g] of withLine.entries()) {
    const analysis: PregameAnalysis = await buildPregameAnalysis(g.gameId, gameModels(modelRun, g.gameId));
    const json = JSON.stringify(analysis);
    preBytes += json.length;
    await writeFile(path.join(DIST, "data", "pregame", `${g.gameId}.json`), json);
    core.analyzed.push(g.gameId);
    // Mejor pick del framework (8.4–8.6) en la tarjeta del partido.
    const pk = core.picks.find((x) => x.id === g.gameId);
    const bp = analysis.bestPick;
    if (pk) pk.best = bp.best
      ? { market: bp.best.market, pick: bp.best.pick, odds: bp.best.odds, light: bp.best.light, klass: bp.best.klass, confidence: bp.best.confidence, edge: bp.best.edge, level: bp.best.level, stake: bp.best.stake, won: bp.best.won, push: bp.best.push, units: bp.best.units }
      : { noBet: true, reason: bp.noBetReason };
    process.stdout.write(`\r   análisis previo ${i + 1}/${withLine.length}`);
  }
  // Marcador del mejor pick del framework por periodo: récord, unidades planas (1 u por pick) y con el
  // stake de Kelly fraccional que el framework asigna (en % del bankroll).
  const bestRecord = (period: "valid" | "live") => {
    const rows = core.picks.filter((x) => x.period === period && x.best && !(x.best as { noBet?: boolean }).noBet) as { best: { won: boolean | null; push: boolean; units: number | null; stake: number; light: string; klass: string } }[];
    const done = rows.filter((x) => x.best.won !== null);
    const w = done.filter((x) => x.best.won).length, pu = done.filter((x) => x.best.push).length, l = done.length - w - pu;
    const flat = done.reduce((acc, x) => acc + (x.best.units ?? 0), 0);
    const staked = done.filter((x) => x.best.stake > 0);
    const kellyUnits = staked.reduce((acc, x) => acc + (x.best.units ?? 0) * x.best.stake * 100, 0);
    const kellyRisk = staked.reduce((acc, x) => acc + x.best.stake * 100, 0);
    const noBets = core.picks.filter((x) => x.period === period && (x.best as { noBet?: boolean } | undefined)?.noBet).length;
    return {
      picks: rows.length, decided: done.length, w, l, p: pu, noBets,
      flatUnits: round(flat, 2), flatRoi: done.length ? round(flat / done.length, 3) : null,
      staked: staked.length, kellyUnits: round(kellyUnits, 2), kellyRisk: round(kellyRisk, 2), kellyRoi: kellyRisk ? round(kellyUnits / kellyRisk, 3) : null,
      byKlass: Object.fromEntries(["Pick fuerte", "Pick moderado", "Lean", "Esperar información"].map((k) => {
        const d = done.filter((x) => x.best.klass === k);
        return [k, { n: d.length, w: d.filter((x) => x.best.won).length, units: round(d.reduce((a, x) => a + (x.best.units ?? 0), 0), 2) }];
      })),
    };
  };
  (core.record as Record<string, unknown>).best = { valid: bestRecord("valid"), live: bestRecord("live") };
  console.log(`\n   mejor pick (validación): ${JSON.stringify((core.record as { best: { valid: unknown } }).best.valid)}`);
  console.log(`\n   ${withLine.length} análisis previos · ${(preBytes / 1024 / 1024).toFixed(1)} MB en data/pregame/`);

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
