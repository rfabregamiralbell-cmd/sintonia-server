import { Response } from "express";
import db from "./db";
import { AuthedRequest } from "./auth";
import { isSubscribed, checkSubscribed } from "./billing";
import { fetchT } from "./fetchT";
import { globalCapHit, addGlobalSpend } from "./globalbudget";

const REQUIRE_SUB = (process.env.REQUIRE_SUBSCRIPTION ?? "1") !== "0";
const FREE_TIER_CALLS = Number(process.env.FREE_TIER_CALLS ?? "10"); // comentarios gratis antes de pedir plan
const DAILY_CAP = Number(process.env.DAILY_CAP ?? "200"); // tope diario por usuario (protege margen)

// Tope diario por usuario (en memoria; para multi-instancia, mover a Redis).
const daily = new Map<string, { n: number; day: string }>();
function dailyExceeded(userId: string): boolean {
  if (DAILY_CAP <= 0) return false;
  const day = new Date().toISOString().slice(0, 10);
  const d = daily.get(userId);
  if (!d || d.day !== day) {
    daily.set(userId, { n: 1, day });
    return false;
  }
  if (d.n >= DAILY_CAP) return true;
  d.n++;
  return false;
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const MODEL = "claude-sonnet-4-6";
const PRICE_IN = 3 / 1000000;
const PRICE_OUT = 15 / 1000000;
const MARKUP = Number(process.env.MARKUP ?? "0.15");
const RL_MAX = Number(process.env.RATE_LIMIT_HOUR ?? "120");

// Límite simple por usuario/hora (en memoria) para proteger la clave incluida.
const buckets = new Map<string, { n: number; reset: number }>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const b = buckets.get(userId);
  if (!b || now > b.reset) {
    buckets.set(userId, { n: 1, reset: now + 3600_000 });
    return false;
  }
  if (b.n >= RL_MAX) return true;
  b.n++;
  return false;
}

const DJ_SYSTEM =
  "Eres el locutor personal de quien te escucha: criterio musical y oficio de gran presentador de radio. " +
  "Recibes una canción y la personalidad del locutor. Devuelve SOLO el comentario hablado, en el idioma " +
  "indicado, sin markdown, listas ni emojis, ajustando la longitud a la duración pedida. Respeta el estilo, " +
  "el trato, el idioma, el enfoque y el nivel de detalle. " +
  "SUSTANCIA: cada frase aporta UNA observación concreta y no obvia: un detalle de lo que suena (una textura, " +
  "una dinámica, dónde entra o se calla un instrumento, cómo está colocada la voz en la mezcla, la forma de una " +
  "melodía), una lectura afilada de la letra (qué confiesa o esconde el narrador, a quién le habla) o un marco " +
  "emocional o cultural real. Nada de relleno: si una frase valdría igual para cualquier otra canción, bórrala. " +
  "Prohibidos los paraguas vacíos ('buen ritmo', 'mucha energía', 'suena muy bien', 'qué temazo', 'una pasada', " +
  "'me encanta') y las muletillas de relleno ('fíjate', 'fíjate fíjate', 'mira', 'oye', '¿eh?', 'ahí está'); " +
  "no abras con una interjección que dirija la atención, entra directo con la observación. No digas que algo te " +
  "gusta: demuestra POR QUÉ importa señalando qué oyes. " +
  "FIEL: separa dos planos. (1) DATOS VERIFICABLES (fechas, año, productores, sellos, colaboradores, premios, " +
  "posiciones de lista, MUESTRAS/SAMPLES e interpolaciones, quién toca cada instrumento, dónde se grabó): NO se " +
  "inventan nunca; si no lo sabes con certeza, no lo digas. El AÑO es el dato que más se falla: no des fecha salvo " +
  "total certeza; sitúa la época por el SONIDO. Nunca afirmes la PROCEDENCIA de un sonido (que algo samplea otra " +
  "canción o que lo toca tal persona): describe el sonido que OYES, no de dónde viene. (2) PERCEPCIÓN (lo que suena " +
  "y lo que dice la letra): aquí sé específico, audaz y seguro. Ante la duda entre soltar un dato o describir lo que " +
  "suena, elige SIEMPRE describir lo que suena. Si no reconoces la canción, no pasa nada: coméntala por lo que oyes.";

