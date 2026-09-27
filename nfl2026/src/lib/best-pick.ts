/**
 * Mejor pick del partido según el framework NFL (docs/nfl_framework_v1.md):
 *
 *  - 5.5  Probabilidad por mercado: los 6 lados con cuota (moneyline, spread y total, ambos lados).
 *  - 5.6 / 6.11 / 7.5 / 7.7 / 8.3  Contradicciones: cada regla se evalúa contra ESE pick en particular.
 *  - 7.2–7.4  Implícita sin margen, edge, momio justo y momio mínimo aceptable.
 *  - 8.3.13  Tres filtros: estadístico (edge ≥ 3 pp), guion (la proyección cruza la línea con holgura)
 *            y cuota (valor esperado positivo al momio real, con el margen de la casa incluido).
 *  - 8.4  Decisión corregida: contradicción Alta/Media/Baja, semáforo y decisión.
 *  - 6.12  Clasificación: Pick fuerte / Pick moderado / Lean / Esperar información / No bet.
 *  - 5.7.8  Stake: Kelly fraccional (¼ en Verde, ⅛ en Amarillo).
 *  - 5.7.10  Correlación: picks del mismo partido que dependen del mismo supuesto.
 *  - 8.5–8.6  Recomendación final.
 *
 * Corrección central del framework: no se elige el mercado que predice al ganador, sino el que mejor
 * representa el guion del partido con menor contradicción. Por eso el orden es: semáforo, nivel de
 * contradicción, confianza y solo después valor esperado.
 */

export type Light = "Verde" | "Amarillo" | "Rojo" | "Gris";
export type Level = "Baja" | "Media" | "Alta";
export type Klass = "Pick fuerte" | "Pick moderado" | "Lean" | "Esperar información" | "No bet";
export type Contradiction = { ref: string; text: string; kind: "dato" | "guion" | "info" };

export type BestPickInput = {
  home: string;
  away: string;
  spread: number | null; // positivo = local favorito (nflverse)
  total: number | null;
  odds: { homeMl: number | null; awayMl: number | null; homeSpread: number | null; awaySpread: number | null; over: number | null; under: number | null };
  pHome: number; // P(gana local) del modelo final
  pCoverHome: number | null; // P(local cubre | sin push)
  pOver: number | null; // P(Over | sin push)
  pushSpread: number;
  pushTotal: number;
  margin: number; // margen proyectado (local − visita)
  totalProj: number;
  teamProj: { home: number; away: number };
  proj1H: { home: number; away: number };
  divergence: number; // máx − mín de los tres métodos del framework (fase 2)
  baseModels: { key: string; label: string; p: number; margin: number | null; total: number | null }[];
  qbProjected: boolean;
  qbs: { home: string | null; away: string | null };
  playingHurt: Record<string, string[]>; // titulares Questionable que sí juegan, por equipo
  offOut: Record<string, string[]>; // titulares ofensivos fuera (confirmados), por equipo
  defOut: Record<string, string[]>; // titulares defensivos fuera (confirmados), por equipo
  weather: { outdoors: boolean; wind: number | null; temp: number | null };
  pressureTop10: Record<string, boolean>;
  defTop10: Record<string, boolean>;
  protectionBottom10: Record<string, boolean>; // sack rate sufrido entre los 10 peores
  divGame: boolean;
  campoFaltante: boolean;
  missing: string[]; // campos obligatorios vacíos (sección 9.3)
  pending: string[]; // información que todavía no existe antes del partido (inactivos, QB confirmado…)
  result: { margin: number; total: number } | null;
};

