import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { WinProbabilityChart } from "@/components/WinProbabilityChart";

export const dynamic = "force-dynamic";

async function getGame(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { gameId },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!game) return null;

  const [plays, drives] = await Promise.all([
    prisma.play.findMany({
      where: { gameId },
      orderBy: { gameSecondsRemaining: "desc" },
      select: {
        quarter: true,
        gameSecondsRemaining: true,
        homeWinProbability: true,
        description: true,
      },
    }),
    prisma.drive.findMany({
      where: { gameId },
      orderBy: { driveNumber: "asc" },
    }),
  ]);

  const driveResults = new Map<string, number>();
  for (const d of drives) {
    const key = d.result ?? "Desconocido";
    driveResults.set(key, (driveResults.get(key) ?? 0) + 1);
  }

  return { game, plays, drives, driveResults };
}

export default async function GamePage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const data = await getGame(gameId);
  if (!data) notFound();
  const { game, plays, drives, driveResults } = data;

  const wpPoints = plays
    .filter((p) => p.gameSecondsRemaining !== null && p.homeWinProbability !== null)
    .map((p) => ({
      gameSecondsRemaining: p.gameSecondsRemaining as number,
      quarter: p.quarter,
      homeWinProbability: p.homeWinProbability as number,
      description: p.description,
    }));

  const maxDriveCount = Math.max(1, ...Array.from(driveResults.values()));

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface/60">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <Link href="/" className="text-xs text-muted hover:text-accent">
            ← DATAGSPORTS
          </Link>
          <h1 className="text-xl font-bold mt-2">
            {game.awayTeam.name} @ {game.homeTeam.name}
          </h1>
          <p className="text-sm text-muted">
            Temporada {game.season} · Semana {game.week} {game.gameType && game.gameType !== "REG" ? `· ${game.gameType}` : ""}
            {game.homeScore !== null && game.awayScore !== null && (
              <>
                {" "}
                · Final: {game.awayTeam.abbr} {game.awayScore} — {game.homeScore} {game.homeTeam.abbr}
              </>
            )}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10 flex flex-col gap-10">
        <section>
          <h2 className="text-lg font-semibold mb-1">Probabilidad de victoria</h2>
          <p className="text-sm text-muted mb-4">
            Cada punto es una jugada real. <code className="text-xs">homeWinProbability</code> viene precalculada por
            el modelo público de nflverse (un proceso de Markov sobre down/distancia/yardas/tiempo — sección 5.7.3
            del framework) y se guarda tal cual en la tabla <code className="text-xs">plays</code>.
          </p>
          <div className="bg-surface border border-border rounded-xl p-4">
            <WinProbabilityChart
              points={wpPoints}
              homeAbbr={game.homeTeam.abbr}
              awayAbbr={game.awayTeam.abbr}
              homeColor={game.homeTeam.primaryColor ?? "#3ddc84"}
              awayColor={game.awayTeam.primaryColor ?? "#8a97a8"}
            />
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-1">Posesiones (drives) — estados absorbentes de la cadena</h2>
          <p className="text-sm text-muted mb-4">
            {drives.length} posesiones en este partido. Cada una es una trayectoria de jugadas que termina en un
            resultado absorbente: touchdown, gol de campo, pérdida de balón, punto o fin de cuarto/mitad. Esta
            distribución, agregada sobre miles de partidos, es la que calibra el modelo de simulación de la sección
            5.4 del framework.
          </p>
          <div className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-2 mb-6">
            {Array.from(driveResults.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([result, count]) => (
                <div key={result} className="flex items-center gap-3 text-sm">
                  <span className="w-36 shrink-0 text-muted">{result}</span>
                  <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${(count / maxDriveCount) * 100}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-mono text-xs">{count}</span>
                </div>
              ))}
          </div>

          <div className="bg-surface border border-border rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted border-b border-border">
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Equipo</th>
                  <th className="px-3 py-2 font-medium">Q</th>
                  <th className="px-3 py-2 font-medium">Inicio</th>
                  <th className="px-3 py-2 font-medium">Fin</th>
                  <th className="px-3 py-2 font-medium text-right">Jugadas</th>
                  <th className="px-3 py-2 font-medium">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {drives.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-muted">{d.driveNumber}</td>
                    <td className="px-3 py-2 font-medium">{d.possessionTeamAbbr ?? "-"}</td>
                    <td className="px-3 py-2 text-muted">{d.quarterStart ?? "-"}</td>
                    <td className="px-3 py-2 text-muted">{d.startYardLine ?? "-"}</td>
                    <td className="px-3 py-2 text-muted">{d.endYardLine ?? "-"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{d.playCount ?? "-"}</td>
                    <td className="px-3 py-2">
                      <ResultBadge result={d.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function ResultBadge({ result }: { result: string | null }) {
  const scoring = result === "Touchdown" || result === "Field goal";
  const turnover = result === "Turnover" || result === "Turnover on downs" || result === "Safety";
  const color = scoring ? "text-accent" : turnover ? "text-red-400" : "text-muted";
  return <span className={`text-xs ${color}`}>{result ?? "-"}</span>;
}
