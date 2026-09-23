"use client";

import { useMemo, useState } from "react";

export type WpPoint = {
  gameSecondsRemaining: number;
  quarter: number | null;
  homeWinProbability: number;
  description: string | null;
};

const TOTAL_GAME_SECONDS = 3600;
const WIDTH = 720;
const HEIGHT = 220;
const PAD_LEFT = 36;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;

function x(elapsed: number) {
  return PAD_LEFT + (elapsed / TOTAL_GAME_SECONDS) * PLOT_W;
}
function y(winProb: number) {
  return PAD_TOP + (1 - winProb) * PLOT_H;
}

export function WinProbabilityChart({
  points,
  homeAbbr,
  awayAbbr,
  homeColor,
  awayColor,
}: {
  points: WpPoint[];
  homeAbbr: string;
  awayAbbr: string;
  homeColor: string;
  awayColor: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const sorted = useMemo(
    () =>
      [...points]
        .filter((p) => p.homeWinProbability !== null && p.homeWinProbability !== undefined)
        .map((p) => ({ ...p, elapsed: TOTAL_GAME_SECONDS - p.gameSecondsRemaining }))
        .sort((a, b) => a.elapsed - b.elapsed),
    [points]
  );

  if (sorted.length < 2) {
    return <p className="text-sm text-muted">No hay suficientes jugadas para graficar la probabilidad de victoria.</p>;
  }

  const linePath = sorted.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.elapsed).toFixed(1)} ${y(p.homeWinProbability).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${x(sorted[sorted.length - 1].elapsed).toFixed(1)} ${y(0.5)} L ${x(sorted[0].elapsed).toFixed(1)} ${y(0.5)} Z`;

  const quarterMarks = [900, 1800, 2700].map((s) => x(s));
  const hovered = hoverIdx !== null ? sorted[hoverIdx] : null;

  function handleMove(evt: React.PointerEvent<SVGRectElement>) {
    const rect = evt.currentTarget.getBoundingClientRect();
    const relX = evt.clientX - rect.left;
    const svgX = PAD_LEFT + (relX / rect.width) * PLOT_W;
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const d = Math.abs(x(sorted[i].elapsed) - svgX);
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    setHoverIdx(nearest);
  }

  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-xs">
        <LegendSwatch color={homeColor} label={`${homeAbbr} (local)`} />
        <LegendSwatch color={awayColor} label={`${awayAbbr} (visitante)`} />
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Probabilidad de victoria de ${homeAbbr} a lo largo del partido`}
        className="w-full h-auto"
      >
        {/* referencia 50% */}
        <line x1={PAD_LEFT} y1={y(0.5)} x2={WIDTH - PAD_RIGHT} y2={y(0.5)} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
        {/* marcas de cuarto */}
        {quarterMarks.map((qx, i) => (
          <line key={i} x1={qx} y1={PAD_TOP} x2={qx} y2={HEIGHT - PAD_BOTTOM} stroke="var(--border)" strokeWidth={1} />
        ))}
        {[0, 1, 2, 3, 4].map((q) => (
          <text key={q} x={x(q * 900) + (q < 4 ? 4 : -4)} y={HEIGHT - 6} fontSize={9} fill="var(--muted)" textAnchor={q < 4 ? "start" : "end"}>
            {q === 0 ? "Inicio" : q === 4 ? "Final" : `Q${q + 1}`}
          </text>
        ))}
        <text x={PAD_LEFT - 4} y={y(1) + 3} fontSize={9} fill="var(--muted)" textAnchor="end">100%</text>
        <text x={PAD_LEFT - 4} y={y(0.5) + 3} fontSize={9} fill="var(--muted)" textAnchor="end">50%</text>
        <text x={PAD_LEFT - 4} y={y(0) + 3} fontSize={9} fill="var(--muted)" textAnchor="end">0%</text>

        {/* área sobre 50% = ventaja local, color local; se recorta con dos paths */}
        <clipPath id="above50">
          <rect x={PAD_LEFT} y={PAD_TOP} width={PLOT_W} height={PLOT_H / 2} />
        </clipPath>
        <clipPath id="below50">
          <rect x={PAD_LEFT} y={PAD_TOP + PLOT_H / 2} width={PLOT_W} height={PLOT_H / 2} />
        </clipPath>
        <path d={areaPath} fill={homeColor} fillOpacity={0.18} clipPath="url(#above50)" />
        <path d={areaPath} fill={awayColor} fillOpacity={0.18} clipPath="url(#below50)" />

        <path d={linePath} fill="none" stroke={homeColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {hovered && (
          <>
            <line x1={x(hovered.elapsed)} y1={PAD_TOP} x2={x(hovered.elapsed)} y2={HEIGHT - PAD_BOTTOM} stroke="var(--foreground)" strokeWidth={1} strokeOpacity={0.4} />
            <circle cx={x(hovered.elapsed)} cy={y(hovered.homeWinProbability)} r={4} fill={homeColor} stroke="var(--surface)" strokeWidth={1.5} />
          </>
        )}

        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onPointerMove={handleMove}
          onPointerLeave={() => setHoverIdx(null)}
        />
      </svg>
      <div className="text-xs text-muted mt-1 min-h-[2.5rem]">
        {hovered ? (
          <>
            <span className="text-foreground font-medium">
              Q{hovered.quarter ?? "?"} · {homeAbbr} {(hovered.homeWinProbability * 100).toFixed(0)}% de ganar
            </span>
            {hovered.description && <div className="truncate">{hovered.description}</div>}
          </>
        ) : (
          "Pasa el cursor sobre el gráfico para ver la probabilidad de victoria jugada por jugada."
        )}
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