function buildPrompt(p: any): string {
  // Modo ANUNCIO: no suena música, hay un corte publicitario; reacciona al corte.
  if (p.moment === "Anuncio") {
    let s = `Soy tu oyente. Escucho en ${p.platform}. Ahora mismo NO suena música: ha entrado un ANUNCIO / corte publicitario. Reacciona al corte EN DIRECTO con naturalidad y un punto de humor cómplice (NO sabes qué anuncian ni lo promociones): un respiro mientras vuelve la música. Breve y con vida.\n`;
    s += `Estilo del locutor: ${p.tone}.\n`;
    if (p.djName) s += `Te llamas ${p.djName}.\n`;
    s += `Trata al oyente de "${p.treatment}".\n`;
    if (p.catchphrase) s += `Si encaja, abre con tu muletilla: "${p.catchphrase}".\n`;
    s += `Idioma de salida: ${p.outLang}. Frase hablada (sin markdown ni emojis). Apunta a unos ${p.duration} segundos.`;
    return s;
  }
  const dims = p.dims.length ? p.dims.join(", ") : "lo más interesante";
  const themes = p.themes && p.themes.length ? p.themes.join(", ") : "";
  let s = `Soy tu oyente. Escucho en ${p.platform}. `;
  s += p.moment === "Presentación"
    ? `Presenta la próxima canción antes de que suene: ${p.track}${p.artist ? " de " + p.artist : ""}.\n`
    : `Comenta la canción que suena: ${p.track}${p.artist ? " de " + p.artist : ""}.\n`;
  if (p.prevTrack) s += `Acabas de pinchar "${p.prevTrack}": haz una transición de DJ, cierra esa y enlaza con la nueva.\n`;
  if (p.liveCtx) s += `${p.liveCtx} Hablas EN DIRECTO, reaccionando a lo que suena en este instante (no como un guion).\n`;
  if (p.recentSaid && p.recentSaid.length) s += `YA HAS DICHO ESTO en comentarios anteriores de la sesión — NO lo repitas (ni ideas, ni frases, ni la misma apertura ni estructura): busca un ángulo y unas palabras NUEVAS. Ya dicho: ${p.recentSaid.map((x: string) => `"${String(x).slice(0, 160)}"`).join(" / ")}.\n`;
  s += `Varía el RITMO: mezcla alguna frase corta con una reflexión más personal o una duda; no encadenes sentencias densas e iguales. Suena a alguien pensando en voz alta EN DIRECTO, no a un informe leído.\n`;
  // Estilo de contenido (gratis = ligero/curioso · premium = denso).
  if (p.style === "nombrar") s += `Modo MÍNIMO: solo di QUÉ suena —${p.track}${p.artist ? " de " + p.artist : ""}— con una pincelada de color, en UNA frase. Nada de análisis.\n`;
  else if (p.style === "ligero") s += `Modo LIGERO: NADA de análisis denso ni enumerar varias cosas. Suelta UN solo apunte curioso, fresco y con chispa sobre lo que oyes —un detalle del sonido, una imagen, un guiño de radio—, en una o dos frases. Sugerente, no exhaustivo; deja al oyente con ganas. (Sigues FIEL: no inventes datos.)\n`;
  s += `Dimensiones a analizar: ${dims}.\n`;
  if (themes) s += `Enfoque temático prioritario: ${themes}.\n`;
  s += `Estilo del locutor: ${p.tone}.\n`;
  if (p.djName) s += `Te llamas ${p.djName}.\n`;
  s += `Trata al oyente de "${p.treatment}".\n`;
  s += `Nivel de detalle: ${p.depth}/5.\n`;
  if (p.style === "denso" && p.depth >= 4) {
    s += `Modo análisis profundo: profundiza de verdad, con densidad alta de ideas y cero relleno. ` +
      `Detalles de composición, producción y teoría musical explicada de forma accesible, SIEMPRE ` +
      `partiendo de lo que se oye. Trae contexto, conexiones o anécdotas SOLO si estás seguro de que ` +
      `son ciertas; si dudas, no las metas: una observación precisa sobre el sonido vale más que un ` +
      `dato dudoso. Prioriza lo más revelador y sorprendente. Encadena ideas con criterio, no enumeres.\n`;
  }
  s += `Idioma de salida: ${p.outLang}.\n`;
  if (p.catchphrase) s += `Si encaja, abre con tu muletilla: "${p.catchphrase}".\n`;
  if (p.avoidRepeat && p.recent && p.recent.length) s += `No repitas lo ya comentado sobre: ${p.recent.join("; ")}.\n`;
  s += `Apunta a una locución de unos ${p.duration} segundos.`;
  return s;
}

