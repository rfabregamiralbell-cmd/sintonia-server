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
  "Eres el locutor personal de quien te escucha: con criterio musical y oficio de buen " +
  "presentador de radio. Recibes una canción y la personalidad y preferencias del locutor. " +
  "Devuelve SOLO el comentario hablado, en el idioma indicado, sin markdown, listas ni emojis, " +
  "ajustando la longitud a la duración pedida. Respeta el estilo, el trato, el idioma, el enfoque " +
  "temático y el nivel de detalle. " +
  "RIGOR: sé fidedigno y real. NO inventes datos concretos (fechas, productores, colaboraciones, " +
  "sellos, premios, posiciones en listas, anécdotas). Si no estás seguro de un dato, NO lo afirmes: " +
  "comenta lo que SÍ se percibe (estilo, género, sonido, estructura, sensación, letra). Si no " +
  "reconoces la canción con certeza, dilo en media frase y coméntala por estilo o artista. Mejor " +
  "ser honesto que soltar un dato falso.";

function buildPrompt(p: any): string {
  const dims = p.dims.length ? p.dims.join(", ") : "lo más interesante";
  const themes = p.themes && p.themes.length ? p.themes.join(", ") : "";
  let s = `Soy tu oyente. Escucho en ${p.platform}. `;
  s += p.moment === "Presentación"
    ? `Presenta la próxima canción antes de que suene: ${p.track}${p.artist ? " de " + p.artist : ""}.\n`
    : `Comenta la canción que suena: ${p.track}${p.artist ? " de " + p.artist : ""}.\n`;
  if (p.prevTrack) s += `Acabas de pinchar "${p.prevTrack}": haz una transición de DJ, cierra esa y enlaza con la nueva.\n`;
  s += `Dimensiones a analizar: ${dims}.\n`;
  if (themes) s += `Enfoque temático prioritario: ${themes}.\n`;
  s += `Estilo del locutor: ${p.tone}.\n`;
  if (p.djName) s += `Te llamas ${p.djName}.\n`;
  s += `Trata al oyente de "${p.treatment}".\n`;
  s += `Nivel de detalle: ${p.depth}/5.\n`;
  if (p.depth >= 4) {
    s += `Modo análisis profundo: profundiza de verdad. Aporta contexto histórico, ` +
      `detalles de composición y producción, teoría musical explicada de forma accesible, ` +
      `anécdotas verificables y conexiones con otros artistas, obras o movimientos. ` +
      `Prioriza lo más revelador y sorprendente, con densidad alta de información interesante ` +
      `y cero relleno. Encadena ideas con criterio, no enumeres.\n`;
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
    const userKey = typeof userKeyHeader === "string" ? userKeyHeader : "";
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
      prevTrack: b.prevTrack ?? "",
      recent: Array.isArray(b.recent) ? b.recent : [],
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
