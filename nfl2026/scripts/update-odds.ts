/**
 * Momios actuales de varias casas con The Odds API (https://the-odds-api.com).
 *
 * Requiere ODDS_API_KEY en nfl2026/.env. Cada consulta cuesta (mercados × regiones) créditos:
 * por defecto 3 mercados × 1 región = 3 créditos; el plan gratis da 500 al mes.
 *
 * Solo se guardan partidos que todavía no empiezan: el momio en vivo no sirve para un pick previo.
 *
 * Uso: npm run data:odds
 *      ODDS_API_REGIONS=us,us2,eu npm run data:odds        (más casas, más créditos)
 *      ODDS_API_BOOKMAKERS=draftkings,fanduel npm run data:odds
 *      npm run data:odds -- --file=odds.json          (respuesta guardada de /odds)
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { prisma } from "../src/lib/prisma";
import { matchGame, parseOddsApi } from "../src/lib/odds";
import { applyOdds, networkHint, saveSnapshots } from "../src/lib/odds-db";

const HOST = "api.the-odds-api.com";

async function main() {
  console.log("\n=== Momios actuales (The Odds API) ===\n");
  const file = process.argv.find((a) => a.startsWith("--file="))?.split("=")[1];
  const now = process.argv.find((a) => a.startsWith("--now="))?.split("=")[1]; // solo para pruebas con respuestas guardadas
  const key = process.env.ODDS_API_KEY;
  if (!key && !file) {
    console.warn("   Falta ODDS_API_KEY en nfl2026/.env (clave gratis en https://the-odds-api.com). Se continúa con los momios que ya hay.");
    return;
  }
  const params = new URLSearchParams({ apiKey: key ?? "", markets: "h2h,spreads,totals", oddsFormat: "american", dateFormat: "iso" });
  if (process.env.ODDS_API_BOOKMAKERS) params.set("bookmakers", process.env.ODDS_API_BOOKMAKERS);
  else params.set("regions", process.env.ODDS_API_REGIONS ?? "us");
  let events: unknown;
  if (file) events = JSON.parse(await readFile(file, "utf8"));
  else try {
    const res = await fetch(`https://${HOST}/v4/sports/americanfootball_nfl/odds/?${params}`);
    const remaining = res.headers.get("x-requests-remaining"), used = res.headers.get("x-requests-used");
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    events = await res.json();
    console.log(`   créditos usados ${used ?? "—"} · restantes ${remaining ?? "—"}`);
  } catch (e) {
    console.warn(networkHint(HOST, e));
    return;
  }
  const teams = await prisma.team.findMany({ select: { abbr: true, name: true } });
  const { parsed, unknownTeams } = parseOddsApi(events as Parameters<typeof parseOddsApi>[0], new Map(teams.map((t) => [t.name, t.abbr])));
  if (unknownTeams.length) console.log(`   equipos sin pareja: ${unknownTeams.join(", ")}`);
  const games = (await prisma.game.findMany({ where: { season: { gte: 2026 } }, select: { gameId: true, homeTeamAbbr: true, awayTeamAbbr: true, gameDate: true, homeScore: true, status: true } }))
    .map((g) => ({ ...g, home: g.homeTeamAbbr, away: g.awayTeamAbbr }));
  const fetchedAt = now ? new Date(now) : new Date();
  const items: { gameId: string; rows: (typeof parsed)[number]["rows"] }[] = [];
  let started = 0;
  for (const ev of parsed) {
    if (ev.commence <= fetchedAt) { started++; continue; }
    const g = matchGame(games, ev.home, ev.away, ev.commence);
    if (!g || g.homeScore !== null) continue;
    await prisma.game.update({ where: { gameId: g.gameId }, data: { kickoff: ev.commence } });
    items.push({ gameId: g.gameId, rows: ev.rows });
  }
  const saved = await saveSnapshots("The Odds API", fetchedAt, items);
  const applied = await applyOdds(items.map((x) => x.gameId));
  const books = new Set(items.flatMap((x) => x.rows.map((r) => r.book)));
  console.log(`   ${parsed.length} partidos · ${started} ya empezaron (se ignoran) · ${saved} momios de ${books.size} casas guardados · ${applied} partidos con consenso nuevo\n`);
}

main()
  .catch((err) => { console.error("Error actualizando momios:", err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
