/**
 * Modelo v2: cadena de Markov completa sobre el estado
 * s = (down, distancia, zona del campo), resuelta por iteración de valor
 * sobre las posesiones reales (docs/nfl_framework_v1.md, 5.4.1 y 5.7.3).
 *
 * A diferencia del modelo v1 (solo 1er down, pérdidas de balón valen 0), aquí
 * una posesión que no anota vale −EP del rival en el punto donde recibe el
 * balón, y una que anota resta lo que el rival espera anotar tras la patada.
 * Como EP aparece en ambos lados de la ecuación, se resuelve iterando hasta
 * que deja de cambiar.
 */
import { prisma } from "./prisma";

export const DOWNS = 4;
export const DIST_BUCKETS = ["1–3", "4–6", "7–10", "11+"] as const;
export const FIELD_BUCKETS = 10; // zonas de 10 yardas
export const STATE_COUNT = DOWNS * DIST_BUCKETS.length * FIELD_BUCKETS;

const TD_VALUE = 6.94;
const SHRINK_K = 25;

export function distBucket(ytg: number): number {
  if (ytg <= 3) return 0;
  if (ytg <= 6) return 1;
  if (ytg <= 10) return 2;
  return 3;
}
export function fieldBucket(yl: number): number {
  return Math.min(FIELD_BUCKETS - 1, Math.max(0, Math.floor((Math.min(99, Math.max(1, yl)) - 1) / 10)));
}
export function stateIndex(down: number, ytg: number, yl: number): number {
  return ((down - 1) * DIST_BUCKETS.length + distBucket(ytg)) * FIELD_BUCKETS + fieldBucket(yl);
}

// Resultado de una jugada para el simulador.
export const OUTCOME = { YARDS: 0, TD: 1, TURNOVER: 2, PUNT: 3, FG_MADE: 4, FG_MISSED: 5 } as const;

type PlayRow = {
  id: string;
  gameId: string;
  driveId: string | null;
  down: number | null;
  yardsToGo: number | null;
  yardLine100: number | null;
  playType: string | null;
  yardsGained: number | null;
  isTouchdown: boolean;
  isInterception: boolean;
  isFumbleLost: boolean;
  epa: number | null;
  possessionTeamAbbr: string | null;
};
type DriveRow = { id: string; gameId: string; driveNumber: number; result: string | null; possessionTeamAbbr: string | null };

export type MarkovModel = {
  ep: number[];
  n: number[];
  iterations: number[];
  epa: { n: number; r: number | null; mae: number };
  transitions: { yards: number[]; codes: number[] }[];
  driveStarts: { zone: number; results: Record<string, number>; points: number; n: number }[];
  ownEpaByPlay: Map<string, number>;
};

