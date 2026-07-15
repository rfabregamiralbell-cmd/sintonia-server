import { Response } from "express";
import { AuthedRequest } from "./auth";

// Voz neural GRATIS de Microsoft Edge ("Read Aloud"), servida desde el backend para
// que el MÓVIL (Capacitor, sin Node) tenga la misma voz por defecto que el escritorio.
// msedge-tts abre un websocket al servicio de Edge y devuelve MP3; aquí lo pasamos a
// base64 (misma forma que /tts y /tts-gemini: el cliente reproduce el audio).

let _voicesCache: any[] | null = null;

export async function edgeTts(req: AuthedRequest, res: Response) {
  try {
    const b: any = req.body ?? {};
    const text = (typeof b.text === "string" ? b.text : "").slice(0, 4000);
    const voiceId = (typeof b.voiceId === "string" && b.voiceId) ? b.voiceId : "es-ES-AlvaroNeural";
    if (!text.trim()) return res.status(400).json({ error: "sin texto" });

    const mod: any = await import("msedge-tts");
    const MsEdgeTTS = mod.MsEdgeTTS || (mod.default && mod.default.MsEdgeTTS);
    const OUTPUT_FORMAT = mod.OUTPUT_FORMAT || (mod.default && mod.default.OUTPUT_FORMAT);
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = await tts.toStream(text);

    const chunks: Buffer[] = [];
    const buf: Buffer = await new Promise((resolve) => {
      const to = setTimeout(() => { try { audioStream.destroy(); } catch {} resolve(Buffer.concat(chunks)); }, 20000);
      audioStream.on("data", (d: Buffer) => chunks.push(d));
      audioStream.on("end", () => { clearTimeout(to); resolve(Buffer.concat(chunks)); });
      audioStream.on("error", () => { clearTimeout(to); resolve(Buffer.concat(chunks)); });
    });
    if (!buf.length) return res.status(502).json({ error: "sin audio" });
    return res.json({ audio: buf.toString("base64"), mime: "audio/mpeg" });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

export async function edgeVoices(_req: AuthedRequest, res: Response) {
  try {
    if (_voicesCache) return res.json({ voices: _voicesCache });
    const mod: any = await import("msedge-tts");
    const MsEdgeTTS = mod.MsEdgeTTS || (mod.default && mod.default.MsEdgeTTS);
    const list: any[] = await new MsEdgeTTS().getVoices();
    _voicesCache = (list || []).map((v: any) => ({
      id: v.ShortName,
      name: v.FriendlyName
        ? String(v.FriendlyName).replace(/^Microsoft\s+/i, "").replace(/\s+Online \(Natural\)/i, "")
        : v.ShortName,
      locale: v.Locale || "",
      gender: v.Gender || "",
    })).filter((v: any) => v.id);
    return res.json({ voices: _voicesCache });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
