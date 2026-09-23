# Framework NFL Picks — Versión 1.0

### Adaptado de `mlb_framework_v2.pdf` (Framework MLB Picks v2)

Este documento adapta el framework de análisis matemático y estadístico de MLB a NFL.
Conserva la misma estructura de 10 secciones, el mismo espíritu (gate de completitud de
datos, auditoría de contradicciones, separación entre predicción y valor) y la misma
matemática cuando es universal (Log5, Elo, shrinkage bayesiano, Kelly, Monte Carlo,
correlación entre mercados). Donde el concepto es específico de béisbol, se reemplaza por
su equivalente real en NFL — no es un simple cambio de palabras:

| MLB | NFL | Por qué |
| --- | --- | --- |
| Abridor (starting pitcher) | Quarterback + unidad ofensiva | El QB es el jugador individual con más peso, pero a diferencia de un abridor no juega solo: línea ofensiva, corredores y receptores condicionan su producción. |
| Bullpen (relevistas) | Defensa (unidades de caja, pase y presión) | El rol de "contener cuando las cosas se complican" lo cumple la defensa completa, no un grupo de suplentes. |
| Entradas (9, con cortes F3/F5) | Cuartos (4, con cortes 1Q/1H) | La unidad de tiempo del juego cambia de entradas a cuartos/mitades. |
| Carreras (runs) | Puntos | Unidad de score. **Importante:** en MLB una carrera es un evento discreto de valor 1; en NFL una anotación vale 2, 3, 6, 7 u 8 puntos. Esto rompe el supuesto de Poisson simple sobre el total y se explica en la sección 5.4. |
| Lineup (orden al bate) | Ofensiva (unidad de ataque: RB, WR, TE, OL) | Conjunto de jugadores que produce puntos, más allá del QB. |
| Park factor | Estadio/clima/superficie | Efecto del entorno físico en el resultado; en NFL pesa más el clima (viento, frío) y menos el "factor de parque" puro. |

**Nota de honestidad matemática:** algunas fórmulas de la sección 5 de MLB (Poisson simple
sobre carreras) no se pueden copiar tal cual a NFL. Se explican los ajustes necesarios en
cada punto donde aplica, no solo el cambio de nombre.

---

## Índice

1. Liga, conferencia y contexto competitivo del partido
2. Localía, visita, récords recientes e historial directo
3. Quarterbacks y unidad ofensiva: comparación completa
4. Defensa: unidades, lesiones/fatiga y matchup contra la ofensiva rival
5. Patrones, probabilidades y modelo matemático final
6. Análisis Over/Under y desarrollo probable por cuartos
7. Cuotas, probabilidad implícita y búsqueda de valor
8. Auditoría final de contradicciones y decisión corregida
9. Fuentes de datos: qué usar, para qué, y qué falta si solo usas una
10. Algoritmo maestro (paso a paso)

---

## 1. Liga, conferencia y contexto competitivo del partido

Se determina si ambos equipos pertenecen a la misma conferencia (AFC/NFC), a la misma
división, y si el partido es divisional. Igual que en MLB, **un partido divisional no debe
interpretarse automáticamente como partido de más puntos**: los rivales de división se
conocen mejor, lo que puede producir juegos más cerrados y defensas mejor preparadas para
el esquema ofensivo rival.

| Pregunta | Respuesta |
| --- | --- |
| ¿Ambos equipos pertenecen a la misma conferencia? | Sí/No |
| ¿Ambos equipos pertenecen a la misma división? | Sí/No |
| ¿El partido es divisional? | Sí/No |
| División del equipo visitante | AFC/NFC + Norte/Sur/Este/Oeste |
| División del equipo local | AFC/NFC + Norte/Sur/Este/Oeste |
| ¿Sede neutra o internacional? (Londres, México, Alemania, Brasil) | Sí/No — si es neutra, ningún split de localía aplica |
| Semana de temporada / bye week reciente de alguno de los dos | Nº de semana; indicar si alguno viene de descanso |

**Interpretación corregida:** no asumir más puntos por ser partido divisional. Si hay sede
neutra, declararlo explícitamente. Si un equipo viene de bye week, señalar que tuvo tiempo
extra de preparación y descanso de lesiones — factor real en NFL sin equivalente directo en
el framework MLB.

---

## 2. Localía, visita, récords recientes e historial directo

Igual estructura que en MLB, ajustada a calendario de 17 partidos por temporada regular.

- Equipo local / equipo visitante / estadio (o "sede neutra")

### 2.1 Récord general y splits de localía/visita

| Equipo | Récord general | Casa | Visita | ATS (contra el spread) | Comentario |
| --- | --- | --- | --- | --- | --- |
| Visitante | W-L | W-L | W-L | W-L-Push | Rendimiento fuera de casa |
| Local | W-L | W-L | W-L | W-L-Push | Rendimiento en casa |

`ATS` (against the spread) no tiene equivalente en el framework MLB porque el mercado
principal de béisbol es moneyline/run line; en NFL el spread es el mercado central, así que
se agrega desde esta sección.

### 2.2–2.4 Últimos 5 partidos como local / como visitante / H2H

(NFL juega 17 partidos por temporada regular, no 162 — se usan **últimos 5**, no últimos 10,
para no diluir la muestra con temporadas pasadas irrelevantes).

| Fecha | Local | Visitante | Estadio | Marcador | Ganador | Total puntos | Cubrió spread |
| --- | --- | --- | --- | --- | --- | --- | --- |

### 2.5 Resumen estadístico de tendencias

| Elemento | Resultado |
| --- | --- |
| Récord últimos 5 del local en casa | W-L |
| Récord últimos 5 del visitante fuera | W-L |
| Récord últimos 5 enfrentamientos directos | Equipo A W — Equipo B W |
| Promedio de puntos anotados por el local | Promedio |
| Promedio de puntos permitidos por el local | Promedio |
| Promedio de puntos anotados por el visitante | Promedio |
| Promedio de puntos permitidos por el visitante | Promedio |
| Tendencia favorece | Local / Visitante / Over / Under |
| Advertencia del historial | No debe dominar si cambió el QB titular, hubo lesiones clave o cambió el coordinador ofensivo/defensivo |

---

## 3. Quarterbacks y unidad ofensiva: comparación completa

Reemplaza la sección de "Pitchers abridores". El QB es el jugador que más pesa en el
resultado, pero **no analiza solo** — se evalúa junto a línea ofensiva, corredores y
receptores, porque a diferencia de un abridor, un QB depende de 10 compañeros en cada jugada.

### 3.1 Identificación de QBs titulares

| Elemento | QB visitante | QB local |
| --- | --- | --- |
| Nombre | | |
| Equipo | | |
| Mano de lanzar | Derecho/Zurdo | Derecho/Zurdo |
| Estado | Confirmado/Cuestionable/Duda (injury report) | Confirmado/Cuestionable/Duda |
| Partidos como titular esta temporada | | |

### 3.2 Comparación general de temporada

| QB | Eq. | Cond. | Cmp% | Yds/Att | TD | INT | Passer Rating | QBR | ANY/A | EPA/play | CPOE | Sack% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### 3.3 Peso corregido para evaluar QBs

Igual que en MLB, **los últimos 5 partidos no pueden pesar más que la calidad de
temporada, las métricas avanzadas, el matchup y el clima/estadio.**

