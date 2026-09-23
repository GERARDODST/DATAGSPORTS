import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const SEASON = 2024;

async function getData() {
  const [teams, recentGames, upcomingGames, statLeaders, totals] = await Promise.all([
    prisma.team.findMany({
      where: { players: { some: {} } },
      orderBy: { abbr: "asc" },
    }),
    prisma.game.findMany({
      where: { season: SEASON, homeScore: { not: null } },
      orderBy: [{ week: "desc" }, { gameDate: "desc" }],
      take: 8,
      include: { homeTeam: true, awayTeam: true },
    }),
    prisma.game.findMany({
      where: { season: SEASON, homeScore: null },
      orderBy: [{ week: "asc" }, { gameDate: "asc" }],
      take: 6,
      include: { homeTeam: true, awayTeam: true },
    }),
    prisma.playerWeekStat.groupBy({
      by: ["playerId"],
      where: { season: SEASON },
      _sum: { fantasyPointsPpr: true },
      orderBy: { _sum: { fantasyPointsPpr: "desc" } },
      take: 10,
    }),
    Promise.all([
      prisma.team.count(),
      prisma.player.count(),
      prisma.game.count({ where: { season: SEASON } }),
      prisma.playerWeekStat.count({ where: { season: SEASON } }),
    ]),
  ]);

  const leaderIds = statLeaders.map((s) => s.playerId);
  const leaderPlayers = await prisma.player.findMany({
    where: { gsisId: { in: leaderIds } },
    include: { team: true },
  });
  const leaderMap = new Map(leaderPlayers.map((p) => [p.gsisId, p]));
  const leaders = statLeaders
    .map((s) => ({
      player: leaderMap.get(s.playerId),
      points: s._sum.fantasyPointsPpr ?? 0,
    }))
    .filter((l) => l.player);

  const [teamCount, playerCount, gameCount, statCount] = totals;

  return { teams, recentGames, upcomingGames, leaders, teamCount, playerCount, gameCount, statCount };
}

export default async function Home() {
  const { teams, recentGames, upcomingGames, leaders, teamCount, playerCount, gameCount, statCount } =
    await getData();

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface/60">
        <div className="mx-auto max-w-6xl px-6 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              DATAG<span className="text-accent">SPORTS</span>
            </h1>
            <p className="text-sm text-muted">Pronósticos de NFL con análisis matemático y estadístico</p>
          </div>
          <div className="hidden sm:flex gap-6 text-sm text-muted">
            <Stat label="Equipos" value={teamCount} />
            <Stat label="Jugadores" value={playerCount} />
            <Stat label="Partidos" value={gameCount} />
            <Stat label="Stats semana-jugador" value={statCount} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10 flex flex-col gap-12">
        <section>
          <SectionTitle
            title="Resultados recientes"
            subtitle={`Temporada ${SEASON} · ${recentGames.length} partidos`}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {recentGames.map((g) => (
              <GameCard key={g.gameId} game={g} />
            ))}
          </div>
        </section>

        {upcomingGames.length > 0 && (
          <section>
            <SectionTitle title="Próximos partidos" subtitle={`Temporada ${SEASON}`} />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {upcomingGames.map((g) => (
                <GameCard key={g.gameId} game={g} />
              ))}
            </div>
          </section>
        )}

        <section>
          <SectionTitle
            title="Líderes de la temporada"
            subtitle="Fantasy points (PPR) acumulados — cruce de datos de jugadores + partidos"
          />
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted border-b border-border">
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">Jugador</th>
                  <th className="px-4 py-3 font-medium">Pos</th>
                  <th className="px-4 py-3 font-medium">Equipo</th>
                  <th className="px-4 py-3 font-medium text-right">Fantasy pts (PPR)</th>
                </tr>
              </thead>
              <tbody>
                {leaders.map((l, i) => (
                  <tr key={l.player!.gsisId} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-muted">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">{l.player!.fullName}</td>
                    <td className="px-4 py-3 text-muted">{l.player!.position ?? "-"}</td>
                    <td className="px-4 py-3 text-muted">{l.player!.teamAbbr ?? "-"}</td>
                    <td className="px-4 py-3 text-right font-mono text-accent">
                      {l.points.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <SectionTitle title="Equipos" subtitle={`${teams.length} equipos activos con jugadores cargados`} />
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-3">
            {teams.map((t) => (
              <div
                key={t.abbr}
                className="bg-surface border border-border rounded-lg p-3 flex flex-col items-center gap-2 text-center"
                style={{ borderTopColor: t.primaryColor ?? undefined, borderTopWidth: t.primaryColor ? 3 : 1 }}
              >
                {t.logoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={t.logoUrl} alt={t.name} className="h-8 w-8 object-contain" />
                )}
                <span className="text-xs text-muted">{t.abbr}</span>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border mt-10">
        <div className="mx-auto max-w-6xl px-6 py-6 text-xs text-muted">
          Datos: nflverse-data (nflverse-data.readthedocs.io). Herramienta de análisis estadístico — no garantiza
          resultados.
        </div>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-right">
      <div className="text-foreground font-semibold">{value.toLocaleString("es-MX")}</div>
      <div className="text-[11px] uppercase tracking-wide">{label}</div>
    </div>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
    </div>
  );
}

type GameWithTeams = {
  gameId: string;
  week: number;
  gameType: string | null;
  homeScore: number | null;
  awayScore: number | null;
  homeTeam: { abbr: string; name: string; logoUrl: string | null };
  awayTeam: { abbr: string; name: string; logoUrl: string | null };
};

function GameCard({ game }: { game: GameWithTeams }) {
  const played = game.homeScore !== null && game.awayScore !== null;
  const homeWon = played && (game.homeScore as number) > (game.awayScore as number);
  const awayWon = played && (game.awayScore as number) > (game.homeScore as number);

  return (
    <Link
      href={`/partidos/${game.gameId}`}
      className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-3 hover:border-accent transition-colors"
    >
      <div className="flex items-center justify-between text-[11px] text-muted uppercase tracking-wide">
        <span>
          Semana {game.week} {game.gameType && game.gameType !== "REG" ? `· ${game.gameType}` : ""}
        </span>
        {played && <span className="text-accent">Ver jugadas →</span>}
      </div>
      <TeamRow abbr={game.awayTeam.abbr} name={game.awayTeam.name} score={game.awayScore} winner={awayWon} />
      <TeamRow abbr={game.homeTeam.abbr} name={game.homeTeam.name} score={game.homeScore} winner={homeWon} />
    </Link>
  );
}

function TeamRow({
  abbr,
  name,
  score,
  winner,
}: {
  abbr: string;
  name: string;
  score: number | null;
  winner: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex flex-col">
        <span className={`text-sm ${winner ? "font-semibold text-foreground" : "text-muted"}`}>{abbr}</span>
        <span className="text-[11px] text-muted">{name}</span>
      </div>
      <span className={`font-mono text-lg ${winner ? "text-accent font-bold" : "text-muted"}`}>
        {score ?? "-"}
      </span>
    </div>
  );
}
