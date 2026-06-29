import { fetchT } from "./fetchT";

// Datos musicales VERIFICADOS (MusicBrainz, gratis y sin clave) para que los locutores
// suelten datos curiosos CIERTOS (año, origen del artista, si es grupo/solista, época de
// formación, géneros) en vez de evitarlos o inventarlos. Best-effort: si falla o no
// encuentra, devuelve null y el comentario sigue como hasta ahora (sin datos).

export type MusicFacts = {
  year?: string;        // año de publicación del tema
  artist?: string;      // nombre canónico del artista
  area?: string;        // país/origen del artista
  type?: string;        // "grupo" | "solista"
  began?: string;       // año de formación/nacimiento artístico
  genres?: string[];    // géneros/etiquetas verificadas
};

const cache = new Map<string, { facts: MusicFacts | null; at: number }>();
const TTL = 24 * 3600 * 1000; // 1 día
const UA = "Locutor/1.0 (radio musical; contacto rfabregamiralbell@gmail.com)";
const MB = "https://musicbrainz.org/ws/2";
const ENABLED = process.env.MUSICDATA !== "0";

const clean = (s: string) => (s || "").replace(/["\\]/g, " ").trim();

export async function fetchMusicFacts(artistRaw: string, titleRaw: string): Promise<MusicFacts | null> {
  if (!ENABLED) return null;
  const artist = clean(artistRaw), title = clean(titleRaw);
  if (!artist || !title || artist.length < 1 || title.length < 1) return null;
  const k = (artist + "|" + title).toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.facts;

  let facts: MusicFacts | null = null;
  try {
    // 1) Buscar la grabación (título + artista) -> año + MBID del artista.
    const q = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
    const r1 = await fetchT(`${MB}/recording?query=${q}&fmt=json&limit=5`,
      { headers: { "User-Agent": UA, Accept: "application/json" } }, 3500);
    if (r1.ok) {
      const d: any = await r1.json();
      const recs: any[] = d.recordings || [];
      const good = recs.filter((x) => (x.score ?? 0) >= 88);
      const pool = good.length ? good : recs.slice(0, 1);
      const rec = pool[0];
      if (rec) {
        facts = {};
        // Año = el MÁS TEMPRANO entre las buenas coincidencias (evita coger una reedición).
        const years = pool
          .flatMap((x: any) => [x["first-release-date"], ...((x.releases || []).map((rl: any) => rl.date))])
          .filter((s: any) => typeof s === "string" && /^\d{4}/.test(s))
          .map((s: string) => s.slice(0, 4))
          .sort();
        if (years.length) facts.year = years[0];
        const credit = (rec["artist-credit"] || [])[0]?.artist;
        if (credit?.name) facts.artist = credit.name;
        const mbid = credit?.id;

        // 2) Ficha del artista (origen, tipo, formación, géneros). Best-effort.
        if (mbid) {
          try {
            const r2 = await fetchT(`${MB}/artist/${mbid}?inc=genres&fmt=json`,
              { headers: { "User-Agent": UA, Accept: "application/json" } }, 3000);
            if (r2.ok) {
              const a: any = await r2.json();
              if (a.area?.name) facts.area = a.area.name;
              if (a.type) facts.type = a.type === "Group" ? "grupo" : a.type === "Person" ? "solista" : a.type;
              const begin: string = a["life-span"]?.begin || "";
              if (begin && /^\d{4}/.test(begin)) facts.began = begin.slice(0, 4);
              const g = (a.genres || []).sort((x: any, y: any) => (y.count || 0) - (x.count || 0)).slice(0, 4).map((x: any) => x.name);
              if (g.length) facts.genres = g;
            }
          } catch { /* ignora: nos quedamos con lo de la grabación */ }
        }
        // Sin ningún dato útil -> trátalo como no encontrado.
        if (!facts.year && !facts.area && !facts.genres) facts = null;
      }
    }
  } catch { facts = null; }

  cache.set(k, { facts, at: Date.now() });
  return facts;
}

// Convierte los datos en una línea para el prompt (o "" si no hay nada).
export function factsLine(f: MusicFacts | null): string {
  if (!f) return "";
  const bits: string[] = [];
  if (f.year) bits.push(`publicado en ${f.year}`);
  if (f.type && f.began) bits.push(`${f.artist || "el artista"} es ${f.type} (de ${f.began})`);
  else if (f.type) bits.push(`${f.artist || "el artista"} es ${f.type}`);
  if (f.area) bits.push(`origen: ${f.area}`);
  if (f.genres && f.genres.length) bits.push(`géneros: ${f.genres.join(", ")}`);
  if (!bits.length) return "";
  return `DATOS VERIFICADOS (ciertos, de base de datos musical): ${bits.join("; ")}. TEJE en el comentario AL MENOS UNO de estos datos como una curiosidad real, con naturalidad y en el momento que encaje (NO como una ficha ni los enumeres todos): son ESTOS los únicos datos duros que puedes afirmar; el resto, descríbelo por lo que suena.`;
}
