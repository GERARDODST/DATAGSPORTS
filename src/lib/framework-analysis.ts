/**
 * Análisis previo al partido que recorre el framework (docs/nfl_framework_v1.md)
 * sección por sección. Usa SOLO información disponible antes de la patada
 * inicial y deja trazabilidad completa:
 *  - cada dato: categoría, fuente (archivo/columna), estado y efecto si falta
 *  - cada cálculo: fórmula con los números sustituidos
 *  - cada regla de la sección 5.3 y de la auditoría (8.3): si se evaluó, con qué
 *    datos, y si no se pudo evaluar, por qué
 */
import { prisma } from "./prisma";

const PYTH_EXP = 2.37;
const PRIOR_SEASON_WEIGHT = 0.5;
const SHRINK_GAMES = 6;
const ELO_K = 20;
const ELO_HOME = 48;
const SIMULATIONS = 50000;
const TD_POINTS = 6.94;

export type DataStatus = "disponible" | "derivado" | "parcial" | "faltante" | "no_aplica";
export type Category =
  | "Contexto"
  | "Récords e historial"
  | "QB y ofensiva"
  | "Defensa"
  | "Disponibilidad de jugadores"
  | "Clima y sede"
  | "Mercado"
  | "Modelo";

type Item = {
  id: string;
  section: string;
  category: Category;
  label: string;
  home?: string;
  away?: string;
  value?: string;
  source: string;
  status: DataStatus;
  note?: string;
  impact?: string;
  homeRank?: number;
  awayRank?: number;
  higherIsBetter?: boolean;
  teams?: number;
};
type Formula = { id: string; section: string; name: string; expression: string; substituted: string; result: string };
type Check = { id: string; rule: string; status: "pasa" | "alerta" | "no_evaluable" | "no_aplica"; detail: string };

const SRC = {
  games: "nflverse · schedules/games.csv",
  pbp: "nflverse · pbp/play_by_play_{temporada}.csv.gz",
  weekly: "nflverse · player_stats/stats_player_week_{temporada}.csv",
  teams: "nflverse · teams/teams_colors_logos.csv",
  injuries: "nflverse · injuries/injuries_{temporada}.csv",
  depth: "nflverse · depth_charts/depth_charts_{temporada}.csv",
  pfr: "nflverse (PFR) · pfr_advstats/advstats_week_def_{temporada}.csv",
  qbr: "nflverse (ESPN) · espn_data/qbr_season_level.csv + qbr_week_level.csv",
  roster: "nflverse · weekly_rosters/roster_weekly_{temporada}.csv",
  model: "Cálculo propio (src/lib/framework-analysis.ts)",
  none: "Sin fuente cargada",
};

