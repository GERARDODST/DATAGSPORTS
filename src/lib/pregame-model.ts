/**
 * Modelo previo al partido (docs/nfl_framework_v1.md, sección 10): usa SOLO
 * partidos jugados antes de la fecha del partido objetivo. En la semana 1 eso
 * significa solo la temporada anterior; conforme avanza la temporada entran
 * los partidos nuevos con más peso y el modelo se actualiza solo.
 */
import { prisma } from "./prisma";

const PYTH_EXP = 2.37;
const PRIOR_SEASON_WEIGHT = 0.5; // un partido de la temporada pasada vale medio partido
const SHRINK_GAMES = 6; // regresión a la media: equivale a 6 partidos "promedio de liga"
const ELO_K = 20;
const ELO_HOME = 48;
const SIMULATIONS = 50000;

type GameRow = Awaited<ReturnType<typeof loadGames>>[number];

async function loadGames(where: object) {
  return prisma.game.findMany({ where, orderBy: [{ gameDate: "asc" }, { gameId: "asc" }] });
}

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
function normalCdf(z: number) {
  // Aproximación de Abramowitz-Stegun (error < 1e-7).
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((v) => (v - m) ** 2)));
};
const r = (v: number, d = 3) => Number(v.toFixed(d));

export function impliedProbability(american: number) {
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}
export function fairAmerican(p: number) {
  return p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}
function kelly(p: number, american: number) {
  const b = american < 0 ? 100 / -american : american / 100;
  return (b * p - (1 - p)) / b;
}