| Factor | Peso corregido | Interpretación |
| --- | --- | --- |
| Calidad de temporada (EPA/play, passer rating, QBR) | 20% | Base principal del análisis |
| Métricas avanzadas (ANY/A, CPOE, success rate) | 15% | Miden eficiencia real, no solo volumen |
| Protección del balón (INT%, fumble%, sack%) | 15% | Mide riesgo de entregar posesiones/puntos al rival |
| Matchup vs secundaria y línea defensiva rival | 15% | Compatibilidad contra el esquema defensivo actual |
| Soporte ofensivo (O-line, corredores, receptores disponibles) | 15% | Un QB no juega solo; lesiones en el ataque bajan su techo |
| Local/visita/clima/estadio | 10% | Ajusta por contexto (viento, frío, altitud, domo) |
| Últimos 5 partidos | 10% | Forma reciente, no factor dominante |

### 3.4 Fórmulas obligatorias

**Passer Rating (fórmula oficial NFL)**

```
a = clip(((Cmp/Att) - 0.3) × 5,        0, 2.375)
b = clip(((Yds/Att) - 3) × 0.25,       0, 2.375)
c = clip((TD/Att) × 20,                0, 2.375)
d = clip(2.375 - (INT/Att) × 25,       0, 2.375)
Passer Rating = (a + b + c + d) / 6 × 100
```

**ANY/A (Adjusted Net Yards per Attempt)** — más informativa que el passer rating porque
castiga sacks:

```
ANY/A = (PassYds + 20×PassTD − 45×INT − SackYds) / (Att + Sacks)
```

**Success Rate (base para EPA, análoga a la sección 5.7.3 de RE24 en MLB)**

Una jugada es "exitosa" si gana:
- ≥ 40% de las yardas por conseguir en 1er down
- ≥ 60% en 2do down
- 100% en 3er/4to down

**Nota sobre EPA (Expected Points Added):** en MLB el framework construye la matriz RE24
manualmente. En NFL **no hace falta construirla desde cero**: nflverse (la fuente que ya
usamos en `scripts/extract-nflverse.ts`) publica play-by-play con la columna `epa` ya
calculada sobre un modelo público de puntos esperados por down/distancia/yardlínea. Cuando
extraigamos play-by-play, el EPA/play vendrá listo para usar.

### 3.5–3.6 Bloques de análisis por QB (visitante y local)

a) Estadísticas generales de la temporada actual
b) Estadísticas como local/visitante
c) Últimos 5 partidos como local/visitante
d) Últimos 5 partidos totales
e) Últimos 3 enfrentamientos contra el rival actual
f) Rendimiento vs el esquema defensivo del rival (blitz%, cobertura man/zone)
g) Analizar si el QB tiene tendencia a forzar el balón (INT%) y si eso contradice un
   posible Over
h) Tamaño de muestra en intentos de pase (Att) de cada bloque, para aplicar shrinkage
   (sección 5.7.4)

### 3.7 Tabla de partidos recientes

| Fecha | QB | Condición | Rival | Att | Cmp | Yds | TD | INT | Sacks | EPA/play |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

### 3.8 Interpretación de QBs

- QB con mejor temporada: nombre y argumento estadístico
- QB que mejora por localía/visita: nombre y argumento
- QB en mejor forma reciente: nombre y argumento — **aplicar shrinkage antes de concluir**
- Mejor historial contra el rival: nombre y argumento
- Mayor riesgo de INT/pérdida de balón: nombre y argumento
- Mayor riesgo de sacks (línea ofensiva débil o rival con buen pass rush): nombre y argumento
- QB más confiable para 1Q: nombre
- QB más confiable para 1H: nombre
- Si el QB tiene tendencia alta a INT bajo presión: revisar primero 1H Under o Under antes
  que Over

### 3.9 Tabla final de ventaja de QB/ofensiva

> **Ventaja preliminar ofensiva:** Equipo/QB — pendiente de confirmar tras la regresión a
> la media (sección 5.7.4). No dar pick final todavía.

---

## 4. Defensa: unidades, lesiones/fatiga y matchup contra la ofensiva rival

Reemplaza la sección de "Bullpen". A diferencia del bullpen (grupo de relevistas que rota
partido a partido), la defensa de NFL **es la misma unidad durante todo el partido**, por
lo que el eje del análisis cambia: en vez de "quién entra fresco", lo relevante es
disponibilidad por lesiones (injury report), pass rush, y matchup de esquema.

> Defensa = eficiencia (EPA/play permitido) + salud del roster (injury report) + pass rush + secundaria vs receptores rivales

| Factor | Defensa visitante | Defensa local |
| --- | --- | --- |
| EPA/play permitido (total) | | |
| EPA/play permitido (pase) | | |
| EPA/play permitido (carrera) | | |
| Puntos permitidos por drive | | |
| % conversión de 3er down permitida | | |
| % touchdown en zona roja permitido | | |
| Pressure rate / sack rate generado | | |
| Takeaways por partido | | |
| Local/visitante | | |
| Últimos 5 en condición actual | | |
| Historial vs rival | | |
| Bajas por lesión en unidad clave (línea D, secundaria) | | |
| Riesgo 1Q | | |
| Riesgo 1H | | |
| Contradicción con Over | | |

### 4.1 Interpretación general de la defensa

- Defensa que permite más EPA/play por aire: Equipo
- Defensa que permite más EPA/play por tierra: Equipo
- Defensa con mejor pass rush (mayor pressure rate): Equipo
- Defensa con más takeaways: Equipo
- Defensa con estadística de puntos permitidos engañosa: Equipo — explicar con EPA/play
  (una defensa puede tener pocos puntos permitidos por buena suerte en zona roja, no por
  ser realmente dominante — equivalente al aviso de ERA vs FIP en MLB)
- Defensa con mayor riesgo de colapso tardío (4to cuarto): Equipo
- Si ambas defensas son fuertes: penalizar Over completo y favorito grande en el spread

### 4.2 Uso reciente, lesiones y disponibilidad (reemplaza "fatiga de bullpen")

| Equipo | Jugador clave | Posición | Estado injury report | Práctica de la semana | ¿Disponible el domingo? | Riesgo |
| --- | --- | --- | --- | --- | --- | --- |

Analizar si:

- El pass rusher principal está limitado/fuera (Questionable/Doubtful/Out)
- La secundaria titular está completa o hay suplentes en el slot/esquina
- Hubo partido en semana corta (Thursday Night Football) que reduce tiempo de recuperación
- El coordinador defensivo cambió de esquema recientemente
- Si no hay reporte de lesiones actualizado (se publica miér/juev/vier), **bajar confianza
  en total completo y en spread del favorito** — igual regla que MLB con bullpen sin datos
  de uso reciente.

> Si falta el injury report oficial de la semana, el pick completo no puede ser verde.

### 4.3 Unidades defensivas principales

| Jugador | Pos. | Rol | EPA/play permitido en su zona | Pressure% | Missed tackle% | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Nombre | EDGE | Pass rush principal | | | | |
| Nombre | CB | Cobertura #1 | | | | |
| Nombre | S | Seguridad libre | | | | |
| Nombre | LB | Contención de carrera | | | | |
| Nombre | DT | Presión interior | | | | |

### 4.4 Matchup defensa vs ofensiva rival

