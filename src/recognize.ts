import { Response } from "express";
import { AuthedRequest } from "./auth";
import { fetchT } from "./fetchT";

const AUDD_TOKEN = process.env.AUDD_TOKEN || "";
const RL_MAX = Number(process.env.RECOGNIZE_LIMIT_HOUR ?? "60");

// Límite por usuario/hora (en memoria) para acotar el coste del reconocimiento.
const buckets = new Map<string, { n: number; reset: number }>();
function rateLimited(userId: string): boolean {
  if (RL_MAX <= 0) return false;
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

/**
 * Reconocimiento ambiente: recibe audio en base64, lo reenvía a AudD y devuelve
 * { title, artist }. AudD es de pago/limitado; alternativa: ACRCloud.
 * (ShazamKit, en cambio, sería 100% en el dispositivo y no pasaría por aquí.)
 */
export async function recognize(req: AuthedRequest, res: Response) {
  try {
    if (!AUDD_TOKEN) return res.status(500).json({ error: "reconocimiento no configurado" });
    if (rateLimited(req.userId!)) return res.status(429).json({ error: "límite por hora alcanzado" });
    const b64 = req.body?.audio;
    if (!b64 || typeof b64 !== "string") return res.status(400).json({ error: "audio requerido" });

    const bytes = Buffer.from(b64, "base64");
    if (bytes.length < 1000) return res.status(400).json({ error: "audio demasiado corto" });

    const form = new FormData();
    form.append("api_token", AUDD_TOKEN);
    form.append("file", new Blob([bytes]), "clip.m4a");

    const r = await fetchT("https://api.audd.io/", { method: "POST", body: form as any }, 20000);
    const data: any = await r.json();
    if (data.status !== "success" || !data.result) {
      return res.status(404).json({ error: "sin coincidencia" });
    }
    res.json({
      title: data.result.title ?? "",
      artist: data.result.artist ?? "",
      album: data.result.album ?? "",
    });
  } catch {
    res.status(500).json({ error: "reconocimiento" });
  }
}
