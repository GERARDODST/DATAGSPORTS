# DATAGSPORTS

Plataforma de pronósticos de NFL con análisis matemático y estadístico, inspirada en el
enfoque de [SofaScore](https://www.sofascore.com/) para presentar datos de equipos, jugadores
y partidos.

Este es el primer paso del proyecto: la **capa de datos**. Combina equipos, jugadores,
calendario y estadísticas semanales de NFL en una base de datos propia, y los muestra en un
dashboard tipo SofaScore. Los pasos siguientes (modelo matemático, cuotas, auditoría de
contradicciones) se basan en el framework de análisis incluido en el proyecto, adaptado de
MLB a NFL.

## Stack

- [Next.js 16](https://nextjs.org/) (App Router) + TypeScript + Tailwind CSS v4
- [Prisma ORM 7](https://www.prisma.io/) + PostgreSQL (vía `@prisma/adapter-pg`)
- Datos abiertos de [nflverse-data](https://github.com/nflverse/nflverse-data) (equipos,
  rosters, calendario y estadísticas semanales de jugadores)

## Requisitos

- Node.js 20+
- PostgreSQL corriendo localmente (o accesible por `DATABASE_URL`)

## Puesta en marcha

```bash
npm install
cp .env.example .env   # ajusta DATABASE_URL si es necesario

npm run db:push        # crea las tablas en la base de datos
npm run data:extract -- --season=2024       # equipos, rosters, calendario, stats semanales
npm run data:extract-pbp -- --season=2024   # play-by-play: posesiones y jugadas (EPA, win prob)

npm run dev             # http://localhost:3000
```

Abre un partido jugado (ej. `/partidos/2024_22_KC_PHI`, el Super Bowl LIX) para ver la
probabilidad de victoria jugada por jugada y el detalle de cada posesión.

## Modelo previo al partido (equipo en seguimiento: Chiefs)

`src/lib/framework-analysis.ts` construye el análisis de un partido usando **solo partidos jugados
antes de su fecha** y siguiendo el algoritmo maestro del framework: gate de completitud,
ratings con regresión a la media (la temporada anterior pesa la mitad), triangulación
Log5 / Elo / simulación, marcador proyectado, valor contra los momios de cierre, auditoría y,
al final, comparación con el resultado real. En la semana 1 todo sale de la temporada
anterior; desde la semana 2 cada partido de la temporada actual pesa el doble que uno del año
anterior en **todas** las métricas (puntos, EPA, 3er down, zona roja, presión, QB, quién es
titular "en la base"). La sección del equipo compara los análisis entre sí: probabilidad del
modelo contra el mercado, error de la proyección, Brier y cómo cambian los ratings partido a
partido.

Para la semana 1 se necesitan los datos de la temporada anterior:

```bash
npm run data:extract -- --season=2023
npm run data:extract-pbp -- --season=2023
npm run data:extract -- --season=2024   # deja los rosters en su estado actual
npm run data:extract-context -- --season=2023   # presión defensiva (PFR) de la base
npm run data:extract-context -- --season=2024   # lesiones, depth chart, QBR de ESPN e inactivos oficiales
for y in 2018 2019 2020 2021 2022; do npm run data:extract -- --season=$y --games-only; done   # historial para H2H y Elo
```

### Datos faltantes: solo se completan con fuentes reales

Cada análisis trae un plan (`gapPlan`) que dice, para cada dato faltante, con qué fuente real se
completó o por qué sigue pendiente:

| Dato | Fuente real | Estado |
| --- | --- | --- |
| Historial directo (5 partidos) | `schedules/games.csv` desde 2018 (`--games-only`) | Resuelto |
| Historia del Elo | Mismo calendario: 6 temporadas con regresión de 1/3 por año | Resuelto |
| QBR | ESPN vía nflverse `espn_data/qbr_*_level.csv` (temporada anterior + semanas ya jugadas) | Resuelto |
| Alineación confirmada | Inactivos oficiales: `weekly_rosters/roster_weekly_{año}.csv`, `status = INA` | Resuelto |
| Lluvia pronosticada | Open-Meteo `historical-forecast-api.open-meteo.com` (gratis) | Pendiente: dominio bloqueado en el entorno en la nube |
| 2+ casas, movimiento de línea, 1Q/1H | The Odds API histórico | Pendiente: requiere clave de pago |
| Titulares de la primera jugada | Solo existen al empezar el partido (snap counts = fuga) | Sin fuente previa |

Cada dato del análisis lleva su categoría, su fuente (archivo y columna de nflverse), su
estado (disponible, derivado, parcial, faltante, no aplica) y qué bloquea si falta; cada
cálculo lleva su fórmula con los números sustituidos. El reporte de lesiones se filtra por
fecha de publicación: un registro posterior al inicio del partido se excluye (fuga de datos).

El equipo y cuántos de sus partidos se analizan se configuran en `scripts/export-snapshot.ts`
(`FOCUS_TEAM`, `FOCUS_GAMES_ANALYZED`).

## Versión publicada (sin servidor)

`npm run snapshot:export -- --season=2024` genera en `snapshot/dist/` una versión estática
del sitio: `snapshot/viewer.html` con los datos generales embebidos, más un JSON de jugadas
por semana que se carga bajo demanda. Es lo que se publica como página en claude.ai para
poder abrir el sitio con un link sin desplegar la app ni la base de datos. Cada cambio en
los datos o el modelo se ve volviendo a exportar y publicar.

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Levanta el servidor de desarrollo |
| `npm run build` / `npm run start` | Build y arranque de producción |
| `npm run db:push` | Sincroniza `prisma/schema.prisma` con la base de datos |
| `npm run db:studio` | Abre Prisma Studio para inspeccionar los datos |
| `npm run data:extract -- --season=YYYY` | Descarga equipos, rosters, calendario y stats semanales |
| `npm run data:extract -- --season=YYYY --games-only` | Solo calendario y resultados (historial para H2H y Elo) |
| `npm run data:extract-pbp -- --season=YYYY` | Descarga play-by-play (posesiones y jugadas) |
| `npm run data:extract-context -- --season=YYYY` | Lesiones, depth charts, presión (PFR), QBR de ESPN e inactivos oficiales |
| `npm run snapshot:export -- --season=YYYY` | Genera la versión estática publicable en `snapshot/dist/` |

## Modelo de datos (`prisma/schema.prisma`)

- **Team** — equipos NFL (colores, logos, conferencia/división)
- **Player** — jugadores (posición, equipo actual, datos físicos, foto)
- **Game** — calendario/resultados por temporada y semana
- **PlayerWeekStat** — estadísticas de cada jugador por semana (pase, carrera, recepción,
  fantasy points), vinculadas a `Player` y opcionalmente a `Game`
- **Drive** — cada posesión ofensiva de un partido (inicio, fin, nº de jugadas, resultado)
- **Play** — cada jugada individual (down, distancia, yardlínea, tiempo restante, EPA,
  probabilidad de victoria) — es el estado atómico del modelo de procesos estocásticos que
  describe `docs/nfl_framework_v1.md` (sección 5.4.1)

La fuente de datos es [nflverse-data](https://github.com/nflverse/nflverse-data), un
proyecto abierto y mantenido por la comunidad — sin necesidad de scraping ni claves de API.

## Framework de análisis

- `docs/mlb_framework_v2.pdf` — framework original de picks matemáticos (MLB)
- `docs/nfl_framework_v1.md` — **adaptación a NFL** del framework anterior: mismas 10
  secciones y misma matemática de banca/probabilidad (Log5, Elo, shrinkage, Kelly, Monte
  Carlo), con los conceptos de béisbol reemplazados por sus equivalentes reales en NFL
  (abridor/bullpen/entradas → QB+ofensiva/defensa/cuartos), incluyendo por qué el modelo de
  puntos no puede ser un Poisson simple como en MLB (sección 5.3-5.4 del documento)

## Próximos pasos

Implementar el motor de análisis descrito en `docs/nfl_framework_v1.md`:

1. Agregar tiempo restante y marcador al estado de la cadena (semi-Markov, sección 5.4.2) — hoy
   el simulador sobreestima por no tener reloj
2. Sumar fuentes de injury reports, clima y momios (sección 9.2 del framework)
3. Simular partidos completos (ambos equipos) para llegar a probabilidades por mercado
4. Implementar la auditoría de contradicciones (sección 8) como reglas verificables sobre
   los picks generados