| Jugador defensivo | Rol | Receptor/corredor rival probable | Ventaja de matchup | Riesgo principal | Mercado afectado |
| --- | --- | --- | --- | --- | --- |

### 4.5 Conclusión obligatoria de la defensa

> **Ventaja preliminar defensiva:** Equipo

Explicar si la defensa recomienda mantener análisis de partido completo, preferir 1H,
preferir 1Q, evitar spread grande del favorito, buscar Over tardío (4to cuarto con
defensas cansadas), o esperar el injury report oficial.

---

## 5. Patrones, probabilidades y modelo matemático final

### 5.1 Relación QB/ofensiva vs defensa rival

```
Ventaja Ofensiva-Defensiva = Calidad de la ofensiva (EPA/play) − Fortaleza defensiva rival (EPA/play permitido)
```

Clasificación: ventaja clara de la ofensiva, ventaja ligera, equilibrado, ventaja ligera de
la defensa, ventaja clara de la defensa.

### 5.2 Riesgo de la defensa frente a la ofensiva rival

```
RiesgoDefensa = z(EPA/play permitido) + z(3rd down% permitido) + z(RZ TD% permitido) + z(bajas por lesión)
```

Si la defensa contradice el pick de partido completo, revisar 1H.

### 5.3 Puntos esperados por posesión — por qué NFL no usa Poisson simple sobre el total

**Esta es la adaptación matemática más importante del documento, no solo un cambio de
nombre.** En MLB, una carrera es un evento de valor 1 y el total de carreras por partido se
aproxima razonablemente con Poisson/Binomial Negativa directamente sobre el conteo. En NFL,
una posesión anotadora vale **3 puntos (gol de campo), 6-8 puntos (touchdown + punto extra
o 2 puntos), o 2 puntos (safety)** — el total de puntos no es un conteo de eventos
unitarios, así que Poisson sobre el total de puntos subestima la varianza real.

**Modelo correcto (dos capas):**

```
Capa 1 — número de posesiones que terminan en anotación:
  λ_posesiones_con_score = (posesiones ofensivas esperadas) × P(la posesión anota)
  P(la posesión anota) = función de EPA ofensivo propio vs EPA defensivo rival, ritmo de
  juego (plays/game), y % de conversión en zona roja

Capa 2 — valor de cada posesión anotadora (distribución categórica, no fija):
  P(Touchdown) ≈ % histórico del equipo (típicamente 55-65%)
  P(Gol de campo) ≈ % histórico del equipo (típicamente 30-40%)
  P(Safety) ≈ % histórico del equipo (típicamente 1-3%)
  P(Touchdown) se sub-divide en 6/7/8 puntos según % de 2-point conversion del equipo
```

El total de puntos del equipo es la **suma de N muestras de la Capa 2**, donde N sale de la
Capa 1. Esto solo se resuelve bien con **simulación de Monte Carlo** (sección 5.7.9) — en
NFL Monte Carlo deja de ser "el método para mercados combinados" (como en MLB) y pasa a ser
**el método principal para proyectar el total**, no un extra.

**Atajo aceptable cuando no hay tiempo para simular:** aproximar el total de puntos por
equipo con una distribución Normal, apoyada en evidencia empírica pública de apuestas NFL:
la desviación estándar del margen de victoria en NFL ronda **σ ≈ 13.5 puntos** (valor de
referencia habitual en la industria; verificar contra datos actuales de la temporada antes
de usarlo). Sirve para estimar rápido P(cubre spread) y P(Over/Under) sin correr una
simulación completa, con menos precisión que el modelo de dos capas.

```
Nunca subir el total por un solo factor.
```

| Condición | Ajuste | Impacto | Interpretación |
| --- | --- | --- | --- |
| Ambos QBs con buen ANY/A y bajo INT% | λ × 0.90 | Baja total | Menos posesiones desperdiciadas, pero también menos errores regalados |
| Rival con alto pressure rate | λ × 0.90 | Baja total | Más sacks/INTs bajo presión, menos puntos |
| Ambas defensas top-10 en EPA/play permitido | λ × 0.88 | Baja total completo | Menor probabilidad de drives largos |
| Clima con viento fuerte (>25 km/h) o lluvia intensa | λ × 0.90 | Baja pase y goles de campo largos | Penaliza Over, especialmente en estadios abiertos |
| Estadio domo/techo cerrado | λ × 1.05 | Sube total | Condiciones ideales para el ataque |
| Ofensiva/defensa titular con bajas confirmadas (QB backup, CB1 fuera) | λ × 0.92 o 1.08 según el lado afectado | Ajusta según quién pierde al titular | No sobreestimar sin confirmación oficial |
| Ritmo de juego alto (plays/game por encima del promedio liga) | λ × 1.05 | Sube total | Más posesiones = más oportunidades de anotar |
| Frío extremo (< 0°C) | λ × 0.93 | Baja total | Afecta el agarre del balón y el juego aéreo |

### 5.4 Modelo de simulación (reemplaza el modelo Poisson directo de MLB)

Hay dos niveles de granularidad para simular un partido. El framework usa el nivel 1 como
atajo rápido y el nivel 2 como modelo de referencia — **el nivel 2 ya tiene su estructura de
datos implementada en este repositorio** (ver 5.4.1).

**Nivel 1 — conteo de posesiones (rápido, agregado):**

```
Para cada equipo:
  1. Muestrear número de posesiones ofensivas del partido (Poisson/Normal según ritmo combinado)
  2. Para cada posesión, muestrear si anota (Bernoulli con p ajustado por matchup EPA)
  3. Si anota, muestrear el valor (categórica: TD 6/7/8, FG 3, Safety 2)
  4. Sumar → puntos del equipo en esa simulación

Repetir 20,000-50,000 veces (sección 5.7.9) → distribución empírica de:
  - Puntos por equipo
  - Márgenes (para spread)
  - Totales combinados (para Over/Under)
```

**Nivel 2 — cadena de Markov jugada por jugada (granular, el modelo real detrás de EPA/WP):**

```
Para cada posesión, en vez de un solo Bernoulli "¿anota o no?":
  1. Empezar en un estado s = (down, distancia, yardline100, tiempo restante)
  2. Muestrear la siguiente jugada (tipo + yardas) según las transiciones observadas en
     `plays` para equipos con perfil ofensivo/defensivo similar al matchup real
  3. Actualizar el estado s' con el resultado de la jugada
  4. Repetir hasta llegar a un estado absorbente: touchdown, gol de campo, pérdida de
     balón, punto, safety o fin de cuarto/mitad (los mismos 9 resultados que ya están en
     `drives.result`, sección 5.4.1)
  5. El resultado absorbente define los puntos de esa posesión exactamente, sin necesidad
     de la distribución categórica del Nivel 1 — la trayectoria completa ya lo determina
```

Probabilidad de victoria, empate (raro en NFL, pero posible) y cobertura de spread se leen
directo de la distribución simulada, igual que en MLB se leía de la suma de Poissons. El
Nivel 2 es más costoso de calibrar (necesita suficientes jugadas por matchup para que las
transiciones no sean puro ruido — aplicar shrinkage, sección 5.7.4) pero es el que de verdad
respeta la dinámica del juego: down y distancia condicionan qué tan probable es cada
resultado, no solo "cuántas posesiones hay".

