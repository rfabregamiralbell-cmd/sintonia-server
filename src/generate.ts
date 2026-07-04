import { fetchT } from "./fetchT";

// Motor de GENERACIÓN de texto unificado. Motor PRINCIPAL = Google Gemini (barato) cuando
// hay GEMINI_KEY; si no, cae a Anthropic (clave de la organización) para no romper nada.
// Con BYOK (clave Anthropic del propio usuario) se usa esa y NO se cobra.
//
// Precios por token ($). Gemini 2.5 Flash-Lite es mucho más barato, sobre todo en SALIDA.
const GEMINI_KEY = process.env.GEMINI_KEY || "";
// Modelo PRINCIPAL: gemini-2.5-flash (medido: 0 muletillas y comentarios más ricos que flash-lite,
// que dejaba pasar ~1/4; sigue las instrucciones bastante mejor). Coste aún ínfimo (~5x más barato
// que Claude). Configurable por env; para máximo ahorro, poner GEMINI_MODEL=gemini-2.5-flash-lite.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_FALLBACK = "gemini-2.5-flash-lite"; // en saturación (503/429): más barato y con más capacidad
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";
const MARKUP = Number(process.env.MARKUP ?? "0.15");

const PRICE = {
  gemini: { in: 0.3 / 1e6, out: 2.5 / 1e6 },   // precio de gemini-2.5-flash (para el cap de gasto)
  anthropic: { in: 3 / 1e6, out: 15 / 1e6 },
};

// ¿Está Gemini como motor principal? (para logs/diagnóstico)
export const GEMINI_ENABLED = !!GEMINI_KEY;

// Refuerzo de FIDELIDAD solo para Gemini. flash-lite es más "suelto" que Claude con las reglas
// enterradas a mitad del system (medido: ~3/4 de comentarios usaban muletillas prohibidas y
// ~1/4 inventaba un año). Re-afirmamos, AL FINAL y en corto, justo lo que más se viola — los
// modelos débiles obedecen mejor lo último y más saliente. Es ADITIVO: no cambia el prompt del
// dominio, solo lo refuerza; y solo se aplica al camino Gemini (Claude ya lo cumple).
const GEMINI_FIDELITY =
  "AVISO FINAL OBLIGATORIO: entra DIRECTO con la observación; PROHIBIDO empezar con o usar las " +
  "muletillas 'fíjate', 'mira', 'oye', '¿eh?', 'ahí está', '¿no te parece?'. " +
  "NUNCA des el AÑO de la canción salvo que te lo hayan dado como DATO VERIFICADO en el mensaje del oyente; " +
  "si ahí no hay año, NO menciones NINGUNO (ni 'de 2010', ni 'del 98', ni 'en los noventa'): sitúa la época solo " +
  "por el SONIDO. Tampoco afirmes otras fechas ni el origen de un sonido (samples, quién lo toca) salvo certeza; " +
  "ante la duda, describe lo que se OYE, no de dónde viene.";

// POST-FILTRO determinista: si el comentario ABRE con una muletilla/interjección (a pesar del prompt),
// la quita y recapitaliza. Garantía dura (no depende de que el modelo obedezca). Solo afecta a la
// APERTURA de texto plano; sobre un JSON de /program (empieza por '[') el patrón no casa = no toca nada.
const OPENER = /^(¡?\s*(f[ií]jate|mira|oye|ah[ií] est[aá]|¿?eh\?|¿?no te parece\??|vaya|uf+|ay+|guau|wow)(\s+(en\s+)?(c[oó]mo|como|lo|bien|qu[eé]))?\s*[,;:!¡.\-–—]*\s+)/i;
function stripOpenerMuletilla(t: string): string {
  const s = String(t || "").trim();
  const m = s.match(OPENER);
  if (m && s.length - m[0].length > 20) { const rest = s.slice(m[0].length); return rest.charAt(0).toUpperCase() + rest.slice(1); }
  return s;
}

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
  const text = stripOpenerMuletilla(((data.candidates?.[0]?.content?.parts) || []).map((p: any) => (p && p.text) || "").join(" ").trim());
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
        // system FIJO (prefijo cacheable) + refuerzo de fidelidad al FINAL (lo más saliente para el modelo).
        system_instruction: { parts: [{ text: (system || "") + "\n\n" + GEMINI_FIDELITY }] },
        contents: [{ role: "user", parts: [{ text: prompt || "" }] }], // VARIABLE
        // thinkingBudget:0 DESACTIVA el "pensamiento" de Gemini 2.5. Sin esto, el modelo de
        // fallback (gemini-2.5-flash, con thinking ON por defecto) puede gastarse TODO
        // maxOutputTokens razonando y devolver texto VACÍO. flash-lite ya no piensa; esto lo
        // fija explícito para ambos.
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
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
