import { Response } from "express";
import db from "./db";
import { AuthedRequest } from "./auth";
import { isSubscribed, checkSubscribed } from "./billing";
import { fetchT } from "./fetchT";
import { globalCapHit, addGlobalSpend } from "./globalbudget";
import { fetchMusicFacts, factsLine } from "./musicdata";
import { fetchReception } from "./quotes";
import { dailyExceeded } from "./dailycap";
import { generate, GEMINI_ENABLED } from "./generate";

const REQUIRE_SUB = (process.env.REQUIRE_SUBSCRIPTION ?? "1") !== "0";
const FREE_TIER_CALLS = Number(process.env.FREE_TIER_CALLS ?? "15"); // comentarios gratis antes de pedir plan
// dailyExceeded ahora vive en ./dailycap (persistido en SQLite, sobrevive a reinicios).

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const MODEL = "claude-sonnet-4-6";
const PRICE_IN = 3 / 1000000;
const PRICE_OUT = 15 / 1000000;
const MARKUP = Number(process.env.MARKUP ?? "0.15");
const RL_MAX = Number(process.env.RATE_LIMIT_HOUR ?? "120");

// Límite simple por usuario/hora (en memoria) para proteger la clave incluida.
const buckets = new Map<string, { n: number; reset: number }>();
function rateLimited(userId: string): boolean {
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

const DJ_SYSTEM =
  "Eres el locutor personal de quien te escucha: criterio musical y oficio de gran presentador de radio. " +
  "Recibes una canción y la personalidad del locutor. Devuelve SOLO el comentario hablado, en el idioma " +
  "indicado, sin markdown, listas ni emojis, ajustando la longitud a la duración pedida. Respeta el estilo, " +
  "el trato, el idioma, el enfoque y el nivel de detalle. " +
  "SUSTANCIA: cada frase aporta UNA observación concreta y no obvia: un detalle de lo que suena (una textura, " +
  "una dinámica, dónde entra o se calla un instrumento, cómo está colocada la voz en la mezcla, la forma de una " +
  "melodía), una lectura afilada de la letra (qué confiesa o esconde el narrador, a quién le habla) o un marco " +
  "emocional o cultural real. Nada de relleno: si una frase valdría igual para cualquier otra canción, bórrala. " +
  "Prohibidos los paraguas vacíos ('buen ritmo', 'mucha energía', 'suena muy bien', 'qué temazo', 'una pasada', " +
  "'me encanta') y las muletillas de relleno ('fíjate', 'fíjate fíjate', 'mira', 'oye', '¿eh?', 'ahí está'); " +
  "no abras con una interjección que dirija la atención, entra directo con la observación. No digas que algo te " +
  "gusta: demuestra POR QUÉ importa señalando qué oyes. " +
  "FIEL: separa dos planos. (1) DATOS VERIFICABLES (fechas, año, productores, sellos, colaboradores, premios, " +
  "posiciones de lista, MUESTRAS/SAMPLES e interpolaciones, quién toca cada instrumento, dónde se grabó): NO se " +
  "inventan nunca; si no lo sabes con certeza, no lo digas. El AÑO es el dato que más se falla: no des fecha salvo " +
  "total certeza; sitúa la época por el SONIDO. Nunca afirmes la PROCEDENCIA de un sonido (que algo samplea otra " +
  "canción o que lo toca tal persona): describe el sonido que OYES, no de dónde viene. (2) PERCEPCIÓN (lo que suena " +
  "y lo que dice la letra): aquí sé específico, audaz y seguro. Ante la duda entre soltar un dato o describir lo que " +
  "suena, elige SIEMPRE describir lo que suena. Si no reconoces la canción, no pasa nada: coméntala por lo que oyes. " +
  "REGLA FIJA, sin excepción: no sabes que eres una app, ni que hay un idioma de interfaz, ni ajustes, ni 'modo cita', " +
  "ni nada de lo que hay detrás de este comentario; JAMÁS menciones ni de pasada nada de eso (ni 'he cambiado de " +
  "idioma', ni 'ahora hablo en inglés', ni 'esto es un anuncio que se detectó', ni comentarios sobre el propio " +
  "sistema): solo existes reaccionando a lo que suena AHORA, punto.";

function buildPrompt(p: any): string {
  // Modo ANUNCIO: no suena música, hay un corte publicitario; reacciona al corte.
  if (p.moment === "Anuncio") {
    let s = `Soy tu oyente. Escucho en ${p.platform}. Ahora mismo NO suena música: ha entrado un ANUNCIO / corte publicitario. Reacciona al corte EN DIRECTO con naturalidad y un punto de humor cómplice (NO sabes qué anuncian ni lo promociones): un respiro mientras vuelve la música. Breve y con vida.\n`;
    s += `Estilo del locutor: ${p.tone}.\n`;
    if (p.djName) s += `Te llamas ${p.djName}.\n`;
    s += `Trata al oyente de "${p.treatment}".\n`;
    if (p.catchphrase) s += `Si encaja, abre con tu muletilla: "${p.catchphrase}".\n`;
    s += `Idioma de salida: ${p.outLang}. Frase hablada (sin markdown ni emojis). Apunta a unos ${p.duration} segundos.`;
    return s;
  }
  const dims = p.dims.length ? p.dims.join(", ") : "lo más interesante";
  const themes = p.themes && p.themes.length ? p.themes.join(", ") : "";
  let s = `Soy tu oyente. Escucho en ${p.platform}. `;
  s += p.moment === "Presentación"
    ? `Presenta la próxima canción antes de que suene: ${p.track}${p.artist ? " de " + p.artist : ""}.\n`
    : `Comenta la canción que suena: ${p.track}${p.artist ? " de " + p.artist : ""}.\n`;
  // Tipo de locución "CITA": NO opines tú; copia una reseña REAL y atribúyela. Cero invención.
  // Si NO hay reseña citable, ya NO avisamos de nada: caemos directo al comentario normal de
  // abajo con el "style" real del oyente (nombrar/ligero/denso), tal cual si citas nunca se
  // hubiera pedido — el oyente no tiene por qué notar que se intentó y no había.
  if (p.cita && p.reception) {
    s += `MODO CITA. Aquí tienes la RECEPCIÓN CRÍTICA REAL de este tema (extraída de Wikipedia, que cita medios reales): «${p.reception}».\n`;
    s += `Tu locución: presenta el tema en media frase y luego trae ANÁLISIS ORIGINAL DE CRÍTICOS Y EXPERTOS. Busca en ese texto las frases entrecomilladas claramente atribuibles a un crítico o medio y CITA hasta TRES, siempre que sean de medios o autores DISTINTOS entre sí (por ejemplo Pitchfork, Rolling Stone, The Guardian, NME, AllMusic…); si solo hay una cita clara en el texto, usa solo esa, no la fuerces ni la dupliques. Atribuye cada una al medio o autor EXACTO que la firma. IDIOMA DE LA CITA: si el texto original de la cita ya está en ${p.outLang}, cópiala LITERAL, palabra por palabra, entre comillas (por ejemplo: «La revista Pitchfork escribió, cito textualmente: "…"»). Si está en OTRO idioma, TRADÚCELA tú de forma FIEL y completa a ${p.outLang} —nunca la dejes sin traducir ni la sueltes en el idioma original— y dilo explícitamente al atribuirla (por ejemplo: «La revista Pitchfork escribió, traduzco: "…"»); la traducción tiene que decir EXACTAMENTE lo mismo que el original, ni más ni menos, sin suavizar ni intensificar el juicio. Si citas más de una, enlázalas con una transición breve de radio, sin opinar tú por encima del contenido (por ejemplo: «Y no fue la única lectura: la revista Rolling Stone, por su parte, escribió, traduzco: "…"»). PROHIBIDO inventar, parafrasear, resumir o añadir cualquier cosa que no esté en el texto original (traducida o no); PROHIBIDO también atribuir una frase a un medio distinto del que la firma en ese texto. Tu única aportación es presentar, traducir con fidelidad si hace falta, y enlazar las citas, no comentarlas ni valorarlas tú. Si en ese texto no hay ninguna frase entrecomillada claramente atribuible a un medio o crítico, di en una frase que de este tema aún no encuentras reseñas que citar.\n`;
    s += `Estilo del locutor: ${p.tone}. ${p.djName ? "Te llamas " + p.djName + ". " : ""}Trata al oyente de "${p.treatment}".\n`;
    s += `Idioma de salida: ${p.outLang}. Frase hablada (sin markdown ni emojis). Apunta a unos ${p.duration} segundos.`;
    return s;
  }
  if (p.prevTrack) s += `Acabas de pinchar "${p.prevTrack}": haz una transición de DJ, cierra esa y enlaza con la nueva.\n`;
  if (p.factsLine) s += `${p.factsLine}\n`;
  if (p.liveCtx) s += `${p.liveCtx} Hablas EN DIRECTO, reaccionando a lo que suena en este instante (no como un guion).\n`;
  if (p.recentSaid && p.recentSaid.length) s += `YA HAS DICHO ESTO en comentarios anteriores de la sesión — NO lo repitas (ni ideas, ni frases, ni la misma apertura ni estructura): busca un ángulo y unas palabras NUEVAS. Ya dicho: ${p.recentSaid.map((x: string) => `"${String(x).slice(0, 160)}"`).join(" / ")}.\n`;
  s += `Varía el RITMO: mezcla alguna frase corta con una reflexión más personal o una duda; no encadenes sentencias densas e iguales. Suena a alguien pensando en voz alta EN DIRECTO, no a un informe leído.\n`;
  // Estilo de contenido (gratis = nombrar/ligero · premium = denso). "nombrar" y "ligero" se
  // parecían demasiado (ambos "una frase suelta") y sonaban intercambiables/genéricos entre
  // sí y entre reproducciones. Ahora se diferencian por FUNCIÓN, no solo por longitud: nombrar
  // es una IDENTIFICACIÓN (sin percepción alguna), ligero es SIEMPRE una observación concreta
  // y señalable (dato real o detalle de oído), nunca una impresión vacía.
  if (p.style === "nombrar") {
    s += `Modo MÍNIMO: solo IDENTIFICA lo que suena —${p.track}${p.artist ? " de " + p.artist : ""}—, en UNA frase corta, como una identificación de radio. CERO percepción o análisis del sonido: nada de "suena a...", "tiene un aire...", ni adjetivos de relleno ("una pasada", "qué temazo"). Si tienes un DATO VERIFICADO abajo (año, álbum, origen, género), puedes teñir la frase con ESE dato concreto en vez de dejarla pelada; si no hay dato, la identificación sola basta y sobra.\n`;
  } else if (p.style === "ligero") {
    s += `Modo LIGERO: UN solo apunte, en una o dos frases, pero tiene que ser CONCRETO Y SEÑALABLE, nunca una impresión genérica que valdría para cualquier canción. Dos caminos válidos, elige uno según lo que tengas: (a) un DETALLE REAL de lo que suena —un acorde, dónde entra o calla un instrumento, cómo está colocada la voz, una palabra de la letra— con el mismo rigor de SUSTANCIA aunque sea una sola línea; o (b) si tienes abajo un DATO VERIFICADO que encaje mejor esta vez, tíralo como curiosidad con naturalidad. PROHIBIDO el relleno atmosférico sin contenido ("un detalle que engancha", "algo que se te queda", "buen rollo"): si no puedes nombrar el QUÉ exacto, no lo digas. (Sigues FIEL: no inventes datos.)\n`;
  }
  s += `Dimensiones a analizar: ${dims}.\n`;
  if (themes) s += `Enfoque temático prioritario: ${themes}.\n`;
  s += `Estilo del locutor: ${p.tone}.\n`;
  if (p.djName) s += `Te llamas ${p.djName}.\n`;
  if (p.charGender || p.charAge) s += `Encarnas a un personaje ${[p.charGender, p.charAge].filter(Boolean).join(" ")}: que se note en la actitud y la forma de hablar, sin caricatura.\n`;
  s += `Trata al oyente de "${p.treatment}".\n`;
  if (p.listenerLevel) s += `Nivel del oyente: ${p.listenerLevel}. Ajusta a ese nivel el vocabulario y cuánto explicas (a un principiante, sin jerga; a un experto, sin obviedades).\n`;
  if (p.persona) s += `INSTRUCCIÓN ESPECIAL de este locutor (respétala siempre, moldea su carácter): ${p.persona}\n`;
  s += `Nivel de detalle: ${p.depth}/5.\n`;
  if (p.style === "denso" && p.depth >= 4) {
    s += `Modo análisis profundo: profundiza de verdad, con densidad alta de ideas y cero relleno. ` +
      `Detalles de composición, producción y teoría musical explicada de forma accesible, SIEMPRE ` +
      `partiendo de lo que se oye. Trae contexto, conexiones o anécdotas SOLO si estás seguro de que ` +
      `son ciertas; si dudas, no las metas: una observación precisa sobre el sonido vale más que un ` +
      `dato dudoso. Prioriza lo más revelador y sorprendente. Encadena ideas con criterio, no enumeres.\n`;
  }
  s += `Idioma de salida: ${p.outLang}.\n`;
  if (p.voiceRef) s += `IMITA esta VOZ de referencia: capta su ESENCIA —registro, ritmo, vocabulario, actitud y forma de las frases— y comenta la canción HABLANDO ASÍ. NO copies sus palabras ni comentes su contenido; absorbe su VOZ y aplícala. Referencia: «${p.voiceRef}».\n`;
  if (p.catchphrase) s += `Si encaja, abre con tu muletilla: "${p.catchphrase}".\n`;
  if (p.avoidRepeat && p.recent && p.recent.length) s += `No repitas lo ya comentado sobre: ${p.recent.join("; ")}.\n`;
  if (p.likedSamples && p.likedSamples.length) s += `GUSTOS DEL OYENTE (aprende de ellos): le han gustado ESPECIALMENTE estos comentarios tuyos anteriores (los marcó como favoritos). Capta lo que tienen en común —tono, enfoque, longitud, tipo de observación, actitud— y TIENDE hacia ese estilo, SIN copiarlos ni repetir su contenido: ${p.likedSamples.map((x: string) => `"${String(x).slice(0, 200)}"`).join(" / ")}.\n`;
  s += `Apunta a una locución de unos ${p.duration} segundos.`;
  return s;
}

export async function commentary(req: AuthedRequest, res: Response) {
  try {
    const userId = req.userId!;
    const userKeyHeader = req.headers["x-user-key"];
    // BYOK SOLO si parece una clave real de Anthropic; si no, NO salta el gating (va por managed).
    const rawUserKey = typeof userKeyHeader === "string" ? userKeyHeader.trim() : "";
    const userKey = (/^sk-ant-/.test(rawUserKey) && rawUserKey.length > 20) ? rawUserKey : "";
    // Hay con qué generar si: BYOK del usuario, o Gemini (motor principal), o Anthropic (org).
    if (!userKey && !GEMINI_ENABLED && !ANTHROPIC_KEY) return res.status(500).json({ error: "falta clave de IA" });

    const u: any = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!u) return res.status(401).json({ error: "usuario no encontrado" });

    const b: any = req.body ?? {};
    if (!b.track) return res.status(400).json({ error: "track requerido" });

    // Cap DURO de toda entrada del cliente: evita (a) URLs gigantes a MusicBrainz/Wikipedia,
    // (b) inflar input_tokens/factura metiendo megabytes en el prompt a Anthropic, (c) abuso.
    const cap = (s: any, n: number) => String(s ?? "").slice(0, n);
    const capArr = (a: any, n: number, len: number) => (Array.isArray(a) ? a.slice(0, n).map((x) => cap(x, len)) : []);

    const p = {
      track: cap(b.track, 200),
      artist: cap(b.artist, 120),
      dims: Array.isArray(b.focuses) ? capArr(b.focuses, 8, 60) : b.focus ? [cap(b.focus, 60)] : [],
      themes: capArr(b.themes, 8, 60),
      tone: cap(b.tone || "Cercano", 160),
      depth: Number(b.depth) || 3,
      duration: Number(b.duration) > 0 ? Math.min(180, Number(b.duration)) : 25,
      platform: cap(b.platform || "Apple Music", 40),
      djName: cap(b.djName, 60),
      outLang: cap(b.outLang || "Español", 30),
      treatment: cap(b.treatment || "tú", 40),
      catchphrase: cap(b.catchphrase, 80),
      voiceRef: cap(b.voiceRef, 700),   // referencia de voz/estilo a imitar
      listenerLevel: cap(b.listenerLevel, 30),  // nivel del oyente (principiante/aficionado/experto)
      charGender: cap(b.charGender, 20),         // género del personaje (si no es neutro)
      charAge: cap(b.charAge, 20),               // edad del personaje (si no es adulto)
      persona: cap(b.persona, 400),              // instrucción personalizada del locutor
      avoidRepeat: !!b.avoidRepeat,
      moment: cap(b.moment || "Comentario", 30),
      liveCtx: cap(b.liveCtx, 600),
      prevTrack: cap(b.prevTrack, 200),
      recent: capArr(b.recent, 8, 200),
      recentSaid: capArr(b.recentSaid, 8, 240),
      likedSamples: capArr(b.likedSamples, 3, 240),  // comentarios que el oyente marcó ❤ (aprende su estilo)
      style: typeof b.style === "string" ? b.style : "denso", // nombrar | ligero | denso
      cita: !!b.cita,   // pide reseñas reales citadas; si no hay, cae a "style" tal cual, SIN avisar
      factsLine: "",
      reception: "",
    };

    // --- Gates (parte 1): autorización y rate-limit. El cupo diario de COSTE va DESPUÉS del
    // enriquecimiento, para que el modo cita SIN reseña no gaste cupo del usuario. ---
    let subscribed = true;
    if (!userKey) {
      // Free-tier: los primeros FREE_TIER_CALLS comentarios son gratis para CUALQUIER usuario
      // (incluidos invitados). El invitado se identifica por un deviceId = UUID estable que el
      // cliente persiste, así que el contador (u.calls) aguanta por dispositivo; la creación de
      // invitados está limitada por IP en /auth/guest y el gasto por el tope global. Sin esto, el
      // móvil (que va como invitado, aún sin login) no tendría NINGÚN comentario gratis.
      const isGuest = userId.startsWith("guest:");
      const onFreeTier = u.calls < FREE_TIER_CALLS;
      subscribed = (REQUIRE_SUB && !onFreeTier) ? await checkSubscribed(userId, req.email) : isSubscribed(u);
      // Agotado el free-tier: al invitado se le pide entrar (una cuenta real da su propio free-tier
      // y desbloquea la suscripción); a la cuenta real ya identificada, hacerse Premium.
      if (REQUIRE_SUB && !onFreeTier && !subscribed) return res.status(402).json({ error: isGuest ? "login" : "subscription" });
    }
    // Rate-limit por hora a TODOS (incluido BYOK): nadie martillea el servidor ni los servicios externos.
    if (rateLimited(userId)) return res.status(429).json({ error: "límite por hora alcanzado" });

    // Enriquecimiento (best-effort, cacheado): citas reales (Wikipedia) si p.cita; datos
    // verificados (MusicBrainz) siempre que haga falta un comentario normal — incluido
    // cuando p.cita pidió reseña y no la hay: cae a un comentario normal de "style" con el
    // mismo enriquecimiento que tendría de por sí, en vez de ir a pelo. Sin aviso: el
    // oyente no tiene por qué saber que se pidieron citas y no había.
    if (p.moment !== "Anuncio" && p.track) {
      // MusicBrainz (para el álbum) y la recepción a nivel de CANCIÓN en paralelo: la
      // mayoría de canciones no tienen artículo propio en Wikipedia, así que casi siempre
      // hará falta el álbum de todos modos.
      const factsPromise = fetchMusicFacts(p.artist, p.track).catch(() => null);
      if (p.cita) {
        const [songReception, facts] = await Promise.all([
          fetchReception(p.artist, p.track, p.outLang).catch(() => ""),
          factsPromise,
        ]);
        let albumReception = "";
        // Nivel ÁLBUM como respaldo (y complemento): los álbumes tienen MUCHA más cobertura
        // de crítica en Wikipedia que canciones sueltas —la mayoría de temas ni tienen
        // artículo propio—, así que sin esto la mayoría de casos se quedarían sin nada.
        if (facts?.album) {
          albumReception = await fetchReception(p.artist, facts.album, p.outLang).catch(() => "");
        }
        p.reception = [songReception, albumReception].filter(Boolean).join("\n\n");
        if (!p.reception) p.factsLine = factsLine(facts);
      } else {
        try { p.factsLine = factsLine(await factsPromise); } catch { /* sin datos */ }
      }
    }

    // --- Gates (parte 2): coste (cupo diario / presupuesto / cap global). Solo IA managed.
    // Aquí ya hemos pasado el modo cita-sin-reseña (que salió sin gastar cupo). ---
    if (!userKey) {
      if (dailyExceeded(userId)) return res.status(429).json({ error: "límite diario alcanzado" });
      if (!subscribed && globalCapHit()) return res.status(503).json({ error: "servicio saturado, prueba más tarde" }); // no corta a quien paga
      if (!subscribed && u.budget > 0 && u.spend >= u.budget) return res.status(402).json({ error: "budget" });
    }

    // La longitud escala con la duración pedida. Tope alto para permitir
    // análisis densos y largos (web/escritorio), acotado por presupuesto/cap diario.
    // Solo con cita Y reseña real: piso más alto — hasta 3 citas VERBATIM (no
    // parafraseables/comprimibles) más sus transiciones no caben en el presupuesto normal.
    // Sin reseña cae a "style" normal, así que usa el presupuesto normal de ese estilo.
    const maxTokens = p.cita && p.reception
      ? Math.max(500, Math.min(1200, Math.round(p.duration * 4) + 200))
      : Math.max(120, Math.min(1200, Math.round(p.duration * 4) + 60));

    // Motor PRINCIPAL Gemini (barato) si hay GEMINI_KEY; si no, Anthropic; BYOK usa su clave.
    let gen;
    try {
      gen = await generate(DJ_SYSTEM, buildPrompt(p), maxTokens, userKey);
    } catch (e) {
      console.error("commentary gen:", e);
      return res.status(502).json({ error: "modelo no disponible" });
    }
    const text = gen.text;

    // Si el modelo no devolvió texto, NO cobramos ni gastamos cupo (sería cobrar por nada).
    if (!text) return res.status(502).json({ error: "respuesta vacía del modelo", empty: true });

    let charged = 0;
    if (!userKey) {
      charged = gen.charged;
      db.prepare(
        "UPDATE users SET spend = spend + ?, calls = calls + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?"
      ).run(charged, gen.inTok, gen.outTok, userId);
      addGlobalSpend(charged); // acumula al tope de gasto global del día
    }

    const after: any = db.prepare("SELECT spend, budget, calls, subscribed, sub_until FROM users WHERE id = ?").get(userId);
    const freeRemaining = Math.max(0, FREE_TIER_CALLS - (after.calls ?? 0));
    res.json({
      text,
      usage: { input_tokens: gen.inTok, output_tokens: gen.outTok },
      charged,
      spend: after.spend,
      budget: after.budget,
      remaining: after.budget > 0 ? Math.max(0, after.budget - after.spend) : null,
      freeRemaining,
      subscribed: isSubscribed(after),
    });
  } catch (e) {
    console.error("commentary:", e);
    res.status(500).json({ error: "interno" });
  }
}