#### 5.4.1 Estructura de datos para el proceso estocástico (implementado)

El estado `s` del Nivel 2 y los resultados absorbentes de cada posesión ya están
modelados en `prisma/schema.prisma` y poblados por `scripts/extract-pbp.ts` desde el
play-by-play de nflverse:

```
model Play {
  down, yardsToGo, yardLine100, quarter, gameSecondsRemaining   // el estado s
  playType, yardsGained                                        // la transición observada
  epa, winProbability, homeWinProbability                       // ya resueltos por nflverse
  isTouchdown, isInterception, isFumbleLost, isSack, isSuccess  // eventos de la jugada
}

model Drive {
  driveNumber, startYardLine, endYardLine, playCount
  result   // TouchDown / Field goal / Punt / Turnover / Turnover on downs / Safety / End of half
}
```

Con esto, dos cosas que antes eran teóricas ya se pueden calcular directo de la base de
datos:

- **La matriz de transición empírica** (sección 5.7.3): agrupar `plays` por
  `(down, yardsToGo bucket, yardLine100 bucket)` y contar a qué estado siguiente se mueve
  cada jugada, o si termina la posesión — es literalmente estimar `P(s'|s)` por conteo,
  la definición de una cadena de Markov.
- **Los 9 estados absorbentes reales de una temporada** — ya verificado con datos de 2024
  (6,134 posesiones): Punt 34%, Touchdown 23%, Field goal 16%, Turnover 10%, End of half 7%,
  Turnover on downs 5%, Missed field goal 3%, Opp touchdown 1%, Safety 0.3%. Esta
  distribución (no un valor inventado) es la que debe calibrar la Capa 2 del Nivel 1.

**Por qué es semi-Markov, no Markov puro:** el tiempo que dura cada jugada es en sí mismo
aleatorio (una jugada por aire con el balón fuera del campo no corre el reloj, una carrera
sí) y depende del contexto (two-minute drill vs. ritmo normal). `gameSecondsRemaining` se
guarda por jugada precisamente para poder estimar esa duración empíricamente en vez de
asumirla constante — necesario para simular con reloj real (garbage time, desesperación de
los últimos 2 minutos, etc.).

**Visualización de este cálculo (implementado):** la página `/partidos/[gameId]` grafica
`homeWinProbability` jugada por jugada (la curva de probabilidad de victoria, calculada por
nflverse sobre este mismo modelo de estados) y lista las posesiones del partido con su
estado absorbente — la forma más directa de *ver* la cadena de Markov en acción sobre un
partido real, no solo describirla en la fórmula.

#### 5.4.2 Modelo v2: la cadena resuelta por iteración de valor (implementado)

`src/lib/markov-model.ts` construye y resuelve la cadena sobre los datos reales:

- **Estado:** `s = (down 1–4, distancia {1–3, 4–6, 7–10, 11+}, zona de 10 yardas)` → 160
  estados, sostenidos por ~41,500 jugadas de 2024.
- **Valor terminal de una posesión:** puntos anotados (TD 6.94, FG 3, safety −2, TD del
  rival −6.94) **más** el valor de la siguiente posesión con signo: `− EP(s_rival)` si el
  balón pasa al rival (despeje, pérdida, gol de campo fallado, o tras anotar y patear). Así
  entregar el balón en tu propia zona vale negativo, como en el modelo "next score".
- **Iteración de valor:** como `EP` aparece en ambos lados, se parte de `EP = 0` y se repite
  `EP(s) ← promedio[valor terminal]` hasta que ningún estado cambie más de 0.001. Con los
  datos de 2024 converge en 63 iteraciones (cambio máximo: 6.15 → 0.0009, caída geométrica).
- **Shrinkage jerárquico (5.7.4):** cada celda se regresa hacia el promedio de su
  `(down, zona)`, y este hacia el de la zona, con `k = 25`; 25 de 160 estados tienen menos de
  20 jugadas.

**Resultados medidos:**

| Modelo | Jugadas comparadas | Correlación con `epa` de nflverse | Diferencia media |
| --- | --- | --- | --- |
| v1 · solo 1er down, pérdidas valen 0 | 16,673 | 0.80 | 0.46 |
| v2 · cadena completa, iteración de valor | 38,699 | **0.945** | 0.35 |

Valores de EP obtenidos (1ro y 10): propia 25 ≈ 0.8, medio campo ≈ 2.2, rival 25 ≈ 3.3,
rival 5 ≈ 4.3. En 4to y corto dentro de tu propia zona el EP es negativo (≈ −1.5).

**Simulador Nivel 2:** muestrea, en cada estado, una jugada real ocurrida en ese mismo estado
y avanza hasta un estado absorbente. Desde 1ro y 10 en la propia 25 da 2.03 puntos por
posesión contra 1.78 reales (1,287 posesiones); desde la rival 35, 3.88 contra 3.23. La
brecha tiene una causa identificada: sin reloj, el simulador nunca termina una posesión por
fin de mitad (6.6% y 9.1% de las posesiones reales en esas zonas). **Siguiente mejora:**
agregar el tiempo restante al estado (semi-Markov) y el marcador.

La página publicada (vista "Laboratorio") muestra el mapa de calor de los 160 estados, la
convergencia de la iteración, EP por down, la validación v1/v2 y el simulador interactivo.

### 5.5 Probabilidad por mercado

| Mercado | Prob. estimada | Dato que apoya | Dato que contradice | Riesgo |
| --- | --- | --- | --- | --- |
| 1Q Moneyline | | | | |
| 1Q Total | | | | |
| 1H Moneyline | | | | |
| 1H Spread | | | | |
| 1H Total | | | | |
| Moneyline completo | | | | |
| Spread completo | | | | |
| Total completo | | | | |
| Team total visitante | | | | |
| Team total local | | | | |
| Primer equipo en anotar | | | | |
| Props principales (QB, RB, WR) | | | | |

### 5.6 Razones preliminares para cancelar un pick

- QB superior, pero línea ofensiva/defensa débil
- Buena 1H, pero mal partido completo
- Buen historial, pero muestra pequeña de partidos como titular
- Buen passer rating, pero ANY/A y EPA/play malos (rating inflado por volumen, no eficiencia)
- Titular cuestionable en el injury report, no confirmado
- Defensa con bajas en la secundaria o línea defensiva
- Corredor principal fuera (cambia todo el plan de juego)
- Clima adverso (viento, lluvia, frío extremo)
- Spread ya se movió demasiado (line movement)
- Equipo favorito inflado por narrativa/mercado público
- Racha reciente contra rivales débiles
- Pick de Over contradicho por alto pressure rate rival
- Favorito grande en el spread contradicho por total proyectado bajo

### 5.7 Fundamentos matemáticos ampliados

#### 5.7.1 Pythagorean Expectation (NFL) — detectar suerte de un equipo

```
Win%esperado = PF^n / (PF^n + PA^n)
```

donde `PF` = puntos a favor en la temporada, `PA` = puntos en contra. En MLB el exponente
es 1.83 (Baseball-Reference). En NFL la investigación pública (Football Outsiders, a partir
del trabajo original de Daryl Morey) usa **n ≈ 2.37** como valor de referencia — verificar
el valor vigente cada temporada, igual que se advierte con la constante de FIP en MLB.