function pointsOf(result: string | null): number | null {
  switch (result) {
    case "Touchdown":
      return TD_VALUE;
    case "Field goal":
      return 3;
    case "Safety":
      return -2;
    case "Opp touchdown":
      return -TD_VALUE;
    default:
      return null;
  }
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

const playOrder = (id: string) => Number(id.slice(id.lastIndexOf("_") + 1));

export async function buildMarkovModel(season: number): Promise<MarkovModel> {
  const [plays, drives] = await Promise.all([
    prisma.play.findMany({
      where: { season },
      select: {
        id: true,
        gameId: true,
        driveId: true,
        down: true,
        yardsToGo: true,
        yardLine100: true,
        playType: true,
        yardsGained: true,
        isTouchdown: true,
        isInterception: true,
        isFumbleLost: true,
        epa: true,
        possessionTeamAbbr: true,
      },
    }) as Promise<PlayRow[]>,
    prisma.drive.findMany({
      where: { season },
      select: { id: true, gameId: true, driveNumber: true, result: true, possessionTeamAbbr: true },
    }) as Promise<DriveRow[]>,
  ]);

  // Jugadas "de estado": tienen down, distancia y yardlínea (excluye patadas de salida y puntos extra).
  const statePlays = plays
    .filter((p) => p.driveId && p.down && p.yardsToGo !== null && p.yardLine100 !== null)
    .sort((a, b) => (a.gameId < b.gameId ? -1 : a.gameId > b.gameId ? 1 : playOrder(a.id) - playOrder(b.id)));

  const playsByDrive = new Map<string, PlayRow[]>();
  for (const p of statePlays) {
    const arr = playsByDrive.get(p.driveId as string) ?? [];
    arr.push(p);
    playsByDrive.set(p.driveId as string, arr);
  }

  // Siguiente posesión de cada drive dentro del mismo partido (y mitad).
  const drivesByGame = new Map<string, DriveRow[]>();
  for (const d of drives) {
    const arr = drivesByGame.get(d.gameId) ?? [];
    arr.push(d);
    drivesByGame.set(d.gameId, arr);
  }
  const nextStart = new Map<string, { state: number; sign: number } | null>();
  for (const list of drivesByGame.values()) {
    list.sort((a, b) => a.driveNumber - b.driveNumber);
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (d.result === "End of half" || pointsOf(d.result) === -2) {
        nextStart.set(d.id, null);
        continue;
      }
      let found: { state: number; sign: number } | null = null;
      for (let j = i + 1; j < list.length && !found; j++) {
        const first = playsByDrive.get(list[j].id)?.[0];
        if (first) {
          found = {
            state: stateIndex(first.down as number, first.yardsToGo as number, first.yardLine100 as number),
            sign: list[j].possessionTeamAbbr === d.possessionTeamAbbr ? 1 : -1,
          };
        }
      }
      nextStart.set(d.id, found);
    }
  }

  const stateOf = new Map<string, number>();
  for (const p of statePlays) stateOf.set(p.id, stateIndex(p.down as number, p.yardsToGo as number, p.yardLine100 as number));

  const driveById = new Map(drives.map((d) => [d.id, d]));
  const terminal = (driveId: string, ep: number[]) => {
    const d = driveById.get(driveId);
    if (!d || d.result === "End of half") return 0;
    const pts = pointsOf(d.result) ?? 0;
    const next = nextStart.get(driveId);
    return pts + (next ? next.sign * ep[next.state] : 0);
  };

  // Iteración de valor: EP(s) = promedio (con shrinkage) del valor terminal de las posesiones que pasan por s.
  const n = new Array(STATE_COUNT).fill(0);
  for (const p of statePlays) n[stateOf.get(p.id) as number]++;
  let ep = new Array(STATE_COUNT).fill(0);
  const iterations: number[] = [];
  for (let iter = 0; iter < 200; iter++) {
    const sums = new Array(STATE_COUNT).fill(0);
    const driveValue = new Map<string, number>();
    for (const driveId of playsByDrive.keys()) driveValue.set(driveId, terminal(driveId, ep));
    for (const p of statePlays) sums[stateOf.get(p.id) as number] += driveValue.get(p.driveId as string) as number;

    // Prior jerárquico (sección 5.7.4): celda -> (down, zona) -> zona.
    const raw = sums.map((s, i) => (n[i] ? s / n[i] : 0));
    const zoneMean = new Array(FIELD_BUCKETS).fill(0).map((_, f) => {
      let s = 0;
      let c = 0;
      for (let i = f; i < STATE_COUNT; i += FIELD_BUCKETS) {
        s += sums[i];
        c += n[i];
      }
      return c ? s / c : 0;
    });
    const next = raw.map((mean, i) => {
      const f = i % FIELD_BUCKETS;
      const down = Math.floor(i / (FIELD_BUCKETS * DIST_BUCKETS.length));
      let s = 0;
      let c = 0;
      for (let dist = 0; dist < DIST_BUCKETS.length; dist++) {
        const j = (down * DIST_BUCKETS.length + dist) * FIELD_BUCKETS + f;
        s += sums[j];
        c += n[j];
      }
      const downZone = (c * (c ? s / c : 0) + SHRINK_K * zoneMean[f]) / (c + SHRINK_K);
      return (n[i] * mean + SHRINK_K * downZone) / (n[i] + SHRINK_K);
    });
    const delta = Math.max(...next.map((v, i) => Math.abs(v - ep[i])));
    ep = next;
    iterations.push(delta);
    if (delta < 0.001) break;
  }

  // EPA propio v2: EP del siguiente estado real (o valor terminal) menos EP del estado actual.
  const ownEpaByPlay = new Map<string, number>();
  const ownList: number[] = [];
  const refList: number[] = [];
  for (const [driveId, list] of playsByDrive) {
    const term = terminal(driveId, ep);
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const after = i + 1 < list.length ? ep[stateOf.get(list[i + 1].id) as number] : term;
      const val = after - ep[stateOf.get(p.id) as number];
      ownEpaByPlay.set(p.id, val);
      if (p.epa !== null && p.playType !== "no_play") {
        ownList.push(val);
        refList.push(p.epa);
      }
    }
  }
  const mae = ownList.reduce((s, v, i) => s + Math.abs(v - refList[i]), 0) / Math.max(1, ownList.length);

  // Tabla de transiciones para el simulador: qué pasó en cada estado.
  const transitions = Array.from({ length: STATE_COUNT }, () => ({ yards: [] as number[], codes: [] as number[] }));
  for (const [driveId, list] of playsByDrive) {
    const d = driveById.get(driveId);
    list.forEach((p, i) => {
      if (!["pass", "run", "punt", "field_goal"].includes(p.playType ?? "")) return;
      const isLast = i === list.length - 1;
      let code: number = OUTCOME.YARDS;
      if (p.playType === "punt") code = OUTCOME.PUNT;
      else if (p.playType === "field_goal") code = isLast && d?.result === "Field goal" ? OUTCOME.FG_MADE : OUTCOME.FG_MISSED;
      else if (p.isInterception || p.isFumbleLost) code = OUTCOME.TURNOVER;
      else if (p.isTouchdown) code = OUTCOME.TD;
      const t = transitions[stateOf.get(p.id) as number];
      t.yards.push(p.yardsGained ?? 0);
      t.codes.push(code);
    });
  }

  // Referencia real: cómo terminan las posesiones según la zona donde empiezan.
  const starts = Array.from({ length: FIELD_BUCKETS }, (_, zone) => ({ zone, results: {} as Record<string, number>, points: 0, n: 0 }));
  for (const [driveId, list] of playsByDrive) {
    const d = driveById.get(driveId);
    const first = list[0];
    if (!d || !d.result || first.down !== 1) continue;
    const z = starts[fieldBucket(first.yardLine100 as number)];
    z.results[d.result] = (z.results[d.result] ?? 0) + 1;
    z.points += pointsOf(d.result) ?? 0;
    z.n++;
  }

  return {
    ep,
    n,
    iterations,
    epa: { n: ownList.length, r: pearson(ownList, refList), mae },
    transitions,
    driveStarts: starts,
    ownEpaByPlay,
  };
}

