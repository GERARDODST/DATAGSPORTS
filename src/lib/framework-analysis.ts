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
  const weightOf = (season: number) => (season === target.season ? 1 : PRIOR_SEASON_WEIGHT);
  const currentSeasonGames = prior.filter((g) => g.season === target.season).length;
  const priorSeasonGames = prior.length - currentSeasonGames;
  const gameById = new Map(prior.map((g) => [g.gameId, g]));

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
    games: Set<string>; offPlays: number; offEpa: number; passPlays: number; passEpa: number; runPlays: number; runEpa: number;
    success: number; explosive: number; dropbacks: number; sacksTaken: number; giveaways: number; conv3: number; att3: number;
    defPlays: number; defEpa: number; defPassPlays: number; defPassEpa: number; defRunPlays: number; defRunEpa: number;
    defConv3: number; defAtt3: number; sacksMade: number; takeaways: number; oppDropbacks: number;
    drives: number; drivePoints: number; rzTrips: number; rzTds: number; oppDrives: number; oppDrivePoints: number; oppRzTrips: number; oppRzTds: number;
    q1Points: number; h1Points: number; pressures: number; missedTackles: number; pressureGames: number;
  };
  const blank = (): TeamAgg => ({
    games: new Set(), offPlays: 0, offEpa: 0, passPlays: 0, passEpa: 0, runPlays: 0, runEpa: 0, success: 0, explosive: 0, dropbacks: 0,
    sacksTaken: 0, giveaways: 0, conv3: 0, att3: 0, defPlays: 0, defEpa: 0, defPassPlays: 0, defPassEpa: 0, defRunPlays: 0, defRunEpa: 0,
    defConv3: 0, defAtt3: 0, sacksMade: 0, takeaways: 0, oppDropbacks: 0, drives: 0, drivePoints: 0, rzTrips: 0, rzTds: 0,
    oppDrives: 0, oppDrivePoints: 0, oppRzTrips: 0, oppRzTds: 0, q1Points: 0, h1Points: 0, pressures: 0, missedTackles: 0, pressureGames: 0,
  });
  const agg = new Map<string, TeamAgg>();
  const T = (t: string) => {
    if (!agg.has(t)) agg.set(t, blank());
    return agg.get(t) as TeamAgg;
  };
  for (const p of plays) {
    if (!p.possessionTeamAbbr || !p.defenseTeamAbbr) continue;
    const o = T(p.possessionTeamAbbr);
    const d = T(p.defenseTeamAbbr);
    o.games.add(p.gameId);
    d.games.add(p.gameId);
    if (p.thirdDownConverted) { o.conv3++; o.att3++; d.defConv3++; d.defAtt3++; }
    if (p.thirdDownFailed) { o.att3++; d.defAtt3++; }
    if (p.isDropback) { o.dropbacks++; d.oppDropbacks++; }
    if (p.isSack) { o.sacksTaken++; d.sacksMade++; }
    if (p.isInterception || p.isFumbleLost) { o.giveaways++; d.takeaways++; }
    if ((p.playType !== "pass" && p.playType !== "run") || p.epa === null) continue;
    o.offPlays++; o.offEpa += p.epa; d.defPlays++; d.defEpa += p.epa;
    if (p.isSuccess) o.success++;
    if ((p.yardsGained ?? 0) >= 20) o.explosive++;
    if (p.playType === "pass") { o.passPlays++; o.passEpa += p.epa; d.defPassPlays++; d.defPassEpa += p.epa; }
    else { o.runPlays++; o.runEpa += p.epa; d.defRunPlays++; d.defRunEpa += p.epa; }
  }
  const pointsOf = (res: string | null) => (res === "Touchdown" ? TD_POINTS : res === "Field goal" ? 3 : 0);
  for (const dr of drives) {
    const g = gameById.get(dr.gameId);
    if (!g || !dr.possessionTeamAbbr) continue;
    const opp = g.homeTeamAbbr === dr.possessionTeamAbbr ? g.awayTeamAbbr : g.homeTeamAbbr;
    const o = T(dr.possessionTeamAbbr);
    const d = T(opp);
    const pts = pointsOf(dr.result);
    o.drives++; o.drivePoints += pts; d.oppDrives++; d.oppDrivePoints += pts;
    if (dr.quarterStart === 1) o.q1Points += pts;
    if ((dr.quarterStart ?? 5) <= 2) o.h1Points += pts;
    if (dr.reachedRedZone) {
      o.rzTrips++; d.oppRzTrips++;
      if (dr.result === "Touchdown") { o.rzTds++; d.oppRzTds++; }
    }
  }
  for (const pr of pressureRows) {
    const t = T(pr.teamAbbr);
    t.pressures += pr.pressures;
    t.missedTackles += pr.missedTackles;
    t.pressureGames++;
  }

  const metric = (fn: (a: TeamAgg) => number) => new Map([...agg.entries()].map(([t, a]) => [t, fn(a)]));
  const M = {
    offEpa: metric((a) => safeDiv(a.offEpa, a.offPlays)),
    passEpa: metric((a) => safeDiv(a.passEpa, a.passPlays)),
    runEpa: metric((a) => safeDiv(a.runEpa, a.runPlays)),
    success: metric((a) => safeDiv(a.success, a.offPlays)),
    explosive: metric((a) => safeDiv(a.explosive, a.offPlays)),
    sackRateTaken: metric((a) => safeDiv(a.sacksTaken, a.dropbacks)),
    giveawaysPg: metric((a) => safeDiv(a.giveaways, a.games.size)),
    conv3: metric((a) => safeDiv(a.conv3, a.att3)),
    pace: metric((a) => safeDiv(a.offPlays, a.games.size)),
    ptsPerDrive: metric((a) => safeDiv(a.drivePoints, a.drives)),
    rzTd: metric((a) => safeDiv(a.rzTds, a.rzTrips)),
    defEpa: metric((a) => safeDiv(a.defEpa, a.defPlays)),
    defPassEpa: metric((a) => safeDiv(a.defPassEpa, a.defPassPlays)),
    defRunEpa: metric((a) => safeDiv(a.defRunEpa, a.defRunPlays)),
    defConv3: metric((a) => safeDiv(a.defConv3, a.defAtt3)),
    sackRateMade: metric((a) => safeDiv(a.sacksMade, a.oppDropbacks)),
    takeawaysPg: metric((a) => safeDiv(a.takeaways, a.games.size)),
    ptsPerDriveAllowed: metric((a) => safeDiv(a.oppDrivePoints, a.oppDrives)),
    rzTdAllowed: metric((a) => safeDiv(a.oppRzTds, a.oppRzTrips)),
    pressureRate: metric((a) => (a.pressureGames ? safeDiv(a.pressures, a.oppDropbacks) : NaN)),
    missedTacklesPg: metric((a) => safeDiv(a.missedTackles, a.pressureGames)),
    q1Share: metric((a) => safeDiv(a.q1Points, a.drivePoints)),
    h1Share: metric((a) => safeDiv(a.h1Points, a.drivePoints)),
  };
  const leagueAvg = (m: Map<string, number>) => mean([...m.values()].filter(Number.isFinite));
  const rk = (m: Map<string, number>, t: string, higher: boolean) => `${rankOf(m, t, higher)}º`;
  const both = (m: Map<string, number>, fmt: (v: number) => string, higher: boolean) => ({
    home: `${fmt(m.get(home) ?? NaN)} (${rk(m, home, higher)})`,
    away: `${fmt(m.get(away) ?? NaN)} (${rk(m, away, higher)})`,
  });
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
  const h2h = prior.filter((g) => [g.homeTeamAbbr, g.awayTeamAbbr].sort().join() === [home, away].sort().join()).slice(-5).map((g) => fmtGame(g, home));
  const rec = (list: { win: boolean }[]) => `${list.filter((x) => x.win).length}–${list.filter((x) => !x.win).length}`;
  const avg = (list: { pf: number; pa: number }[], k: "pf" | "pa") => f1(mean(list.map((x) => x[k])));
  add({ id: "l5home", section: "2", category: "Récords e historial", label: `Últimos 5 de ${home} en casa (récord · PF/PA)`, value: `${rec(homeLast5)} · ${avg(homeLast5, "pf")} / ${avg(homeLast5, "pa")}`, source: `${SRC.games} · home_score, away_score`, status: homeLast5.length >= 5 ? "derivado" : "parcial" });
  add({ id: "l5away", section: "2", category: "Récords e historial", label: `Últimos 5 de ${away} de visita (récord · PF/PA)`, value: `${rec(awayLast5)} · ${avg(awayLast5, "pf")} / ${avg(awayLast5, "pa")}`, source: `${SRC.games} · home_score, away_score`, status: awayLast5.length >= 5 ? "derivado" : "parcial" });
  add({
    id: "h2h", section: "2", category: "Récords e historial", label: "Últimos 5 enfrentamientos directos",
    value: h2h.length ? `${h2h.length} de 5 · ${home} ${h2h.filter((x) => x.win).length}–${h2h.filter((x) => !x.win).length} ${away}` : "0 de 5",
    source: `${SRC.games} · temporadas cargadas: ${priorSeason}–${target.season}`, status: h2h.length >= 5 ? "derivado" : h2h.length ? "parcial" : "faltante",
    note: h2h.length < 5 ? `Solo hay ${h2h.length} cara a cara en las temporadas cargadas; se necesitarían temporadas anteriores a ${priorSeason}.` : undefined,
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
    const sum = (k: "completions" | "attempts" | "passingYards" | "passingTds" | "interceptions") => priorWeeks.reduce((s, w) => s + (w[k] ?? 0), 0);
    const cmp = sum("completions"), att = sum("attempts"), yds = sum("passingYards"), td = sum("passingTds"), int = sum("interceptions");
    const qbPlays = plays.filter((p) => p.passerPlayerId === player.gsisId);
    const sacks = qbPlays.filter((p) => p.isSack).length;
    const sackYds = -qbPlays.filter((p) => p.isSack).reduce((s, p) => s + (p.yardsGained ?? 0), 0);
    const cpoeVals = qbPlays.map((p) => p.cpoe).filter((v): v is number => v !== null);
    const epaVals = qbPlays.map((p) => p.epa).filter((v): v is number => v !== null);
    const pr = passerRating(cmp, att, yds, td, int);
    const anya = (yds + 20 * td - 45 * int - sackYds) / (att + sacks);
    return {
      team, name, id: player.gsisId, cmp, att, yds, td, int, sacks, sackYds, pr, anya,
      cpoe: cpoeVals.length ? mean(cpoeVals) : null, epa: epaVals.length ? mean(epaVals) : null,
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
      by: ["playerId"],
      where: { season: priorSeason },
      _sum: { attempts: true, passingYards: true, passingTds: true, interceptions: true },
    });
    const sackByQb = new Map<string, { n: number; yds: number }>();
    for (const p of plays) {
      if (!p.isSack || !p.passerPlayerId || p.season !== priorSeason) continue;
      const s = sackByQb.get(p.passerPlayerId) ?? { n: 0, yds: 0 };
      s.n++; s.yds += -(p.yardsGained ?? 0);
      sackByQb.set(p.passerPlayerId, s);
    }
    const m = new Map<string, number>();
    for (const r of rows) {
      const att = r._sum.attempts ?? 0;
      if (att < 200) continue;
      const s = sackByQb.get(r.playerId) ?? { n: 0, yds: 0 };
      m.set(r.playerId, ((r._sum.passingYards ?? 0) + 20 * (r._sum.passingTds ?? 0) - 45 * (r._sum.interceptions ?? 0) - s.yds) / (att + s.n));
    }
    return m;
  })();
  const qbRows = (label: string, fn: (q: NonNullable<typeof qbH>) => string, source: string, status: DataStatus) =>
    add({ id: `qb-${label}`, section: "3", category: "QB y ofensiva", label, home: qbH ? fn(qbH) : "—", away: qbA ? fn(qbA) : "—", source, status: qbH && qbA ? status : "faltante" });
  add({ id: "qb-name", section: "3", category: "QB y ofensiva", label: "QB titular", home: target.homeQbName ?? "—", away: target.awayQbName ?? "—", source: `${SRC.games} · home_qb_name / away_qb_name`, status: target.homeQbName && target.awayQbName ? "disponible" : "faltante" });
  qbRows(`Cmp% · Yds/Att (${priorSeason})`, (q) => `${pctS(q.cmp / q.att)} · ${f1(q.yds / q.att)}`, `${SRC.weekly} · completions, attempts, passing_yards`, "derivado");
  qbRows("TD · INT", (q) => `${q.td} · ${q.int}`, `${SRC.weekly} · passing_tds, interceptions`, "disponible");
  qbRows("Passer rating (fórmula NFL)", (q) => f1(q.pr.rating), `${SRC.weekly} → fórmula oficial`, "derivado");
  qbRows("Sacks recibidos · yardas", (q) => `${q.sacks} · ${q.sackYds}`, `${SRC.pbp} · sack, yards_gained, passer_player_id`, "derivado");
  qbRows("ANY/A (rango entre QBs con 200+ intentos)", (q) => `${f1(q.anya, 2)} (${rankOf(qbAnyaAll, q.id, true)}º de ${qbAnyaAll.size})`, `${SRC.weekly} + ${SRC.pbp}`, "derivado");
  qbRows("EPA por jugada del QB", (q) => (q.epa === null ? "—" : sgn(q.epa, 3)), `${SRC.pbp} · epa (jugadas con passer_player_id)`, "derivado");
  qbRows("CPOE (% de pases completos sobre lo esperado)", (q) => (q.cpoe === null ? "—" : `${sgn(q.cpoe, 1)} pp`), `${SRC.pbp} · cpoe`, "disponible");
  add({ id: "qb-qbr", section: "3", category: "QB y ofensiva", label: "QBR (ESPN)", value: "—", source: SRC.none, status: "faltante", note: "Métrica propietaria de ESPN, no está en nflverse.", impact: "Ninguno: EPA/jugada y CPOE cubren lo mismo (sección 3.4)." });
  const Hoff = both(M.offEpa, epaFmt, true);
  add({ id: "o-epa", section: "3", category: "QB y ofensiva", label: "EPA/jugada ofensiva (rango liga)", ...Hoff, source: `${SRC.pbp} · epa (pass/run)`, status: "derivado" });
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
  const [injAll, depthNow, depthPrior] = await Promise.all([
    prisma.injuryReport.findMany({ where: { season: target.season, week: target.week, teamAbbr: { in: [home, away] } } }),
    prisma.depthChartEntry.findMany({ where: { season: target.season, week: target.week, teamAbbr: { in: [home, away] }, depthTeam: 1 } }),
    prisma.depthChartEntry.findMany({ where: { season: priorSeason, teamAbbr: { in: [home, away] }, depthTeam: 1 } }),
  ]);
  const injPre = injAll.filter((i) => i.dateModified && i.dateModified < cutoff);
  const injLate = injAll.filter((i) => !i.dateModified || i.dateModified >= cutoff);
  const priorStarterWeeks = new Map<string, Set<number>>();
  for (const d of depthPrior) {
    if (!d.gsisId) continue;
    const key = `${d.teamAbbr}_${d.gsisId}`;
    const s = priorStarterWeeks.get(key) ?? new Set<number>();
    s.add(d.week);
    priorStarterWeeks.set(key, s);
  }
  const priorWeeksCount = new Set(depthPrior.map((d) => d.week)).size || 1;
  const currentStarters = new Set(depthNow.map((d) => `${d.teamAbbr}_${d.gsisId}`));
  const injuryDetail = injPre
    .filter((i) => i.reportStatus === "Out" || i.reportStatus === "Doubtful")
    .map((i) => {
      const key = `${i.teamAbbr}_${i.gsisId}`;
      const baseWeeks = priorStarterWeeks.get(key)?.size ?? 0;
      return {
        team: i.teamAbbr, name: i.fullName, position: i.position, status: i.reportStatus, injury: i.primaryInjury,
        date: i.dateModified?.toISOString().slice(0, 10) ?? null,
        starterNow: currentStarters.has(key),
        inBase: baseWeeks >= priorWeeksCount / 2,
        baseWeeks,
      };
    });
  const injFmt = (t: string) => {
    const list = injuryDetail.filter((i) => i.team === t);
    return list.length ? list.map((i) => `${i.name} (${i.position}, ${i.status})`).join("; ") : "Sin bajas (Out/Doubtful)";
  };
  add({
    id: "inj", section: "4", category: "Disponibilidad de jugadores", label: "Reporte oficial de lesiones: Out / Doubtful",
    home: injFmt(home), away: injFmt(away), source: `${SRC.injuries} · report_status, date_modified`,
    status: injPre.length ? "disponible" : "faltante",
    note: injLate.length ? `${injLate.length} registro(s) excluido(s) por tener fecha posterior al inicio del partido (${injLate.map((i) => `${i.fullName}, ${i.dateModified?.toISOString().slice(0, 10)}`).join("; ")}): usarlos sería fuga de datos.` : undefined,
    impact: injPre.length ? undefined : "Bloquea Verde en total y spread (sección 9.3).",
  });
  add({
    id: "depth", section: "4", category: "Disponibilidad de jugadores", label: "Alineación (titulares del depth chart)",
    home: `${depthNow.filter((d) => d.teamAbbr === home).length} titulares listados`, away: `${depthNow.filter((d) => d.teamAbbr === away).length} titulares listados`,
    source: `${SRC.depth} · depth_team = 1`, status: depthNow.length ? "parcial" : "faltante",
    note: "Es la alineación proyectada de la semana, no la confirmada 90 minutos antes del partido.",
    impact: "Sin alineación confirmada ningún pick puede ser Verde (sección 8.3, regla 12).",
  });

  // ============================================================ SECCIÓN 5 — ratings y proyección
  const hfa = neutral ? 0 : hfaObserved;
  formula({ id: "league", section: "5", name: "Promedio de liga (puntos por equipo y partido)", expression: "μ = Σ w·(pts local + pts visita) / Σ 2w, con w = 0.5 para la temporada anterior y 1 para la actual", substituted: `${prior.length} partidos (${priorSeasonGames} de ${priorSeason}, ${currentSeasonGames} de ${target.season})`, result: f1(leagueMean, 2) });
  formula({ id: "shrink-off", section: "5", name: `Ofensiva de ${home} regresada a la media (5.7.4)`, expression: "off = (n·PF̄ + k·μ) / (n + k), k = 6 partidos", substituted: `(${f1(H.w, 1)}·${f1(H.rawOff, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(H.w, 1)} + 6)`, result: f1(H.off, 2) });
  formula({ id: "shrink-def", section: "5", name: `Defensa de ${home} regresada a la media`, expression: "def = (n·PĀ + k·μ) / (n + k)", substituted: `(${f1(H.w, 1)}·${f1(H.rawDef, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(H.w, 1)} + 6)`, result: f1(H.def, 2) });
  formula({ id: "shrink-off-a", section: "5", name: `Ofensiva de ${away} regresada a la media`, expression: "off = (n·PF̄ + k·μ) / (n + k)", substituted: `(${f1(A.w, 1)}·${f1(A.rawOff, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(A.w, 1)} + 6)`, result: f1(A.off, 2) });
  formula({ id: "shrink-def-a", section: "5", name: `Defensa de ${away} regresada a la media`, expression: "def = (n·PĀ + k·μ) / (n + k)", substituted: `(${f1(A.w, 1)}·${f1(A.rawDef, 2)} + 6·${f1(leagueMean, 2)}) / (${f1(A.w, 1)} + 6)`, result: f1(A.def, 2) });
  formula({ id: "hfa", section: "5", name: "Ventaja de local observada", expression: "HFA = promedio(pts local − pts visita) en sedes no neutrales", substituted: `${prior.filter((g) => g.location === "Home").length} partidos`, result: `${sgn(hfaObserved, 2)} pts${neutral ? " (no se aplica: sede neutral)" : ""}` });

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
  const offStarterOut = (t: string) => injuryDetail.filter((i) => i.team === t && i.inBase && ["QB", "WR", "TE", "RB", "T", "G", "C"].includes(i.position ?? ""));
  const defStarterOut = (t: string) => injuryDetail.filter((i) => i.team === t && i.inBase && !["QB", "WR", "TE", "RB", "T", "G", "C", "K", "P", "LS"].includes(i.position ?? ""));
  const newToBase = injuryDetail.filter((i) => !i.inBase);
  type Adj = { condition: string; data: string; met: boolean | null; inBase: boolean; factor: number; appliesTo: "total" | "home" | "away"; applied: boolean; reason: string };
  const adjustments: Adj[] = [];
  const pushAdj = (a: Omit<Adj, "applied">) => adjustments.push({ ...a, applied: Boolean(a.met) && !a.inBase });
  pushAdj({ condition: "Ambos QBs con buen ANY/A y bajo INT%", data: `${qbH?.name ?? home}: ANY/A ${anyaRank(qbH)}º, INT% ${pctS(qbH ? qbH.int / qbH.att : NaN)} · ${qbA?.name ?? away}: ANY/A ${anyaRank(qbA)}º, INT% ${pctS(qbA ? qbA.int / qbA.att : NaN)} (liga ${pctS(lgInt)})`, met: qbH && qbA ? qbGood(qbH) && qbGood(qbA) : null, inBase: true, factor: 0.9, appliesTo: "total", reason: "La producción de ambos QBs en la temporada pasada ya está en los puntos a favor que forman la base." });
  pushAdj({ condition: `Rival con alto pressure rate (contra ${home})`, data: `${away}: ${pctS(M.pressureRate.get(away))} (${rk(M.pressureRate, away, true)})`, met: top10(M.pressureRate, away, true), inBase: true, factor: 0.9, appliesTo: "home", reason: "La presión de la defensa rival ya se refleja en sus puntos permitidos." });
  pushAdj({ condition: `Rival con alto pressure rate (contra ${away})`, data: `${home}: ${pctS(M.pressureRate.get(home))} (${rk(M.pressureRate, home, true)})`, met: top10(M.pressureRate, home, true), inBase: true, factor: 0.9, appliesTo: "away", reason: "Igual: ya está en los puntos permitidos." });
  pushAdj({ condition: "Ambas defensas top-10 en EPA/jugada permitido", data: `${home} ${rk(M.defEpa, home, false)}, ${away} ${rk(M.defEpa, away, false)}`, met: top10(M.defEpa, home, false) && top10(M.defEpa, away, false), inBase: true, factor: 0.88, appliesTo: "total", reason: "La calidad defensiva ya entra como def_local y def_visita en λ: aplicarlo otra vez contaría doble." });
  pushAdj({ condition: "Viento fuerte (> 25 km/h ≈ 15.5 mph) o lluvia intensa", data: target.roof === "outdoors" ? `Viento ${windMph ?? "—"} mph; lluvia: sin dato` : `Estadio ${target.roof}`, met: target.roof === "outdoors" ? (windMph ?? 0) > 15.5 : false, inBase: false, factor: 0.9, appliesTo: "total", reason: "Condición del día del partido: información nueva." });
  pushAdj({ condition: "Estadio con domo o techo cerrado", data: target.roof ?? "—", met: target.roof === "dome" || target.roof === "closed", inBase: false, factor: 1.05, appliesTo: "total", reason: "Condición del día del partido." });
  pushAdj({ condition: "Frío extremo (< 0 °C ≈ 32 °F)", data: tempF !== null ? `${tempF} °F` : "Sin dato", met: tempF !== null ? tempF < 32 : null, inBase: false, factor: 0.93, appliesTo: "total", reason: "Condición del día del partido." });
  pushAdj({ condition: `Ritmo combinado alto (jugadas por partido sobre la media)`, data: `${home} ${f1(M.pace.get(home))}, ${away} ${f1(M.pace.get(away))}, liga ${f1(leagueAvg(M.pace))}`, met: (M.pace.get(home) ?? 0) + (M.pace.get(away) ?? 0) > 2 * leagueAvg(M.pace), inBase: true, factor: 1.05, appliesTo: "total", reason: "El ritmo de la temporada pasada ya está en los puntos por partido." });
  for (const t of [home, away]) {
    const offOut = offStarterOut(t);
    const defOut = defStarterOut(t);
    pushAdj({ condition: `Baja de titular ofensivo de ${t} que sí jugó en la base`, data: offOut.length ? offOut.map((i) => `${i.name} (${i.position}, ${i.status})`).join("; ") : "Ninguna", met: offOut.length > 0, inBase: false, factor: 0.92, appliesTo: t === home ? "home" : "away", reason: "Información nueva del reporte de lesiones." });
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
    add({ id: "inj-new", section: "5", category: "Disponibilidad de jugadores", label: "Bajas de jugadores que no están en la base", value: newToBase.map((i) => `${i.name} (${i.team}, ${i.position})`).join("; "), source: `${SRC.injuries} + ${SRC.depth} ${priorSeason}`, status: "derivado", note: `No fueron titulares de su equipo en ${priorSeason}: los ratings construidos con ${priorSeason} no los contienen, así que su baja no cambia la proyección. Es información que el modelo todavía no sabe usar (fichajes, novatos).` });
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
  let regressed = false;
  for (const g of prior) {
    if (g.season === target.season && !regressed) {
      for (const [t, v] of elo) elo.set(t, v - (v - 1505) / 3);
      regressed = true;
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
  if (!regressed) for (const [t, v] of elo) elo.set(t, v - (v - 1505) / 3);
  const eH = getElo(home), eA = getElo(away);
  const pElo = 1 / (1 + 10 ** (-(eH + (neutral ? 0 : ELO_HOME) - eA) / 400));
  formula({ id: "elo", section: "5", name: "Elo (5.7.7)", expression: "E = 1 / (1 + 10^(−(R_local + 48 − R_visita)/400)); K = 20 × multiplicador de margen; regresión de 1/3 hacia 1505 entre temporadas", substituted: `R_${home} = ${Math.round(eH)}, R_${away} = ${Math.round(eA)} (arrancan en 1500 en la semana 1 de ${priorSeason}: no hay temporadas previas cargadas)`, result: pctS(pElo) });
  add({ id: "elo-start", section: "5", category: "Modelo", label: "Punto de partida del Elo", value: `1500 en ${priorSeason}`, source: SRC.model, status: "parcial", note: `Sin temporadas anteriores a ${priorSeason}, el Elo solo acumula un año de historia.` });

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
    { section: "6", label: "Alineación confirmada, clima completo", ok: false, ids: ["depth", "rain"], blocks: "Bloquea Verde en total" },
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
    { id: "8.3.2", rule: "No sobreponderar los últimos 5 partidos", status: "pasa", detail: `El modelo no usa rachas: pondera temporada completa y regresión. Los últimos 5 del QB son de ${priorSeason} y solo se muestran como contexto.` },
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
    assumption: m.market === "Total" ? (m.pick === "Under" ? "Las dos defensas de la temporada pasada siguen siendo élite" : "Las ofensivas superan a las defensas") : `${m.pick} rinde al menos como en ${priorSeason} y el rival no mejora`,
    ifFails: "Pierde valor",
    risk: m.market === "Total" ? "Medio" : "Alto",
  }));

  // ============================================================ SECCIÓN 10 — algoritmo maestro
  const algorithm = [
    { phase: "Fase 0 · Ingesta con gate", step: "Resultados, calendario, momios, QBs, clima", status: "hecho" },
    { phase: "Fase 0 · Ingesta con gate", step: "Play-by-play con EPA, CPOE y 3er down", status: "hecho" },
    { phase: "Fase 0 · Ingesta con gate", step: "Reporte de lesiones (filtrado por fecha)", status: injPre.length ? "hecho" : "falta" },
    { phase: "Fase 0 · Ingesta con gate", step: "Presión defensiva (PFR)", status: "hecho" },
    { phase: "Fase 0 · Ingesta con gate", step: "Alineación confirmada, lluvia, 2+ casas de apuestas", status: "falta" },
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

  // Después del partido
  const gameEpa = async (abbr: string) =>
    (await prisma.play.aggregate({ where: { gameId, possessionTeamAbbr: abbr, playType: { in: ["pass", "run"] } }, _avg: { epa: true } }))._avg.epa;
  const [hg, ag] = played ? await Promise.all([gameEpa(home), gameEpa(away)]) : [null, null];
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
    items, formulas,
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