**Aplicación:** idéntica a MLB — un equipo muy por encima de su Pitagórico probablemente
tenga récord inflado por suerte en partidos cerrados (ej. exceso de victorias por 1-3
puntos) y no debe pesar tanto como sugiere la tabla de récords.

#### 5.7.2 Fórmula Log5 — probabilidad de un enfrentamiento directo

Sin cambios respecto a MLB — es matemática universal, no específica de béisbol:

```
P(A gana) = (pA − pA·pB) / (pA + pB − 2·pA·pB)
```

usando el win% Pitagórico de cada equipo como `pA`, `pB`. En sede neutra no se suma ventaja
de local.

#### 5.7.3 Expected Points (EP) — el equivalente NFL de la matriz RE24

En MLB, RE24 asigna un valor esperado de carreras a cada combinación de corredores en base
× outs. En NFL el concepto equivalente es el modelo de **Puntos Esperados (EP)** por
combinación de down, distancia y yardlínea: p. ej., 1er down y 10 en la yarda 25 propia
vale menos en EP que 1er down y 10 en la yarda 5 rival. **EPA/play (sección 3.4) es
simplemente la diferencia de EP entre el antes y el después de cada jugada.**

**Aplicación:** sustento formal de por qué no basta con proyectar yardas totales (sección
6.6): el valor real de una jugada depende del down, la distancia y la yardlínea en que
ocurre, no es un evento fijo — igual que en MLB un hit vale distinto según el estado base-out.

**Formalización como proceso estocástico:** EP es la función de valor de una cadena de
Markov cuyos estados son `(down, distancia, yardlínea, tiempo restante)` y cuyos estados
absorbentes son touchdown/gol de campo/pérdida de balón/punto/safety/fin de periodo — el
mismo espacio de estados que `model Play`/`model Drive` (sección 5.4.1). `EP(s)` es el valor
esperado descontado de puntos desde `s` hasta el estado absorbente, y `EPA(jugada) =
EP(s') − EP(s)` es la diferencia de valor entre dos estados consecutivos, exactamente como
una recompensa de un paso en un proceso de decisión de Markov (MDP) sin decisiones — aquí no
hace falta re-derivar `EP(s)` porque nflverse ya publica su valor resuelto en la columna
`epa` de cada jugada, que ya extraemos y guardamos.

#### 5.7.4 Regresión a la media / shrinkage bayesiano

Fórmula sin cambios:

```
θ̂ = (n / (n+k)) × x̄observado + (k / (n+k)) × μliga
```

`n` = tamaño de muestra (intentos de pase, jugadas defendidas), `k` = punto de
estabilización. Los puntos de estabilización cambian de unidad respecto a MLB (PA/BF →
intentos de pase / jugadas):

| Métrica (QB) | Se estabiliza en (aprox.) | Métrica (defensa) | Se estabiliza en (aprox.) |
| --- | --- | --- | --- |
| Cmp% | ~150 intentos | EPA/play permitido | ~200 jugadas |
| INT% | ~200 intentos | 3rd down % permitido | ~100 jugadas de 3er down |
| TD% | ~200 intentos | Pressure rate | ~150 pass rushes |
| EPA/play | ~250 intentos | Sack rate | ~150 pass rushes |

Valores de referencia — **verificar contra investigación pública actualizada** (Football
Outsiders, PFF, nflverse) antes de tratarlos como definitivos, igual que MLB cita a Russell
Carleton como fuente y no un valor inventado.

**Aplicación:** justifica por qué los últimos 5 partidos (sección 3.3) solo pesan 10%: un
QB necesita más de 150-250 intentos de pase para que su Cmp%/EPA por partido deje de estar
dominado por ruido, y 5 partidos rara vez llegan a esa muestra.

#### 5.7.5 Distribución del total de puntos: por qué no es Poisson puro

Ver sección 5.3/5.4 — desarrollado ahí porque es la adaptación central del modelo, no una
nota lateral como en MLB.

#### 5.7.6 Inferencia bayesiana — actualizar la probabilidad con nueva información

Sin cambios conceptuales:

```
P(θ | dato nuevo) = P(dato nuevo | θ) · P(θ) / P(dato nuevo)
```

**Aplicación NFL:** el análisis se hace en al menos dos pasadas — miércoles/jueves con el
primer injury report, y viernes/sábado con el reporte final y clima confirmado. Cada dato
nuevo (estado final de un titular, clima confirmado, línea movida) actualiza la probabilidad
prior en vez de repetir el análisis desde cero.

#### 5.7.7 Rating Elo con ajuste por QB

Sin cambios en la fórmula — y a diferencia de MLB (donde "Elo ajustado por abridor" es una
extrapolación razonable pero no estándar), **en NFL este método ya existe y está publicado**
(FiveThirtyEight/ESPN "QB Elo"): el Elo de franquicia se ajusta con un valor específico del
QB titular del día, restando valor cuando juega un suplente.

```
EA = 1 / (1 + 10^((RB − RA)/400))
R'A = RA + K·(SA − EA)
```

Se suma un bono fijo de local (omitido en sede neutra) y se mezcla el Elo de franquicia con
el ajuste por QB titular.

**Aplicación:** tercera estimación independiente de probabilidad de victoria, usada para
triangular junto con Log5 y el modelo de simulación (sección 10).

#### 5.7.8 Kelly Criterion — tamaño de apuesta

Sin cambios — matemática de banca, no de deporte:

```
f* = bp − q / b = p − q/b
```

Se recomienda Kelly fraccional (1/4 a 1/8) para reducir varianza frente a errores de
estimación de `p`.

#### 5.7.9 Simulación de Monte Carlo

En MLB es una herramienta para mercados combinados. **En NFL es el método principal para
proyectar el total** (sección 5.4), porque el total de puntos no es un conteo simple de
eventos. Simular 20,000-50,000 partidos muestreando posesiones, probabilidad de anotar y
valor de cada anotación da la distribución completa de márgenes y totales, con intervalos
de confianza en vez de un número puntual.

#### 5.7.10 Correlación entre mercados

Sin cambios conceptuales: dos mercados del mismo partido casi nunca son independientes
(ej. 1H Under y Total completo Under comparten la misma causa: ambas defensas dominantes).
Multiplicar probabilidades individuales para "combinarlas" sobreestima la probabilidad
conjunta real.

> Antes de recomendar dos picks del mismo partido juntos, verificar si comparten el mismo
> supuesto causal.

---

## 6. Análisis Over/Under y desarrollo probable por cuartos

Reemplaza "desarrollo probable por entradas". La unidad de tiempo pasa de entradas (9) a
cuartos (4), con cortes de mercado en **1Q** (primer cuarto, equivalente a F3) y **1H**
(primera mitad, equivalente a F5).

> Si el partido proyecta pocos puntos, revisar primero Under/1H Under antes que
> Moneyline o Spread.

### 6.1 Datos base para el total

| Factor | Favorece Over | Favorece Under | Comentario |
| --- | --- | --- | --- |
| QB/ofensiva visitante | | | |
| QB/ofensiva local | | | |
| EPA/play ofensivo y defensivo de ambos equipos | | | |
| Últimos 5 partidos | | | |
| Splits local/visitante | | | |
| Historial contra rival | | | |
| Titulares confirmados/cuestionables (injury report) | | | |
| Ritmo de juego (plays/game, seconds/play) | | | |
| Eficiencia en zona roja (TD% vs FG%) | | | |
| Defensas de ambos equipos | | | |
| Estadio (domo/aire libre) | | | |
| Clima (viento, lluvia, temperatura) | | | |
| Tendencia reciente Over/Under | | | |
| Proyección de pressure rate | Si hay mucha presión proyectada, cuidado con Over |

