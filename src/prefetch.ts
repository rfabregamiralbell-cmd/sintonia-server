import { Response } from "express";
import { AuthedRequest } from "./auth";
import { fetchMusicFacts } from "./musicdata";
import { fetchReception } from "./quotes";

// Precalienta las cachés (MusicBrainz / Wikipedia) para la canción que SUENA, antes de que
// el usuario pulse "poner en antena". Así, al pedir el comentario, el enriquecimiento ya está
// cacheado y NO añade espera. NO llama al modelo ni consume cupo: solo rellena caché.
// Responde al instante (fire-and-forget): las cachés siguen calentándose en segundo plano.
export function prefetch(req: AuthedRequest, res: Response) {
  const b: any = req.body ?? {};
  const track = (typeof b.track === "string" ? b.track : "").slice(0, 200);
  const artist = (typeof b.artist === "string" ? b.artist : "").slice(0, 120);
  const outLang = (typeof b.outLang === "string" ? b.outLang : "").slice(0, 30);
  if (!track) return res.json({ ok: false });
  fetchMusicFacts(artist, track).catch(() => {});
  if (b.cita) fetchReception(artist, track, outLang).catch(() => {});
  res.json({ ok: true });
}
