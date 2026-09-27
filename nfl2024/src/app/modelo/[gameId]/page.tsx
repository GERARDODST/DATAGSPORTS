import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  buildFieldPositionEpModel,
  bucketFor,
  bucketLabel,
  ownEpaForPlay,
} from "@/lib/expected-points";
import { EpByFieldPositionChart, type HighlightPoint } from "@/components/EpByFieldPositionChart";

export const dynamic = "force-dynamic";

async function getData(gameId: string) {
  const game = await prisma.game.findUnique({
    where: { gameId },
    include: { homeTeam: true, awayTeam: true },
  });
  if (!game) return null;

  const model = await buildFieldPositionEpModel(game.season);

  const firstDownPlays = await prisma.play.findMany({
    where: { gameId, down: 1, yardLine100: { not: null } },
    orderBy: { gameSecondsRemaining: "desc" },
    select: {
      id: true,
      quarter: true,
      possessionTeamAbbr: true,
      yardLine100: true,
      yardsGained: true,
      isTouchdown: true,
      isInterception: true,
      isFumbleLost: true,
      epa: true,
      description: true,
    },
  });

  const rows = firstDownPlays.map((p) => ({
    ...p,
    ...ownEpaForPlay(model, { ...p, yardLine100: p.yardLine100 as number }),
  }));

  const highlights: HighlightPoint[] = firstDownPlays
    .filter((p) => p.yardLine100 !== null)
    .map((p) => ({
      bucket: bucketFor(p.yardLine100 as number),
      label: bucketLabel(bucketFor(p.yardLine100 as number)),
      playDescription: p.description,
    }));

  return { game, model, rows, highlights };
}

export default async function ModeloPage({ params }: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await params;
  const data = await getData(gameId);
  if (!data) notFound();
  const { game, model, rows, highlights } = data;
  const maxValue = Math.max(...model.map((b) => b.avgExpectedPoints ?? 0)) * 1.1;

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-surface/60">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <div className="flex items-center gap-3 text-xs text-muted">
            <Link href="/" className="hover:text-accent">
              DATAGSPORTS
            </Link>
            <span>/</span>
            <Link href={`/partidos/${game.gameId}`} className="hover:text-accent">
              {game.awayTeam.abbr} @ {game.homeTeam.abbr}
            </Link>
            <span>/ construcción del modelo</span>
          </div>
          <h1 className="text-xl font-bold mt-2">Construyendo el modelo de Puntos Esperados (EP)</h1>
          <p className="text-sm text-muted">
            Temporada {game.season} · caso de estudio: {game.awayTeam.name} @ {game.homeTeam.name}
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10 flex flex-col gap-10">
        <section className="bg-surface border border-border rounded-xl p-5">
          <h2 className="text-lg font-semibold mb-2">1. ¿Qué estamos construyendo?</h2>
          <p className="text-sm text-muted leading-relaxed">
            El framework (sección 5.7.3) dice que EP es la función de valor de una cadena de Markov sobre estados
            <code className="text-xs mx-1">(down, distancia, yardlínea, tiempo)</code>. Aquí construimos la versión
            más simple posible de esa función, con datos reales en vez de teoría: <strong>tomamos todas las jugadas
            de 1er down de la temporada {game.season}</strong>, las agrupamos por posición de campo, y calculamos
            cuántos puntos anotó en promedio el equipo con el balón antes de que terminara esa posesión. Eso es
            <code className="text-xs mx-1">EP(yardlínea)</code>.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-1">2. El modelo, calculado en vivo sobre {game.season}</h2>
          <p className="text-sm text-muted mb-4">
            {model.reduce((s, b) => s + b.sampleSize, 0).toLocaleString("es-MX")} jugadas de 1er down agrupadas en
            {" "}
            {model.length} tramos de 5 yardas. Las barras resaltadas marcan en qué tramo cayeron las jugadas de 1er
            down de <strong>{game.awayTeam.abbr} @ {game.homeTeam.abbr}</strong> — pasa el cursor para verlas.
          </p>
          <div className="bg-surface border border-border rounded-xl p-4">
            <EpByFieldPositionChart model={model} maxValue={maxValue} highlights={highlights} />
          </div>
          <p className="text-xs text-muted mt-3">
            La curva confirma lo esperado: EP es más alto cerca de la zona de anotación rival (~6 puntos) y baja
            cerca de tu propia zona (~1-1.5). No llega a negativo porque esta versión simplificada no le asigna
            valor al rival cuando pierdes el balón — el modelo de nflverse (columna <code>epa</code>) sí lo hace,
            por eso no van a coincidir exactamente en el paso 3.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold mb-1">3. Comparando nuestro modelo contra el profesional</h2>
          <p className="text-sm text-muted mb-4">
            Para cada jugada de 1er down de este partido: buscamos <code className="text-xs">EP</code> antes y
            después en la curva de arriba, calculamos <code className="text-xs">EPA_propio = EP(después) −
            EP(antes)</code>, y lo comparamos contra el <code className="text-xs">epa</code> real que ya trae
            nflverse para esa misma jugada.
          </p>
          <div className="bg-surface border border-border rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted border-b border-border">
                  <th className="px-3 py-2 font-medium">Q</th>
                  <th className="px-3 py-2 font-medium">Equipo</th>
                  <th className="px-3 py-2 font-medium">Yardlínea</th>
                  <th className="px-3 py-2 font-medium">Jugada</th>
                  <th className="px-3 py-2 font-medium text-right">EP antes</th>
                  <th className="px-3 py-2 font-medium text-right">EP después</th>
                  <th className="px-3 py-2 font-medium text-right">EPA propio</th>
                  <th className="px-3 py-2 font-medium text-right">EPA nflverse</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-muted">{r.quarter ?? "-"}</td>
                    <td className="px-3 py-2 font-medium">{r.possessionTeamAbbr ?? "-"}</td>
                    <td className="px-3 py-2 text-muted font-mono text-xs">{r.yardLine100}</td>
                    <td className="px-3 py-2 text-muted truncate max-w-[220px]">{r.description}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{r.epBefore?.toFixed(2) ?? "-"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{r.epAfter?.toFixed(2) ?? "-"}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-accent">
                      {r.epaHat !== null ? (r.epaHat >= 0 ? "+" : "") + r.epaHat.toFixed(2) : "-"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.epa !== null ? (r.epa >= 0 ? "+" : "") + r.epa.toFixed(2) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-surface border border-border rounded-xl p-5">
          <h2 className="text-lg font-semibold mb-2">4. Qué le falta a este modelo para ser el real</h2>
          <ul className="text-sm text-muted list-disc list-inside space-y-1">
            <li>Solo usa 1er down — no condiciona por down (2do/3ro/4to) ni por distancia a conseguir</li>
            <li>No usa el tiempo restante (una jugada en el 4to cuarto vale distinto que en el 1ero, sección 5.4.1)</li>
            <li>No le asigna valor al rival cuando el equipo pierde el balón (metodología &quot;next score&quot; real)</li>
            <li>Los tramos de 5 yardas son gruesos — con más datos se puede afinar a 1 yarda</li>
          </ul>
          <p className="text-sm text-muted mt-3">
            El siguiente paso natural (sección 5.4.1 del framework) es construir la matriz de transición completa
            <code className="text-xs mx-1">P(s&apos;|s)</code> con los 4 downs y usarla para simular posesiones
            completas, no solo mirar el punto de partida.
          </p>
        </section>
      </main>
    </div>
  );
}