### 6.2 Lectura de QBs para el total

Para cada QB: si favorece Under temprano (ritmo lento, mucho juego terrestre), si tiene
riesgo de pérdidas de balón, si su línea ofensiva sostiene protección, si su ANY/A
contradice su passer rating, si mejora en el segundo tiempo tras ajustes, y si su tendencia
a jugadas explosivas contradice un posible Under.

### 6.3 Filtro de pressure rate contra Over

Reemplaza el "filtro de ponches" de MLB. Si la defensa rival tiene un pass rush fuerte, se
debe tener cuidado con el Over — más presión significa más sacks, más INTs bajo presión y
menos drives sostenidos.

> Defensa con pressure rate alto + QB con sack% alto = revisar 1H Under/Under antes que Over

Si se cumplen tres o más condiciones, el Over debe bloquearse salvo razón muy fuerte para
mantenerlo:

| Condición | Ajuste | Lectura |
| --- | --- | --- |
| Defensa rival con alto pressure rate | Baja expectativa de drives largos | Favorece Under temprano |
| QB con alto sack% | Menos jugadas limpias | Favorece Under |
| Clima con viento fuerte | Penaliza pase largo y goles de campo | Penaliza Over |
| Ofensiva con bajo ritmo (plays/game bajo) | Menos posesiones | Baja probabilidad de rally ofensivo |
| Estadio al aire libre en clima frío | Baja eficiencia de pase | Favorece Under completo |

### 6.4 El estadio no puede dominar el análisis

Un estadio "ofensivo" (domo, altitud, superficie rápida) solo debe subir el total si
también hay ritmo alto, ofensivas sanas (sin bajas clave) y clima favorable.

> Estadio ofensivo solo sube el total si hay ritmo alto + ofensivas sanas + clima favorable

No basta con afirmar: "Estadio ofensivo ⇒ Over".

### 6.5 Lectura defensiva para el total

Se analiza cómo cambia el total según la salud de ambas defensas: EPA/play permitido,
3rd down% permitido, red zone TD% permitido, pressure rate, takeaways, bajas por lesión en
unidades clave, historial de la defensa contra el estilo de ataque rival.

> Defensas fuertes + clima adverso = Under o no bet al total

### 6.6 Diferenciar yardas de puntos

No basta con proyectar yardas totales o primeros downs. Para proyectar puntos se deben
evaluar eficiencia en zona roja, jugadas explosivas (20+ yardas), pérdidas de balón y
defensa rival en 3er down — equivalente directo a la regla MLB de "diferenciar hits de
carreras" (sección 5.7.3: el valor depende del contexto down/distancia/yardlínea, no es un
evento fijo).

> Para proyectar puntos, evaluar zona roja + jugadas explosivas + turnovers + 3er down, no solo yardas totales

| Dato | Mercado que afecta |
| --- | --- |
| Yardas totales sin contexto | Props de yardas |
| Eficiencia en zona roja (TD% vs FG%) | Team total, spread |
| Jugadas explosivas permitidas | Total, Over tardío |
| Turnovers forzados | Moneyline, spread |
| 3rd down% ofensivo/defensivo | Posesión del balón, total |

### 6.7 Puntos esperados por tramos

```
λ_1Q,total = λ_1Q,visitante + λ_1Q,local
λ_1H,total = λ_1H,visitante + λ_1H,local
λ_Partido,total = λ_Partido,visitante + λ_Partido,local
```

### 6.8 Probabilidad con modelo de simulación

Se calculan, vía la simulación de la sección 5.4: probabilidad 1Q Over/Under, 1H
Over/Under, Over/Under de partido completo, probabilidad de que cada equipo anote primero,
y probabilidad de team totals.

Las probabilidades deben compararse en las líneas relevantes del mercado (ej. 37.5, 41, 44,
47.5, 51). No debe darse una sola respuesta si la línea cambia mucho el valor.

### 6.9 Desarrollo probable por cuartos

```
1Q: Visitante X — Local Y     1H: Visitante X — Local Y     Final: Visitante X — Local Y
```

Analizar: qué equipo debería anotar primero, si el daño probable viene por aire o por
tierra, en qué cuarto puede cambiar el partido (ajustes de medio tiempo), si el total
depende más de la 1H o de puntos tardíos con el partido ya definido (garbage time), si las
defensas pueden romper el Under, si las ofensivas pueden romper el Over.

### 6.10 Tabla de decisiones por línea

| Línea | Over estimado | Under estimado | Lectura | Decisión |
| --- | --- | --- | --- | --- |
| 1Q total | | | | |
| 1H total | | | | |
| Total completo (línea del mercado) | | | | |
| Team total visitante | | | | |
| Team total local | | | | |

### 6.11 Contradicciones del total

- Ofensivas favorecen Over, pero ambas defensas favorecen Under
- QB vulnerable, pero titulares defensivos rivales no confirmados
- Over depende de jugadas explosivas, pero clima favorece juego terrestre
- Under depende de la defensa, pero hay bajas confirmadas en la línea defensiva
- Estadio reduce el juego aéreo (viento/frío)
- Total ya se movió demasiado
- Línea quedó muy ajustada
- El equipo favorito puede ganar sin necesidad de muchos puntos (garbage time del rival)
- El prop de turnovers contradice el Over

### 6.12 Conclusión Over/Under

- Mejor línea para Over:
- Mejor línea para Under:
- Línea donde no hay valor:
- Mercado más conveniente: Total completo/1H total/team total
- Información faltante antes de apostar:
- Clasificación: Pick fuerte / Pick moderado / Lean / Esperar información / No bet
- Semáforo: 🟢 Verde / 🟡 Amarillo / ⚪ Gris / 🔴 Rojo

> **Regla final:** si el total proyectado cae muy cerca de la línea del mercado, no forzar
> pick. Buscar mejor valor en 1H total, team total o props.

---

## 7. Cuotas, probabilidad implícita y búsqueda de valor

Mismo objetivo que en MLB: no confirmar el pick más probable, sino encontrar si existe
valor real. Los mercados cambian de nombre (Run Line → Point Spread) pero la matemática de
esta sección es idéntica.

### 7.1 Mercados a cotizar

Moneyline, Point Spread, Total completo, Team totals, 1Q Moneyline, 1Q total, 1H Moneyline,
1H Spread, 1H total, Primer equipo en anotar, Props de QB (yardas de pase, TDs, INTs),
Props de RB (yardas de carrera, TDs), Props de WR/TE (recepciones, yardas, TDs), Anytime TD
scorer.

| Mercado | Casa 1 | Casa 2 | Casa 3 | Mejor cuota | Movimiento de línea |
| --- | --- | --- | --- | --- | --- |

### 7.2–7.4 Probabilidad implícita, comparación y precio máximo aceptable

Fórmulas sin cambios respecto a MLB:

