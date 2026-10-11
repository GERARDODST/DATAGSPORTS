/**
 * Momios actuales de varias casas (The Odds API) y marcador/estado en vivo (ESPN).
 *
 * Funciones puras (sin red ni base de datos) para leer las respuestas de cada fuente, emparejarlas
 * con los partidos de nflverse, calcular el consenso del mercado, el mejor momio disponible por
 * lado y el movimiento de línea. Los scripts update-odds.ts y update-scores.ts hacen la red y la base.
 *
 * Convenciones:
 *  - nflverse: spread_line positivo = el local es favorito (spreadLine = −spreadHome de las casas).
 *  - Casas: el punto del spread del local es negativo cuando da puntos (−3.5).
 */

export type OddsRow = {
  book: string;
  lastUpdate: Date | null;
  homeMl: number | null; awayMl: number | null;
  spreadHome: number | null; homeSpreadOdds: number | null; awaySpreadOdds: number | null;
  total: number | null; overOdds: number | null; underOdds: number | null;
};
export type EventOdds = { home: string; away: string; commence: Date; rows: OddsRow[] };

// ------------------------------------------------------------ The Odds API (/v4/sports/americanfootball_nfl/odds)
type OddsApiOutcome = { name: string; price: number; point?: number };
type OddsApiEvent = {
  id: string; commence_time: string; home_team: string; away_team: string;
  bookmakers?: { key: string; title: string; last_update?: string; markets?: { key: string; outcomes: OddsApiOutcome[] }[] }[];
};

/** teamByName: nombre completo de nflverse ("Kansas City Chiefs") → abreviatura ("KC"). */
export function parseOddsApi(events: OddsApiEvent[], teamByName: Map<string, string>): { parsed: EventOdds[]; unknownTeams: string[] } {
  const unknown = new Set<string>();
  const parsed: EventOdds[] = [];
  for (const e of events) {
    const home = teamByName.get(e.home_team), away = teamByName.get(e.away_team);
    if (!home) unknown.add(e.home_team);
    if (!away) unknown.add(e.away_team);
    if (!home || !away) continue;
    const rows: OddsRow[] = [];
    for (const b of e.bookmakers ?? []) {
      const m = (k: string) => b.markets?.find((x) => x.key === k)?.outcomes ?? [];
      const h2h = m("h2h"), sp = m("spreads"), to = m("totals");
      const by = (list: OddsApiOutcome[], name: string) => list.find((o) => o.name === name);
      const row: OddsRow = {
        book: b.title || b.key,
        lastUpdate: b.last_update ? new Date(b.last_update) : null,
        homeMl: by(h2h, e.home_team)?.price ?? null,
        awayMl: by(h2h, e.away_team)?.price ?? null,
        spreadHome: by(sp, e.home_team)?.point ?? null,
        homeSpreadOdds: by(sp, e.home_team)?.price ?? null,
        awaySpreadOdds: by(sp, e.away_team)?.price ?? null,
        total: by(to, "Over")?.point ?? null,
        overOdds: by(to, "Over")?.price ?? null,
        underOdds: by(to, "Under")?.price ?? null,
      };
      if ([row.homeMl, row.spreadHome, row.total].some((v) => v !== null)) rows.push(row);
    }
    parsed.push({ home, away, commence: new Date(e.commence_time), rows });
  }
  return { parsed, unknownTeams: [...unknown] };
}

