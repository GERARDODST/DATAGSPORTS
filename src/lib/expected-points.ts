/**
 * Construye un modelo de Puntos Esperados (EP) por posición de campo desde
 * cero, a partir de los datos reales de `plays`/`drives` (docs/nfl_framework_v1.md,
 * secciones 5.4.1 y 5.7.3). Es una versión simplificada del EP "de verdad"
 * (nflverse usa next-score, aquí solo miramos los puntos que anota el propio
 * equipo en esa posesión) — la comparación contra `Play.epa` en la página del
 * modelo muestra exactamente esa diferencia.
 */
import { prisma } from "./prisma";

// Valor de puntos asignado a cada resultado absorbente de una posesión.
// Positivo = anotó el equipo con el balón; negativo = anotó el rival.
const DRIVE_POINT_VALUES: Record<string, number> = {
  Touchdown: 6.94, // ~7, ajustado por el ~94% de acierto en punto extra + algún 2pt
  "Field goal": 3,
  "Missed field goal": 0,
  Punt: 0,
  Turnover: 0,
  "Turnover on downs": 0,
  Safety: -2,
  "Opp touchdown": -6.94, // pick-six / fumble return TD: anota la defensa rival
  "End of half": 0,
};

export const BUCKET_SIZE = 5;
export const BUCKET_COUNT = 20; // 100 yardas / 5

export function bucketFor(yardLine100: number): number {
  const clamped = Math.min(99, Math.max(1, yardLine100));
  return Math.min(BUCKET_COUNT - 1, Math.floor((clamped - 1) / BUCKET_SIZE));
}

export function bucketLabel(bucket: number): string {
  const start = bucket * BUCKET_SIZE + 1;
  const end = Math.min(100, start + BUCKET_SIZE - 1);
  return `${start}-${end}`;
}

export type EpBucket = {
  bucket: number;
  label: string;
  avgExpectedPoints: number | null;
  sampleSize: number;
};

/**
 * Modelo EP condicionado a 1er down (la referencia clásica más simple:
 * "con primera oportunidad, en esta yarda, ¿cuántos puntos anota en promedio
 * el equipo antes de que termine la posesión?"), calculado sobre TODA la
 * temporada para tener muestra suficiente en cada bucket.
 */
export async function buildFieldPositionEpModel(season: number): Promise<EpBucket[]> {
  const drives = await prisma.drive.findMany({
    where: { season },
    select: { id: true, result: true },
  });
  const pointValueByDrive = new Map<string, number>();
  for (const d of drives) {
    pointValueByDrive.set(d.id, DRIVE_POINT_VALUES[d.result ?? ""] ?? 0);
  }

  const plays = await prisma.play.findMany({
    where: { season, down: 1, yardLine100: { not: null }, driveId: { not: null } },
    select: { yardLine100: true, driveId: true },
  });

  const sums = Array.from({ length: BUCKET_COUNT }, () => ({ sum: 0, count: 0 }));
  for (const p of plays) {
    if (p.yardLine100 === null || !p.driveId) continue;
    const value = pointValueByDrive.get(p.driveId);
    if (value === undefined) continue;
    const b = bucketFor(p.yardLine100);
    sums[b].sum += value;
    sums[b].count += 1;
  }

  return sums.map((s, bucket) => ({
    bucket,
    label: bucketLabel(bucket),
    avgExpectedPoints: s.count > 0 ? s.sum / s.count : null,
    sampleSize: s.count,
  }));
}

export function lookupExpectedPoints(model: EpBucket[], yardLine100: number): number | null {
  return model[bucketFor(yardLine100)]?.avgExpectedPoints ?? null;
}

export type FirstDownPlay = {
  yardLine100: number;
  yardsGained: number | null;
  isTouchdown: boolean;
  isInterception: boolean;
  isFumbleLost: boolean;
};

/**
 * EPA propio de una jugada de 1er down: EP(después) − EP(antes) sobre la
 * curva del modelo. Touchdown vale su valor completo; una pérdida de balón
 * se trata como 0 porque este modelo no le asigna valor al rival.
 */
export function ownEpaForPlay(model: EpBucket[], play: FirstDownPlay) {
  const epBefore = lookupExpectedPoints(model, play.yardLine100);
  let epAfter: number | null;
  if (play.isTouchdown) {
    epAfter = DRIVE_POINT_VALUES.Touchdown;
  } else if (play.isInterception || play.isFumbleLost) {
    epAfter = 0;
  } else {
    epAfter = lookupExpectedPoints(model, play.yardLine100 - (play.yardsGained ?? 0));
  }
  const epaHat = epBefore !== null && epAfter !== null ? epAfter - epBefore : null;
  return { epBefore, epAfter, epaHat };
}
