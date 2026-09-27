/**
 * Protocolo de la edición NFL 2026 (sin datos de temporadas anteriores a 2025):
 *
 *  - 2025, semanas 1–4: solo calientan los modelos (todos los equipos arrancan iguales); nunca se puntúan.
 *  - 2025, semana 5 en adelante (incluye playoffs): entrenamiento de los hiperparámetros de cada modelo.
 *  - 2026, semanas 1–3 (partidos jugados hasta VALID_CUTOFF): validación principal del ensamble y de las capas
 *    (valor de QB, cambio de QB, bajas y clima, números clave). Como son pocos partidos, la
 *    validación se completa con la segunda mitad de 2025 (semana 10+) con el mismo peso total.
 *  - 2026, después de VALID_CUTOFF (domingo de la semana 3 en adelante): en vivo. Nada se ajusta con esos partidos; cada pick queda fijo
 *    antes del partido y se compara con el resultado cuando se juega.
 */
import type { MGame } from "./core";

export const FIRST_SEASON = 2025;
export const LIVE_SEASON = 2026;
/** Último día con partidos jugados cuando se fijaron los parámetros (jueves de la semana 3). Todo lo
 * posterior es en vivo: se predice con los parámetros fijos y se compara al jugarse. */
export const VALID_CUTOFF = "2026-09-25";

/** Clave temporada-semana comparable: 2025 semana 5 → 202505. */
export const sw = (g: { season: number; week: number }) => g.season * 100 + g.week;
/** Desde aquí los resultados alimentan el ensamble y las capas (antes solo calientan). */
export const SCORE_FROM = FIRST_SEASON * 100 + 5;

export const isScored = (g: MGame) => g.played && sw(g) >= SCORE_FROM;
export const inTrain = (g: MGame) => g.played && g.season === FIRST_SEASON && g.week >= 5;
export const inValid = (g: MGame) => g.played && g.season === LIVE_SEASON && g.date <= VALID_CUTOFF;
export const inValidAux = (g: MGame) => g.played && g.season === FIRST_SEASON && g.week >= 10;
export const inLive = (g: MGame) => g.season === LIVE_SEASON && g.date > VALID_CUTOFF;
/** Antes de la validación (2025 puntuado): con lo que se ajustan los pesos de números clave. */
export const beforeValid = (g: MGame) => g.played && sw(g) >= SCORE_FROM && g.season < LIVE_SEASON;
/** Todo lo jugado hasta el corte: lo que el modelo en vivo puede usar para ajustar ω. */
export const upToCutoff = (g: MGame) => g.played && sw(g) >= SCORE_FROM && g.date <= VALID_CUTOFF;

export const PROTOCOL_TEXT =
  `Calentamiento 2025 sem 1–4 · entrenamiento 2025 sem 5–playoffs (modelos) · validación 2026 sem 1–3 jugadas al ${VALID_CUTOFF} + 2025 sem 10+ (ensamble y capas) · en vivo 2026 desde el domingo de la semana 3`;
