import { fetchT } from "./fetchT";

// Recepción crítica REAL desde Wikipedia: es justo donde Wikipedia ya cita —atribuidas y
// en uso legítimo (fair use)— a los grandes medios (Pitchfork, Rolling Stone, The Guardian,
// NME, AllMusic…). Devolvemos el TEXTO de esa sección para que el locutor copie una frase
// VERBATIM y la atribuya. Best-effort: "" si el tema no tiene recepción en Wikipedia
// (gran parte del reggaetón/novedades). NUNCA se inventa una cita.

const cache = new Map<string, { text: string; at: number }>();
const TTL = 24 * 3600 * 1000;
const UA = "Locutor/1.0 (radio musical; contacto rfabregamiralbell@gmail.com)";
const ENABLED = process.env.QUOTES !== "0";
const REC_RE = /(recepci[oó]n|cr[ií]tic|reception|critical|reviews)/i;

const clean = (s: string) => (s || "").replace(/[\[\]"]/g, " ").trim();

// Quita marcas HTML, refs [1], notas [editar] y normaliza espacios.
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<sup[\s\S]*?<\/sup>/gi, " ")          // refs [1]
    .replace(/<[^>]+>/g, " ")                        // resto de etiquetas
    .replace(/&#91;.*?&#93;/g, " ")
    .replace(/\[\d+\]/g, " ")                        // [1] sueltas
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ")
    .replace(/\[\s*editar\s*\]/gi, " ").replace(/\[\s*edit\s*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function receptionFromWiki(lang: string, artist: string, title: string): Promise<string> {
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  // 1) Buscar el artículo del tema.
  const srq = encodeURIComponent(`${clean(title)} ${clean(artist)}`);
  const r1 = await fetchT(`${base}?action=query&list=search&srsearch=${srq}&srlimit=3&format=json&origin=*`,
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 3000);
  if (!r1.ok) return "";
  const d1: any = await r1.json();
  const hits: any[] = d1?.query?.search || [];
  if (!hits.length) return "";
  // Prefiere un artículo cuyo título contenga el del tema (evita desambiguaciones raras).
  const tl = clean(title).toLowerCase();
  const page = (hits.find((h) => (h.title || "").toLowerCase().includes(tl)) || hits[0]).title;

  // 2) Localizar la sección de recepción.
  const r2 = await fetchT(`${base}?action=parse&page=${encodeURIComponent(page)}&prop=sections&format=json&origin=*`,
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 3000);
  if (!r2.ok) return "";
  const d2: any = await r2.json();
  const sections: any[] = d2?.parse?.sections || [];
  const sec = sections.find((s) => REC_RE.test(s.line || ""));
  if (!sec) return "";

  // 3) Traer el HTML de esa sección y limpiarlo.
  const r3 = await fetchT(`${base}?action=parse&page=${encodeURIComponent(page)}&section=${sec.index}&prop=text&disablelimitreport=1&format=json&origin=*`,
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 3500);
  if (!r3.ok) return "";
  const d3: any = await r3.json();
  const html: string = d3?.parse?.text?.["*"] || "";
  const text = stripHtml(html);
  // Solo vale si hay material citable (comillas en el texto = reseñas entrecomilladas).
  if (text.length < 120 || !/["“»]/.test(html)) return "";
  return `[${page} · ${lang}.wikipedia] ${text.slice(0, 2200)}`;
}

// Devuelve el texto de recepción crítica (en/es) o "" si no hay. `outLang` decide la
// preferencia de idioma de la cita (para que a un oyente en español le salga, si existe,
// una reseña en español en vez de una en inglés).
export async function fetchReception(artistRaw: string, titleRaw: string, outLang = ""): Promise<string> {
  if (!ENABLED) return "";
  const artist = clean(artistRaw), title = clean(titleRaw);
  if (!artist || !title) return "";
  const preferEs = /espa|spanish|\bes\b/i.test(outLang);
  const k = (artist + "|" + title + "|" + (preferEs ? "es" : "en")).toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.text;

  let text = "";
  try {
    // En PARALELO (antes era secuencial en->es, hasta ~20s). Preferimos el idioma del oyente
    // y caemos al otro si en su idioma no hay reseña.
    const [en, es] = await Promise.all([
      receptionFromWiki("en", artist, title).catch(() => ""),
      receptionFromWiki("es", artist, title).catch(() => ""),
    ]);
    text = preferEs ? (es || en) : (en || es);
  } catch { text = ""; }

  cache.set(k, { text, at: Date.now() });
  return text;
}
