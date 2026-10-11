/**
 * Guarda momios por casa y recalcula los momios del partido (consenso, mejor momio y primera línea
 * registrada). Solo toca partidos que no han empezado: el pick se decide con lo que había antes de
 * la patada y un momio en vivo no sirve para eso.
 */
import { prisma } from "./prisma";
import { consensus, latestPerBook, type OddsRow } from "./odds";

export async function saveSnapshots(source: string, fetchedAt: Date, items: { gameId: string; rows: OddsRow[] }[]) {
  const data = items.flatMap(({ gameId, rows }) => rows.map((r) => ({ gameId, source, fetchedAt, ...r })));
  if (data.length) await prisma.oddsSnapshot.createMany({ data });
  return data.length;
}

/** Vuelve a calcular los momios de los partidos indicados a partir de su historial de snapshots. */
export async function applyOdds(gameIds: string[]) {
  let updated = 0;
  for (const gameId of gameIds) {
    const g = await prisma.game.findUnique({ where: { gameId } });
    if (!g || g.homeScore !== null || g.status === "in" || g.status === "post") continue;
    const snaps = await prisma.oddsSnapshot.findMany({ where: { gameId }, orderBy: { fetchedAt: "asc" } });
    if (!snaps.length) continue;
    // Varias casas (The Odds API) mandan sobre una sola línea (ESPN).
    const preferred = snaps.some((s) => s.source === "The Odds API") ? snaps.filter((s) => s.source === "The Odds API") : snaps;
    const latest = latestPerBook(preferred);
    const c = consensus(latest);
    if (!c) continue;
    const at = latest.reduce((m, r) => (r.fetchedAt > m ? r.fetchedAt : m), latest[0].fetchedAt);
    // Primera línea registrada: la de nflverse si ya la había, si no la de la primera consulta.
    let oddsOpen = g.oddsOpen as Record<string, unknown> | null;
    if (!oddsOpen) {
      if (g.spreadLine !== null || g.totalLine !== null) {
        oddsOpen = { spread: g.spreadLine, total: g.totalLine, homeMl: g.homeMoneyline, awayMl: g.awayMoneyline, at: (g.oddsUpdatedAt ?? null)?.toISOString?.() ?? null, source: g.oddsSource ?? "nflverse" };
      } else {
        const first = preferred.filter((s) => s.fetchedAt.getTime() === preferred[0].fetchedAt.getTime());
        const c0 = consensus(first);
        oddsOpen = { spread: c0?.spreadLine ?? null, total: c0?.totalLine ?? null, homeMl: c0?.homeMl ?? null, awayMl: c0?.awayMl ?? null, at: preferred[0].fetchedAt.toISOString(), source: preferred[0].source };
      }
    }
    await prisma.game.update({
      where: { gameId },
      data: {
        homeMoneyline: c.homeMl, awayMoneyline: c.awayMl,
        spreadLine: c.spreadLine, homeSpreadOdds: c.homeSpreadOdds, awaySpreadOdds: c.awaySpreadOdds,
        totalLine: c.totalLine, overOdds: c.overOdds, underOdds: c.underOdds,
        oddsSource: preferred[0].source, oddsUpdatedAt: at, oddsBooks: c.books,
        bestOdds: c.best, oddsOpen: oddsOpen as object,
      },
    });
    updated++;
  }
  return updated;
}

/** Aviso claro cuando la red del entorno no deja llegar a una fuente. */
export function networkHint(host: string, err: unknown) {
  return `No se pudo consultar ${host} (${err instanceof Error ? err.message : String(err)}). ` +
    `Si estás en Claude Code en la nube, agrega ${host} en Network access → Allowed domains del entorno. Se continúa con los datos que ya hay.`;
}
