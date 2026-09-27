"use client";

import { useState } from "react";
import type { EpBucket } from "@/lib/expected-points";

const WIDTH = 760;
const HEIGHT = 220;
const PAD_LEFT = 32;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 28;
const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;

export type HighlightPoint = {
  bucket: number;
  label: string;
  playDescription: string | null;
};

export function EpByFieldPositionChart({
  model,
  maxValue,
  highlights = [],
}: {
  model: EpBucket[];
  maxValue: number;
  highlights?: HighlightPoint[];
}) {
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);

  // Invertimos el orden: yardLine100 alto (cerca de tu propia zona) queda a
  // la izquierda, yardLine100 bajo (cerca de la zona rival) a la derecha —
  // así se lee como un campo de fútbol americano real.
  const ordered = [...model].sort((a, b) => b.bucket - a.bucket);
  const barW = PLOT_W / ordered.length;
  const highlightByBucket = new Map<number, HighlightPoint[]>();
  for (const h of highlights) {
    const arr = highlightByBucket.get(h.bucket) ?? [];
    arr.push(h);
    highlightByBucket.set(h.bucket, arr);
  }

  const yFor = (v: number) => PAD_TOP + (1 - v / maxValue) * PLOT_H;
  const hovered = hoverBucket !== null ? model[hoverBucket] : null;
  const hoveredHighlights = hoverBucket !== null ? highlightByBucket.get(hoverBucket) ?? [] : [];

  return (
    <div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Puntos esperados por posición de campo" className="w-full h-auto">
        {[0, 1, 2, 3, 4, 5, 6].map((v) => (
          <g key={v}>
            <line x1={PAD_LEFT} y1={yFor(v)} x2={WIDTH - PAD_RIGHT} y2={yFor(v)} stroke="var(--border)" strokeWidth={1} opacity={0.5} />
            <text x={PAD_LEFT - 6} y={yFor(v) + 3} fontSize={9} fill="var(--muted)" textAnchor="end">
              {v}
            </text>
          </g>
        ))}

        {ordered.map((b, i) => {
          if (b.avgExpectedPoints === null) return null;
          const bx = PAD_LEFT + i * barW;
          const barTop = yFor(b.avgExpectedPoints);
          const isHovered = hoverBucket === b.bucket;
          const hasHighlight = highlightByBucket.has(b.bucket);
          return (
            <g key={b.bucket}>
              <rect
                x={bx + 1}
                y={barTop}
                width={Math.max(1, barW - 2)}
                height={HEIGHT - PAD_BOTTOM - barTop}
                fill={hasHighlight ? "var(--accent)" : "var(--surface-2)"}
                fillOpacity={isHovered ? 1 : hasHighlight ? 0.9 : 0.7}
                stroke={hasHighlight ? "var(--accent)" : "none"}
                strokeWidth={hasHighlight ? 1 : 0}
                onMouseEnter={() => setHoverBucket(b.bucket)}
                onMouseLeave={() => setHoverBucket(null)}
              />
              {hasHighlight && (
                <circle cx={bx + barW / 2} cy={yFor(b.avgExpectedPoints)} r={3} fill="var(--background)" stroke="var(--accent)" strokeWidth={1.5} />
              )}
            </g>
          );
        })}

        <text x={PAD_LEFT} y={HEIGHT - 6} fontSize={9} fill="var(--muted)" textAnchor="start">
          ← Tu zona (yardline 100)
        </text>
        <text x={WIDTH - PAD_RIGHT} y={HEIGHT - 6} fontSize={9} fill="var(--muted)" textAnchor="end">
          Zona rival (yardline 1) →
        </text>
      </svg>
      <div className="text-xs text-muted mt-2 min-h-[2.5rem]">
        {hovered ? (
          <span className="text-foreground">
            Yardas {hovered.label} hasta la anotación rival · EP promedio ={" "}
            <span className="font-mono text-accent">{hovered.avgExpectedPoints?.toFixed(2)}</span> puntos · n=
            {hovered.sampleSize} jugadas de 1er down en la temporada
            {hoveredHighlights.length > 0 && (
              <>
                {" "}
                — en este partido:{" "}
                {hoveredHighlights.map((h, i) => (
                  <em key={i} className="text-muted not-italic">
                    {h.playDescription}
                    {i < hoveredHighlights.length - 1 ? "; " : ""}
                  </em>
                ))}
              </>
            )}
          </span>
        ) : (
          "Pasa el cursor sobre las barras. Las barras resaltadas son buckets donde el partido seleccionado tuvo una jugada de 1er down."
        )}
      </div>
    </div>
  );
}