/**
 * Simula una posesión desde (down, distancia, yardlínea) muestreando, en cada
 * estado, una jugada real de la temporada que ocurrió en ese mismo estado.
 */
export function simulateDrive(
  transitions: { yards: number[]; codes: number[] }[],
  start: { down: number; ytg: number; yl: number },
  rand: () => number = Math.random
) {
  let { down, ytg, yl } = start;
  for (let step = 0; step < 40; step++) {
    const t = transitions[stateIndex(down, ytg, yl)];
    if (!t || t.codes.length === 0) return { result: "Punt", points: 0 };
    const k = Math.floor(rand() * t.codes.length);
    const code = t.codes[k];
    if (code === OUTCOME.TD) return { result: "Touchdown", points: TD_VALUE };
    if (code === OUTCOME.TURNOVER) return { result: "Turnover", points: 0 };
    if (code === OUTCOME.PUNT) return { result: "Punt", points: 0 };
    if (code === OUTCOME.FG_MADE) return { result: "Field goal", points: 3 };
    if (code === OUTCOME.FG_MISSED) return { result: "Missed field goal", points: 0 };
    const gain = t.yards[k];
    yl -= gain;
    if (yl <= 0) return { result: "Touchdown", points: TD_VALUE };
    if (yl >= 100) return { result: "Safety", points: -2 };
    if (gain >= ytg) {
      down = 1;
      ytg = Math.min(10, yl);
    } else {
      down += 1;
      ytg -= gain;
      if (down > 4) return { result: "Turnover on downs", points: 0 };
    }
  }
  return { result: "End of half", points: 0 };
}
