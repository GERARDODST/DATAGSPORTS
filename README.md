# DATAGSPORTS

Plataforma de pronósticos de NFL con análisis matemático y estadístico. El proyecto está separado
en **dos ediciones independientes** que no comparten información: cada una tiene su propio código,
su propia base de datos PostgreSQL y sus propios datos publicados.

| Edición | Carpeta | Base de datos | Datos | Para qué sirve |
| --- | --- | --- | --- | --- |
| **NFL 2024** | [`nfl2024/`](nfl2024/README.md) | `datagsports_2024` | 2018–2024 | Laboratorio de acierto: walk-forward con prueba en 2024 para encontrar el mejor modelo (seguimiento partido a partido de los Chiefs). |
| **NFL 2026** | [`nfl2026/`](nfl2026/README.md) | `datagsports_2026` | solo 2025–2026 | Picks previos de **todos** los partidos de la temporada 2026, comparados con el resultado cuando se juegan. |

Las dos usan la misma programación (Next.js 16, Prisma 7, el mismo motor de modelos y el mismo
visor), pero son copias separadas: un cambio en una no toca a la otra. Las dependencias de npm se
instalan una sola vez aquí en la raíz; cada edición genera su propio cliente de Prisma.

## Puesta en marcha

```bash
npm install                      # dependencias compartidas (solo en la raíz)
service postgresql start

cd nfl2024 && cp .env.example .env && npm run db:generate && npm run db:push && cd ..
cd nfl2026 && cp .env.example .env && npm run db:generate && npm run db:push && cd ..
```

Después, cada edición carga sus datos con sus propios scripts (ver su README).

## Sitio publicado: un solo enlace con selector

```bash
npm run 2024:export     # snapshot estático de la edición 2024 → nfl2024/snapshot/dist/
npm run 2026:export     # snapshot estático de la edición 2026 → nfl2026/snapshot/dist/
npm run site:build      # arma site/dist/: portada + nfl2024/ + nfl2026/
```

`site/shell.html` es la portada: lee la edición elegida (`#ed-2024` / `#ed-2026`, el año del
partido en el enlace, o la última usada en la pestaña; por defecto NFL 2026), descarga el
`index.html` de esa carpeta y lo monta en la página. Junto a **DATAGSPORTS** cada visor muestra el
selector **NFL 2024 | NFL 2026**; cambiar de edición recarga el sitio con la otra copia.

Para actualizar la edición 2026 cada semana (datos nuevos de nflverse y nuevos picks):

```bash
npm run 2026:update && npm run site:build
```

## Scripts de la raíz

| Comando | Descripción |
| --- | --- |
| `npm run 2024:export` | Exporta el snapshot de la edición 2024 |
| `npm run 2026:export` | Exporta el snapshot de la edición 2026 |
| `npm run 2026:update` | Descarga lo nuevo de 2026 (calendario, jugadas, contexto) y exporta |
| `npm run site:build` | Arma el sitio combinado en `site/dist/` |
| `npm run db:generate` | Genera el cliente de Prisma de ambas ediciones |
| `npm run typecheck` | Revisa los tipos de ambas ediciones |
