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
| `npm run data:extract-pbp -- --season=YYYY` | Descarga play-by-play (posesiones y jugadas) |
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

1. Calcular la matriz de transición empírica `P(s'|s)` sobre `plays` (sección 5.7.3) — los
   datos ya están, falta el cálculo
2. Sumar fuentes de injury reports, clima y momios (sección 9.2 del framework)
3. Construir el motor de simulación Monte Carlo (sección 5.4, Nivel 1 y Nivel 2)
4. Implementar la auditoría de contradicciones (sección 8) como reglas verificables sobre
   los picks generados