```
Momio negativo:  P_implícita = |m| / (|m| + 100)
Momio positivo:  P_implícita = 100 / (m + 100)

Edge = P_estimada − P_implícita   (usar SIEMPRE la probabilidad triangulada: Log5 + Elo/QB-Elo + simulación Monte Carlo)

m_justo = −100p/(1−p)   si p ≥ 0.5
m_justo =  100(1−p)/p   si p < 0.5
```

### 7.5 Filtro contra favoritos caros

```
Favorito caro + total proyectado bajo = buscar Under, 1H Under, props de defensa/turnovers o no bet
```

| Pregunta | Si la respuesta es sí | Ajuste |
| --- | --- | --- |
| ¿El moneyline está inflado? | Evitar moneyline | Bajar confianza |
| ¿El total proyectado es bajo? | Evitar spread grande | Revisar Under o 1H |
| ¿La defensa rival puede competir? | Evitar favorito grande | Revisar spread más corto o 1H |
| ¿El pick depende de que el rival tenga bajas confirmadas? | Bajar confianza | Requiere confirmación oficial |

### 7.6 Mercados alternativos

Si el moneyline no tiene valor: 1H Moneyline, 1H Spread, Team total 1H, Props de QB/RB/WR,
Primer equipo en anotar, Anytime TD scorer.

### 7.7 Razones para cancelar el pick

- Favorito inflado
- Movimiento de línea ya consumió el valor
- Cuota buena pero titular no confirmado (injury report pendiente)
- Total movido por clima
- Prop dependiente de jugador cuestionable
- Defensa contradice moneyline completo
- QB limitado por lesión no reportada oficialmente
- Mercado público muy cargado a un lado (narrativa de equipo "de moda")
- Diferencia grande entre casas
- El pick depende del mismo supuesto que otro pick

### 7.8 Tabla final de valor

| Mercado | Pick | Mejor momio | P. implícita | P. estimada | Edge | Riesgo principal |
| --- | --- | --- | --- | --- | --- | --- |

Semáforo: 🟢/🟡/⚪/🔴 — Confianza 1-10

---

## 8. Auditoría final de contradicciones y decisión corregida

Misma estructura y misma regla central que MLB — **no se debe elegir el mercado que predice
al ganador, sino el mercado que mejor representa el guion del partido con menor
contradicción.**

```
Modelo estadístico + Guion del partido + Cuota con edge
```

### 8.2 Dependencia de supuestos

| Pick | Supuesto principal | Si el supuesto falla | Observación | Riesgo |
| --- | --- | --- | --- | --- |
| Moneyline favorito | Defensa rival no puede parar la ofensiva | Pierde valor | Depende de un solo matchup | Alto |
| Over total | Ambas defensas permiten drives largos | Pierde valor | Requiere clima favorable también | Alto |
| 1H Under | Ambas defensas dominan temprano | Pierde valor | Depende de pass rush sostenido | Medio |
| Prop QB Over yardas | Rival no genera presión | Pierde valor | Mismo supuesto que moneyline favorito | Alto |

### 8.3 Auditoría obligatoria antes del pick final

1. No confundir predicción con valor.
2. No sobreponderar los últimos 5 partidos del QB — comparar temporada completa, EPA/play,
   ANY/A, matchup específico, clima y titulares confirmados.
3. Si el pick depende de que la defensa rival colapse, verificar clima, línea ofensiva
   rival, injury report, pressure rate y tendencia de turnovers.
4. Si se proyecta pressure rate alto contra el QB, revisar primero 1H Under y Under completo.
5. El estadio/clima no decide solo — un estadio "ofensivo" solo sube el Over si también hay
   ritmo alto y ofensivas sanas.
6. Si ambas defensas son top-10 en EPA/play permitido, penalizar Over completo y favorito
   grande en el spread.
7. Diferenciar yardas de puntos — usar zona roja, jugadas explosivas, turnovers y 3er down,
   no solo yardas totales.
8. Hacer la tabla de dependencia de supuestos (8.2).
9. Antes de elegir un spread grande, revisar el total proyectado — evitar favoritos -7 o
   más si el total esperado es bajo, salvo defensa rival muy débil confirmada.
10. Antes de elegir team total Over, verificar que el equipo pueda anotar touchdowns y no
    solo mover el balón entre las yardas 20.
11. Si el partido es divisional, no asumir automáticamente más puntos.
12. Si falta el injury report oficial, el clima confirmado o los titulares confirmados,
    marcar el pick como gris o amarillo, nunca verde.
13. El pick final debe sobrevivir tres filtros: estadístico, guion del partido, mercado/cuota.
14. Si el análisis favorece Under y al mismo tiempo favorito grande en el spread, revisar
    contradicción.
15. Si no hay edge claro, recomendar no bet.
16. Verificar correlación entre picks del mismo partido antes de recomendarlos juntos.
17. Si algún campo obligatorio de la tabla de completitud (sección 9) está vacío, el pick
    de esa sección no puede ser Verde bajo ninguna circunstancia.

### 8.4 Tabla final de decisión corregida

| Mercado | Modelo | Guion | Cuota | Contradicción | Semáforo | Decisión final |
| --- | --- | --- | --- | --- | --- | --- |
| Moneyline | Sí/No | Sí/No | Sí/No | Alta/Media/Baja | | Pick/Lean/No bet |
| Spread | Sí/No | Sí/No | Sí/No | Alta/Media/Baja | | Pick/Lean/No bet |
| Total | Sí/No | Sí/No | Sí/No | Alta/Media/Baja | | Pick/Lean/No bet |
| 1H | Sí/No | Sí/No | Sí/No | Alta/Media/Baja | | Pick/Lean/No bet |
| Team total | Sí/No | Sí/No | Sí/No | Alta/Media/Baja | | Pick/Lean/No bet |
| Prop QB/RB/WR | Sí/No | Sí/No | Sí/No | Alta/Media/Baja | | Pick/Lean/No bet |

### 8.5–8.6 Recomendación final

- Mejor pick por valor / Mejor pick 1H / Mejor total / Mejor prop
- Pick con valor pero alto riesgo / Pick que parece probable pero no tiene valor
- Pick que se debe evitar / Mercado donde conviene esperar mejor cuota
- Stake sugerido (Kelly fraccional 1/4-1/8): % de bankroll

> **Corrección central:** no elijas el mercado que predice al ganador; elige el mercado que
> mejor representa el guion del partido con menor contradicción.
>
> **Regla final:** proteger el bankroll es más importante que forzar una apuesta.

---

## 9. Fuentes de datos: qué usar, para qué, y qué falta si solo usas una

### 9.1 nflverse-data — ya implementado en este proyecto

`scripts/extract-nflverse.ts` ya descarga de
[nflverse-data](https://github.com/nflverse/nflverse-data) (datos abiertos, sin scraping ni
API keys): equipos, rosters, calendario/resultados y estadísticas semanales por jugador.
Es el equivalente directo de "SofaScore investigado a fondo" en el framework MLB, con una
ventaja: nflverse **sí** publica play-by-play con EPA precalculado y una API/librería
documentada (`nfl_data_py` en Python, o los CSV de releases que ya consumimos directo en
TypeScript).

**Ya implementado:** `scripts/extract-pbp.ts` descarga
`pbp/play_by_play_{season}.csv.gz` y lo carga como `Drive` + `Play` (down, distancia,
yardlínea, tiempo restante, EPA, win probability por jugada) — la base de datos para las
secciones 3, 4, 5 y 5.7.3 (EPA/play, success rate) y para la simulación Nivel 2 (5.4.1).

