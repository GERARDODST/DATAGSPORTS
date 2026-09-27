# DATAGSPORTS · edición NFL 2026

Picks previos de **todos los partidos** de la temporada 2026 de la NFL. Para cada partido el
modelo da su probabilidad de victoria, el lado del spread y el del total, con solo la información
publicada antes de la patada inicial. Cuando el partido se juega, el pick se compara con el resultado.

Es una copia independiente de `nfl2024/`: mismo tipo de programación, pero su propio código, su
propia base de datos (`datagsports_2026`) y sus propios archivos publicados. **No usa datos
anteriores a 2025.** Todos los comandos se corren dentro de `nfl2026/` (las dependencias se
instalan una vez en la raíz).

## Puesta en marcha

```bash
npm install            # en la raíz del repositorio
cd nfl2026
cp .env.example .env   # base datagsports_2026
npm run db:generate    # cliente de Prisma de esta edición (src/generated/prisma)
npm run db:push

for s in 2025 2026; do
  npm run data:extract -- --season=$s          # equipos, rosters, calendario, stats semanales
  npm run data:extract-pbp -- --season=$s      # play-by-play (EPA)
  npm run data:extract-context -- --season=$s  # lesiones, depth charts, inactivos, PFR, QBR
done

npm run models:optimize   # parámetros de los modelos → data/model-params.json
npm run snapshot:export   # visor estático → snapshot/dist/
```

Desde 2025 nflverse publica los depth charts como capturas diarias de ESPN (sin semana). El
extractor toma, para cada partido de cada equipo, la última captura anterior a la patada y la
traduce al formato anterior (LT → T, LCB/NB → CB…). Las estadísticas semanales se leen del release
`stats_player`.

## Protocolo (`src/lib/models/protocol.ts`)

| Periodo | Partidos | Uso |
| --- | --- | --- |
| Calentamiento | 2025, semanas 1–4 | Los modelos aprenden desde cero (todos los equipos iguales); no se puntúa |
| Entrenamiento | 2025, semana 5 a playoffs | Hiperparámetros de cada modelo |
| Validación | 2026, semanas 1–3 jugadas al corte (`VALID_CUTOFF`) + 2025 semana 10+ | Ensamble (η, γ) y capas (valor de QB, cambio de QB, bajas y clima, números clave), cada bloque con la mitad del peso |
| En vivo | 2026 después del corte | Nada se ajusta: cada pick queda fijo antes del partido |

Los partidos por jugar entran al walk-forward con `played = false`: se predicen con lo aprendido
hasta la última fecha jugada y ningún modelo ni capa se actualiza con ellos. Si nflverse todavía no
publica el QB titular, se usa el último titular del equipo (marcado como proyectado).

Resultado de la optimización del 27 de septiembre de 2026 (semanas 1–3, 33 partidos): el modelo
final acierta 20 ganadores (mercado 23), log-loss 0.673 (mercado 0.653). La validación apagó la
capa binaria de QB y la de bajas y clima (con una sola temporada no mejoran), y mantuvo el valor
por QB y los números clave.

## Visor

`snapshot/viewer.html` → `snapshot/dist/`:

- **Partidos**: los picks más firmes de la semana y todos los partidos con su pick.
- **Picks** (`#picks`): marcador de la temporada (en vivo y validación, modelo contra mercado,
  spread y over/under) y una tarjeta por partido con el pick de ganador, spread y total.
- **Análisis previo** (`#p-<gameId>`): el análisis completo del framework para cada partido con
  línea publicada, en `data/pregame/<gameId>.json` (se carga bajo demanda).
- **Laboratorio**: cadena de Markov (construida con 2025), torneo de modelos e investigación.

## Scripts

| Comando | Descripción |
| --- | --- |
| `npm run db:generate` / `db:push` | Cliente de Prisma y tablas de `datagsports_2026` |
| `npm run data:extract -- --season=YYYY` | Equipos, rosters, calendario y stats semanales |
| `npm run data:extract-pbp -- --season=YYYY` | Play-by-play |
| `npm run data:extract-context -- --season=YYYY` | Lesiones, depth charts, presión (PFR), QBR e inactivos |
| `npm run models:optimize` | Optimiza modelos y ensamble con el protocolo de esta edición |
| `npm run models:report` | Tabla del torneo por periodo |
| `npm run snapshot:export` | Genera el visor estático con los picks de toda la temporada |