export async function commentary(req: AuthedRequest, res: Response) {
  try {
    const userId = req.userId!;
    const userKeyHeader = req.headers["x-user-key"];
    // BYOK SOLO si parece una clave real de Anthropic; si no, NO salta el gating (va por managed).
    const rawUserKey = typeof userKeyHeader === "string" ? userKeyHeader.trim() : "";
    const userKey = (/^sk-ant-/.test(rawUserKey) && rawUserKey.length > 20) ? rawUserKey : "";
    const key = userKey || ANTHROPIC_KEY; // BYOK usa la clave del usuario.
    if (!key) return res.status(500).json({ error: "falta clave de IA" });

    const u: any = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!u) return res.status(401).json({ error: "usuario no encontrado" });

    if (!userKey) {
      // El free-tier es SOLO para cuentas reales (Google/Apple), no para invitados:
      // así un atacante no puede crear miles de invitados para IA gratis infinita.
      const isGuest = userId.startsWith("guest:");
      const onFreeTier = !isGuest && u.calls < FREE_TIER_CALLS;
      const subscribed = (REQUIRE_SUB && !onFreeTier) ? await checkSubscribed(userId, req.email) : isSubscribed(u);
      if (REQUIRE_SUB && !onFreeTier && !subscribed) return res.status(402).json({ error: isGuest ? "login" : "subscription" });
      if (dailyExceeded(userId)) return res.status(429).json({ error: "límite diario alcanzado" });
      if (rateLimited(userId)) return res.status(429).json({ error: "límite por hora alcanzado" });
      if (globalCapHit()) return res.status(503).json({ error: "servicio saturado, prueba más tarde" }); // tope de gasto global
      // El presupuesto NO aplica a suscriptores (pagan): solo protege coste de free-tier/BYOK-incluido.
      if (!subscribed && u.budget > 0 && u.spend >= u.budget) return res.status(402).json({ error: "budget" });
    }

    const b: any = req.body ?? {};
    if (!b.track) return res.status(400).json({ error: "track requerido" });

    const p = {
      track: b.track,
      artist: b.artist ?? "",
      dims: Array.isArray(b.focuses) ? b.focuses : b.focus ? [b.focus] : [],
      themes: Array.isArray(b.themes) ? b.themes : [],
      tone: b.tone ?? "Cercano",
      depth: Number(b.depth) || 3,
      duration: Number(b.duration) > 0 ? Number(b.duration) : 25,
      platform: b.platform ?? "Apple Music",
      djName: b.djName ?? "",
      outLang: b.outLang ?? "Español",
      treatment: b.treatment ?? "tú",
      catchphrase: b.catchphrase ?? "",
      avoidRepeat: !!b.avoidRepeat,
      moment: b.moment ?? "Comentario",
      liveCtx: typeof b.liveCtx === "string" ? b.liveCtx : "",
      prevTrack: b.prevTrack ?? "",
      recent: Array.isArray(b.recent) ? b.recent : [],
      recentSaid: Array.isArray(b.recentSaid) ? b.recentSaid : [],
      style: typeof b.style === "string" ? b.style : "denso", // nombrar | ligero (gratis) | denso (premium)
    };

    // La longitud escala con la duración pedida. Tope alto para permitir
    // análisis densos y largos (web/escritorio), acotado por presupuesto/cap diario.
    const maxTokens = Math.max(120, Math.min(1200, Math.round(p.duration * 4) + 60));

    const r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: DJ_SYSTEM, messages: [{ role: "user", content: buildPrompt(p) }] }),
    }, 60000);

    if (!r.ok) return res.status(502).json({ error: "modelo " + r.status });
    const data: any = await r.json();
    const text = (data.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").trim();
    const usage = data.usage ?? { input_tokens: 0, output_tokens: 0 };

    let charged = 0;
    if (!userKey) {
      const raw = usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT;
      charged = raw * (1 + MARKUP); // + mantenimiento
      db.prepare(
        "UPDATE users SET spend = spend + ?, calls = calls + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?"
      ).run(charged, usage.input_tokens, usage.output_tokens, userId);
      addGlobalSpend(charged); // acumula al tope de gasto global del día
    }

    const after: any = db.prepare("SELECT spend, budget, calls, subscribed, sub_until FROM users WHERE id = ?").get(userId);
    const freeRemaining = Math.max(0, FREE_TIER_CALLS - (after.calls ?? 0));
    res.json({
      text,
      usage,
      charged,
      spend: after.spend,
      budget: after.budget,
      remaining: after.budget > 0 ? Math.max(0, after.budget - after.spend) : null,
      freeRemaining,
      subscribed: isSubscribed(after),
    });
  } catch (e) {
    console.error("commentary:", e);
    res.status(500).json({ error: "interno" });
  }
}