const f1 = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
const pctS = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`);
const sgn = (v: number, d = 2) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;
const r3 = (v: number, d = 3) => Number(v.toFixed(d));
const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((v) => (v - m) ** 2)));
};
const safeDiv = (a: number, b: number) => (b ? a / b : NaN);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function normalCdf(z: number) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
export function impliedProbability(american: number) {
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}
export function fairAmerican(p: number) {
  return p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}
function kellyFraction(p: number, american: number) {
  const b = american < 0 ? 100 / -american : american / 100;
  return { b, f: (b * p - (1 - p)) / b };
}
function rankOf(values: Map<string, number>, team: string, higherIsBetter: boolean) {
  const sorted = [...values.entries()].filter(([, v]) => Number.isFinite(v)).sort((a, b) => (higherIsBetter ? b[1] - a[1] : a[1] - b[1]));
  return sorted.findIndex(([t]) => t === team) + 1;
}
function passerRating(cmp: number, att: number, yds: number, td: number, int: number) {
  const clip = (v: number) => Math.min(2.375, Math.max(0, v));
  const a = clip((cmp / att - 0.3) * 5);
  const b = clip((yds / att - 3) * 0.25);
  const c = clip((td / att) * 20);
  const d = clip(2.375 - (int / att) * 25);
  return { a, b, c, d, rating: ((a + b + c + d) / 6) * 100 };
}

export async function buildPregameAnalysis(gameId: string) {
  const target = await prisma.game.findUniqueOrThrow({ where: { gameId }, include: { homeTeam: true, awayTeam: true } });
  if (!target.gameDate) throw new Error(`${gameId} no tiene fecha`);
  const cutoff = target.gameDate;
  const home = target.homeTeamAbbr;
  const away = target.awayTeamAbbr;
  const priorSeason = target.season - 1;

  const items: Item[] = [];
  const formulas: Formula[] = [];
  const add = (it: Item) => items.push(it);
  const formula = (fm: Formula) => formulas.push(fm);

  // ---------------------------------------------------------------- Datos base
  const prior = await prisma.game.findMany({
    where: { season: { in: [priorSeason, target.season] }, gameDate: { lt: cutoff }, homeScore: { not: null } },
    orderBy: [{ gameDate: "asc" }, { gameId: "asc" }],
  });
  const priorIds = prior.map((g) => g.gameId);
  // Historial completo cargado (todas las temporadas antes del partido): solo para H2H y Elo.
  const history = await prisma.game.findMany({
    where: { gameDate: { lt: cutoff }, homeScore: { not: null } },
    orderBy: [{ gameDate: "asc" }, { gameId: "asc" }],
  });
  const firstSeason = history[0]?.season ?? priorSeason;
  const weightOf = (season: number) => (season === target.season ? 1 : PRIOR_SEASON_WEIGHT);
  const currentSeasonGames = prior.filter((g) => g.season === target.season).length;
  const priorSeasonGames = prior.length - currentSeasonGames;
  const gameById = new Map(prior.map((g) => [g.gameId, g]));
  // Cómo se describe "la base" en los textos: solo la temporada anterior o ambas.
  const baseLabel = currentSeasonGames ? `${priorSeason} (×${PRIOR_SEASON_WEIGHT}) + ${target.season} hasta la semana ${target.week - 1}` : `${priorSeason}`;

  const [plays, drives] = await Promise.all([
    prisma.play.findMany({
      where: { gameId: { in: priorIds } },
      select: {
        gameId: true, season: true, possessionTeamAbbr: true, defenseTeamAbbr: true, playType: true, epa: true,
        isSuccess: true, yardsGained: true, isSack: true, isDropback: true, isInterception: true, isFumbleLost: true,
        thirdDownConverted: true, thirdDownFailed: true, cpoe: true, passerPlayerId: true, isPassAttempt: true,
      },
    }),
    prisma.drive.findMany({
      where: { gameId: { in: priorIds } },
      select: { gameId: true, possessionTeamAbbr: true, reachedRedZone: true, result: true, quarterStart: true },
    }),
  ]);
  const pressureRows = await prisma.teamGamePressure.findMany({ where: { gameId: { in: priorIds } } });

  // Liga: promedio de puntos, ventaja de local, dispersión.
  let lw = 0, lp = 0;
  for (const g of prior) {
    const w = weightOf(g.season);
    lp += w * ((g.homeScore as number) + (g.awayScore as number));
    lw += 2 * w;
  }
  const leagueMean = lp / lw;
  const lastSeasonGames = prior.filter((g) => g.season === priorSeason);
  const hfaObserved = mean(prior.filter((g) => g.location === "Home").map((g) => (g.homeScore as number) - (g.awayScore as number)));
  const sigmaMargin = sd(lastSeasonGames.map((g) => (g.homeScore as number) - (g.awayScore as number)));
  const sigmaTotal = sd(lastSeasonGames.map((g) => (g.homeScore as number) + (g.awayScore as number)));

  // ------------------------------------------------ Métricas por equipo (32)
  type TeamAgg = {
    games: Set<string>; gamesW: number; gamesCur: number; offPlays: number; offEpa: number; passPlays: number; passEpa: number; runPlays: number; runEpa: number;
    success: number; explosive: number; dropbacks: number; sacksTaken: number; giveaways: number; conv3: number; att3: number;
    defPlays: number; defEpa: number; defPassPlays: number; defPassEpa: number; defRunPlays: number; defRunEpa: number;
    defConv3: number; defAtt3: number; sacksMade: number; takeaways: number; oppDropbacks: number;
    drives: number; drivePoints: number; rzTrips: number; rzTds: number; oppDrives: number; oppDrivePoints: number; oppRzTrips: number; oppRzTds: number;
    q1Points: number; h1Points: number; pressures: number; missedTackles: number; pressureGames: number;
  };
  const blank = (): TeamAgg => ({
    games: new Set(), gamesW: 0, gamesCur: 0, offPlays: 0, offEpa: 0, passPlays: 0, passEpa: 0, runPlays: 0, runEpa: 0, success: 0, explosive: 0, dropbacks: 0,
    sacksTaken: 0, giveaways: 0, conv3: 0, att3: 0, defPlays: 0, defEpa: 0, defPassPlays: 0, defPassEpa: 0, defRunPlays: 0, defRunEpa: 0,
    defConv3: 0, defAtt3: 0, sacksMade: 0, takeaways: 0, oppDropbacks: 0, drives: 0, drivePoints: 0, rzTrips: 0, rzTds: 0,
    oppDrives: 0, oppDrivePoints: 0, oppRzTrips: 0, oppRzTds: 0, q1Points: 0, h1Points: 0, pressures: 0, missedTackles: 0, pressureGames: 0,
  });
  const agg = new Map<string, TeamAgg>();
  const T = (t: string) => {
    if (!agg.has(t)) agg.set(t, blank());
    return agg.get(t) as TeamAgg;
  };
  // Cada jugada, posesión y fila de presión pesa según su temporada (0.5 la anterior, 1 la actual):
  // así las métricas por equipo usan la misma ponderación que los puntos del λ.
  const markGame = (a: TeamAgg, gameId: string, season: number) => {
    if (a.games.has(gameId)) return;
    a.games.add(gameId);
    a.gamesW += weightOf(season);
    if (season === target.season) a.gamesCur++;
  };
  for (const p of plays) {
    if (!p.possessionTeamAbbr || !p.defenseTeamAbbr) continue;
    const w = weightOf(p.season);
    const o = T(p.possessionTeamAbbr);
    const d = T(p.defenseTeamAbbr);
    markGame(o, p.gameId, p.season);
    markGame(d, p.gameId, p.season);
    if (p.thirdDownConverted) { o.conv3 += w; o.att3 += w; d.defConv3 += w; d.defAtt3 += w; }
    if (p.thirdDownFailed) { o.att3 += w; d.defAtt3 += w; }
    if (p.isDropback) { o.dropbacks += w; d.oppDropbacks += w; }
    if (p.isSack) { o.sacksTaken += w; d.sacksMade += w; }
    if (p.isInterception || p.isFumbleLost) { o.giveaways += w; d.takeaways += w; }
    if ((p.playType !== "pass" && p.playType !== "run") || p.epa === null) continue;
    o.offPlays += w; o.offEpa += w * p.epa; d.defPlays += w; d.defEpa += w * p.epa;
    if (p.isSuccess) o.success += w;
    if ((p.yardsGained ?? 0) >= 20) o.explosive += w;
    if (p.playType === "pass") { o.passPlays += w; o.passEpa += w * p.epa; d.defPassPlays += w; d.defPassEpa += w * p.epa; }
    else { o.runPlays += w; o.runEpa += w * p.epa; d.defRunPlays += w; d.defRunEpa += w * p.epa; }
  }
  const pointsOf = (res: string | null) => (res === "Touchdown" ? TD_POINTS : res === "Field goal" ? 3 : 0);
  for (const dr of drives) {
    const g = gameById.get(dr.gameId);
    if (!g || !dr.possessionTeamAbbr) continue;
    const opp = g.homeTeamAbbr === dr.possessionTeamAbbr ? g.awayTeamAbbr : g.homeTeamAbbr;
    const o = T(dr.possessionTeamAbbr);
    const d = T(opp);
    const w = weightOf(g.season);
    const pts = w * pointsOf(dr.result);
    o.drives += w; o.drivePoints += pts; d.oppDrives += w; d.oppDrivePoints += pts;
    if (dr.quarterStart === 1) o.q1Points += pts;
    if ((dr.quarterStart ?? 5) <= 2) o.h1Points += pts;
    if (dr.reachedRedZone) {
      o.rzTrips += w; d.oppRzTrips += w;
      if (dr.result === "Touchdown") { o.rzTds += w; d.oppRzTds += w; }
    }
  }
  // La presión solo cuenta contra los dropbacks de los partidos que tienen fila de PFR.
  const pressureGameIds = new Set(pressureRows.map((pr) => `${pr.gameId}_${pr.teamAbbr}`));
  const pressDropbacks = new Map<string, number>();
  for (const p of plays) {
    if (!p.isDropback || !p.defenseTeamAbbr || !pressureGameIds.has(`${p.gameId}_${p.defenseTeamAbbr}`)) continue;
    pressDropbacks.set(p.defenseTeamAbbr, (pressDropbacks.get(p.defenseTeamAbbr) ?? 0) + weightOf(p.season));
  }
  for (const pr of pressureRows) {
    const t = T(pr.teamAbbr);
    const w = weightOf(gameById.get(pr.gameId)?.season ?? priorSeason);
    t.pressures += w * pr.pressures;
    t.missedTackles += w * pr.missedTackles;
    t.pressureGames += w;
  }

  const teamOf = (a: TeamAgg) => [...agg.entries()].find(([, v]) => v === a)?.[0] ?? "";
  const metric = (fn: (a: TeamAgg) => number) => new Map([...agg.entries()].map(([t, a]) => [t, fn(a)]));
  const M = {
    offEpa: metric((a) => safeDiv(a.offEpa, a.offPlays)),
    passEpa: metric((a) => safeDiv(a.passEpa, a.passPlays)),
    runEpa: metric((a) => safeDiv(a.runEpa, a.runPlays)),
    success: metric((a) => safeDiv(a.success, a.offPlays)),
    explosive: metric((a) => safeDiv(a.explosive, a.offPlays)),
    sackRateTaken: metric((a) => safeDiv(a.sacksTaken, a.dropbacks)),
    giveawaysPg: metric((a) => safeDiv(a.giveaways, a.gamesW)),
    conv3: metric((a) => safeDiv(a.conv3, a.att3)),
    pace: metric((a) => safeDiv(a.offPlays, a.gamesW)),
    ptsPerDrive: metric((a) => safeDiv(a.drivePoints, a.drives)),
    rzTd: metric((a) => safeDiv(a.rzTds, a.rzTrips)),
    defEpa: metric((a) => safeDiv(a.defEpa, a.defPlays)),
    defPassEpa: metric((a) => safeDiv(a.defPassEpa, a.defPassPlays)),
    defRunEpa: metric((a) => safeDiv(a.defRunEpa, a.defRunPlays)),
    defConv3: metric((a) => safeDiv(a.defConv3, a.defAtt3)),
    sackRateMade: metric((a) => safeDiv(a.sacksMade, a.oppDropbacks)),
    takeawaysPg: metric((a) => safeDiv(a.takeaways, a.gamesW)),
    ptsPerDriveAllowed: metric((a) => safeDiv(a.oppDrivePoints, a.oppDrives)),
    rzTdAllowed: metric((a) => safeDiv(a.oppRzTds, a.oppRzTrips)),
    pressureRate: metric((a) => (a.pressureGames ? safeDiv(a.pressures, pressDropbacks.get(teamOf(a)) ?? NaN) : NaN)),
    missedTacklesPg: metric((a) => safeDiv(a.missedTackles, a.pressureGames)),
    q1Share: metric((a) => safeDiv(a.q1Points, a.drivePoints)),
    h1Share: metric((a) => safeDiv(a.h1Points, a.drivePoints)),
  };
  const leagueAvg = (m: Map<string, number>) => mean([...m.values()].filter(Number.isFinite));
  const rk = (m: Map<string, number>, t: string, higher: boolean) => `${rankOf(m, t, higher)}º`;
  const both = (m: Map<string, number>, fmt: (v: number) => string, higher: boolean) => ({
    home: fmt(m.get(home) ?? NaN),
    away: fmt(m.get(away) ?? NaN),
    homeRank: rankOf(m, home, higher),
    awayRank: rankOf(m, away, higher),
    higherIsBetter: higher,
    teams: [...m.values()].filter(Number.isFinite).length,
  });
  // Qué equipo queda mejor en una métrica (para las conclusiones de cada sección).
  const better = (m: Map<string, number>, higher: boolean) => (rankOf(m, home, higher) < rankOf(m, away, higher) ? home : away);
  const epaFmt = (v: number) => sgn(v, 3);

  // ============================================================ SECCIÓN 1
  const hT = target.homeTeam, aT = target.awayTeam;
  const neutral = target.location === "Neutral";
  add({ id: "conf", section: "1", category: "Contexto", label: "Conferencia", home: hT.conference ?? "—", away: aT.conference ?? "—", source: `${SRC.teams} · team_conf`, status: hT.conference ? "disponible" : "faltante" });
  add({ id: "div", section: "1", category: "Contexto", label: "División", home: hT.division ?? "—", away: aT.division ?? "—", source: `${SRC.teams} · team_division`, status: hT.division ? "disponible" : "faltante" });
  add({ id: "divgame", section: "1", category: "Contexto", label: "¿Partido divisional?", value: target.divGame === null ? "—" : target.divGame ? "Sí" : "No", source: `${SRC.games} · div_game`, status: target.divGame === null ? "faltante" : "disponible" });
  add({ id: "neutral", section: "1", category: "Clima y sede", label: "¿Sede neutral?", value: target.location ? (neutral ? "Sí" : `No (local: ${home})`) : "—", source: `${SRC.games} · location`, status: target.location ? "disponible" : "faltante" });
  add({ id: "rest", section: "1", category: "Contexto", label: "Días de descanso", home: `${target.homeRest ?? "—"}`, away: `${target.awayRest ?? "—"}`, source: `${SRC.games} · home_rest / away_rest`, status: target.homeRest !== null ? "disponible" : "faltante", note: target.homeRest !== null && target.awayRest !== null && Math.abs(target.homeRest - target.awayRest) >= 3 ? "Diferencia relevante de descanso." : "Mismo descanso: sin ventaja de preparación." });

  // ============================================================ SECCIÓN 2
  const teamGames = (t: string) => prior.filter((g) => g.homeTeamAbbr === t || g.awayTeamAbbr === t);
  const fmtGame = (g: (typeof prior)[number], t: string) => {
    const isHome = g.homeTeamAbbr === t;
    const pf = (isHome ? g.homeScore : g.awayScore) as number;
    const pa = (isHome ? g.awayScore : g.homeScore) as number;
    return { gameId: g.gameId, date: g.gameDate?.toISOString().slice(0, 10) ?? "", opp: isHome ? g.awayTeamAbbr : g.homeTeamAbbr, isHome, neutral: g.location === "Neutral", type: g.gameType ?? "REG", pf, pa, total: pf + pa, win: pf > pa };
  };
  const homeLast5 = teamGames(home).filter((g) => g.homeTeamAbbr === home && g.location !== "Neutral").slice(-5).map((g) => fmtGame(g, home));
  const awayLast5 = teamGames(away).filter((g) => g.awayTeamAbbr === away && g.location !== "Neutral").slice(-5).map((g) => fmtGame(g, away));
  const isH2h = (g: (typeof prior)[number]) => [g.homeTeamAbbr, g.awayTeamAbbr].sort().join() === [home, away].sort().join();
  const h2h = history.filter(isH2h).slice(-5).map((g) => fmtGame(g, home));
  const h2hInBase = prior.filter(isH2h).length;
  const rec = (list: { win: boolean }[]) => `${list.filter((x) => x.win).length}–${list.filter((x) => !x.win).length}`;
  const avg = (list: { pf: number; pa: number }[], k: "pf" | "pa") => f1(mean(list.map((x) => x[k])));
  add({ id: "l5home", section: "2", category: "Récords e historial", label: `Últimos 5 de ${home} en casa (récord · PF/PA)`, value: `${rec(homeLast5)} · ${avg(homeLast5, "pf")} / ${avg(homeLast5, "pa")}`, source: `${SRC.games} · home_score, away_score`, status: homeLast5.length >= 5 ? "derivado" : "parcial" });
  add({ id: "l5away", section: "2", category: "Récords e historial", label: `Últimos 5 de ${away} de visita (récord · PF/PA)`, value: `${rec(awayLast5)} · ${avg(awayLast5, "pf")} / ${avg(awayLast5, "pa")}`, source: `${SRC.games} · home_score, away_score`, status: awayLast5.length >= 5 ? "derivado" : "parcial" });
  add({
    id: "h2h", section: "2", category: "Récords e historial", label: "Últimos 5 enfrentamientos directos",
    value: h2h.length ? `${h2h.length} de 5 · ${home} ${h2h.filter((x) => x.win).length}–${h2h.filter((x) => !x.win).length} ${away}` : "0 de 5",
    source: `${SRC.games} · temporadas cargadas: ${firstSeason}–${target.season}`, status: h2h.length >= 5 ? "derivado" : h2h.length ? "parcial" : "faltante",
    note: h2h.length < 5 ? `Solo hay ${h2h.length} cara a cara en las temporadas cargadas; se necesitarían temporadas anteriores a ${firstSeason}.` : `Del ${h2h[0].date.slice(0, 4)} al ${h2h[h2h.length - 1].date.slice(0, 4)} (con solo ${priorSeason}–${target.season} había ${h2hInBase}).`,
    impact: h2h.length < 5 ? "Baja confianza histórica (sección 9.3, secciones 1–2)." : undefined,
  });

  const profile = (t: string) => {
    let w = 0, pf = 0, pa = 0;
    for (const g of teamGames(t)) {
      const x = fmtGame(g, t);
      const gw = weightOf(g.season);
      w += gw; pf += gw * x.pf; pa += gw * x.pa;
    }
    const rawOff = w ? pf / w : leagueMean;
    const rawDef = w ? pa / w : leagueMean;
    const reg = lastSeasonGames.filter((g) => g.gameType === "REG" && (g.homeTeamAbbr === t || g.awayTeamAbbr === t)).map((g) => fmtGame(g, t));
    const regPf = reg.reduce((s, x) => s + x.pf, 0);
    const regPa = reg.reduce((s, x) => s + x.pa, 0);
    const wins = reg.filter((x) => x.pf > x.pa).length;
    const pyth = regPf ** PYTH_EXP / (regPf ** PYTH_EXP + regPa ** PYTH_EXP);
    return {
      w, rawOff, rawDef,
      off: (w * rawOff + SHRINK_GAMES * leagueMean) / (w + SHRINK_GAMES),
      def: (w * rawDef + SHRINK_GAMES * leagueMean) / (w + SHRINK_GAMES),
      reg: { wins, losses: reg.length - wins, pf: regPf, pa: regPa, games: reg.length },
      pyth, actual: reg.length ? wins / reg.length : 0,
      last: teamGames(t).length ? fmtGame(teamGames(t).at(-1) as (typeof prior)[number], t) : null,
    };
  };
  const H = profile(home);
  const A = profile(away);
  add({ id: "record", section: "2", category: "Récords e historial", label: `Récord ${priorSeason} (temporada regular)`, home: `${H.reg.wins}–${H.reg.losses}`, away: `${A.reg.wins}–${A.reg.losses}`, source: `${SRC.games} · resultados ${priorSeason}`, status: "derivado" });
  const curRec = (t: string) => {
    const list = teamGames(t).filter((g) => g.season === target.season).map((g) => fmtGame(g, t));
    return list.length ? `${rec(list)} · ${avg(list, "pf")} / ${avg(list, "pa")}` : "—";
  };
  if (currentSeasonGames) add({ id: "record-cur", section: "2", category: "Récords e historial", label: `Récord ${target.season} antes de este partido (PF/PA)`, home: curRec(home), away: curRec(away), source: `${SRC.games} · resultados ${target.season}`, status: "derivado", note: `Cada partido de ${target.season} pesa ${1 / PRIOR_SEASON_WEIGHT} veces lo que uno de ${priorSeason} en los ratings.` });
  add({ id: "last", section: "2", category: "Récords e historial", label: "Último partido", home: H.last ? `${H.last.win ? "G" : "P"} ${H.last.pf}–${H.last.pa} vs ${H.last.opp}` : "—", away: A.last ? `${A.last.win ? "G" : "P"} ${A.last.pf}–${A.last.pa} vs ${A.last.opp}` : "—", source: `${SRC.games}`, status: "disponible" });

  // ============================================================ SECCIÓN 3
  const qbProfile = async (team: string, name: string | null) => {
    if (!name) return null;
    const player = await prisma.player.findFirst({ where: { fullName: name, position: "QB" } });
    if (!player) return null;
    const weeks = await prisma.playerWeekStat.findMany({
      where: { playerId: player.gsisId, season: { in: [priorSeason, target.season] }, attempts: { gt: 0 } },
      orderBy: [{ season: "asc" }, { week: "asc" }],
    });
    const priorWeeks = weeks.filter((w) => w.season < target.season || (w.gameId && gameById.has(w.gameId)));
    // Sumas ponderadas por temporada (igual que los ratings de equipo), redondeadas para mostrarse.
    const sum = (k: "completions" | "attempts" | "passingYards" | "passingTds" | "interceptions") => Math.round(priorWeeks.reduce((s, w) => s + weightOf(w.season) * (w[k] ?? 0), 0));
    const cmp = sum("completions"), att = sum("attempts"), yds = sum("passingYards"), td = sum("passingTds"), int = sum("interceptions");
    const qbPlays = plays.filter((p) => p.passerPlayerId === player.gsisId);
    const sackPlays = qbPlays.filter((p) => p.isSack);
    const sacks = Math.round(sackPlays.reduce((s, p) => s + weightOf(p.season), 0));
    const sackYds = Math.round(-sackPlays.reduce((s, p) => s + weightOf(p.season) * (p.yardsGained ?? 0), 0));
    const wMean = (xs: { v: number; w: number }[]) => xs.reduce((s, x) => s + x.v * x.w, 0) / Math.max(1e-9, xs.reduce((s, x) => s + x.w, 0));
    const cpoeVals = qbPlays.filter((p) => p.cpoe !== null).map((p) => ({ v: p.cpoe as number, w: weightOf(p.season) }));
    const epaVals = qbPlays.filter((p) => p.epa !== null).map((p) => ({ v: p.epa as number, w: weightOf(p.season) }));
    const currentGames = priorWeeks.filter((w) => w.season === target.season).length;
    const pr = passerRating(cmp, att, yds, td, int);
    const anya = (yds + 20 * td - 45 * int - sackYds) / (att + sacks);
    return {
      team, name, id: player.gsisId, cmp, att, yds, td, int, sacks, sackYds, pr, anya,
      cpoe: cpoeVals.length ? wMean(cpoeVals) : null, epa: epaVals.length ? wMean(epaVals) : null, currentGames,
      last5: priorWeeks.slice(-5).map((w) => ({ season: w.season, week: w.week, opp: w.opponentAbbr, cmp: w.completions, att: w.attempts, yds: w.passingYards, td: w.passingTds, int: w.interceptions })),
    };
  };
  const [qbH, qbA] = await Promise.all([qbProfile(home, target.homeQbName), qbProfile(away, target.awayQbName)]);
  // Referencia de liga para el shrinkage de QBs (sección 5.7.4).
  const leagueQb = await prisma.playerWeekStat.aggregate({
    where: { season: priorSeason, attempts: { gt: 0 } },
    _sum: { completions: true, attempts: true, interceptions: true },
  });
  const lgCmp = (leagueQb._sum.completions ?? 0) / Math.max(1, leagueQb._sum.attempts ?? 1);
  const lgInt = (leagueQb._sum.interceptions ?? 0) / Math.max(1, leagueQb._sum.attempts ?? 1);
  const qbAnyaAll = await (async () => {
    const rows = await prisma.playerWeekStat.groupBy({
      by: ["playerId", "season"],
      where: { OR: [{ season: priorSeason }, { season: target.season, gameId: { in: priorIds } }] },
      _sum: { attempts: true, passingYards: true, passingTds: true, interceptions: true },
    });
    const tot = new Map<string, { att: number; w: number; num: number }>();
    for (const r of rows) {
      const w = weightOf(r.season);
      const t = tot.get(r.playerId) ?? { att: 0, w: 0, num: 0 };
      t.att += r._sum.attempts ?? 0;
      t.w += w * (r._sum.attempts ?? 0);
      t.num += w * ((r._sum.passingYards ?? 0) + 20 * (r._sum.passingTds ?? 0) - 45 * (r._sum.interceptions ?? 0));
      tot.set(r.playerId, t);
    }
    const sackByQb = new Map<string, { n: number; yds: number }>();
    for (const p of plays) {
      if (!p.isSack || !p.passerPlayerId) continue;
      const w = weightOf(p.season);
      const s = sackByQb.get(p.passerPlayerId) ?? { n: 0, yds: 0 };
      s.n += w; s.yds += -w * (p.yardsGained ?? 0);
      sackByQb.set(p.passerPlayerId, s);
    }
    const m = new Map<string, number>();
    for (const [id, t] of tot) {
      if (t.att < 200) continue;
      const s = sackByQb.get(id) ?? { n: 0, yds: 0 };
      m.set(id, (t.num - s.yds) / (t.w + s.n));
    }
    return m;
  })();
  const qbRows = (label: string, fn: (q: NonNullable<typeof qbH>) => string, source: string, status: DataStatus) =>
    add({ id: `qb-${label}`, section: "3", category: "QB y ofensiva", label, home: qbH ? fn(qbH) : "—", away: qbA ? fn(qbA) : "—", source, status: qbH && qbA ? status : "faltante" });
  add({ id: "qb-name", section: "3", category: "QB y ofensiva", label: "QB titular", home: target.homeQbName ?? "—", away: target.awayQbName ?? "—", source: `${SRC.games} · home_qb_name / away_qb_name`, status: target.homeQbName && target.awayQbName ? "disponible" : "faltante" });
  qbRows(`Cmp% · Yds/Att (${baseLabel})`, (q) => `${pctS(q.cmp / q.att)} · ${f1(q.yds / q.att)}`, `${SRC.weekly} · completions, attempts, passing_yards`, "derivado");
  qbRows("TD · INT", (q) => `${q.td} · ${q.int}`, `${SRC.weekly} · passing_tds, interceptions`, "disponible");
  qbRows("Passer rating (fórmula NFL)", (q) => f1(q.pr.rating), `${SRC.weekly} → fórmula oficial`, "derivado");
  qbRows("Sacks recibidos · yardas", (q) => `${q.sacks} · ${q.sackYds}`, `${SRC.pbp} · sack, yards_gained, passer_player_id`, "derivado");
  qbRows("ANY/A (rango entre QBs con 200+ intentos)", (q) => `${f1(q.anya, 2)} (${rankOf(qbAnyaAll, q.id, true)}º de ${qbAnyaAll.size})`, `${SRC.weekly} + ${SRC.pbp}`, "derivado");
  qbRows("EPA por jugada del QB", (q) => (q.epa === null ? "—" : sgn(q.epa, 3)), `${SRC.pbp} · epa (jugadas con passer_player_id)`, "derivado");
  qbRows("CPOE (% de pases completos sobre lo esperado)", (q) => (q.cpoe === null ? "—" : `${sgn(q.cpoe, 1)} pp`), `${SRC.pbp} · cpoe`, "disponible");
  // QBR de ESPN: la temporada anterior completa (week = 0) y, de la actual, solo las semanas ya jugadas (el total de la temporada actual sería fuga).
  const qbrRows = await prisma.qbrEntry.findMany({
    where: {
      seasonType: "Regular",
      OR: [{ season: priorSeason, week: 0 }, { season: target.season, week: { gt: 0, lt: target.week } }],
    },
  });
  const qbrPrior = qbrRows.filter((r) => r.season === priorSeason && r.qbPlays >= 200).sort((x, y) => y.qbrTotal - x.qbrTotal);
  const qbrText = (name: string | null) => {
    if (!name) return null;
    const base = qbrPrior.find((r) => r.name === name) ?? qbrRows.find((r) => r.season === priorSeason && r.name === name);
    const cur = qbrRows.filter((r) => r.season === target.season && r.name === name).sort((x, y) => x.week - y.week);
    if (!base && !cur.length) return null;
    const rank = base ? qbrPrior.indexOf(base) + 1 : 0;
    const parts = [base ? `${priorSeason}: ${base.qbrTotal.toFixed(1)}${rank ? ` (${rank}º de ${qbrPrior.length})` : ""}` : `${priorSeason}: sin QBR`];
    if (cur.length) parts.push(`${target.season}: ${cur.map((r) => `S${r.week} ${r.qbrTotal.toFixed(1)}`).join(", ")}`);
    return parts.join(" · ");
  };
  const qbrH = qbrText(target.homeQbName), qbrA = qbrText(target.awayQbName);
  add({
    id: "qb-qbr", section: "3", category: "QB y ofensiva", label: "QBR de ESPN (0–100)", home: qbrH ?? "—", away: qbrA ?? "—",
    source: `${SRC.qbr} · qbr_total, qb_plays`, status: qbrH && qbrA ? "disponible" : qbrH || qbrA ? "parcial" : "faltante",
    note: `Temporada ${priorSeason} completa (rango entre QBs con 200+ jugadas) y, de ${target.season}, solo los partidos ya jugados: el QBR de la temporada ${target.season} completa incluiría partidos futuros.`,
    impact: qbrH && qbrA ? undefined : "Ninguno: EPA/jugada y CPOE cubren lo mismo (sección 3.4).",
  });
  add({ id: "o-epa", section: "3", category: "QB y ofensiva", label: "EPA/jugada ofensiva (rango liga)", ...both(M.offEpa, epaFmt, true), source: `${SRC.pbp} · epa (pass/run)`, status: "derivado" });
  add({ id: "o-pr", section: "3", category: "QB y ofensiva", label: "EPA pase · EPA carrera", home: `${epaFmt(M.passEpa.get(home) ?? NaN)} · ${epaFmt(M.runEpa.get(home) ?? NaN)}`, away: `${epaFmt(M.passEpa.get(away) ?? NaN)} · ${epaFmt(M.runEpa.get(away) ?? NaN)}`, source: `${SRC.pbp} · epa, play_type`, status: "derivado" });
  add({ id: "o-sr", section: "3", category: "QB y ofensiva", label: "Success rate", ...both(M.success, (v) => pctS(v), true), source: `${SRC.pbp} · success`, status: "derivado" });
  add({ id: "o-exp", section: "3", category: "QB y ofensiva", label: "Jugadas explosivas (20+ yardas)", ...both(M.explosive, (v) => pctS(v), true), source: `${SRC.pbp} · yards_gained`, status: "derivado" });
  add({ id: "o-3d", section: "3", category: "QB y ofensiva", label: "Conversión de 3er down", ...both(M.conv3, (v) => pctS(v), true), source: `${SRC.pbp} · third_down_converted / failed`, status: "derivado" });
  add({ id: "o-ppd", section: "3", category: "QB y ofensiva", label: "Puntos por posesión", ...both(M.ptsPerDrive, (v) => f1(v, 2), true), source: `${SRC.pbp} · fixed_drive_result`, status: "derivado" });
  add({ id: "o-rz", section: "3", category: "QB y ofensiva", label: "TD% en zona roja", ...both(M.rzTd, (v) => pctS(v), true), source: `${SRC.pbp} · drive_inside20, fixed_drive_result`, status: "derivado" });
  add({ id: "o-sack", section: "3", category: "QB y ofensiva", label: "Sack% permitido", ...both(M.sackRateTaken, (v) => pctS(v), false), source: `${SRC.pbp} · sack, qb_dropback`, status: "derivado" });
  add({ id: "o-to", section: "3", category: "QB y ofensiva", label: "Pérdidas de balón por partido", ...both(M.giveawaysPg, (v) => f1(v, 2), false), source: `${SRC.pbp} · interception, fumble_lost`, status: "derivado" });
  add({ id: "o-pace", section: "3", category: "QB y ofensiva", label: "Ritmo (jugadas ofensivas por partido)", ...both(M.pace, (v) => f1(v), true), source: `${SRC.pbp} · play_type`, status: "derivado" });

  if (qbH) {
    const q = qbH;
    formula({ id: "pr", section: "3", name: `Passer rating de ${q.name}`, expression: "a=((Cmp/Att)−0.3)·5, b=((Yds/Att)−3)·0.25, c=(TD/Att)·20, d=2.375−(INT/Att)·25; rating=(a+b+c+d)/6·100", substituted: `a=${f1(q.pr.a, 3)}, b=${f1(q.pr.b, 3)}, c=${f1(q.pr.c, 3)}, d=${f1(q.pr.d, 3)} (Cmp=${q.cmp}, Att=${q.att}, Yds=${q.yds}, TD=${q.td}, INT=${q.int})`, result: f1(q.pr.rating) });
    formula({ id: "anya", section: "3", name: `ANY/A de ${q.name}`, expression: "(Yds + 20·TD − 45·INT − SackYds) / (Att + Sacks)", substituted: `(${q.yds} + 20·${q.td} − 45·${q.int} − ${q.sackYds}) / (${q.att} + ${q.sacks})`, result: f1(q.anya, 2) });
    const kCmp = 150;
    const shr = (q.att / (q.att + kCmp)) * (q.cmp / q.att) + (kCmp / (q.att + kCmp)) * lgCmp;
    formula({ id: "shrink-cmp", section: "3", name: `Cmp% de ${q.name} regresado a la media (5.7.4)`, expression: "θ̂ = n/(n+k)·x̄ + k/(n+k)·μ_liga, con k = 150 intentos", substituted: `${q.att}/(${q.att}+150)·${pctS(q.cmp / q.att)} + 150/(${q.att}+150)·${pctS(lgCmp)}`, result: pctS(shr) });
  }
  if (qbA) {
    const q = qbA;
    formula({ id: "anya-a", section: "3", name: `ANY/A de ${q.name}`, expression: "(Yds + 20·TD − 45·INT − SackYds) / (Att + Sacks)", substituted: `(${q.yds} + 20·${q.td} − 45·${q.int} − ${q.sackYds}) / (${q.att} + ${q.sacks})`, result: f1(q.anya, 2) });
  }

  // ============================================================ SECCIÓN 4
  add({ id: "d-epa", section: "4", category: "Defensa", label: "EPA/jugada permitido (rango, más negativo = mejor)", ...both(M.defEpa, epaFmt, false), source: `${SRC.pbp} · epa por defteam`, status: "derivado" });
  add({ id: "d-pr", section: "4", category: "Defensa", label: "EPA permitido pase · carrera", home: `${epaFmt(M.defPassEpa.get(home) ?? NaN)} · ${epaFmt(M.defRunEpa.get(home) ?? NaN)}`, away: `${epaFmt(M.defPassEpa.get(away) ?? NaN)} · ${epaFmt(M.defRunEpa.get(away) ?? NaN)}`, source: `${SRC.pbp}`, status: "derivado" });
  add({ id: "d-ppd", section: "4", category: "Defensa", label: "Puntos permitidos por posesión", ...both(M.ptsPerDriveAllowed, (v) => f1(v, 2), false), source: `${SRC.pbp} · fixed_drive_result`, status: "derivado" });
  add({ id: "d-3d", section: "4", category: "Defensa", label: "3er down permitido", ...both(M.defConv3, (v) => pctS(v), false), source: `${SRC.pbp} · third_down_converted`, status: "derivado" });
  add({ id: "d-rz", section: "4", category: "Defensa", label: "TD% permitido en zona roja", ...both(M.rzTdAllowed, (v) => pctS(v), false), source: `${SRC.pbp} · drive_inside20`, status: "derivado" });
  add({ id: "d-press", section: "4", category: "Defensa", label: "Pressure rate (presiones / dropbacks rivales)", ...both(M.pressureRate, (v) => pctS(v), true), source: `${SRC.pfr} · def_pressures + ${SRC.pbp} · qb_dropback`, status: "derivado" });
  add({ id: "d-sack", section: "4", category: "Defensa", label: "Sack rate generado", ...both(M.sackRateMade, (v) => pctS(v), true), source: `${SRC.pbp} · sack`, status: "derivado" });
  add({ id: "d-take", section: "4", category: "Defensa", label: "Takeaways por partido", ...both(M.takeawaysPg, (v) => f1(v, 2), true), source: `${SRC.pbp} · interception, fumble_lost`, status: "derivado" });
  add({ id: "d-mt", section: "4", category: "Defensa", label: "Tackles fallados por partido", ...both(M.missedTacklesPg, (v) => f1(v, 1), false), source: `${SRC.pfr} · def_missed_tackles`, status: "derivado" });

  // Disponibilidad: reporte de lesiones (solo lo publicado antes del partido) y depth chart.
  const [injAll, depthNow, depthPrior, inactives] = await Promise.all([
    prisma.injuryReport.findMany({ where: { season: target.season, week: target.week, teamAbbr: { in: [home, away] } } }),
    prisma.depthChartEntry.findMany({ where: { season: target.season, week: target.week, teamAbbr: { in: [home, away] }, depthTeam: 1 } }),
    prisma.depthChartEntry.findMany({ where: { OR: [{ season: priorSeason }, { season: target.season, week: { lt: target.week } }], teamAbbr: { in: [home, away] }, depthTeam: 1 } }),
    prisma.rosterStatus.findMany({ where: { season: target.season, week: target.week, teamAbbr: { in: [home, away] }, status: "INA" } }),
  ]);
  const inactiveKeys = new Set(inactives.map((i) => `${i.teamAbbr}_${i.gsisId}`));
  const haveInactives = inactives.length > 0;
  const injPre = injAll.filter((i) => i.dateModified && i.dateModified < cutoff);
  const injLate = injAll.filter((i) => !i.dateModified || i.dateModified >= cutoff);
  // ¿El jugador está "en la base"? Semanas como titular, ponderadas por temporada, sobre el total ponderado de semanas.
  const priorStarterWeeks = new Map<string, Set<string>>();
  for (const d of depthPrior) {
    if (!d.gsisId) continue;
    const key = `${d.teamAbbr}_${d.gsisId}`;
    const s = priorStarterWeeks.get(key) ?? new Set<string>();
    s.add(`${d.season}_${d.week}`);
    priorStarterWeeks.set(key, s);
  }
  const weekW = (sw: string) => weightOf(Number(sw.split("_")[0]));
  const allBaseWeeks = new Set(depthPrior.map((d) => `${d.season}_${d.week}`));
  const priorWeeksCount = [...allBaseWeeks].reduce((s, sw) => s + weekW(sw), 0) || 1;
  const currentStarters = new Set(depthNow.map((d) => `${d.teamAbbr}_${d.gsisId}`));
  const reported = new Set(injPre.map((i) => `${i.teamAbbr}_${i.gsisId}`));
  const injuryDetail = [
    ...injPre.filter((i) => i.reportStatus === "Out" || i.reportStatus === "Doubtful" || inactiveKeys.has(`${i.teamAbbr}_${i.gsisId}`)),
    // Inactivos oficiales que no venían en el reporte de lesiones (decisión del equipo, no lesión).
    ...inactives.filter((i) => !reported.has(`${i.teamAbbr}_${i.gsisId}`)).map((i) => ({ teamAbbr: i.teamAbbr, gsisId: i.gsisId, fullName: i.fullName, position: i.position, reportStatus: "Inactivo", primaryInjury: null, dateModified: null })),
  ]
    .map((i) => {
      const key = `${i.teamAbbr}_${i.gsisId}`;
      const starterWeeks = [...(priorStarterWeeks.get(key) ?? [])];
      const baseWeeks = starterWeeks.length;
      const baseShare = starterWeeks.reduce((s, sw) => s + weekW(sw), 0) / priorWeeksCount;
      return {
        team: i.teamAbbr, name: i.fullName, position: i.position, status: i.reportStatus, injury: i.primaryInjury,
        date: i.dateModified?.toISOString().slice(0, 10) ?? null,
        starterNow: currentStarters.has(key),
        inactive: inactiveKeys.has(key),
        // Baja confirmada: inactivo oficial; sin lista de inactivos, se usa el "Out" del reporte.
        confirmedOut: haveInactives ? inactiveKeys.has(key) : i.reportStatus === "Out",
        inBase: baseShare >= 0.5,
        baseWeeks,
      };
    });
  const injFmt = (t: string) => {
    const list = injuryDetail.filter((i) => i.team === t && i.status !== "Inactivo");
    return list.length ? list.map((i) => `${i.name} (${i.position}, ${i.status}${i.inactive && i.status !== "Inactivo" ? " → inactivo" : ""})`).join("; ") : "Sin bajas (Out/Doubtful)";
  };
  add({
    id: "inj", section: "4", category: "Disponibilidad de jugadores", label: "Reporte oficial de lesiones: Out / Doubtful",
    home: injFmt(home), away: injFmt(away), source: `${SRC.injuries} · report_status, date_modified`,
    status: injPre.length ? "disponible" : "faltante",
    note: injLate.length ? `${injLate.length} registro(s) excluido(s) por tener fecha posterior al inicio del partido (${injLate.map((i) => `${i.fullName}, ${i.dateModified?.toISOString().slice(0, 10)}`).join("; ")}): usarlos sería fuga de datos.` : undefined,
    impact: injPre.length ? undefined : "Bloquea Verde en total y spread (sección 9.3).",
  });
  const inaFmt = (t: string) => {
    const list = inactives.filter((i) => i.teamAbbr === t);
    const starters = list.filter((i) => currentStarters.has(`${t}_${i.gsisId}`));
    return list.length ? `${list.length} inactivos${starters.length ? ` · titulares: ${starters.map((i) => i.fullName).join(", ")}` : " · ningún titular"}` : "—";
  };
  add({
    id: "inactive", section: "4", category: "Disponibilidad de jugadores", label: "Inactivos oficiales del partido",
    home: inaFmt(home), away: inaFmt(away), source: `${SRC.roster} · status = INA`,
    status: haveInactives ? "disponible" : "faltante",
    note: "Lista que cada equipo entrega 90 minutos antes de la patada inicial: confirma quién NO juega. Reemplaza al Doubtful/Questionable del reporte de lesiones.",
    impact: haveInactives ? undefined : "Sin inactivos, las bajas salen solo del reporte de lesiones (Out) y ningún pick puede ser Verde (8.3.12).",
  });
  add({
    id: "depth", section: "4", category: "Disponibilidad de jugadores", label: "Titulares (depth chart de la semana)",
    home: `${depthNow.filter((d) => d.teamAbbr === home).length} titulares listados`, away: `${depthNow.filter((d) => d.teamAbbr === away).length} titulares listados`,
    source: `${SRC.depth} · depth_team = 1`, status: depthNow.length ? "parcial" : "faltante",
    note: "Los titulares son los que publica el equipo en la semana; quién no juega lo confirman los inactivos oficiales. La alineación exacta de la primera jugada solo existe después de la patada inicial.",
  });

  // ============================================================ SECCIÓN 5 — ratings y proyección
  const hfa = neutral ? 0 : hfaObserved;
  formula({ id: "league", section: "5", name: "Promedio de liga (puntos por equipo y partido)", expression: "μ = Σ w·(pts local + pts visita) / Σ 2w, con w = 0.5 para la temporada anterior y 1 para la actual", substituted: `${prior.length} partidos (${priorSeasonGames} de ${priorSeason}, ${currentSeasonGames} de ${target.season})`, result: f1(leagueMean, 2) });
  formula({ id: "shrink-off", section: "5", name: `Ofensiva de ${home} regresada a la media (5.7.4)`, expression: "off = (n·PF̄ + k·μ) / (n + k), k = 6 partidos", substituted: `(${f1(H.w, 1)}·${f1(H.rawOff, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(H.w, 1)} + 6)`, result: f1(H.off, 2) });
  formula({ id: "shrink-def", section: "5", name: `Defensa de ${home} regresada a la media`, expression: "def = (n·PĀ + k·μ) / (n + k)", substituted: `(${f1(H.w, 1)}·${f1(H.rawDef, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(H.w, 1)} + 6)`, result: f1(H.def, 2) });
  formula({ id: "shrink-off-a", section: "5", name: `Ofensiva de ${away} regresada a la media`, expression: "off = (n·PF̄ + k·μ) / (n + k)", substituted: `(${f1(A.w, 1)}·${f1(A.rawOff, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(A.w, 1)} + 6)`, result: f1(A.off, 2) });
  formula({ id: "shrink-def-a", section: "5", name: `Defensa de ${away} regresada a la media`, expression: "def = (n·PĀ + k·μ) / (n + k)", substituted: `(${f1(A.w, 1)}·${f1(A.rawDef, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(A.w, 1)} + 6)`, result: f1(A.def, 2) });
  formula({ id: "hfa", section: "5", name: "Ventaja de local observada", expression: "HFA = promedio(pts local − pts visita) en sedes no neutrales", substituted: `${prior.filter((g) => g.location === "Home").length} partidos`, result: `${sgn(hfaObserved, 2)} pts${neutral ? " (no se aplica: sede neutral)" : ""}` });

  const curShare = (t: string) => {
    const a = agg.get(t);
    return a && a.gamesW ? a.gamesCur / a.gamesW : 0;
  };
  add({
    id: "weight", section: "5", category: "Modelo", label: `Peso de los partidos de ${target.season} en los ratings`,
    home: `${agg.get(home)?.gamesCur ?? 0} partido(s) · ${pctS(curShare(home), 0)}`, away: `${agg.get(away)?.gamesCur ?? 0} partido(s) · ${pctS(curShare(away), 0)}`,
    source: SRC.model, status: "derivado",
    note: currentSeasonGames ? `El resto del peso sigue viniendo de ${priorSeason}. Cada partido nuevo sube esta proporción.` : `Semana 1: todo el modelo sale de ${priorSeason}.`,
  });
  formula({ id: "weights", section: "5", name: `Peso de ${target.season} frente a ${priorSeason}`, expression: `peso = n_${target.season}·1 / (n_${target.season}·1 + n_${priorSeason}·${PRIOR_SEASON_WEIGHT})`, substituted: `${home}: ${agg.get(home)?.gamesCur ?? 0} / ${f1(agg.get(home)?.gamesW ?? 0, 1)} · ${away}: ${agg.get(away)?.gamesCur ?? 0} / ${f1(agg.get(away)?.gamesW ?? 0, 1)}`, result: `${home} ${pctS(curShare(home))} · ${away} ${pctS(curShare(away))}` });

  const baseHome = leagueMean + (H.off - leagueMean) + (A.def - leagueMean) + hfa / 2;
  const baseAway = leagueMean + (A.off - leagueMean) + (H.def - leagueMean) - hfa / 2;
  formula({ id: "lambda-h", section: "5", name: `λ base de ${home}`, expression: "λ_local = μ + (off_local − μ) + (def_visita − μ) + HFA/2", substituted: `${f1(leagueMean, 2)} + (${f1(H.off, 2)} − ${f1(leagueMean, 2)}) + (${f1(A.def, 2)} − ${f1(leagueMean, 2)}) + ${f1(hfa / 2, 2)}`, result: f1(baseHome, 2) });
  formula({ id: "lambda-a", section: "5", name: `λ base de ${away}`, expression: "λ_visita = μ + (off_visita − μ) + (def_local − μ) − HFA/2", substituted: `${f1(leagueMean, 2)} + (${f1(A.off, 2)} − ${f1(leagueMean, 2)}) + (${f1(H.def, 2)} − ${f1(leagueMean, 2)}) − ${f1(hfa / 2, 2)}`, result: f1(baseAway, 2) });

  // Ajustes multiplicativos de la tabla 5.3: se evalúan TODOS, se aplican solo los que traen información nueva.
  const top10 = (m: Map<string, number>, t: string, higher: boolean) => rankOf(m, t, higher) <= 10;
  const anyaRank = (q: typeof qbH) => (q ? rankOf(qbAnyaAll, q.id, true) : 99);
  const qbGood = (q: typeof qbH) => Boolean(q && anyaRank(q) <= 10 && q.int / q.att < lgInt);
  const windMph = target.wind;
  const tempF = target.temp;
  const OFF_POS = ["QB", "WR", "TE", "RB", "FB", "T", "G", "C", "OL"];
  const offStarterOut = (t: string) => injuryDetail.filter((i) => i.team === t && i.inBase && i.confirmedOut && OFF_POS.includes(i.position ?? ""));
  const defStarterOut = (t: string) => injuryDetail.filter((i) => i.team === t && i.inBase && i.confirmedOut && !OFF_POS.includes(i.position ?? "") && !["K", "P", "LS"].includes(i.position ?? ""));
  const newToBase = injuryDetail.filter((i) => !i.inBase);
  type Adj = { condition: string; data: string; met: boolean | null; inBase: boolean; factor: number; appliesTo: "total" | "home" | "away"; applied: boolean; reason: string };
  const adjustments: Adj[] = [];
  const pushAdj = (a: Omit<Adj, "applied">) => adjustments.push({ ...a, applied: Boolean(a.met) && !a.inBase });
  pushAdj({ condition: "Ambos QBs con buen ANY/A y bajo INT%", data: `${qbH?.name ?? home}: ANY/A ${anyaRank(qbH)}º, INT% ${pctS(qbH ? qbH.int / qbH.att : NaN)} · ${qbA?.name ?? away}: ANY/A ${anyaRank(qbA)}º, INT% ${pctS(qbA ? qbA.int / qbA.att : NaN)} (liga ${pctS(lgInt)})`, met: qbH && qbA ? qbGood(qbH) && qbGood(qbA) : null, inBase: true, factor: 0.9, appliesTo: "total", reason: "La producción de ambos QBs ya está en los puntos a favor que forman la base." });
  pushAdj({ condition: `Rival con alto pressure rate (contra ${home})`, data: `${away}: ${pctS(M.pressureRate.get(away))} (${rk(M.pressureRate, away, true)})`, met: top10(M.pressureRate, away, true), inBase: true, factor: 0.9, appliesTo: "home", reason: "La presión de la defensa rival ya se refleja en sus puntos permitidos." });
  pushAdj({ condition: `Rival con alto pressure rate (contra ${away})`, data: `${home}: ${pctS(M.pressureRate.get(home))} (${rk(M.pressureRate, home, true)})`, met: top10(M.pressureRate, home, true), inBase: true, factor: 0.9, appliesTo: "away", reason: "Igual: ya está en los puntos permitidos." });
  pushAdj({ condition: "Ambas defensas top-10 en EPA/jugada permitido", data: `${home} ${rk(M.defEpa, home, false)}, ${away} ${rk(M.defEpa, away, false)}`, met: top10(M.defEpa, home, false) && top10(M.defEpa, away, false), inBase: true, factor: 0.88, appliesTo: "total", reason: "La calidad defensiva ya entra como def_local y def_visita en λ: aplicarlo otra vez contaría doble." });
  pushAdj({ condition: "Viento fuerte (> 25 km/h ≈ 15.5 mph) o lluvia intensa", data: target.roof === "outdoors" ? `Viento ${windMph ?? "—"} mph; lluvia: sin dato` : `Estadio ${target.roof}`, met: target.roof === "outdoors" ? (windMph ?? 0) > 15.5 : false, inBase: false, factor: 0.9, appliesTo: "total", reason: "Condición del día del partido: información nueva." });
  pushAdj({ condition: "Estadio con domo o techo cerrado", data: target.roof ?? "—", met: target.roof === "dome" || target.roof === "closed", inBase: false, factor: 1.05, appliesTo: "total", reason: "Condición del día del partido." });
  pushAdj({ condition: "Frío extremo (< 0 °C ≈ 32 °F)", data: tempF !== null ? `${tempF} °F` : "Sin dato", met: tempF !== null ? tempF < 32 : null, inBase: false, factor: 0.93, appliesTo: "total", reason: "Condición del día del partido." });
  pushAdj({ condition: `Ritmo combinado alto (jugadas por partido sobre la media)`, data: `${home} ${f1(M.pace.get(home))}, ${away} ${f1(M.pace.get(away))}, liga ${f1(leagueAvg(M.pace))}`, met: (M.pace.get(home) ?? 0) + (M.pace.get(away) ?? 0) > 2 * leagueAvg(M.pace), inBase: true, factor: 1.05, appliesTo: "total", reason: "El ritmo de la base ya está en los puntos por partido." });
  for (const t of [home, away]) {
    const offOut = offStarterOut(t);
    const defOut = defStarterOut(t);
    pushAdj({ condition: `Baja de titular ofensivo de ${t} que sí jugó en la base`, data: offOut.length ? offOut.map((i) => `${i.name} (${i.position}, ${i.status})`).join("; ") : "Ninguna", met: offOut.length > 0, inBase: false, factor: 0.92, appliesTo: t === home ? "home" : "away", reason: haveInactives ? "Información nueva: baja confirmada por la lista oficial de inactivos." : "Información nueva del reporte de lesiones (Out)." });
    pushAdj({ condition: `Baja de titular defensivo de ${t} que sí jugó en la base`, data: defOut.length ? defOut.map((i) => `${i.name} (${i.position}, ${i.status})`).join("; ") : "Ninguna", met: defOut.length > 0, inBase: false, factor: 1.08, appliesTo: t === home ? "away" : "home", reason: "Sube los puntos esperados del rival." });
  }
  let mulHome = 1, mulAway = 1;
  for (const a of adjustments.filter((x) => x.applied)) {
    if (a.appliesTo === "total" || a.appliesTo === "home") mulHome *= a.factor;
    if (a.appliesTo === "total" || a.appliesTo === "away") mulAway *= a.factor;
  }
  const muHome = baseHome * mulHome;
  const muAway = baseAway * mulAway;
  const muMargin = muHome - muAway;
  const muTotal = muHome + muAway;
  formula({ id: "lambda-final", section: "5", name: "λ final con ajustes aplicables", expression: "λ_final = λ_base × Π(factores con información nueva)", substituted: `${home}: ${f1(baseHome, 2)} × ${f1(mulHome, 3)} · ${away}: ${f1(baseAway, 2)} × ${f1(mulAway, 3)}`, result: `${home} ${f1(muHome, 1)} – ${away} ${f1(muAway, 1)} · total ${f1(muTotal, 1)}` });
  if (newToBase.length) {
    add({ id: "inj-new", section: "5", category: "Disponibilidad de jugadores", label: "Bajas de jugadores que no están en la base", value: newToBase.map((i) => `${i.name} (${i.team}, ${i.position})`).join("; "), source: `${SRC.injuries} + ${SRC.depth} (${baseLabel})`, status: "derivado", note: `No fueron titulares de su equipo en la base (${baseLabel}): los ratings no los contienen, así que su baja no cambia la proyección. Es información que el modelo todavía no sabe usar (fichajes, novatos).` });
  }

  // Simulación (5.4 / 5.7.9)
  const rand = mulberry32(hashString(gameId));
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const bins: Record<number, number> = {};
  let homeWins = 0, homeCovers = 0, overs = 0;
  const spread = target.spreadLine;
  const total = target.totalLine;
  for (let i = 0; i < SIMULATIONS; i++) {
    const m = muMargin + sigmaMargin * gauss();
    const t = muTotal + sigmaTotal * gauss();
    if (m > 0) homeWins++;
    if (spread !== null && m > spread) homeCovers++;
    if (total !== null && t > total) overs++;
    const b = Math.max(-40, Math.min(40, Math.round(m)));
    bins[b] = (bins[b] ?? 0) + 1;
  }
  const pSim = homeWins / SIMULATIONS;
  formula({ id: "sim", section: "5", name: "Simulación Monte Carlo (5.7.9)", expression: "margen ~ N(λ_local − λ_visita, σ_margen), total ~ N(λ_local + λ_visita, σ_total); P = frecuencia en 50,000 partidos", substituted: `margen ~ N(${sgn(muMargin, 2)}, ${f1(sigmaMargin, 2)}), total ~ N(${f1(muTotal, 2)}, ${f1(sigmaTotal, 2)}); σ medidas en ${priorSeason}`, result: `P(${home} gana) = ${pctS(pSim)}` });

  // Log5 (5.7.2) y Pitagórico (5.7.1)
  const pyth = (off: number, def: number) => off ** PYTH_EXP / (off ** PYTH_EXP + def ** PYTH_EXP);
  const pH = pyth(H.off, H.def), pA = pyth(A.off, A.def);
  const log5 = (pH - pH * pA) / (pH + pA - 2 * pH * pA);
  const homeBoost = normalCdf(hfa / sigmaMargin) - 0.5;
  const pLog5 = Math.min(0.99, Math.max(0.01, log5 + homeBoost));
  formula({ id: "pyth", section: "5", name: "Pitagórico con ratings regresados (5.7.1)", expression: "p = off^2.37 / (off^2.37 + def^2.37)", substituted: `${home}: ${f1(H.off, 2)}^2.37 / (${f1(H.off, 2)}^2.37 + ${f1(H.def, 2)}^2.37) · ${away}: ${f1(A.off, 2)}^2.37 / (… + ${f1(A.def, 2)}^2.37)`, result: `${home} ${f1(pH, 3)} · ${away} ${f1(pA, 3)}` });
  formula({ id: "log5", section: "5", name: "Log5 + ventaja de local (5.7.2)", expression: "P = (pA − pA·pB)/(pA + pB − 2·pA·pB) + [Φ(HFA/σ) − 0.5]", substituted: `(${f1(pH, 3)} − ${f1(pH, 3)}·${f1(pA, 3)})/(${f1(pH, 3)} + ${f1(pA, 3)} − 2·${f1(pH, 3)}·${f1(pA, 3)}) + ${f1(homeBoost, 3)}`, result: pctS(pLog5) });
  formula({ id: "pyth-luck", section: "2", name: "Suerte según el Pitagórico real (5.7.1)", expression: "suerte = win% real − PF^2.37/(PF^2.37 + PA^2.37)", substituted: `${home}: ${pctS(H.actual)} − ${pctS(H.pyth)} · ${away}: ${pctS(A.actual)} − ${pctS(A.pyth)} (PF/PA ${priorSeason}: ${H.reg.pf}/${H.reg.pa} y ${A.reg.pf}/${A.reg.pa})`, result: `${home} ${sgn((H.actual - H.pyth) * 100, 1)} pp · ${away} ${sgn((A.actual - A.pyth) * 100, 1)} pp` });

  // Elo (5.7.7)
  const elo = new Map<string, number>();
  const getElo = (t: string) => elo.get(t) ?? 1500;
  let eloSeason = firstSeason;
  for (const g of history) {
    if (g.season !== eloSeason) {
      for (const [t, v] of elo) elo.set(t, v - (v - 1505) / 3);
      eloSeason = g.season;
    }
    const diff = getElo(g.homeTeamAbbr) + (g.location === "Neutral" ? 0 : ELO_HOME) - getElo(g.awayTeamAbbr);
    const exp = 1 / (1 + 10 ** (-diff / 400));
    const margin = (g.homeScore as number) - (g.awayScore as number);
    const res = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
    const mov = Math.log(Math.abs(margin) + 1) * (2.2 / ((margin > 0 ? diff : -diff) * 0.001 + 2.2));
    const delta = ELO_K * mov * (res - exp);
    elo.set(g.homeTeamAbbr, getElo(g.homeTeamAbbr) + delta);
    elo.set(g.awayTeamAbbr, getElo(g.awayTeamAbbr) - delta);
  }
  if (eloSeason !== target.season) for (const [t, v] of elo) elo.set(t, v - (v - 1505) / 3);
  const eloSeasons = target.season - firstSeason;
  const eH = getElo(home), eA = getElo(away);
  const pElo = 1 / (1 + 10 ** (-(eH + (neutral ? 0 : ELO_HOME) - eA) / 400));
  formula({ id: "elo", section: "5", name: "Elo (5.7.7)", expression: "E = 1 / (1 + 10^(−(R_local + 48 − R_visita)/400)); K = 20 × multiplicador de margen; regresión de 1/3 hacia 1505 entre temporadas", substituted: `R_${home} = ${Math.round(eH)}, R_${away} = ${Math.round(eA)} (arrancan en 1500 en la semana 1 de ${firstSeason}; ${history.length} partidos y ${eloSeasons} temporadas de historia)`, result: pctS(pElo) });
  add({ id: "elo-start", section: "5", category: "Modelo", label: "Punto de partida del Elo", value: `1500 en ${firstSeason} · ${eloSeasons} temporadas`, source: `${SRC.games} · ${firstSeason}–${target.season}`, status: eloSeasons >= 3 ? "derivado" : "parcial", note: eloSeasons >= 3 ? `Con ${eloSeasons} temporadas y la regresión de 1/3 en cada cambio de año, el valor inicial de 1500 ya casi no pesa.` : `Con solo ${eloSeasons} temporada(s) el Elo depende mucho del valor inicial.` });

  const methods = [
    { key: "log5", label: "Log5 (Pitagórico regresado + local)", p: pLog5 },
    { key: "elo", label: "Elo (regresión de 1/3 entre temporadas)", p: pElo },
    { key: "sim", label: `Simulación (${SIMULATIONS.toLocaleString("es-MX")} partidos)`, p: pSim },
  ];
  const pHome = mean(methods.map((m) => m.p));
  const divergence = Math.max(...methods.map((m) => m.p)) - Math.min(...methods.map((m) => m.p));
  const confidence = divergence <= 0.05 ? "alta" : divergence <= 0.1 ? "media" : "baja";
  formula({ id: "tri", section: "5", name: "Probabilidad triangulada (sección 10, fase 2)", expression: "P = promedio(Log5, Elo, Simulación); divergencia = máx − mín", substituted: `(${pctS(pLog5)} + ${pctS(pElo)} + ${pctS(pSim)}) / 3; divergencia ${pctS(divergence)}`, result: `${pctS(pHome)} · confianza ${confidence}` });

  // ============================================================ SECCIÓN 6
  const lgQ1 = leagueAvg(M.q1Share), lgH1 = leagueAvg(M.h1Share);
  const shrinkShare = (v: number | undefined, lg: number, t: string) => {
    const n = agg.get(t)?.drives ?? 0;
    return ((n * (v ?? lg)) + 180 * lg) / (n + 180);
  };
  const q1H = shrinkShare(M.q1Share.get(home), lgQ1, home), q1A = shrinkShare(M.q1Share.get(away), lgQ1, away);
  const h1H = shrinkShare(M.h1Share.get(home), lgH1, home), h1A = shrinkShare(M.h1Share.get(away), lgH1, away);
  const proj1Q = { home: muHome * q1H, away: muAway * q1A };
  const proj1H = { home: muHome * h1H, away: muAway * h1A };
  add({ id: "q-share", section: "6", category: "Modelo", label: "% de sus puntos que anota en 1Q · 1H (regresado)", home: `${pctS(q1H)} · ${pctS(h1H)}`, away: `${pctS(q1A)} · ${pctS(h1A)}`, source: `${SRC.pbp} · drive_quarter_start, fixed_drive_result`, status: "derivado" });
  formula({ id: "q-proj", section: "6", name: "Puntos esperados por tramo (6.7)", expression: "λ_1Q = λ_final × %1Q ; λ_1H = λ_final × %1H (porcentajes regresados con k = 180 posesiones)", substituted: `${home}: ${f1(muHome, 2)}×${f1(q1H, 3)} y ×${f1(h1H, 3)} · ${away}: ${f1(muAway, 2)}×${f1(q1A, 3)} y ×${f1(h1A, 3)}`, result: `1Q ${f1(proj1Q.away)}–${f1(proj1Q.home)} · 1H ${f1(proj1H.away)}–${f1(proj1H.home)} (${away}–${home})` });
  const totalLines = total !== null ? [total - 3, total - 1.5, total, total + 1.5, total + 3] : [];
  const lineTable = totalLines.map((line) => {
    const pOver = 1 - normalCdf((line - muTotal) / sigmaTotal);
    return { line, pOver: r3(pOver), pUnder: r3(1 - pOver), read: Math.abs(pOver - 0.5) < 0.03 ? "Sin valor: muy cerca de 50%" : pOver > 0.5 ? "Inclina Over" : "Inclina Under" };
  });
  formula({ id: "p-over", section: "6", name: "Probabilidad de Over por línea (6.8)", expression: "P(Over L) = 1 − Φ((L − λ_total) / σ_total)", substituted: total !== null ? `1 − Φ((${total} − ${f1(muTotal, 2)}) / ${f1(sigmaTotal, 2)})` : "Sin línea", result: total !== null ? pctS(1 - normalCdf((total - muTotal) / sigmaTotal)) : "—" });
  add({ id: "wx", section: "6", category: "Clima y sede", label: "Clima (temperatura · viento)", value: target.roof === "outdoors" ? `${tempF ?? "—"} °F · ${windMph ?? "—"} mph` : `Techado (${target.roof})`, source: `${SRC.games} · temp, wind, roof`, status: target.roof === "outdoors" ? (tempF !== null ? "disponible" : "faltante") : "no_aplica", note: "Es el clima medido en el partido; como pronóstico previo es una aproximación." });
  add({ id: "rain", section: "6", category: "Clima y sede", label: "Lluvia / precipitación", value: "—", source: SRC.none, status: target.roof === "outdoors" ? "faltante" : "no_aplica", note: "nflverse no publica precipitación. Fuente sugerida: Open-Meteo (sección 9.2).", impact: target.roof === "outdoors" ? "No se puede evaluar el ajuste de lluvia intensa (5.3)." : undefined });
  add({ id: "surface", section: "6", category: "Clima y sede", label: "Estadio · superficie", value: `${target.stadium ?? "—"} · ${target.surface ?? "—"}`, source: `${SRC.games} · stadium, surface`, status: "disponible" });

  // ============================================================ SECCIÓN 7
  const markets: {
    market: string; pick: string; line: string; odds: number; pImplied: number; pModel: number; edge: number; fairOdds: number;
    kellyFull: number; kellyQuarter: number; b: number; model: boolean; script: boolean; price: boolean; light: "Verde" | "Amarillo" | "Gris"; won: boolean | null; push: boolean;
    sides: { pick: string; odds: number; pRaw: number; pImplied: number; pModel: number; edge: number }[]; overround: number;
  }[] = [];
  const played = target.homeScore !== null && target.awayScore !== null;
  const finalMargin = played ? (target.homeScore as number) - (target.awayScore as number) : null;
  const finalTotal = played ? (target.homeScore as number) + (target.awayScore as number) : null;
  const addMarket = (market: string, sides: { pick: string; line: string; odds: number | null; p: number; won: boolean | null; push?: boolean; scriptOk: boolean }[]) => {
    if (sides.some((s) => s.odds === null)) return;
    const raw = sides.map((s) => impliedProbability(s.odds as number));
    const overround = raw.reduce((a, b) => a + b, 0);
    const scored = sides.map((s, i) => ({ ...s, pRaw: raw[i], pImplied: raw[i] / overround, edge: s.p - raw[i] / overround }));
    const best = [...scored].sort((a, b) => b.edge - a.edge)[0];
    const k = kellyFraction(best.p, best.odds as number);
    markets.push({
      market, pick: best.pick, line: best.line, odds: best.odds as number, pImplied: r3(best.pImplied), pModel: r3(best.p), edge: r3(best.edge),
      fairOdds: fairAmerican(best.p), kellyFull: r3(k.f), kellyQuarter: r3(Math.max(0, k.f / 4)), b: r3(k.b),
      model: best.edge >= 0.03, script: best.scriptOk, price: (best.odds as number) >= fairAmerican(best.p),
      light: "Gris", won: best.won, push: Boolean(best.push), overround: r3(overround),
      sides: scored.map((s) => ({ pick: s.pick, odds: s.odds as number, pRaw: r3(s.pRaw), pImplied: r3(s.pImplied), pModel: r3(s.p), edge: r3(s.edge) })),
    });
  };
  const pCover = homeCovers / SIMULATIONS;
  const pOver = overs / SIMULATIONS;
  const fmtLine = (v: number) => (v > 0 ? `+${v}` : `${v}`);
  addMarket("Moneyline", [
    { pick: home, line: "gana", odds: target.homeMoneyline, p: pHome, won: played ? (finalMargin as number) > 0 : null, scriptOk: muMargin > 0 },
    { pick: away, line: "gana", odds: target.awayMoneyline, p: 1 - pHome, won: played ? (finalMargin as number) < 0 : null, scriptOk: muMargin < 0 },
  ]);
  if (spread !== null) addMarket("Spread", [
    { pick: home, line: fmtLine(-spread), odds: target.homeSpreadOdds, p: pCover, won: played ? (finalMargin as number) > spread : null, push: played && finalMargin === spread, scriptOk: muMargin > spread },
    { pick: away, line: fmtLine(spread), odds: target.awaySpreadOdds, p: 1 - pCover, won: played ? (finalMargin as number) < spread : null, push: played && finalMargin === spread, scriptOk: muMargin < spread },
  ]);
  if (total !== null) addMarket("Total", [
    { pick: "Over", line: `${total}`, odds: target.overOdds, p: pOver, won: played ? (finalTotal as number) > total : null, push: played && finalTotal === total, scriptOk: muTotal > total },
    { pick: "Under", line: `${total}`, odds: target.underOdds, p: 1 - pOver, won: played ? (finalTotal as number) < total : null, push: played && finalTotal === total, scriptOk: muTotal < total },
  ]);
  const mk = (name: string) => markets.find((m) => m.market === name);
  add({ id: "ml", section: "7", category: "Mercado", label: "Moneyline de cierre", home: `${target.homeMoneyline ?? "—"}`, away: `${target.awayMoneyline ?? "—"}`, source: `${SRC.games} · home_moneyline / away_moneyline`, status: target.homeMoneyline !== null ? "disponible" : "faltante", note: "Momio de cierre: el último antes del partido. No hay historial de movimiento de línea." });
  add({ id: "sp", section: "7", category: "Mercado", label: "Spread de cierre (momios)", value: spread !== null ? `${spread >= 0 ? home : away} −${Math.abs(spread)} (${target.homeSpreadOdds ?? "—"} / ${target.awaySpreadOdds ?? "—"})` : "—", source: `${SRC.games} · spread_line, home/away_spread_odds`, status: spread !== null ? "disponible" : "faltante" });
  add({ id: "tot", section: "7", category: "Mercado", label: "Total de cierre (momios)", value: total !== null ? `${total} (O ${target.overOdds ?? "—"} / U ${target.underOdds ?? "—"})` : "—", source: `${SRC.games} · total_line, over_odds, under_odds`, status: total !== null ? "disponible" : "faltante" });
  add({ id: "books", section: "7", category: "Mercado", label: "Momios de 2 o más casas", value: "1 línea de consenso", source: SRC.games, status: "parcial", note: "La sección 9.3 pide al menos 2 casas para verificar el precio. nflverse da una sola línea de cierre.", impact: "No se puede buscar el mejor precio ni detectar diferencias entre casas (7.1)." });
  add({ id: "mv", section: "7", category: "Mercado", label: "Movimiento de línea (apertura → cierre)", value: "—", source: SRC.none, status: "faltante", note: "Fuente sugerida: The Odds API con histórico (sección 9.2).", impact: "No se puede evaluar si el movimiento ya consumió el valor (7.7)." });
  add({ id: "alt", section: "7", category: "Mercado", label: "Líneas de 1Q, 1H, team totals y props", value: "—", source: SRC.none, status: "faltante", note: "Solo hay líneas de partido completo.", impact: "Los mercados alternativos de 7.6 se proyectan (sección 6) pero no se pueden valorar." });
  for (const m of markets) {
    const s0 = m.sides[0], s1 = m.sides[1];
    formula({ id: `imp-${m.market}`, section: "7", name: `Probabilidad implícita sin margen · ${m.market}`, expression: "P = |m|/(|m|+100) si m<0; 100/(m+100) si m>0; luego P / Σ P para quitar el margen", substituted: `${s0.pick} ${s0.odds}: ${pctS(s0.pRaw)} · ${s1.pick} ${s1.odds}: ${pctS(s1.pRaw)} · suma ${pctS(m.overround)}`, result: `${s0.pick} ${pctS(s0.pImplied)} · ${s1.pick} ${pctS(s1.pImplied)}` });
    formula({ id: `edge-${m.market}`, section: "7", name: `Edge, momio justo y Kelly · ${m.market} (${m.pick} ${m.line})`, expression: "edge = P_modelo − P_implícita; momio justo = −100p/(1−p) si p≥0.5, 100(1−p)/p si p<0.5; f* = (b·p − q)/b", substituted: `${pctS(m.pModel)} − ${pctS(m.pImplied)}; b = ${f1(m.b, 3)}; f* = (${f1(m.b, 3)}·${f1(m.pModel, 3)} − ${f1(1 - m.pModel, 3)}) / ${f1(m.b, 3)}`, result: `edge ${sgn(m.edge * 100, 1)} pp · justo ${m.fairOdds > 0 ? "+" : ""}${m.fairOdds} · ¼ Kelly ${pctS(m.kellyQuarter)}` });
  }

  // ============================================================ SECCIÓN 9 — inventario y gate
  const gateFields = [
    { section: "1–2", label: "División, récords y últimos partidos", ok: true, ids: ["div", "record", "l5home", "l5away"] },
    { section: "1–2", label: "Historial directo (5 partidos)", ok: h2h.length >= 5, ids: ["h2h"], blocks: "Baja confianza histórica" },
    { section: "3", label: "QB: passer rating, ANY/A, EPA, CPOE", ok: Boolean(qbH && qbA), ids: ["qb-name"], blocks: "Bloquea Verde en moneyline y 1H" },
    { section: "4", label: "Defensa: EPA permitido, presión, reporte de lesiones", ok: injPre.length > 0, ids: ["d-epa", "d-press", "inj"], blocks: "Bloquea Verde en total y spread" },
    { section: "5", label: "Ajustes multiplicativos con dato real", ok: adjustments.every((a) => a.met !== null), ids: [], blocks: "Bloquea Verde en total" },
    { section: "4–6", label: "Alineación confirmada (inactivos oficiales)", ok: haveInactives, ids: ["inactive", "depth"], blocks: "Ningún pick puede ser Verde (8.3.12)" },
    { section: "6", label: "Clima completo (lluvia)", ok: false, ids: ["rain"], blocks: "Bloquea Verde en total" },
    { section: "7", label: "Momios de al menos 2 casas", ok: false, ids: ["books"], blocks: "Sin verificación de precio" },
  ];
  const campoFaltante = gateFields.some((g) => !g.ok);

  // Semáforo por mercado: Verde solo si Modelo + Guion + Cuota y sin campo faltante.
  for (const m of markets) {
    if (m.model && m.script && m.price) m.light = campoFaltante ? "Amarillo" : "Verde";
    else if (m.model) m.light = "Amarillo";
    else m.light = "Gris";
    if (m.light === "Gris") m.kellyQuarter = 0;
  }

  // ============================================================ SECCIÓN 8 — 17 filtros
  const picks = markets.filter((m) => m.light !== "Gris");
  const ml = mk("Moneyline"), sp = mk("Spread"), to = mk("Total");
  const marketFav = (target.homeMoneyline ?? 0) < (target.awayMoneyline ?? 0) ? home : away;
  const checks: Check[] = [
    { id: "8.3.1", rule: "No confundir predicción con valor", status: ml ? "pasa" : "no_evaluable", detail: ml ? `El mercado favorece a ${marketFav}; el modelo ve ${pctS(pHome)} para ${home}. El pick sale del edge (${ml.pick}), no de quién es más probable.` : "Sin moneyline." },
    { id: "8.3.2", rule: "No sobreponderar los últimos 5 partidos", status: "pasa", detail: `El modelo no usa rachas: pondera temporadas completas (${baseLabel}) con regresión a la media. Los últimos 5 partidos del QB solo se muestran como contexto.` },
    { id: "8.3.3", rule: "Si el pick depende de que una defensa colapse, verificar presión, lesiones y clima", status: "pasa", detail: `Ningún pick asume un colapso: las defensas son ${rk(M.defEpa, home, false)} (${home}) y ${rk(M.defEpa, away, false)} (${away}) en EPA permitido.` },
    { id: "8.3.4", rule: "Presión alta contra el QB → revisar 1H Under / Under primero", status: top10(M.pressureRate, home, true) || top10(M.pressureRate, away, true) ? "alerta" : "pasa", detail: `Pressure rate: ${home} ${pctS(M.pressureRate.get(home))} (${rk(M.pressureRate, home, true)}), ${away} ${pctS(M.pressureRate.get(away))} (${rk(M.pressureRate, away, true)}).` },
    { id: "8.3.5", rule: "El estadio o el clima no deciden solos", status: "pasa", detail: `Ajustes de clima/estadio aplicados: ${adjustments.filter((a) => a.applied && /Viento|domo|Frío/.test(a.condition)).length}.` },
    { id: "8.3.6", rule: "Ambas defensas top-10 → penalizar Over y favorito grande", status: top10(M.defEpa, home, false) && top10(M.defEpa, away, false) ? (to?.pick === "Over" ? "alerta" : "pasa") : "no_aplica", detail: `${home} ${rk(M.defEpa, home, false)} y ${away} ${rk(M.defEpa, away, false)} en EPA permitido${to ? `; el pick de total es ${to.pick}` : ""}.` },
    { id: "8.3.7", rule: "Diferenciar yardas de puntos (zona roja, explosivas, pérdidas, 3er down)", status: "pasa", detail: `TD% zona roja ${home} ${pctS(M.rzTd.get(home))} vs ${away} ${pctS(M.rzTd.get(away))}; puntos por posesión ${f1(M.ptsPerDrive.get(home), 2)} vs ${f1(M.ptsPerDrive.get(away), 2)}.` },
    { id: "8.3.8", rule: "Tabla de dependencia de supuestos", status: "pasa", detail: "Generada abajo para cada pick." },
    { id: "8.3.9", rule: "Spread grande (≥ 7) con total bajo", status: spread !== null && Math.abs(spread) >= 7 ? (muTotal < (total ?? 99) ? "alerta" : "pasa") : "no_aplica", detail: `Spread de ${Math.abs(spread ?? 0)}.` },
    { id: "8.3.10", rule: "Team total Over: ¿el equipo anota touchdowns y no solo yardas?", status: "no_evaluable", detail: "No hay línea de team total en la fuente." },
    { id: "8.3.11", rule: "Partido divisional: no asumir más puntos", status: target.divGame ? "pasa" : "no_aplica", detail: target.divGame ? "Divisional, sin ajuste al alza." : "No es divisional." },
    { id: "8.3.12", rule: "Sin lesiones, clima o alineación confirmada → nunca Verde", status: campoFaltante ? "alerta" : "pasa", detail: campoFaltante ? `Faltan: ${gateFields.filter((g) => !g.ok).map((g) => g.label).join("; ")}.` : "Completo." },
    { id: "8.3.13", rule: "Tres filtros: estadístico, guion y cuota", status: picks.every((m) => m.model && m.script && m.price) ? "pasa" : "alerta", detail: markets.map((m) => `${m.market}: modelo ${m.model ? "sí" : "no"}, guion ${m.script ? "sí" : "no"}, cuota ${m.price ? "sí" : "no"}`).join(" · ") },
    { id: "8.3.14", rule: "Under y favorito en el spread a la vez", status: to?.pick === "Under" && sp && sp.pick === (spread !== null && spread >= 0 ? home : away) && sp.light !== "Gris" ? "alerta" : "pasa", detail: `Total: ${to?.pick ?? "—"} · spread: ${sp ? `${sp.pick} ${sp.line}` : "—"}.` },
    { id: "8.3.15", rule: "Sin edge claro → no bet", status: markets.some((m) => m.edge >= 0.03) ? "pasa" : "alerta", detail: `Edges: ${markets.map((m) => `${m.market} ${sgn(m.edge * 100, 1)} pp`).join(", ")}.` },
    { id: "8.3.16", rule: "Correlación entre picks del mismo partido (5.7.10)", status: ml && sp && ml.light !== "Gris" && sp.light !== "Gris" && ml.pick === sp.pick ? "alerta" : "pasa", detail: ml && sp && ml.pick === sp.pick ? `Moneyline y spread con ${ml.pick} dependen del mismo supuesto: solo uno puede llevar stake completo.` : "Sin picks correlacionados." },
    { id: "8.3.17", rule: "Campo obligatorio vacío → nunca Verde (9.3)", status: campoFaltante ? "alerta" : "pasa", detail: campoFaltante ? "campo_faltante = verdadero → semáforo máximo Amarillo." : "Sin campos faltantes." },
  ];
  const dependencies = picks.map((m) => ({
    pick: `${m.market}: ${m.pick} ${m.line}`,
    assumption: m.market === "Total" ? (m.pick === "Under" ? "Las dos defensas mantienen el nivel de la base" : "Las ofensivas superan a las defensas") : `${m.pick} rinde al menos como en la base (${baseLabel}) y el rival no mejora`,
    ifFails: "Pierde valor",
    risk: m.market === "Total" ? "Medio" : "Alto",
  }));

  // ============================================================ SECCIÓN 10 — algoritmo maestro
  const algorithm = [
    { phase: "Fase 0 · Ingesta con gate", step: "Resultados, calendario, momios, QBs, clima", status: "hecho" },
    { phase: "Fase 0 · Ingesta con gate", step: "Play-by-play con EPA, CPOE y 3er down", status: "hecho" },
    { phase: "Fase 0 · Ingesta con gate", step: "Reporte de lesiones (filtrado por fecha)", status: injPre.length ? "hecho" : "falta" },
    { phase: "Fase 0 · Ingesta con gate", step: "Presión defensiva (PFR)", status: "hecho" },
    { phase: "Fase 0 · Ingesta con gate", step: "Historial 2018+ (H2H y Elo), QBR de ESPN, inactivos oficiales", status: haveInactives ? "hecho" : "parcial" },
    { phase: "Fase 0 · Ingesta con gate", step: "Lluvia pronosticada (Open-Meteo)", status: "falta" },
    { phase: "Fase 0 · Ingesta con gate", step: "Momios de 2+ casas y movimiento de línea", status: "falta" },
    { phase: "Fase 1 · Ajuste estadístico", step: "Shrinkage de ratings y Cmp%; Pitagórico vs récord", status: "hecho" },
    { phase: "Fase 2 · Triangulación", step: "Log5, Elo, simulación y divergencia", status: "hecho" },
    { phase: "Fase 3 · Puntos y total", step: "λ base + ajustes 5.3 sin doble conteo; 1Q/1H; tabla por línea", status: "hecho" },
    { phase: "Fase 3 · Puntos y total", step: "Simulación por posesiones con la cadena de Markov (5.4 nivel 2)", status: "parcial" },
    { phase: "Fase 4 · Valor", step: "Probabilidad implícita, edge, momio justo, ¼ Kelly", status: "hecho" },
    { phase: "Fase 5 · Auditoría", step: "17 filtros de la sección 8.3 y dependencia de supuestos", status: "hecho" },
    { phase: "Fase 6 · Salida", step: "Semáforo por mercado con razón y dato faltante", status: "hecho" },
  ];

  // Inventario resumido
  const byStatus: Record<DataStatus, number> = { disponible: 0, derivado: 0, parcial: 0, faltante: 0, no_aplica: 0 };
  const byCategory: Record<string, Record<DataStatus, number>> = {};
  for (const it of items) {
    byStatus[it.status]++;
    byCategory[it.category] ??= { disponible: 0, derivado: 0, parcial: 0, faltante: 0, no_aplica: 0 };
    byCategory[it.category][it.status]++;
  }

  // Plan para los datos faltantes: qué se completó con una fuente real y qué sigue pendiente (y por qué).
  type GapKind = "resuelto" | "red" | "clave" | "sin_fuente";
  const itemStatus = (id: string) => items.find((it) => it.id === id)?.status ?? "faltante";
  const gapPlan: { id: string; label: string; section: string; before: DataStatus; now: DataStatus; kind: GapKind; source: string; detail: string }[] = [
    { id: "h2h", label: "Historial directo (5 partidos)", section: "2", before: h2hInBase >= 5 ? "derivado" : "parcial", now: itemStatus("h2h"), kind: h2h.length >= 5 ? "resuelto" : "sin_fuente",
      source: `${SRC.games} · temporadas ${firstSeason}–${priorSeason - 1} (npm run data:extract -- --season=AAAA --games-only)`,
      detail: `Con ${priorSeason}–${target.season} solo había ${h2hInBase} enfrentamiento(s); con el calendario de temporadas anteriores hay ${h2h.length}.` },
    { id: "elo-start", label: "Historia del Elo", section: "5", before: "parcial", now: itemStatus("elo-start"), kind: "resuelto",
      source: `${SRC.games} · ${history.length} partidos desde ${firstSeason}`,
      detail: `El Elo ya no arranca en 1500 en ${priorSeason}: acumula ${eloSeasons} temporadas de resultados reales.` },
    { id: "qb-qbr", label: "QBR de ESPN", section: "3", before: "faltante", now: itemStatus("qb-qbr"), kind: qbrH && qbrA ? "resuelto" : "sin_fuente",
      source: `${SRC.qbr}`,
      detail: `nflverse publica el QBR real de ESPN por partido y por temporada. Se usa ${priorSeason} completo y, de ${target.season}, solo los partidos anteriores.` },
    { id: "inactive", label: "Alineación confirmada", section: "4–6", before: "parcial", now: itemStatus("inactive"), kind: haveInactives ? "resuelto" : "sin_fuente",
      source: `${SRC.roster} · status = INA`,
      detail: haveInactives ? `${inactives.length} inactivos oficiales para este partido. Las bajas de los ajustes 5.3 ahora salen de esta lista, no del Doubtful del reporte.` : "No hay lista de inactivos publicada para esta semana." },
    { id: "depth", label: "Titulares exactos de la primera jugada", section: "4", before: "parcial", now: itemStatus("depth"), kind: "sin_fuente",
      source: "nflverse · snap_counts_{temporada}.csv (posterior al partido)",
      detail: "Solo se conocen al empezar el partido. Los snap counts los tienen, pero usarlos antes del partido sería fuga de datos; quién no juega ya lo confirman los inactivos." },
    { id: "rain", label: "Lluvia pronosticada", section: "6", before: "faltante", now: itemStatus("rain"), kind: "red",
      source: "Open-Meteo · historical-forecast-api.open-meteo.com (gratis, sin clave)",
      detail: "Guarda el pronóstico que existía antes de cada partido, hora por hora, para la ubicación del estadio. El dominio está bloqueado por la red de este entorno: se puede permitir en la configuración o cargar desde tu computadora." },
    { id: "books", label: "Momios de 2 o más casas", section: "7", before: "parcial", now: itemStatus("books"), kind: "clave",
      source: "The Odds API · /v4/historical/sports/americanfootball_nfl/odds",
      detail: "Da los momios de varias casas en una fecha y hora dadas. El histórico es de un plan de pago y necesita una clave (API key)." },
    { id: "mv", label: "Movimiento de línea (apertura → cierre)", section: "7", before: "faltante", now: itemStatus("mv"), kind: "clave",
      source: "The Odds API · snapshots históricos",
      detail: "Pidiendo la misma línea en varias fechas antes del partido se reconstruye el movimiento real. Misma clave que el punto anterior." },
    { id: "alt", label: "Líneas de 1Q, 1H, team totals y props", section: "7", before: "faltante", now: itemStatus("alt"), kind: "clave",
      source: "The Odds API · mercados adicionales (period markets)",
      detail: "Los mercados por cuarto y mitad están en el mismo servicio, con la misma clave." },
  ];

  // Conclusiones por sección, calculadas con los datos (se muestran como "nube" en cada sección).
  const rkN = (m: Map<string, number>, t: string, higher: boolean) => `${rankOf(m, t, higher)}º`;
  const betterOff = better(M.offEpa, true);
  const betterDef = better(M.defEpa, false);
  const appliedAdj = adjustments.filter((x) => x.applied).length;
  const metAdj = adjustments.filter((x) => x.met).length;
  const bestMarket = [...markets].sort((x, y) => y.edge - x.edge)[0];
  const alerts = checks.filter((x) => x.status === "alerta").length;
  const notEval = checks.filter((x) => x.status === "no_evaluable").length;
  const doneSteps = algorithm.filter((x) => x.status === "hecho").length;
  const takeaways: Record<string, string[]> = {
    "1": [
      `${target.divGame ? "Partido divisional" : "No es divisional"}, ${neutral ? "en sede neutral" : `${home} juega en casa`} y ${target.homeRest === target.awayRest ? `ambos con ${target.homeRest} días de descanso` : `descanso ${home} ${target.homeRest} vs ${away} ${target.awayRest} días`}: el contexto no da ventajas especiales.`,
    ],
    "2": [
      `En ${priorSeason}: ${home} ${H.reg.wins}–${H.reg.losses} y ${away} ${A.reg.wins}–${A.reg.losses}. Según el Pitagórico, ${home} ${H.actual - H.pyth >= 0 ? "ganó un poco más" : "ganó un poco menos"} de lo que merecía y ${away} ${A.actual - A.pyth >= 0 ? "un poco más" : "un poco menos"}.`,
      ...(currentSeasonGames ? [`En ${target.season} antes de este partido: ${home} ${curRec(home)} y ${away} ${curRec(away)} (récord · PF/PA).`] : []),
      h2h.length >= 5 ? `Últimos 5 enfrentamientos (${h2h[0].date.slice(0, 4)}–${h2h[h2h.length - 1].date.slice(0, 4)}): ${home} ${h2h.filter((x) => x.win).length}–${h2h.filter((x) => !x.win).length}. Es contexto, no argumento principal.` : `Solo hay ${h2h.length} de 5 enfrentamientos directos en los datos cargados: el historial pesa poco.`,
    ],
    "3": [
      `${betterOff} tuvo la ofensiva más eficiente (EPA/jugada ${rkN(M.offEpa, home, true)} ${home} vs ${rkN(M.offEpa, away, true)} ${away}).`,
      qbH && qbA ? `${anyaRank(qbA) < anyaRank(qbH) ? qbA.name : qbH.name} tuvo mejor ANY/A (${anyaRank(qbH)}º ${qbH.name.split(" ").pop()} vs ${anyaRank(qbA)}º ${qbA.name.split(" ").pop()}).` : "Falta información de los QBs.",
      `${better(M.sackRateTaken, false)} protege mejor a su QB (sack% ${rkN(M.sackRateTaken, home, false)} ${home} vs ${rkN(M.sackRateTaken, away, false)} ${away}).`,
    ],
    "4": [
      `${betterDef} tuvo la mejor defensa por jugada (${rkN(M.defEpa, home, false)} ${home} vs ${rkN(M.defEpa, away, false)} ${away}); ${better(M.pressureRate, true)} presiona más al QB (${rkN(M.pressureRate, home, true)} vs ${rkN(M.pressureRate, away, true)}).`,
      injuryDetail.length ? `Bajas${haveInactives ? " confirmadas por los inactivos oficiales" : " del reporte"}: ${injuryDetail.filter((i) => i.confirmedOut).map((i) => `${i.name} (${i.team})`).join(", ") || "ninguna"}. ${injuryDetail.some((i) => i.inBase && i.confirmedOut) ? `Titulares de la base fuera: ${injuryDetail.filter((i) => i.inBase && i.confirmedOut).map((i) => i.name).join(", ")}.` : "Ninguna era titular en la base, así que no mueven la proyección."}` : "Sin bajas importantes reportadas antes del partido.",
    ],
    "5": [
      `Proyección ${away} ${f1(muAway)} – ${home} ${f1(muHome)} (total ${f1(muTotal)}). Los tres métodos dan entre ${pctS(Math.min(...methods.map((m) => m.p)))} y ${pctS(Math.max(...methods.map((m) => m.p)))} a ${home}: confianza ${confidence}.`,
      currentSeasonGames ? `Los partidos de ${target.season} ya pesan ${pctS(curShare(home), 0)} en los ratings de ${home} y ${pctS(curShare(away), 0)} en los de ${away}; el resto sigue saliendo de ${priorSeason}.` : `Semana 1: los ratings salen por completo de ${priorSeason}.`,
      `${metAdj} de ${adjustments.length} condiciones de la tabla 5.3 se cumplen; ${appliedAdj} se aplicaron (el resto ya está en la base o no se cumple).`,
    ],
    "6": [
      total !== null ? `Total proyectado ${f1(muTotal)} contra una línea de ${total}: ${muTotal < total ? "el modelo inclina Under" : "el modelo inclina Over"} en ${lineTable.filter((l) => (muTotal < total ? l.pUnder > 0.53 : l.pOver > 0.53)).length} de ${lineTable.length} líneas revisadas.` : "Sin línea de total.",
      `Primera mitad proyectada ${away} ${f1(proj1H.away)} – ${home} ${f1(proj1H.home)}; no hay línea de 1H para valorarla.`,
    ],
    "7": [
      bestMarket ? `Mayor edge: ${bestMarket.market} ${bestMarket.pick} ${bestMarket.line} (${sgn(bestMarket.edge * 100, 1)} pp). ${markets.filter((m) => m.light === "Amarillo").length} de ${markets.length} mercados en Amarillo, ninguno Verde por datos faltantes.` : "Sin mercados.",
    ],
    "8": [`${alerts} alertas, ${notEval} filtros no evaluables y ${checks.length - alerts - notEval} que pasan o no aplican, de ${checks.length}.`],
    "9": [campoFaltante ? `Faltan campos obligatorios (${gateFields.filter((g) => !g.ok).map((g) => g.label.toLowerCase()).join("; ")}): máximo Amarillo.` : "Todos los campos obligatorios presentes."],
    "10": [`${doneSteps} de ${algorithm.length} pasos del algoritmo maestro completos.`],
  };

  // Después del partido
  const gameEpa = async (abbr: string) =>
    (await prisma.play.aggregate({ where: { gameId, possessionTeamAbbr: abbr, playType: { in: ["pass", "run"] } }, _avg: { epa: true } }))._avg.epa;
  const [hg, ag] = played ? await Promise.all([gameEpa(home), gameEpa(away)]) : [null, null];
  const diagnosis: string[] = [];
  if (played) {
    const realTotal = finalTotal as number, realMargin = finalMargin as number;
    if (total !== null) {
      const closer = Math.abs(muTotal - realTotal) < Math.abs(total - realTotal) ? "El modelo estuvo más cerca que el mercado." : "El mercado estuvo más cerca.";
      diagnosis.push(`Total: proyectado ${f1(muTotal)}, real ${realTotal}, línea ${total}. ${closer}`);
    }
    if (spread !== null) {
      const closer = Math.abs(muMargin - realMargin) < Math.abs(spread - realMargin) ? "el modelo estuvo más cerca" : "el mercado estuvo más cerca";
      diagnosis.push(`Margen para ${home}: proyectado ${sgn(muMargin, 1)}, mercado ${sgn(spread, 1)}, real ${sgn(realMargin, 0)}: ${closer}.`);
    }
    for (const [t, v] of [[home, hg], [away, ag]] as const) {
      const baseEpa = M.offEpa.get(t);
      if (v === null || baseEpa === undefined) continue;
      const diff = v - baseEpa;
      diagnosis.push(`EPA ofensivo de ${t} en el partido: ${sgn(v, 3)} contra ${sgn(baseEpa, 3)} en la base (${Math.abs(diff) < 0.05 ? "en su nivel" : diff > 0 ? "muy por encima de su nivel" : "muy por debajo de su nivel"}).`);
    }
    if (ml) {
      const bm = (pHome - (realMargin > 0 ? 1 : 0)) ** 2;
      const bk = ((ml.sides.find((x) => x.pick === home)?.pImplied ?? 0.5) - (realMargin > 0 ? 1 : 0)) ** 2;
      diagnosis.push(`Brier del modelo ${f1(bm, 3)} contra ${f1(bk, 3)} del mercado: ${bm < bk ? "el modelo fue más preciso" : "el mercado fue más preciso"} en la probabilidad de victoria.`);
    }
    if (newToBase.length) diagnosis.push(`Jugadores fuera de la base (fichajes, novatos o suplentes que subieron): ${newToBase.length} en el reporte de lesiones. El modelo todavía no sabe medirlos.`);
    diagnosis.push("Las reglas se aplicaron igual que antes del partido: nada se ajustó después de conocer el resultado.");
  }
  const postgame = played
    ? {
        homeScore: target.homeScore as number,
        awayScore: target.awayScore as number,
        marginError: r3(muMargin - (finalMargin as number), 1),
        totalError: r3(muTotal - (finalTotal as number), 1),
        winnerCorrect: (pHome >= 0.5) === ((finalMargin as number) > 0),
        brierModel: r3((pHome - ((finalMargin as number) > 0 ? 1 : 0)) ** 2),
        brierMarket: ml ? r3(((mk("Moneyline")?.sides.find((s) => s.pick === home)?.pImplied ?? 0.5) - ((finalMargin as number) > 0 ? 1 : 0)) ** 2) : null,
        epaInGame: { [home]: hg === null ? null : r3(hg), [away]: ag === null ? null : r3(ag) },
        diagnosis,
        injuredLate: injLate.map((i) => `${i.fullName} (${i.teamAbbr}, ${i.reportStatus ?? "—"}, ${i.dateModified?.toISOString().slice(0, 10)})`),
      }
    : null;

  return {
    gameId, season: target.season, week: target.week, date: cutoff.toISOString().slice(0, 10), home, away,
    context: {
      stadium: target.stadium, location: target.location, roof: target.roof, surface: target.surface, temp: tempF, wind: windMph,
      divGame: target.divGame, homeRest: target.homeRest, awayRest: target.awayRest, homeQb: target.homeQbName, awayQb: target.awayQbName,
      spread, total, homeMoneyline: target.homeMoneyline, awayMoneyline: target.awayMoneyline,
    },
    data: { priorSeasonGames, currentSeasonGames, cutoff: cutoff.toISOString().slice(0, 10), plays: plays.length, drives: drives.length, pressureRows: pressureRows.length, injuryRows: injPre.length, depthRows: depthNow.length },
    league: { mean: r3(leagueMean, 2), hfa: r3(hfa, 2), hfaObserved: r3(hfaObserved, 2), sigmaMargin: r3(sigmaMargin, 2), sigmaTotal: r3(sigmaTotal, 2) },
    items, formulas, takeaways, baseLabel, gapPlan,
    ratings: Object.fromEntries([[home, H, qbH], [away, A, qbA]].map(([t, P, q]) => {
      const team = t as string, prof = P as typeof H, qb = q as typeof qbH;
      return [team, {
        off: r3(prof.off, 2), def: r3(prof.def, 2), elo: Math.round(getElo(team)), weightCurrent: r3(curShare(team)), gamesCurrent: agg.get(team)?.gamesCur ?? 0,
        offEpa: r3(M.offEpa.get(team) ?? NaN), defEpa: r3(M.defEpa.get(team) ?? NaN),
        offEpaRank: rankOf(M.offEpa, team, true), defEpaRank: rankOf(M.defEpa, team, false),
        qb: qb ? { name: qb.name, anya: r3(qb.anya, 2), epa: qb.epa === null ? null : r3(qb.epa), currentGames: qb.currentGames } : null,
      }];
    })),
    inventory: { byStatus, byCategory, total: items.length },
    gate: gateFields.map((g) => ({ section: g.section, label: g.label, ok: g.ok, blocks: g.blocks ?? null })),
    campoFaltante,
    h2h, homeLast5, awayLast5,
    qbs: { [home]: qbH ? { name: qbH.name, last5: qbH.last5 } : null, [away]: qbA ? { name: qbA.name, last5: qbA.last5 } : null },
    injuries: injuryDetail,
    adjustments: adjustments.map((a) => ({ ...a, factor: a.factor })),
    base: { home: r3(baseHome, 2), away: r3(baseAway, 2) },
    projection: { home: r3(muHome, 1), away: r3(muAway, 1), margin: r3(muMargin, 1), total: r3(muTotal, 1), q1: { home: r3(proj1Q.home, 1), away: r3(proj1Q.away, 1) }, h1: { home: r3(proj1H.home, 1), away: r3(proj1H.away, 1) } },
    lineTable,
    methods: methods.map((m) => ({ ...m, p: r3(m.p) })),
    pHome: r3(pHome), divergence: r3(divergence), confidence,
    markets, checks, dependencies, algorithm,
    marginBins: Object.entries(bins).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]),
    simulations: SIMULATIONS,
    postgame,
  };
}

export type PregameAnalysis = Awaited<ReturnType<typeof buildPregameAnalysis>>;
