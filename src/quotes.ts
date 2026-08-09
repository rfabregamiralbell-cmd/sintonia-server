import { fetchT } from "./fetchT";

// Recepción crítica REAL desde Wikipedia: es justo donde Wikipedia ya cita —atribuidas y
// en uso legítimo (fair use)— a los grandes medios (Pitchfork, Rolling Stone, The Guardian,
// NME, AllMusic…). Devolvemos el TEXTO de esa sección para que el locutor copie una frase
// VERBATIM y la atribuya. Best-effort: "" si el tema no tiene recepción en Wikipedia
// (gran parte del reggaetón/novedades). NUNCA se inventa una cita.
// (Se evaluó añadir Album of the Year como segunda fuente: su contenido es igual de válido
// —recopilación de reseñas reales con atribución—, pero su protección antibots bloquea de
// forma sistemática las peticiones del propio servidor (fingerprint TLS/HTTP, no cabeceras),
// y evadir eso no es algo que debamos hacer. Se descartó; Wikipedia sigue siendo la fuente,
// vía su API pública pensada para reutilización.)

const cache = new Map<string, { text: string; at: number }>();
const TTL = 24 * 3600 * 1000;
const UA = "Locutor/1.0 (radio musical; contacto rfabregamiralbell@gmail.com)";
const ENABLED = process.env.QUOTES !== "0";
// Variantes de título de sección en los 4 idiomas que buscamos: es/recepción-acogida-
// valoración-reseñas, pt/recepção, fr/critique-accueil, en/reception-critical-reviews.
// Palabra de CRÍTICA propiamente dicha: si aparece, la sección vale sola (aunque diga
// "comercial" en otra parte del título, poco probable).
const CRITIC_WORD_RE = /cr[ií]tic|critique|critical|reviews/i;
// "Recepción"/"acogida" a secas es AMBIGUO: Wikipedia también titula así secciones de
// RECEPCIÓN COMERCIAL (ventas, taquilla, gira) que no tienen nada que ver con la crítica.
// Solo cuentan si NO van acompañadas de una palabra comercial en el mismo título.
const GENERIC_REC_RE = /(recepci[oó]n|recep[çc][ãa]o|acogida|valoraci[oó]n|rese[ñn]as?|reception)/i;
const COMERCIAL_RE = /comercial|commercial|taquilla|box\s*office|ventas|gira|tour/i;
// Idiomas de Wikipedia que probamos (mismo set que soporta el locutor: es/en/pt/fr).
const LANGS = ["en", "es", "pt", "fr"];
// Orden de preferencia: el idioma del oyente primero (más probable que tenga la reseña
// que le sirve), el resto detrás como red de seguridad.
function prefOrder(outLang: string): string[] {
  const o = (outLang || "").toLowerCase();
  const primary = /espa|spanish/.test(o) ? "es" : /portugu/.test(o) ? "pt" : /franc|french/.test(o) ? "fr" : "en";
  return [primary, ...LANGS.filter((l) => l !== primary)];
}

const clean = (s: string) => (s || "").replace(/[\[\]"]/g, " ").trim();
// Sin acentos y en minúsculas, para comparar títulos sin que un acento de más/de menos
// (o mayúsculas) rompa la coincidencia exacta: quita las marcas diacríticas que deja "NFD"
// al descomponer (e.g. é -> e + acento suelto). Rango construido por código de carácter
// (0x300-0x36f), no como literal en el regex, para no depender de tipear el símbolo.
const DIACRITIC_RE = new RegExp("[" + String.fromCharCode(0x300) + "-" + String.fromCharCode(0x36f) + "]", "g");
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(DIACRITIC_RE, "");

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
  // Prefiere el artículo cuyo título coincide EXACTO con el tema buscado (ignorando
  // acentos/mayúsculas); si no hay exacto, cae a uno que lo contenga como subcadena. Antes
  // solo miraba "contiene", y eso podía coger un artículo más largo relacionado pero
  // distinto (p. ej. "X World Tour" en vez del álbum "X") si rankeaba primero en la
  // búsqueda de Wikipedia.
  const tl = norm(title);
  const exact = hits.find((h) => norm(h.title || "") === tl);
  const partial = hits.find((h) => norm(h.title || "").includes(tl));
  const page = (exact || partial || hits[0]).title;

  // 2) Localizar la sección de recepción CRÍTICA (no comercial: taquilla, gira, ventas...
  // Wikipedia también usa "Recepción" para eso, y no tiene nada que citar de un crítico).
  const r2 = await fetchT(`${base}?action=parse&page=${encodeURIComponent(page)}&prop=sections&format=json&origin=*`,
    { headers: { "User-Agent": UA, Accept: "application/json" } }, 3000);
  if (!r2.ok) return "";
  const d2: any = await r2.json();
  const sections: any[] = d2?.parse?.sections || [];
  const sec = sections.find((s) => {
    const line = s.line || "";
    if (COMERCIAL_RE.test(line)) return false;
    return CRITIC_WORD_RE.test(line) || GENERIC_REC_RE.test(line);
  });
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
  // Margen más amplio que antes (2200 -> 3200): las secciones de recepción con varios
  // medios citados (Pitchfork, Rolling Stone, The Guardian…) se cortaban a mitad de la
  // segunda o tercera cita, dejando solo una utilizable para el modo Citas.
  return `[${page} · ${lang}.wikipedia] ${text.slice(0, 3200)}`;
}

// Devuelve el texto de recepción crítica (probando en/es/pt/fr) o "" si no hay en ninguno.
// `outLang` decide la preferencia de idioma de la cita (para que a un oyente en español le
// salga, si existe, una reseña en español en vez de en otro idioma).
export async function fetchReception(artistRaw: string, titleRaw: string, outLang = ""): Promise<string> {
  if (!ENABLED) return "";
  const artist = clean(artistRaw), title = clean(titleRaw);
  if (!artist || !title) return "";
  const order = prefOrder(outLang);
  const k = (artist + "|" + title + "|" + order[0]).toLowerCase();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.text;

  let text = "";
  try {
    // Las 4 ediciones de Wikipedia EN PARALELO: más temas tienen sección de recepción
    // citable en algún idioma que en otro (p. ej. reguetón más cubierto en español que en
    // inglés, o al revés con indie/rock angloparlante).
    const results = await Promise.all(order.map((l) => receptionFromWiki(l, artist, title).catch(() => "")));
    text = results.find((t) => t) || "";
  } catch { text = ""; }

  cache.set(k, { text, at: Date.now() });
  return text;
}
