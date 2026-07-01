import { Response } from "express";
import { AuthedRequest } from "./auth";
import { fetchT } from "./fetchT";
import { globalCapHit, addGlobalSpend } from "./globalbudget";
import { dailyExceeded } from "./dailycap";

// VOZ con Gemini TTS. Motor de voz "gemini": el cliente decide el modo.
//  - "multi": conversación de ≤2 locutores en UNA llamada (voces distintas, hand-off natural).
//  - "single": una línea con una voz (para >2 locutores, por turno, o comentario de 1 locutor).
// Gemini devuelve PCM 24kHz; lo envolvemos en cabecera WAV para reproducir en el <audio> del
// cliente (data:audio/wav;base64). Coste controlado (rate-limit + cupo + tope global).

const GEMINI_KEY = process.env.GEMINI_KEY || "";
const TTS_MODEL = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
const RL_MAX = Number(process.env.GEMINI_TTS_LIMIT_HOUR ?? "300"); // clips/hora por usuario
const COST_PER_CHAR = Number(process.env.GEMINI_TTS_COST_PER_CHAR ?? "0.00002"); // estimación para el cap

// 30 voces válidas de Gemini TTS.
const VOICES = new Set([
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
  "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
  "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
]);
const safeVoice = (v: any) => (typeof v === "string" && VOICES.has(v) ? v : "Kore");

const buckets = new Map<string, { n: number; reset: number }>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const b = buckets.get(userId);
  if (!b || now > b.reset) { buckets.set(userId, { n: 1, reset: now + 3600_000 }); return false; }
  if (b.n >= RL_MAX) return true;
  b.n++; return false;
}

// PCM 16-bit mono -> WAV (cabecera de 44 bytes).
function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bits = 16): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(bits, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
// Del mimeType "audio/L16;codec=pcm;rate=24000" saca el sample rate.
function rateFromMime(m: string): number {
  const x = /rate=(\d+)/.exec(m || "");
  return x ? Number(x[1]) : 24000;
}

export async function ttsGemini(req: AuthedRequest, res: Response) {
  try {
    if (!GEMINI_KEY) return res.status(500).json({ error: "voz Gemini no configurada (falta GEMINI_KEY)" });
    const userId = req.userId!;
    if (rateLimited(userId)) return res.status(429).json({ error: "límite por hora alcanzado" });
    if (dailyExceeded(userId)) return res.status(429).json({ error: "límite diario alcanzado" });
    if (globalCapHit()) return res.status(503).json({ error: "servicio saturado, prueba más tarde" });

    const b: any = req.body ?? {};
    const multi = b.mode === "multi";

    let text = "";
    let speechConfig: any;
    if (multi) {
      const speakers = (Array.isArray(b.speakers) ? b.speakers : []).slice(0, 2);
      if (!speakers.length) return res.status(400).json({ error: "speakers requerido" });
      text = String(b.transcript || "").slice(0, 5000);
      speechConfig = {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakers.map((s: any) => ({
            speaker: String(s && s.speaker || "").slice(0, 40),
            voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice(s && s.voice) } },
          })),
        },
      };
    } else {
      text = String(b.text || "").slice(0, 2500);
      speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice(b.voice) } } };
    }
    if (!text.trim()) return res.status(400).json({ error: "text requerido" });

    addGlobalSpend(text.length * COST_PER_CHAR); // suma el coste de la voz al gasto del día

    const r = await fetchT(
      `https://generativelanguage.googleapis.com/v1beta/models/${TTS_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig } }),
      },
      45000
    );
    if (!r.ok) {
      let msg = "gemini-tts " + r.status;
      try { const j: any = await r.json(); msg = (j?.error?.message || msg); } catch {}
      return res.status(502).json({ error: msg });
    }
    const data: any = await r.json();
    const inline = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inline || !inline.data) return res.status(502).json({ error: "sin audio" });

    const pcm = Buffer.from(inline.data, "base64");
    const wav = pcmToWav(pcm, rateFromMime(inline.mimeType));
    res.json({ audio: wav.toString("base64"), mime: "audio/wav" });
  } catch (e) {
    console.error("gemini-tts:", e);
    res.status(500).json({ error: "interno" });
  }
}