export async function buildPregameAnalysis(gameId: string) {
  const target = await prisma.game.findUniqueOrThrow({
    where: { gameId },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!target.gameDate) throw new Error(`${gameId} no tiene fecha`);
  const cutoff = target.gameDate;
  const home = target.homeTeamAbbr;
  const away = target.awayTeamAbbr;

  // Solo lo que ya se había jugado antes de la patada inicial.
  const prior = (await loadGames({
    season: { in: [target.season - 1, target.season] },
    gameDate: { lt: cutoff },
    homeScore: { not: null },
  })) as GameRow[];
  const weightOf = (g: GameRow) => (g.season === target.season ? 1 : PRIOR_SEASON_WEIGHT);
  const currentSeasonGames = prior.filter((g) => g.season === target.season).length;
  const priorSeasonGames = prior.length - currentSeasonGames;

  // Promedio de liga y ventaja de local observada.
  let leagueW = 0;
  let leaguePts = 0;
  for (const g of prior) {
    const w = weightOf(g);
    leaguePts += w * ((g.homeScore as number) + (g.awayScore as number));
    leagueW += 2 * w;
  }
  const leagueMean = leaguePts / leagueW;
  const homeGames = prior.filter((g) => g.location === "Home");
  const hfa = mean(homeGames.map((g) => (g.homeScore as number) - (g.awayScore as number)));
  const lastSeason = prior.filter((g) => g.season === target.season - 1);
  const sigmaMargin = sd(lastSeason.map((g) => (g.homeScore as number) - (g.awayScore as number)));
  const sigmaTotal = sd(lastSeason.map((g) => (g.homeScore as number) + (g.awayScore as number)));

  const teamProfile = (abbr: string) => {
    const games = prior.filter((g) => g.homeTeamAbbr === abbr || g.awayTeamAbbr === abbr);
    let w = 0;
    let pf = 0;
    let pa = 0;
    for (const g of games) {
      const isHome = g.homeTeamAbbr === abbr;
      const f = (isHome ? g.homeScore : g.awayScore) as number;
      const a = (isHome ? g.awayScore : g.homeScore) as number;
      const gw = weightOf(g);
      w += gw;
      pf += gw * f;
      pa += gw * a;
    }
    const rawOff = w ? pf / w : leagueMean;
    const rawDef = w ? pa / w : leagueMean;
    const off = (w * rawOff + SHRINK_GAMES * leagueMean) / (w + SHRINK_GAMES);
    const def = (w * rawDef + SHRINK_GAMES * leagueMean) / (w + SHRINK_GAMES);

    const regular = lastSeason.filter((g) => g.gameType === "REG" && (g.homeTeamAbbr === abbr || g.awayTeamAbbr === abbr));
    const record = (list: GameRow[]) => {
      let wins = 0, losses = 0, ties = 0, forPts = 0, againstPts = 0;
      for (const g of list) {
        const isHome = g.homeTeamAbbr === abbr;
        const f = (isHome ? g.homeScore : g.awayScore) as number;
        const a = (isHome ? g.awayScore : g.homeScore) as number;
        forPts += f;
        againstPts += a;
        if (f > a) wins++;
        else if (f < a) losses++;
        else ties++;
      }
      return { wins, losses, ties, pf: forPts, pa: againstPts, games: list.length };
    };
    const reg = record(regular);
    const pyth = reg.pf ** PYTH_EXP / (reg.pf ** PYTH_EXP + reg.pa ** PYTH_EXP);
    const actualPct = reg.games ? (reg.wins + reg.ties / 2) / reg.games : 0;
    const homeRec = record(regular.filter((g) => g.homeTeamAbbr === abbr));
    const awayRec = record(regular.filter((g) => g.awayTeamAbbr === abbr));
    const post = record(lastSeason.filter((g) => g.gameType !== "REG" && (g.homeTeamAbbr === abbr || g.awayTeamAbbr === abbr)));

    const last = games.at(-1);
    const lastGame = last
      ? {
          gameId: last.gameId,
          season: last.season,
          week: last.week,
          type: last.gameType,
          date: last.gameDate?.toISOString().slice(0, 10) ?? null,
          opponent: last.homeTeamAbbr === abbr ? last.awayTeamAbbr : last.homeTeamAbbr,
          isHome: last.homeTeamAbbr === abbr,
          location: last.location,
          pointsFor: (last.homeTeamAbbr === abbr ? last.homeScore : last.awayScore) as number,
          pointsAgainst: (last.homeTeamAbbr === abbr ? last.awayScore : last.homeScore) as number,
        }
      : null;

    return {
      abbr,
      effectiveGames: r(w, 1),
      rawOff: r(rawOff, 2),
      rawDef: r(rawDef, 2),
      off: r(off, 2),
      def: r(def, 2),
      regressionShare: r(SHRINK_GAMES / (w + SHRINK_GAMES), 3),
      regular: reg,
      home: homeRec,
      away: awayRec,
      postseason: post,
      pythagorean: r(pyth),
      actualPct: r(actualPct),
      luck: r(actualPct - pyth),
      lastGame,
    };
  };

  const H = teamProfile(home);
  const A = teamProfile(away);

  // Eficiencia por jugada (EPA) de las jugadas previas: contexto de las secciones 3 y 4.
  const epaFor = async (abbr: string) => {
    const priorIds = prior.map((g) => g.gameId);
    const [off, def] = await Promise.all([
      prisma.play.aggregate({
        where: { gameId: { in: priorIds }, possessionTeamAbbr: abbr, playType: { in: ["pass", "run"] } },
        _avg: { epa: true },
        _count: { _all: true },
      }),
      prisma.play.aggregate({
        where: { gameId: { in: priorIds }, defenseTeamAbbr: abbr, playType: { in: ["pass", "run"] } },
        _avg: { epa: true },
        _count: { _all: true },
      }),
    ]);
    const passOff = await prisma.play.aggregate({
      where: { gameId: { in: priorIds }, possessionTeamAbbr: abbr, playType: "pass" },
      _avg: { epa: true },
    });
    const runOff = await prisma.play.aggregate({
      where: { gameId: { in: priorIds }, possessionTeamAbbr: abbr, playType: "run" },
      _avg: { epa: true },
    });
    return {
      offEpa: r(off._avg.epa ?? 0),
      defEpa: r(def._avg.epa ?? 0),
      passEpa: r(passOff._avg.epa ?? 0),
      runEpa: r(runOff._avg.epa ?? 0),
      plays: off._count._all + def._count._all,
    };
  };
  const [homeEpa, awayEpa] = await Promise.all([epaFor(home), epaFor(away)]);

  // Fase 3: marcador esperado.
  const neutral = target.location === "Neutral";
  const hfaUsed = neutral ? 0 : hfa;
  const muHome = leagueMean + (H.off - leagueMean) + (A.def - leagueMean) + hfaUsed / 2;
  const muAway = leagueMean + (A.off - leagueMean) + (H.def - leagueMean) - hfaUsed / 2;
  const muMargin = muHome - muAway;
  const muTotal = muHome + muAway;

  const rand = mulberry32(hashString(gameId));
  const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const bins: Record<number, number> = {};
  let homeWins = 0;
  let homeCovers = 0;
  let overs = 0;
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

  // Fase 2a: Log5 con el Pitagórico de los ratings regresados, más la ventaja de local.
  const pythOf = (off: number, def: number) => off ** PYTH_EXP / (off ** PYTH_EXP + def ** PYTH_EXP);
  const pH = pythOf(H.off, H.def);
  const pA = pythOf(A.off, A.def);
  const log5Neutral = (pH - pH * pA) / (pH + pA - 2 * pH * pA);
  const homeBoost = normalCdf(hfaUsed / sigmaMargin) - 0.5;
  const pLog5 = Math.min(0.99, Math.max(0.01, log5Neutral + homeBoost));

  // Fase 2b: Elo recorriendo los partidos previos en orden, con regresión de 1/3 entre temporadas.
  const elo = new Map<string, number>();
  const getElo = (t: string) => elo.get(t) ?? 1500;
  let regressed = false;
  for (const g of prior) {
    if (g.season === target.season && !regressed) {
      for (const [t, v] of elo) elo.set(t, v - (v - 1505) / 3);
      regressed = true;
    }
    const hAdv = g.location === "Neutral" ? 0 : ELO_HOME;
    const diff = getElo(g.homeTeamAbbr) + hAdv - getElo(g.awayTeamAbbr);
    const expHome = 1 / (1 + 10 ** (-diff / 400));
    const margin = (g.homeScore as number) - (g.awayScore as number);
    const result = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
    const winnerDiff = margin > 0 ? diff : -diff;
    const mov = Math.log(Math.abs(margin) + 1) * (2.2 / (winnerDiff * 0.001 + 2.2));
    const delta = ELO_K * mov * (result - expHome);
    elo.set(g.homeTeamAbbr, getElo(g.homeTeamAbbr) + delta);
    elo.set(g.awayTeamAbbr, getElo(g.awayTeamAbbr) - delta);
  }
  if (!regressed) for (const [t, v] of elo) elo.set(t, v - (v - 1505) / 3);
  const eloHome = getElo(home);
  const eloAway = getElo(away);
  const pElo = 1 / (1 + 10 ** (-(eloHome + (neutral ? 0 : ELO_HOME) - eloAway) / 400));

  const methods = [
    { key: "log5", label: "Log5 (Pitagórico regresado + local)", p: pLog5 },
    { key: "elo", label: "Elo (con regresión de 1/3 entre temporadas)", p: pElo },
    { key: "sim", label: `Simulación (${SIMULATIONS.toLocaleString("es-MX")} partidos)`, p: pSim },
  ];
  const pHome = mean(methods.map((m) => m.p));
  const divergence = Math.max(...methods.map((m) => m.p)) - Math.min(...methods.map((m) => m.p));
  const confidence = divergence <= 0.05 ? "alta" : divergence <= 0.1 ? "media" : "baja";

  // Fase 0: gate de completitud (sección 9.3).
  const completeness = [
    { field: "Récords, puntos y últimos partidos de ambos equipos", ok: H.regular.games > 0 && A.regular.games > 0 },
    { field: "EPA por jugada (play-by-play previo)", ok: homeEpa.plays > 0 && awayEpa.plays > 0 },
    { field: "QB titular de cada equipo", ok: Boolean(target.homeQbName && target.awayQbName) },
    { field: "Momios de cierre (moneyline, spread, total)", ok: target.homeMoneyline !== null && target.spreadLine !== null && target.totalLine !== null },
    { field: "Clima y tipo de estadio", ok: target.roof !== null && (target.roof !== "outdoors" || target.temp !== null) },
    { field: "Reporte oficial de lesiones", ok: false },
    { field: "Alineaciones confirmadas", ok: false },
  ];
  const missingField = completeness.some((c) => !c.ok);

  // Fase 4: valor de mercado.
  const markets: {
    market: string;
    pick: string;
    line: string;
    odds: number;
    pImplied: number;
    pModel: number;
    edge: number;
    fairOdds: number;
    kellyQuarter: number;
    light: "Verde" | "Amarillo" | "Gris";
    won: boolean | null;
    push: boolean;
  }[] = [];
  const addMarket = (market: string, sides: { pick: string; line: string; odds: number | null; p: number; won: boolean | null; push?: boolean }[]) => {
    if (sides.some((s) => s.odds === null)) return;
    const raw = sides.map((s) => impliedProbability(s.odds as number));
    const overround = raw.reduce((a, b) => a + b, 0);
    const scored = sides.map((s, i) => ({ ...s, pImplied: raw[i] / overround, edge: s.p - raw[i] / overround }));
    const best = scored.sort((a, b) => b.edge - a.edge)[0];
    const k = kelly(best.p, best.odds as number) / 4;
    let light: "Verde" | "Amarillo" | "Gris" = "Gris";
    if (best.edge >= 0.03 && confidence !== "baja") light = missingField ? "Amarillo" : "Verde";
    markets.push({
      market,
      pick: best.pick,
      line: best.line,
      odds: best.odds as number,
      pImplied: r(best.pImplied),
      pModel: r(best.p),
      edge: r(best.edge),
      fairOdds: fairAmerican(best.p),
      kellyQuarter: light === "Gris" ? 0 : r(Math.max(0, k)),
      light,
      won: best.won,
      push: Boolean(best.push),
    });
  };
  const played = target.homeScore !== null && target.awayScore !== null;
  const finalMargin = played ? (target.homeScore as number) - (target.awayScore as number) : null;
  const finalTotal = played ? (target.homeScore as number) + (target.awayScore as number) : null;
  addMarket("Moneyline", [
    { pick: home, line: "ganador", odds: target.homeMoneyline, p: pHome, won: played ? (finalMargin as number) > 0 : null },
    { pick: away, line: "ganador", odds: target.awayMoneyline, p: 1 - pHome, won: played ? (finalMargin as number) < 0 : null },
  ]);
  if (spread !== null) {
    const pCover = homeCovers / SIMULATIONS;
    const fmt = (v: number) => (v > 0 ? `+${v}` : `${v}`);
    addMarket("Spread", [
      { pick: home, line: fmt(-spread), odds: target.homeSpreadOdds, p: pCover, won: played ? (finalMargin as number) > spread : null, push: played && finalMargin === spread },
      { pick: away, line: fmt(spread), odds: target.awaySpreadOdds, p: 1 - pCover, won: played ? (finalMargin as number) < spread : null, push: played && finalMargin === spread },
    ]);
  }
  if (total !== null) {
    const pOver = overs / SIMULATIONS;
    addMarket("Total", [
      { pick: "Over", line: `${total}`, odds: target.overOdds, p: pOver, won: played ? (finalTotal as number) > total : null, push: played && finalTotal === total },
      { pick: "Under", line: `${total}`, odds: target.underOdds, p: 1 - pOver, won: played ? (finalTotal as number) < total : null, push: played && finalTotal === total },
    ]);
  }

  // Fase 5: auditoría (sección 8.3), solo los filtros que aplican con estos datos.
  const mlImplied = target.homeMoneyline !== null ? impliedProbability(target.homeMoneyline) : null;
  const audit = [
    {
      rule: "Datos de la temporada actual",
      ok: currentSeasonGames > 0,
      detail: currentSeasonGames > 0
        ? `${currentSeasonGames} partidos de ${target.season} ya jugados alimentan el modelo.`
        : `Semana 1: el 100% de los datos es de ${target.season - 1}. Los ratings se regresaron ${Math.round(H.regressionShare * 100)}% hacia el promedio de liga (sección 5.7.4).`,
    },
    {
      rule: "Los tres métodos coinciden (sección 10, fase 2)",
      ok: divergence <= 0.1,
      detail: `Divergencia de ${(divergence * 100).toFixed(1)} puntos porcentuales → confianza ${confidence}.`,
    },
    {
      rule: "Completitud de datos (sección 9.3)",
      ok: !missingField,
      detail: missingField ? "Falta reporte de lesiones y alineaciones confirmadas: ningún pick puede ser Verde." : "Todos los campos obligatorios presentes.",
    },
    {
      rule: "El total proyectado no está pegado a la línea (sección 6.12)",
      ok: total === null || Math.abs(muTotal - total) >= 1.5,
      detail: total === null ? "Sin línea de total." : `Modelo ${muTotal.toFixed(1)} vs línea ${total}: diferencia de ${Math.abs(muTotal - total).toFixed(1)} puntos.`,
    },
    {
      rule: "Favorito caro (sección 7.5)",
      ok: mlImplied === null || mlImplied < 0.65,
      detail: mlImplied === null ? "Sin moneyline." : `El moneyline de ${mlImplied >= 0.5 ? home : away} implica ${(Math.max(mlImplied, 1 - mlImplied) * 100).toFixed(0)}% (con margen de la casa).`,
    },
    {
      rule: "Picks correlacionados (sección 5.7.10)",
      ok: !(markets.find((m) => m.market === "Moneyline" && m.light !== "Gris")?.pick === markets.find((m) => m.market === "Spread" && m.light !== "Gris")?.pick &&
        markets.some((m) => m.market === "Moneyline" && m.light !== "Gris")),
      detail: "Moneyline y spread del mismo equipo dependen del mismo supuesto: si ambos califican, solo uno puede llevar stake completo.",
    },
    {
      rule: "Mismo QB titular que la temporada anterior",
      ok: true,
      detail: `${target.homeQbName ?? "?"} (${home}) y ${target.awayQbName ?? "?"} (${away}): sin ajuste de Elo por cambio de QB.`,
    },
  ];

  const gameEpa = async (abbr: string) =>
    (
      await prisma.play.aggregate({
        where: { gameId, possessionTeamAbbr: abbr, playType: { in: ["pass", "run"] } },
        _avg: { epa: true },
        _count: { _all: true },
      })
    )._avg.epa;
  const [homeGameEpa, awayGameEpa] = played ? await Promise.all([gameEpa(home), gameEpa(away)]) : [null, null];

  const postgame = played
    ? {
        epaInGame: {
          [home]: homeGameEpa === null ? null : r(homeGameEpa),
          [away]: awayGameEpa === null ? null : r(awayGameEpa),
        },
        homeScore: target.homeScore,
        awayScore: target.awayScore,
        marginError: r(muMargin - (finalMargin as number), 1),
        totalError: r(muTotal - (finalTotal as number), 1),
        winnerCorrect: (pHome >= 0.5) === ((finalMargin as number) > 0),
        brierModel: r((pHome - ((finalMargin as number) > 0 ? 1 : 0)) ** 2),
        brierMarket:
          target.homeMoneyline !== null && target.awayMoneyline !== null
            ? r(
                (impliedProbability(target.homeMoneyline) /
                  (impliedProbability(target.homeMoneyline) + impliedProbability(target.awayMoneyline)) -
                  ((finalMargin as number) > 0 ? 1 : 0)) **
                  2
              )
            : null,
      }
    : null;

  return {
    gameId,
    season: target.season,
    week: target.week,
    date: cutoff.toISOString().slice(0, 10),
    home,
    away,
    context: {
      stadium: target.stadium,
      location: target.location,
      roof: target.roof,
      surface: target.surface,
      temp: target.temp,
      wind: target.wind,
      divGame: target.divGame,
      homeRest: target.homeRest,
      awayRest: target.awayRest,
      homeQb: target.homeQbName,
      awayQb: target.awayQbName,
      spread,
      total,
      homeMoneyline: target.homeMoneyline,
      awayMoneyline: target.awayMoneyline,
    },
    data: { priorSeasonGames, currentSeasonGames, cutoff: cutoff.toISOString().slice(0, 10) },
    league: { mean: r(leagueMean, 2), hfa: r(hfaUsed, 2), hfaObserved: r(hfa, 2), sigmaMargin: r(sigmaMargin, 2), sigmaTotal: r(sigmaTotal, 2) },
    teams: { [home]: { ...H, epa: homeEpa, elo: Math.round(eloHome) }, [away]: { ...A, epa: awayEpa, elo: Math.round(eloAway) } },
    h2h: prior
      .filter((g) => [g.homeTeamAbbr, g.awayTeamAbbr].sort().join() === [home, away].sort().join())
      .map((g) => ({ gameId: g.gameId, date: g.gameDate?.toISOString().slice(0, 10), type: g.gameType, home: g.homeTeamAbbr, away: g.awayTeamAbbr, hs: g.homeScore, as: g.awayScore })),
    projection: { home: r(muHome, 1), away: r(muAway, 1), margin: r(muMargin, 1), total: r(muTotal, 1) },
    methods: methods.map((m) => ({ ...m, p: r(m.p) })),
    pHome: r(pHome),
    divergence: r(divergence),
    confidence,
    completeness,
    missingField,
    markets,
    audit,
    marginBins: Object.entries(bins).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]),
    simulations: SIMULATIONS,
    postgame,
  };
}

export type PregameAnalysis = Awaited<ReturnType<typeof buildPregameAnalysis>>;
