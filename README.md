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
npm run data:extract -- --season=2024   # extrae datos reales de NFL

npm run dev             # http://localhost:3000
```

## Scripts

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Levanta el servidor de desarrollo |
| `npm run build` / `npm run start` | Build y arranque de producción |
| `npm run db:push` | Sincroniza `prisma/schema.prisma` con la base de datos |
| `npm run db:studio` | Abre Prisma Studio para inspeccionar los datos |
| `npm run data:extract -- --season=YYYY` | Descarga y carga datos de nflverse-data para una temporada |

## Modelo de datos (`prisma/schema.prisma`)

- **Team** — equipos NFL (colores, logos, conferencia/división)
- **Player** — jugadores (posición, equipo actual, datos físicos, foto)
- **Game** — calendario/resultados por temporada y semana
- **PlayerWeekStat** — estadísticas de cada jugador por semana (pase, carrera, recepción,
  fantasy points), vinculadas a `Player` y opcionalmente a `Game`

La fuente de datos es [nflverse-data](https://github.com/nflverse/nflverse-data), un
proyecto abierto y mantenido por la comunidad — sin necesidad de scraping ni claves de API.

## Próximos pasos

El documento `mlb_framework_v2.pdf` (framework de análisis matemático de picks, adaptado de
MLB) es la base para la siguiente etapa: construir el motor de análisis de partidos de NFL
(ventaja ofensiva/defensiva, modelo de puntos esperados, probabilidad por mercado, cuotas y
auditoría de contradicciones), reemplazando los conceptos específicos de MLB (abridores,
bullpen, entradas) por sus equivalentes en NFL (unidades ofensiva/defensiva, quarterback,
línea de golpeo, cuartos/mitades).