**Lo que todavía falta agregar a la extracción para completar esta sección:**

- Pressure rate / pass rush por jugador — no viene precalculado en el pbp de nflverse, hay
  que derivarlo de columnas de sacks/QB hits o de una fuente con grades (PFF)
- Injury reports semanales — no está en nflverse-data de forma estructurada; requiere fuente
  complementaria
- Clima por estadio y semana

### 9.2 Fuentes complementarias necesarias

| Dato requerido | Fuente recomendada | Qué obtener exactamente |
| --- | --- | --- |
| Play-by-play con EPA, success rate | nflverse (`pbp`) | EPA/play, success rate, down/distancia/yardlínea |
| Injury report oficial semanal | ESPN API / Pro Football Reference | Estado (Out/Doubtful/Questionable), posición, jugador |
| Passer rating, QBR avanzado | Pro Football Reference / ESPN | Passer rating, ANY/A, QBR |
| Grades avanzados (pass rush, coverage) | PFF (Pro Football Focus, de pago) | Grades por jugador y por jugada |
| Momios de múltiples casas | The Odds API / SportsGameOdds | Línea y momio por casa, por mercado |
| Clima/viento del estadio | API meteorológica (Open-Meteo) | Velocidad/dirección del viento, temperatura, precipitación |
| Ritmo de juego (plays/game, seconds/play) | Derivado de play-by-play propio | Plays por partido, tiempo de posesión |

### 9.3 Regla de completitud obligatoria

Igual que en MLB: **el análisis no puede avanzar a la siguiente sección ni asignar
semáforo Verde si un campo obligatorio está vacío.**

| Sección | Campos obligatorios | Fuente primaria | Si falta → |
| --- | --- | --- | --- |
| 1-2 | Conferencia/división de ambos equipos, récord L5 local/visita, H2H | nflverse | Baja confianza histórica |
| 3 | Passer rating, ANY/A, EPA/play, últimos 5, splits local/visita | nflverse (pbp) + PFR | Bloquea Verde en moneyline/1H/props |
| 4 | EPA/play permitido, injury report, pressure rate | nflverse (pbp) + ESPN | Bloquea Verde en total y spread |
| 5 | Ritmo de juego, ajustes multiplicativos con dato real | nflverse (pbp) + cálculo propio | Bloquea Verde en total |
| 6 | Titulares confirmados, clima/viento, estadio | ESPN + Open-Meteo | Bloquea Verde en total y team total |
| 7 | Momios de al menos 2 casas | Odds API | Sin edge calculable → no bet |

---

## 10. Algoritmo maestro (paso a paso)

```
FASE 0 -- INGESTA CON GATE DE COMPLETITUD
  1. nflverse: equipos, rosters, calendario, resultados         [YA IMPLEMENTADO]
  2. nflverse: play-by-play con EPA por jugada                  [PENDIENTE]
  3. ESPN / PFR: injury report semanal, QBR avanzado             [PENDIENTE]
  4. Odds API: momios de 2-3 casas, verificación cruzada         [PENDIENTE]
  5. API meteorológica: clima/viento por estadio y semana        [PENDIENTE]
  SI falta un campo obligatorio -> campo_faltante = true
    -> el resultado NUNCA podrá ser semáforo Verde (máximo Amarillo)

FASE 1 -- AJUSTE ESTADÍSTICO (regresión a la media)
  6. Shrinkage bayesiano por métrica según punto de estabilización (sección 5.7.4)
  7. Pythagorean win% esperado (n≈2.37) vs récord real -> detectar "suerte"

FASE 2 -- TRIANGULACIÓN DE PROBABILIDAD DE VICTORIA
  8. Calcular P(gana local) por 3 métodos independientes:
     a) Log5 con win% ajustado (Pitagórico)
     b) Elo de equipo + ajuste por QB titular del día
     c) Simulación Monte Carlo de posesiones (sección 5.4)
  9. Si los 3 métodos coinciden (~5pp) -> confianza alta
     Si divergen (>10pp) -> confianza baja, explicar la contradicción

FASE 3 -- MODELO DE PUNTOS Y TOTAL (dos capas, sección 5.3-5.4)
  10. Estimar posesiones ofensivas esperadas por equipo (ritmo combinado)
  11. Estimar P(la posesión anota) por matchup EPA ofensivo vs defensivo
  12. Simular valor de cada posesión anotadora (TD 6/7/8, FG 3, Safety 2)
  13. Monte Carlo (20,000-50,000 simulaciones) -> distribución de puntos, márgenes, totales

FASE 4 -- VALOR DE MERCADO
  14. Momios -> probabilidad implícita
  15. Edge = P_estimada (triangulada) - P_implícita
  16. Momio justo y momio mínimo aceptable
  17. Kelly fraccional (1/4 a 1/8) -> stake sugerido

FASE 5 -- AUDITORÍA
  18. Los 17 filtros de contradicción (sección 8.3)
  19. Correlación entre picks del mismo partido (sección 5.7.10)
  20. Si campo_faltante = true -> forzar semáforo <= Amarillo, sin excepción

FASE 6 -- SALIDA
  21. Por mercado: semáforo, pick, cuota mínima, edge, stake, razón en 1 línea,
      y qué dato faltó si aplica
  22. Filtrar salida final: solo picks Verde (o Verde+Amarillo si se pide más volumen)
```

---

## Nota final

Este framework es una herramienta de análisis estadístico, no garantiza resultados: las
apuestas deportivas implican riesgo financiero real y ningún modelo elimina la
incertidumbre del juego. La disciplina de la sección 8 (auditoría de contradicciones) es
tan importante como la matemática de la sección 5: un modelo puede recomendar con fuerza un
mercado que termine perdiendo, y la auditoría es la que evita convertir esa confianza
numérica en una apuesta mala.

**Estado de implementación en este repositorio (referencia rápida):**

| Pieza del framework | Estado |
| --- | --- |
| Datos de equipos, jugadores, calendario, stats semanales (secciones 1-3, 9.1) | ✅ Implementado (`scripts/extract-nflverse.ts`) |
| Play-by-play con EPA/play y win probability, estructura Drive/Play (secciones 3.4, 4, 5.4.1, 5.7.3) | ✅ Implementado (`scripts/extract-pbp.ts`) |
| Visualización de probabilidad de victoria y posesiones por partido | ✅ Implementado (`/partidos/[gameId]`) |
| Cadena de Markov de 160 estados resuelta por iteración de valor (secciones 5.4.2, 5.7.3) | ✅ Implementado (`src/lib/markov-model.ts`) — r = 0.945 contra nflverse |
| Estado con tiempo restante y marcador (semi-Markov) | ⏳ Pendiente |
| Injury reports y clima (secciones 4.2, 6, 9.2) | ⏳ Pendiente |
| Simulador de posesiones Nivel 2 (sección 5.4.2) | ✅ Implementado — sobreestima ~0.25–0.65 pts por falta de reloj |
| Simulación de partido completo (ambos equipos, marcador final) | ⏳ Pendiente |
| Cuotas y cálculo de edge (sección 7) | ⏳ Pendiente |
| Auditoría de contradicciones automatizada (sección 8) | ⏳ Pendiente |