const EDGE_MIN = 0.03;
const r3 = (v: number, d = 3) => Number(v.toFixed(d));
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;
const sgn = (v: number, d = 1) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const implied = (a: number) => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
const payout = (a: number) => (a < 0 ? 100 / -a : a / 100);
export const fairAmericanOf = (p: number) => (p >= 0.5 ? Math.round((-100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p));
const fmtOdds = (a: number) => (a > 0 ? `+${a}` : `${a}`);
const fmtLine = (v: number) => (v === 0 ? "PK" : v > 0 ? `+${v}` : `${v}`);

export function buildBestPick(x: BestPickInput) {
  const { home, away } = x;
  type Side = {
    market: "Moneyline" | "Spread" | "Total"; pick: string; team: string | null; line: string; odds: number; oddsOther: number;
    p: number; pPush: number; scriptEdge: number; scriptUnit: string; side: "home" | "away" | "over" | "under";
  };
  const sides: Side[] = [];
  const o = x.odds;
  if (o.homeMl !== null && o.awayMl !== null) {
    sides.push({ market: "Moneyline", pick: `${home} gana`, team: home, line: "ML", odds: o.homeMl, oddsOther: o.awayMl, p: x.pHome, pPush: 0, scriptEdge: x.margin, scriptUnit: "pts de margen", side: "home" });
    sides.push({ market: "Moneyline", pick: `${away} gana`, team: away, line: "ML", odds: o.awayMl, oddsOther: o.homeMl, p: 1 - x.pHome, pPush: 0, scriptEdge: -x.margin, scriptUnit: "pts de margen", side: "away" });
  }
  if (x.spread !== null && x.pCoverHome !== null && o.homeSpread !== null && o.awaySpread !== null) {
    sides.push({ market: "Spread", pick: `${home} ${fmtLine(-x.spread)}`, team: home, line: fmtLine(-x.spread), odds: o.homeSpread, oddsOther: o.awaySpread, p: x.pCoverHome, pPush: x.pushSpread, scriptEdge: x.margin - x.spread, scriptUnit: "pts sobre la línea", side: "home" });
    sides.push({ market: "Spread", pick: `${away} ${fmtLine(x.spread)}`, team: away, line: fmtLine(x.spread), odds: o.awaySpread, oddsOther: o.homeSpread, p: 1 - x.pCoverHome, pPush: x.pushSpread, scriptEdge: x.spread - x.margin, scriptUnit: "pts sobre la línea", side: "away" });
  }
  if (x.total !== null && x.pOver !== null && o.over !== null && o.under !== null) {
    sides.push({ market: "Total", pick: `Over ${x.total}`, team: null, line: `${x.total}`, odds: o.over, oddsOther: o.under, p: x.pOver, pPush: x.pushTotal, scriptEdge: x.totalProj - x.total, scriptUnit: "pts sobre el total", side: "over" });
    sides.push({ market: "Total", pick: `Under ${x.total}`, team: null, line: `${x.total}`, odds: o.under, oddsOther: o.over, p: 1 - x.pOver, pPush: x.pushTotal, scriptEdge: x.total - x.totalProj, scriptUnit: "pts bajo el total", side: "under" });
  }
  // Umbral del guion: la proyección debe pasar la línea por al menos un gol de campo en el moneyline,
  // 1.5 pts en el spread y 2 pts en el total (regla final de 6.12: si cae muy cerca, no forzar pick).
  const scriptMin = { Moneyline: 3, Spread: 1.5, Total: 2 } as const;
  const favTeam = x.spread === null ? null : x.spread > 0 ? home : x.spread < 0 ? away : null;
  const bigFav = x.spread !== null && Math.abs(x.spread) >= 7;
  const hurtAll = [...(x.playingHurt[home] ?? []), ...(x.playingHurt[away] ?? [])];

  const scored = sides.map((s) => {
    const pImp = implied(s.odds) / (implied(s.odds) + implied(s.oddsOther));
    const edge = s.p - pImp;
    const b = payout(s.odds);
    const ev = s.p * b - (1 - s.p); // por unidad apostada; el push devuelve la apuesta
    const kelly = (b * s.p - (1 - s.p)) / b;
    const agreeList = x.baseModels.filter((m) => {
      if (s.market === "Moneyline") return s.side === "home" ? m.p > 0.5 : m.p < 0.5;
      if (s.market === "Spread") return m.margin !== null && x.spread !== null && (s.side === "home" ? m.margin > x.spread : m.margin < x.spread);
      return m.total !== null && x.total !== null && (s.side === "over" ? m.total > x.total : m.total < x.total);
    });
    const agree = agreeList.length;
    const scriptStrong = s.scriptEdge >= scriptMin[s.market];
    const scriptAgainst = s.scriptEdge < 0;
    const c: Contradiction[] = [];
    const rival = s.team === home ? away : s.team === away ? home : null;
    // Guion (8.3.13 / 6.12)
    if (scriptAgainst) c.push({ ref: "8.3.13", kind: "guion", text: `La proyección va en contra (${sgn(s.scriptEdge)} ${s.scriptUnit}): el valor sale solo de la forma de la distribución.` });
    else if (!scriptStrong) c.push({ ref: "6.12", kind: "guion", text: `La proyección queda muy cerca de la línea (${sgn(s.scriptEdge)} ${s.scriptUnit}; se pide ${scriptMin[s.market]}): no forzar pick.` });
    // Modelos del torneo
    if (x.baseModels.length && agree <= 2) c.push({ ref: "Torneo", kind: "dato", text: `Solo ${agree} de ${x.baseModels.length} modelos del torneo respaldan este lado.` });
    // Dispersión entre los modelos del torneo: si el rango de sus proyecciones es muy amplio, el
    // número final depende de a quién le dio peso el ensamble más que de un consenso.
    const proj = x.baseModels.map((m) => (s.market === "Total" ? m.total : m.margin)).filter((v): v is number => v !== null);
    const spreadOf = proj.length ? Math.max(...proj) - Math.min(...proj) : 0;
    const dispMax = s.market === "Total" ? 10 : 8;
    if (proj.length >= 3 && spreadOf > dispMax) c.push({ ref: "Torneo", kind: "dato", text: `Los modelos del torneo no se ponen de acuerdo: ${s.market === "Total" ? "totales" : "márgenes"} entre ${Math.min(...proj).toFixed(1)} y ${Math.max(...proj).toFixed(1)} (rango ${spreadOf.toFixed(1)} > ${dispMax} pts).` });
    // Fase 2: triangulación
    if (s.market !== "Total" && x.divergence > 0.1) c.push({ ref: "10 · fase 2", kind: "dato", text: `Los tres métodos del framework divergen ${pct(x.divergence, 0)} (> 10 pp): confianza baja en el ganador.` });
    // 8.3.18: edge enorme contra el cierre
    if (edge > 0.1) c.push({ ref: "8.3.18", kind: "info", text: `Edge de ${sgn(edge * 100)} pp contra la línea de cierre: suele ser información que el modelo no tiene${hurtAll.length ? ` (titulares en duda que juegan: ${hurtAll.join(", ")})` : ""}.` });
    // 5.6 / 7.7: titular no confirmado
    if (x.qbProjected) c.push({ ref: "5.6 · 7.7", kind: "info", text: `QB titular no confirmado todavía (${x.qbs.away ?? "—"} / ${x.qbs.home ?? "—"} proyectados): cuota buena pero titular sin confirmar.` });
    if (s.team) {
      const hurt = x.playingHurt[s.team] ?? [];
      if (hurt.length) c.push({ ref: "5.6 · 7.7", kind: "info", text: `${s.team} juega con titulares en duda (Questionable): ${hurt.join(", ")}.` });
      const out = [...(x.offOut[s.team] ?? []), ...(x.defOut[s.team] ?? [])];
      if (out.length) c.push({ ref: "5.6", kind: "dato", text: `${s.team} tiene titulares fuera: ${out.join(", ")}.` });
      if (rival && x.protectionBottom10[s.team] && x.pressureTop10[rival]) c.push({ ref: "5.6 · 8.3.3", kind: "dato", text: `${s.team} protege mal a su QB (sack rate entre los 10 peores) y ${rival} presiona entre los 10 mejores.` });
      if (s.market === "Moneyline" && s.odds <= -250) c.push({ ref: "7.5", kind: "dato", text: `Favorito caro (${fmtOdds(s.odds)}): el moneyline está inflado; buscar spread, total o no bet.` });
      if (s.market === "Spread" && s.team === favTeam && bigFav) {
        if (x.totalProj < (x.total ?? Infinity)) c.push({ ref: "8.3.9", kind: "dato", text: `Favorito de ${Math.abs(x.spread as number)} con total proyectado bajo (${x.totalProj.toFixed(1)} < ${x.total}): evitar el spread grande.` });
        if (x.defTop10[home] && x.defTop10[away]) c.push({ ref: "8.3.6", kind: "dato", text: "Ambas defensas top-10 en EPA permitido: penalizar al favorito grande." });
      }
    } else {
      const offOutAll = [...(x.offOut[home] ?? []), ...(x.offOut[away] ?? [])];
      const defOutAll = [...(x.defOut[home] ?? []), ...(x.defOut[away] ?? [])];
      if (s.side === "over") {
        if (x.pressureTop10[home] || x.pressureTop10[away]) c.push({ ref: "6.3 · 8.3.4", kind: "dato", text: `Pressure rate alto (${[home, away].filter((t) => x.pressureTop10[t]).join(" y ")} entre los 10 mejores): revisar Under primero.` });
        if (x.defTop10[home] && x.defTop10[away]) c.push({ ref: "8.3.6", kind: "dato", text: "Ambas defensas top-10 en EPA permitido: penalizar el Over." });
        if (x.weather.outdoors && (x.weather.wind ?? 0) >= 15) c.push({ ref: "5.6 · 6.11", kind: "dato", text: `Viento de ${x.weather.wind} mph: el clima reduce el juego aéreo.` });
        if (x.weather.outdoors && x.weather.temp !== null && x.weather.temp <= 32) c.push({ ref: "5.6", kind: "dato", text: `Frío extremo (${x.weather.temp} °F).` });
        if (x.divGame) c.push({ ref: "8.3.11", kind: "dato", text: "Partido divisional: no asumir más puntos." });
        if (offOutAll.length) c.push({ ref: "6.11", kind: "dato", text: `Titulares ofensivos fuera: ${offOutAll.join(", ")}.` });
      } else {
        if (defOutAll.length) c.push({ ref: "6.11", kind: "dato", text: `El Under depende de las defensas y hay titulares defensivos fuera: ${defOutAll.join(", ")}.` });
      }
    }
    return { s, pImp, edge, b, ev, kelly, agree, agreeList: agreeList.map((m) => m.label), scriptStrong, scriptAgainst, c };
  });

  // 8.3.14: Under y favorito del spread a la vez (cruzada entre dos picks con valor).
  const underV = scored.find((z) => z.s.side === "under" && z.edge >= EDGE_MIN);
  const favSpreadV = scored.find((z) => z.s.market === "Spread" && z.s.team === favTeam && z.edge >= EDGE_MIN);
  if (underV && favSpreadV) for (const z of [underV, favSpreadV]) z.c.push({ ref: "8.3.14", kind: "dato", text: "El análisis favorece al mismo tiempo el Under y al favorito en el spread: revisar la contradicción." });

  const candidates = scored.map((z) => {
    const model = z.edge >= EDGE_MIN;
    const price = z.ev > 0;
    const script = z.scriptStrong;
    const n = z.c.length;
    const level: Level = n === 0 ? "Baja" : n === 1 ? "Media" : "Alta";
    let light: Light;
    if (!model) light = "Gris";
    else if (level === "Alta" || z.scriptAgainst) light = "Rojo";
    else if (script && price && level === "Baja" && !x.campoFaltante) light = "Verde";
    else light = "Amarillo";
    // Confianza 1–10: edge, acuerdo de los modelos, guion y contradicciones (y datos faltantes).
    let conf = 5 + Math.max(-2, Math.min(2, (z.edge * 100) / 3));
    conf += z.agree === 5 ? 1 : z.agree === 4 ? 0.5 : z.agree <= 2 ? -1 : 0;
    conf += script ? 1 : 0; // un guion débil o en contra ya resta como contradicción
    conf -= 1.5 * n;
    if (x.campoFaltante) conf -= 1;
    const confidence = Math.max(1, Math.min(10, Math.round(conf)));
    const infoOnly = n > 0 && z.c.every((k) => k.kind === "info");
    let klass: Klass;
    if (light === "Verde") klass = confidence >= 8 ? "Pick fuerte" : "Pick moderado";
    else if (light === "Amarillo") klass = infoOnly || (z.c.some((k) => k.kind === "info") && level !== "Baja") ? "Esperar información" : "Lean";
    else klass = "No bet";
    const fraction = light === "Verde" ? 0.25 : light === "Amarillo" && klass === "Lean" ? 0.125 : 0;
    const stake = Math.max(0, z.kelly) * fraction;
    const minOdds = fairAmericanOf(Math.max(0.01, z.s.p - EDGE_MIN));
    let won: boolean | null = null, push = false;
    if (x.result) {
      const m = x.result.margin, t = x.result.total;
      const v = z.s.market === "Moneyline" ? (z.s.side === "home" ? m : -m)
        : z.s.market === "Spread" ? (z.s.side === "home" ? m - (x.spread as number) : (x.spread as number) - m)
        : z.s.side === "over" ? t - (x.total as number) : (x.total as number) - t;
      push = v === 0; won = v > 0;
    }
    return {
      market: z.s.market, pick: z.s.pick, team: z.s.team, side: z.s.side, line: z.s.line, odds: z.s.odds,
      pModel: r3(z.s.p), pImplied: r3(z.pImp), edge: r3(z.edge), ev: r3(z.ev), pPush: r3(z.s.pPush),
      fairOdds: fairAmericanOf(z.s.p), minOdds, kelly: r3(Math.max(0, z.kelly)), fraction, stake: r3(stake, 4),
      model, script, price, scriptEdge: r3(z.s.scriptEdge, 1), scriptUnit: z.s.scriptUnit,
      agree: z.agree, agreeOf: x.baseModels.length, agreeList: z.agreeList,
      contradictions: z.c, level, light, confidence, klass, won, push,
      units: won === null ? null : push ? 0 : won ? r3(payout(z.s.odds), 3) : -1,
    };
  });
  type Cand = (typeof candidates)[number];

  // Orden del framework: semáforo → menor contradicción → confianza → valor esperado.
  const lightRank: Record<Light, number> = { Verde: 0, Amarillo: 1, Rojo: 2, Gris: 3 };
  const levelRank: Record<Level, number> = { Baja: 0, Media: 1, Alta: 2 };
  const order = (a: Cand, b: Cand) => lightRank[a.light] - lightRank[b.light] || levelRank[a.level] - levelRank[b.level] || b.confidence - a.confidence || b.ev - a.ev;
  const playable = candidates.filter((c) => c.light === "Verde" || c.light === "Amarillo").sort(order);
  const best = playable[0] ?? null;

  // 5.7.10: correlación con el mejor pick (mismo supuesto causal).
  const correlated = best
    ? playable.filter((c) => c !== best && (
        (c.team !== null && c.team === best.team) ||
        (best.side === "under" && c.market === "Spread" && c.team === favTeam) ||
        (c.side === "under" && best.market === "Spread" && best.team === favTeam) ||
        (best.side === "over" && c.market === "Spread" && c.team === favTeam) ||
        (c.side === "over" && best.market === "Spread" && best.team === favTeam)
      )).map((c) => ({ pick: `${c.market}: ${c.pick}`, reason: c.team !== null && c.team === best.team ? `Mismo supuesto: que ${c.team} rinda por encima del mercado.` : "El total y el spread del favorito dependen del mismo guion de puntos." }))
    : [];

  // 8.2: dependencia de supuestos del mejor pick.
  const assumption = (c: Cand) => {
    if (c.market === "Total") return c.side === "under"
      ? { main: `Las dos defensas sostienen su nivel y el partido queda en ${x.totalProj.toFixed(1)} puntos o menos`, fails: "Un par de jugadas explosivas o pérdidas en campo corto rompen el Under" }
      : { main: `Las ofensivas anotan como en la base: ${x.totalProj.toFixed(1)} puntos proyectados`, fails: "Presión, clima o zona roja ineficiente dejan el partido corto" };
    const t = c.team as string, r = t === home ? away : home;
    return c.market === "Moneyline"
      ? { main: `${t} gana el partido (${pct(c.pModel)} según el modelo)`, fails: `${r} gana: se pierde la apuesta completa` }
      : { main: `${t} queda del lado correcto de ${c.line} (proyección ${sgn(c.scriptEdge)} ${c.scriptUnit})`, fails: `Un solo touchdown de diferencia decide el spread: riesgo en números clave (3 y 7)` };
  };

  // Mercados alternativos (6.10 / 7.6): proyección sin cuota publicada en la fuente.
  const impliedTT = x.spread !== null && x.total !== null ? { home: x.total / 2 + x.spread / 2, away: x.total / 2 - x.spread / 2 } : null;
  const alternatives = [
    ...(impliedTT ? ([["home", home], ["away", away]] as const).map(([k, t]) => {
      const diff = x.teamProj[k] - impliedTT[k];
      return { market: `Team total ${t}`, projection: r3(x.teamProj[k], 1), marketLine: r3(impliedTT[k], 1), lean: Math.abs(diff) < 1.5 ? "Sin lectura clara" : diff > 0 ? `Over ${impliedTT[k].toFixed(1)}` : `Under ${impliedTT[k].toFixed(1)}`, note: "Línea implícita del mercado (total/2 ± spread/2); sin cuota publicada: solo proyección." };
    }) : []),
    { market: "1H total", projection: r3(x.proj1H.home + x.proj1H.away, 1), marketLine: null, lean: "Sin línea", note: `1H proyectada ${away} ${x.proj1H.away.toFixed(1)} – ${x.proj1H.home.toFixed(1)} ${home}; sin línea de 1H en la fuente.` },
    { market: "1H margen", projection: r3(x.proj1H.home - x.proj1H.away, 1), marketLine: null, lean: Math.abs(x.proj1H.home - x.proj1H.away) < 1 ? "Parejo" : x.proj1H.home > x.proj1H.away ? `${home} arriba` : `${away} arriba`, note: "Sin línea de 1H en la fuente." },
  ];

  // 8.5–8.6: recomendación final.
  const byEdge = [...candidates].sort((a, b) => b.edge - a.edge);
  const mlSides = candidates.filter((c) => c.market === "Moneyline");
  const probable = [...mlSides].sort((a, b) => b.pModel - a.pModel)[0] ?? null;
  const totals = candidates.filter((c) => c.market === "Total").sort(order);
  const waitOdds = candidates.filter((c) => c.script && !c.model && c.edge > -0.03 && c.contradictions.length <= 1).sort((a, b) => b.edge - a.edge)[0] ?? null;
  const label = (c: Cand) => `${c.market}: ${c.pick} (${fmtOdds(c.odds)})`;
  const recommendation = {
    bestValue: byEdge[0] ? { pick: label(byEdge[0]), edge: byEdge[0].edge, light: byEdge[0].light } : null,
    bestTotal: totals[0] ? { pick: label(totals[0]), edge: totals[0].edge, light: totals[0].light } : null,
    best1H: `${away} ${x.proj1H.away.toFixed(1)} – ${x.proj1H.home.toFixed(1)} ${home} (sin línea para valorarla)`,
    valueHighRisk: candidates.filter((c) => c.light === "Rojo").map((c) => ({ pick: label(c), edge: c.edge, why: [...new Set(c.contradictions.map((k) => k.ref))].join(", ") })),
    probableNoValue: probable && probable.edge <= 0 ? { pick: label(probable), pModel: probable.pModel, pImplied: probable.pImplied } : null,
    avoid: candidates.filter((c) => c.light === "Rojo" || c.edge <= -0.05).map((c) => label(c)),
    waitForOdds: waitOdds ? { pick: label(waitOdds), minOdds: waitOdds.minOdds, now: waitOdds.odds } : null,
    stake: best ? best.stake : 0,
    missing: x.missing,
    pending: x.pending,
  };

  return {
    candidates,
    best: best ? { ...best, assumption: assumption(best), correlated } : null,
    noBetReason: best ? null : byEdge[0] && byEdge[0].edge >= EDGE_MIN
      ? `El lado con más valor (${label(byEdge[0])}, ${sgn(byEdge[0].edge * 100)} pp) tiene contradicción ${byEdge[0].level.toLowerCase()}: ${byEdge[0].contradictions.map((k) => k.text).join(" ")}`
      : `Ningún lado llega a ${EDGE_MIN * 100} pp de edge contra la línea de cierre: proteger el bankroll es más importante que forzar una apuesta.`,
    alternatives,
    recommendation,
    rules: {
      edgeMin: EDGE_MIN,
      scriptMin,
      confidence: "5 + edge/3 (±2) + acuerdo de modelos (5/5 +1, 4/5 +0.5, ≤2/5 −1) + guion con holgura (+1) − 1.5 por contradicción − 1 si falta un campo obligatorio; entre 1 y 10",
      stake: "¼ Kelly en Verde, ⅛ Kelly en Amarillo (Lean); 0 en Esperar información, Rojo y Gris",
    },
  };
}

export type BestPick = ReturnType<typeof buildBestPick>;
