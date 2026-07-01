import { fetchT } from "./fetchT";

// Motor de GENERACIÓN de texto unificado. Motor PRINCIPAL = Google Gemini (barato) cuando
// hay GEMINI_KEY; si no, cae a Anthropic (clave de la organización) para no romper nada.
// Con BYOK (clave Anthropic del propio usuario) se usa esa y NO se cobra.
//
// Precios por token ($). Gemini 2.5 Flash-Lite es mucho más barato, sobre todo en SALIDA.
const GEMINI_KEY = process.env.GEMINI_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite"; // fácil de cambiar por env
const GEMINI_FALLBACK = "gemini-2.5-flash"; // si el modelo barato no está disponible
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const MARKUP = Number(process.env.MARKUP ?? "0.15");

const PRICE = {
  gemini: { in: 0.1 / 1e6, out: 0.4 / 1e6 },
  anthropic: { in: 3 / 1e6, out: 15 / 1e6 },
};

// ¿Está Gemini como motor principal? (para logs/diagnóstico)
export const GEMINI_ENABLED = !!GEMINI_KEY;

export type GenResult = {
  text: string;
  inTok: number;
  outTok: number;
  charged: number; // coste estimado con markup ($); 0 si BYOK
  engine: string;  // "gemini" | "anthropic" | "anthropic-byok"
};

// Genera texto a partir de un system (fijo, cacheable en Gemini) y un prompt (variable).
export async function generate(system: string, prompt: string, maxTokens: number, byokAnthropicKey = ""): Promise<GenResult> {
  if (byokAnthropicKey) {
    const r = await anthropicGen(byokAnthropicKey, system, prompt, maxTokens);
    return { ...r, charged: 0, engine: "anthropic-byok" };
  }
  if (GEMINI_KEY) {
    try {
      const r = await geminiGen(system, prompt, maxTokens);
      const charged = (r.inTok * PRICE.gemini.in + r.outTok * PRICE.gemini.out) * (1 + MARKUP);
      return { ...r, charged, engine: "gemini" };
    } catch (e) {
      // Gemini saturado/caído (p. ej. 503 "high demand"): si hay clave Anthropic de la org,
      // tiramos de ella para NO dejar al usuario sin respuesta (coste mayor puntual, fiable).
      if (!ANTHROPIC_KEY) throw e;
      console.warn("[gen] Gemini falló -> fallback Anthropic:", String((e as any)?.message || e).slice(0, 140));
    }
  }
  const r = await anthropicGen(ANTHROPIC_KEY, system, prompt, maxTokens);
  const charged = (r.inTok * PRICE.anthropic.in + r.outTok * PRICE.anthropic.out) * (1 + MARKUP);
  return { ...r, charged, engine: "anthropic" };
}

// ── Gemini ────────────────────────────────────────────────────────────────────────────
async function geminiGen(system: string, prompt: string, maxTokens: number): Promise<{ text: string; inTok: number; outTok: number }> {
  let res = await callGemini(GEMINI_MODEL, system, prompt, maxTokens);
  // Reintenta con el flash normal si el modelo barato NO está disponible O está SATURADO
  // (503/429/"high demand"): el flash suele tener más capacidad.
  if (!res.ok && isRetryable(res)) res = await callGemini(GEMINI_FALLBACK, system, prompt, maxTokens);
  if (!res.ok) throw new Error("gemini " + res.status + " " + JSON.stringify((res.data && res.data.error) || {}).slice(0, 200));
  const data: any = res.data || {};
  const text = ((data.candidates?.[0]?.content?.parts) || []).map((p: any) => (p && p.text) || "").join(" ").trim();
  // Respuesta 200 pero SIN texto (bloqueo de seguridad, finishReason MAX_TOKENS con todo el
  // presupuesto en "thinking", etc.): lo tratamos como fallo para que generate() ESCALE a
  // Anthropic en vez de devolver un comentario vacío al usuario.
  if (!text) throw new Error("gemini vacío (finishReason=" + String(data.candidates?.[0]?.finishReason || "?") + ")");
  const um = data.usageMetadata || {};
  return { text, inTok: Number(um.promptTokenCount) || 0, outTok: Number(um.candidatesTokenCount) || 0 };
}

async function callGemini(model: string, system: string, prompt: string, maxTokens: number) {
  const r = await fetchT(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system || "" }] }, // FIJO -> prefijo cacheable
        contents: [{ role: "user", parts: [{ text: prompt || "" }] }], // VARIABLE
        // thinkingBudget:0 DESACTIVA el "pensamiento" de Gemini 2.5. Sin esto, el modelo de
        // fallback (gemini-2.5-flash, con thinking ON por defecto) puede gastarse TODO
        // maxOutputTokens razonando y devolver texto VACÍO. flash-lite ya no piensa; esto lo
        // fija explícito para ambos.
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.8, thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
    60000
  );
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

function isRetryable(res: { status: number; data: any }): boolean {
  if (res.status === 404 || res.status === 429 || res.status === 503 || res.status === 500) return true;
  const err = res.data && res.data.error;
  const msg = String((err && (err.message || err.status)) || "");
  return /not found|not supported|does not exist|unavailable|unsupported|no such model|overloaded|high demand|resource has been exhausted/i.test(msg);
}

// ── Anthropic ─────────────────────────────────────────────────────────────────────────
async function anthropicGen(key: string, system: string, prompt: string, maxTokens: number): Promise<{ text: string; inTok: number; outTok: number }> {
  const r = await fetchT(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] }),
    },
    60000
  );
  if (!r.ok) throw new Error("modelo " + r.status);
  const data: any = await r.json();
  const text = (data.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").trim();
  const u = data.usage ?? {};
  return { text, inTok: Number(u.input_tokens) || 0, outTok: Number(u.output_tokens) || 0 };
}
