/**
 * Estado y marcador de los partidos desde ESPN (marcador final apenas termina el partido; nflverse
 * tarda horas o días). También guarda la línea que ESPN publica para los partidos por jugar.
 *
 * Uso: npm run data:scores                    (de hace 4 días a dentro de 8)
 *      npm run data:scores -- --from=20261008 --to=20261013
 *      npm run data:scores -- --file=espn.json        (respuesta guardada del scoreboard)
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { prisma } from "../src/lib/prisma";
import { matchGame, parseEspnScoreboard } from "../src/lib/odds";
import { applyOdds, networkHint, saveSnapshots } from "../src/lib/odds-db";

const HOST = "site.api.espn.com";
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];

async function main() {
  const now = new Date();
  const from = arg("from") ?? ymd(new Date(now.getTime() - 4 * 86400000));
  const to = arg("to") ?? ymd(new Date(now.getTime() + 8 * 86400000));
  console.log(`\n=== Marcadores y estado (ESPN) · ${from}–${to} ===\n`);
  let json: unknown;
  const file = arg("file");
  try {
    if (file) json = JSON.parse(await readFile(file, "utf8")); // respuesta guardada (prueba o carga manual)
    else {
      const res = await fetch(`https://${HOST}/apis/site/v2/sports/football/nfl/scoreboard?dates=${from}-${to}&limit=200`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    }
  } catch (e) {
    console.warn(file ? `No se pudo leer ${file}: ${e}` : networkHint(HOST, e));
    return;
  }
  const events = parseEspnScoreboard(json as Parameters<typeof parseEspnScoreboard>[0]);
  const games = (await prisma.game.findMany({ where: { season: { gte: 2026 } }, select: { gameId: true, homeTeamAbbr: true, awayTeamAbbr: true, gameDate: true, homeScore: true, awayScore: true, scoreSource: true } }))
    .map((g) => ({ ...g, home: g.homeTeamAbbr, away: g.awayTeamAbbr }));
  const fetchedAt = new Date();
  let finals = 0, live = 0, pre = 0, unmatched = 0;
  const oddsItems: { gameId: string; rows: NonNullable<(typeof events)[number]["odds"]>[] }[] = [];
  for (const ev of events) {
    const g = matchGame(games, ev.home, ev.away, ev.kickoff);
    if (!g) { unmatched++; console.log(`   sin pareja en nflverse: ${ev.away} @ ${ev.home} ${ev.kickoff.toISOString()}`); continue; }
    const base = { kickoff: ev.kickoff, status: ev.state, statusDetail: ev.detail };
    if (ev.state === "post" && ev.completed && ev.homeScore !== null && ev.awayScore !== null) {
      // Marcador final: cuenta como resultado. Si nflverse ya lo tenía, se deja su fuente.
      const keep = g.homeScore !== null && g.scoreSource !== "ESPN";
      await prisma.game.update({
        where: { gameId: g.gameId },
        data: { ...base, liveHomeScore: null, liveAwayScore: null, ...(keep ? {} : { homeScore: ev.homeScore, awayScore: ev.awayScore, scoreSource: "ESPN", scoreUpdatedAt: fetchedAt }) },
      });
      if (!keep && (g.homeScore !== ev.homeScore || g.awayScore !== ev.awayScore)) console.log(`   final: ${g.gameId} ${ev.away} ${ev.awayScore} – ${ev.homeScore} ${ev.home}`);
      finals++;
    } else if (ev.state === "in") {
      // En juego: el marcador se muestra pero NO es resultado (el modelo no aprende de él).
      await prisma.game.update({ where: { gameId: g.gameId }, data: { ...base, liveHomeScore: ev.homeScore, liveAwayScore: ev.awayScore } });
      live++;
    } else {
      await prisma.game.update({ where: { gameId: g.gameId }, data: base });
      if (ev.odds && ev.kickoff > fetchedAt) oddsItems.push({ gameId: g.gameId, rows: [ev.odds] });
      pre++;
    }
  }
  const saved = await saveSnapshots("ESPN", fetchedAt, oddsItems);
  const applied = await applyOdds(oddsItems.map((x) => x.gameId));
  console.log(`   ${events.length} partidos de ESPN: ${finals} finales, ${live} en juego, ${pre} por jugar${unmatched ? `, ${unmatched} sin pareja` : ""}`);
  console.log(`   líneas de ESPN guardadas: ${saved} · partidos con momios recalculados: ${applied}\n`);
}

main()
  .catch((err) => { console.error("Error actualizando marcadores:", err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
