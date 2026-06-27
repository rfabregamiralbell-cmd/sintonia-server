import { Response } from "express";
import { AuthedRequest } from "./auth";
import { checkSubscribed } from "./billing";

// Voces PREMIUM incluidas: usa la clave de ElevenLabs de la ORGANIZACIÓN (no del
// usuario) y solo se permite a suscriptores. Así el usuario (un abuelo) no pone
// ninguna clave: entra con Google, se hace Premium, y tiene voces buenas.
const ELEVEN_KEY = process.env.ELEVENLABS_KEY || "";
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // voz por defecto
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
const RL_MAX = Number(process.env.TTS_LIMIT_HOUR ?? "400"); // turnos/hora por usuario (protege la clave)

const buckets = new Map<string, { n: number; reset: number }>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const b = buckets.get(userId);
  if (!b || now > b.reset) { buckets.set(userId, { n: 1, reset: now + 3600_000 }); return false; }
  if (b.n >= RL_MAX) return true;
  b.n++; return false;
}

export async function tts(req: AuthedRequest, res: Response) {
  try {
    if (!ELEVEN_KEY) return res.status(500).json({ error: "voces premium no configuradas (falta ELEVENLABS_KEY)" });

    if (!(await checkSubscribed(req.userId!, req.email))) return res.status(402).json({ error: "subscription" }); // voces premium = solo suscriptores
    if (rateLimited(req.userId!)) return res.status(429).json({ error: "límite por hora alcanzado" });

    const text = (req.body?.text || "").toString().slice(0, 1500);
    if (!text) return res.status(400).json({ error: "text requerido" });
    const voiceId = (req.body?.voiceId || DEFAULT_VOICE).toString();

    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
      }
    );
    if (!r.ok) {
      let msg = `elevenlabs ${r.status}`;
      try { const j: any = await r.json(); msg = j?.detail?.message || j?.detail || msg; } catch {}
      return res.status(502).json({ error: msg });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("content-type", "audio/mpeg");
    res.send(buf);
  } catch {
    res.status(500).json({ error: "interno" });
  }
}