// ------------------------------------------------------------ ESPN (site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard)
/** Abreviaturas de ESPN que difieren de nflverse. */
export const ESPN_ABBR: Record<string, string> = { WSH: "WAS", LAR: "LA" };
const espnAbbr = (a: string) => ESPN_ABBR[a] ?? a;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /^ev(en)?$/i.test(v.trim())) return 100;
  const n = Number(String(v).replace(/[^\d.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
type EspnTeamSide = { homeAway: "home" | "away"; score?: string; team: { abbreviation: string } };
type EspnOdds = {
  provider?: { name?: string }; details?: string; overUnder?: number; spread?: number;
  homeTeamOdds?: { moneyLine?: number; spreadOdds?: number }; awayTeamOdds?: { moneyLine?: number; spreadOdds?: number };
  moneyline?: { home?: { close?: { odds?: string } }; away?: { close?: { odds?: string } } };
  pointSpread?: { home?: { close?: { line?: string; odds?: string } }; away?: { close?: { line?: string; odds?: string } } };
  total?: { over?: { close?: { line?: string; odds?: string } }; under?: { close?: { line?: string; odds?: string } } };
};
type EspnEvent = {
  id: string; date: string;
  status?: { type?: { state?: string; completed?: boolean; detail?: string; shortDetail?: string } };
  competitions?: { competitors?: EspnTeamSide[]; odds?: EspnOdds[]; status?: EspnEvent["status"] }[];
};
export type EspnGame = {
  espnId: string; home: string; away: string; kickoff: Date;
  state: "pre" | "in" | "post"; completed: boolean; detail: string | null;
  homeScore: number | null; awayScore: number | null; odds: OddsRow | null;
};

export function parseEspnScoreboard(json: { events?: EspnEvent[] }): EspnGame[] {
  const out: EspnGame[] = [];
  for (const e of json.events ?? []) {
    const c = e.competitions?.[0];
    const side = (k: "home" | "away") => c?.competitors?.find((x) => x.homeAway === k);
    const h = side("home"), a = side("away");
    if (!h || !a) continue;
    const st = c?.status?.type ?? e.status?.type ?? {};
    const state = (st.state === "in" || st.state === "post" ? st.state : "pre") as EspnGame["state"];
    let odds: OddsRow | null = null;
    const o = c?.odds?.[0];
    if (o) {
      // Formato clásico (moneyLine/spread/overUnder) o el nuevo con apertura/cierre por mercado.
      // "details" dice quién da los puntos ("KC -3.5", "EVEN"): es la forma menos ambigua de orientar el spread.
      const det = /^\s*([A-Z]{2,4})\s+([+-]?\d+(?:\.\d+)?)\s*$/.exec(o.details ?? "");
      const fromDetails = det ? (espnAbbr(det[1]) === espnAbbr(h.team.abbreviation) ? Number(det[2]) : -Number(det[2])) : /^(even|pk|pick)/i.test(o.details ?? "") ? 0 : null;
      const spreadHome = num(o.pointSpread?.home?.close?.line) ?? fromDetails ?? (typeof o.spread === "number" ? o.spread : null);
      odds = {
        book: o.provider?.name ?? "ESPN",
        lastUpdate: null,
        homeMl: num(o.moneyline?.home?.close?.odds) ?? num(o.homeTeamOdds?.moneyLine),
        awayMl: num(o.moneyline?.away?.close?.odds) ?? num(o.awayTeamOdds?.moneyLine),
        spreadHome,
        homeSpreadOdds: num(o.pointSpread?.home?.close?.odds) ?? num(o.homeTeamOdds?.spreadOdds),
        awaySpreadOdds: num(o.pointSpread?.away?.close?.odds) ?? num(o.awayTeamOdds?.spreadOdds),
        total: num(o.total?.over?.close?.line) ?? (typeof o.overUnder === "number" ? o.overUnder : null),
        overOdds: num(o.total?.over?.close?.odds),
        underOdds: num(o.total?.under?.close?.odds),
      };
      if ([odds.homeMl, odds.spreadHome, odds.total].every((v) => v === null)) odds = null;
    }
    out.push({
      espnId: e.id, home: espnAbbr(h.team.abbreviation), away: espnAbbr(a.team.abbreviation), kickoff: new Date(e.date),
      state, completed: Boolean(st.completed), detail: st.shortDetail ?? st.detail ?? null,
      homeScore: num(h.score), awayScore: num(a.score), odds,
    });
  }
  return out;
}

// ------------------------------------------------------------ Emparejar con nflverse
type GameKey = { gameId: string; home: string; away: string; gameDate: Date | null };
/** Mismo local y visitante, y la fecha (hora del Este) a no más de 1 día de la de nflverse. */
export function matchGame<T extends GameKey>(games: T[], home: string, away: string, kickoff: Date): T | null {
  const etDay = new Date(kickoff.getTime() - 4 * 3600 * 1000).toISOString().slice(0, 10);
  const day = Date.parse(etDay);
  const cands = games.filter((g) => g.home === home && g.away === away && g.gameDate && Math.abs(g.gameDate.getTime() - day) <= 86400000 * 1.01);
  return cands.sort((x, y) => Math.abs((x.gameDate as Date).getTime() - day) - Math.abs((y.gameDate as Date).getTime() - day))[0] ?? null;
}

// ------------------------------------------------------------ Consenso, mejor momio y movimiento
const implied = (a: number) => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
const american = (p: number) => (p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));
const payout = (a: number) => (a < 0 ? 100 / -a : a / 100);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const roundHalf = (v: number) => Math.round(v * 2) / 2;
/** Precio de consenso: mediana de las probabilidades implícitas, devuelta como momio americano. */
const medianPrice = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? american(median(v.map(implied))) : null; };
const best = (rows: OddsRow[], f: (r: OddsRow) => number | null) => {
  let top: { price: number; book: string } | null = null;
  for (const r of rows) { const p = f(r); if (p !== null && (!top || payout(p) > payout(top.price))) top = { price: p, book: r.book }; }
  return top;
};

export type Consensus = {
  books: number;
  homeMl: number | null; awayMl: number | null;
  spreadLine: number | null; homeSpreadOdds: number | null; awaySpreadOdds: number | null; // spreadLine en convención nflverse
  totalLine: number | null; overOdds: number | null; underOdds: number | null;
  best: Record<"homeMl" | "awayMl" | "homeSpread" | "awaySpread" | "over" | "under", { price: number; book: string } | null>;
};

/** Consenso con la última fila de cada casa. Línea = mediana; precios = mediana entre las casas que ofrecen esa línea. */
export function consensus(rows: OddsRow[]): Consensus | null {
  if (!rows.length) return null;
  const spreads = rows.filter((r) => r.spreadHome !== null).map((r) => r.spreadHome as number);
  const totals = rows.filter((r) => r.total !== null).map((r) => r.total as number);
  const sp = spreads.length ? roundHalf(median(spreads)) : null;
  const to = totals.length ? roundHalf(median(totals)) : null;
  const atSp = rows.filter((r) => r.spreadHome === sp);
  const atTo = rows.filter((r) => r.total === to);
  return {
    books: new Set(rows.map((r) => r.book)).size,
    homeMl: medianPrice(rows.map((r) => r.homeMl)), awayMl: medianPrice(rows.map((r) => r.awayMl)),
    spreadLine: sp === null ? null : -sp,
    homeSpreadOdds: medianPrice(atSp.map((r) => r.homeSpreadOdds)), awaySpreadOdds: medianPrice(atSp.map((r) => r.awaySpreadOdds)),
    totalLine: to, overOdds: medianPrice(atTo.map((r) => r.overOdds)), underOdds: medianPrice(atTo.map((r) => r.underOdds)),
    best: {
      homeMl: best(rows, (r) => r.homeMl), awayMl: best(rows, (r) => r.awayMl),
      homeSpread: best(atSp, (r) => r.homeSpreadOdds), awaySpread: best(atSp, (r) => r.awaySpreadOdds),
      over: best(atTo, (r) => r.overOdds), under: best(atTo, (r) => r.underOdds),
    },
  };
}

/** Última fila de cada casa (antes de `until`). */
export function latestPerBook<T extends OddsRow & { fetchedAt: Date }>(rows: T[], until = new Date(8.64e15)): T[] {
  const byBook = new Map<string, T>();
  for (const r of rows) {
    if (r.fetchedAt > until) continue;
    const prev = byBook.get(r.book);
    if (!prev || r.fetchedAt > prev.fetchedAt) byBook.set(r.book, r);
  }
  return [...byBook.values()];
}
