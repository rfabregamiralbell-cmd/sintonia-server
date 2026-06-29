import "dotenv/config";
import path from "path";
import express from "express";
import cors from "cors";
import db from "./db";
import { authApple, authGoogle, authGoogleWeb, authDev, authGuest, requireAuth } from "./auth";
import { commentary } from "./commentary";
import { program } from "./program";
import { getUsage, setBudget, syncSave, syncLoad } from "./me";
import { publish, browse, getOne, remove } from "./stations";
import { checkout, webhook, status, verifyApple, verifyGoogle } from "./billing";
import { recognize } from "./recognize";
import { tts } from "./tts";
import { ipLimit } from "./ratelimit";

const app = express();
app.set("trust proxy", 1); // Render va detrás de proxy: necesario para la IP real (rate-limit)

// CORS restringido: la app de escritorio NO envía Origin (permitido); los
// navegadores solo si su origen está en ALLOWED_ORIGINS (coma-separado).
const ALLOWED = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);            // escritorio / server-to-server
    return cb(null, ALLOWED.includes(origin));     // navegador: solo allowlist
  },
}));

// Stripe webhook: necesita el body crudo y va ANTES de express.json().
app.post("/billing/webhook", express.raw({ type: "application/json" }), webhook);

app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => {
  // Comprueba también que la BD responde (no solo que el proceso vive).
  try { db.prepare("SELECT 1").get(); return res.json({ ok: true, db: true }); }
  catch { return res.status(503).json({ ok: false, db: false }); }
});

// Landing estática (web del producto) servida desde /public en la raíz del dominio.
// Solo responde a ficheros que EXISTEN (index.html, privacy.html, success.html, cancel.html);
// cualquier otra ruta pasa de largo a los handlers de la API de abajo.
app.use(express.static(path.join(__dirname, "..", "public")));

// Páginas de retorno de Stripe Checkout (billing.ts usa /billing/ok y /billing/cancel).
const PUBLIC = path.join(__dirname, "..", "public");
app.get("/billing/ok", (_req, res) => res.sendFile(path.join(PUBLIC, "success.html")));
app.get("/billing/cancel", (_req, res) => res.sendFile(path.join(PUBLIC, "cancel.html")));

// Autenticación (el móvil manda el idToken nativo; dev = solo pruebas)
app.post("/auth/apple", authApple);
app.post("/auth/google", authGoogle);
app.post("/auth/google/web", authGoogleWeb); // web: login Google por código (PKCE)
app.post("/auth/guest", ipLimit(20), authGuest); // web sin login: sesión de invitado (máx 20/h por IP)
// /auth/dev (login de pruebas sin verificar) NO se registra en producción. Con tope por IP además.
if (process.env.NODE_ENV !== "production") app.post("/auth/dev", ipLimit(20), authDev);

// IA (requiere sesión). ipLimit añade un tope por IP además del tope por usuario,
// para que ni siquiera BYOK (x-user-key) ni invitados puedan martillear.
app.post("/commentary", ipLimit(120), requireAuth, commentary); // 1 locutor (freemium)
app.post("/program", ipLimit(120), requireAuth, program); // varios locutores (premium / BYOK)
app.post("/tts", requireAuth, tts); // voces premium ElevenLabs incluidas (solo suscriptores)
app.get("/me/usage", requireAuth, getUsage);
app.post("/me/budget", requireAuth, setBudget);
// /me/reset ELIMINADO: reseteaba el contador de free-tier y el gasto -> IA gratis ilimitada.
app.post("/me/sync", requireAuth, syncSave); // guarda emisoras + historial del usuario
app.get("/me/sync", requireAuth, syncLoad);  // recupera emisoras + historial del usuario

// Emisoras en la nube
app.post("/stations", requireAuth, publish);
app.get("/stations", browse); // explorar es público
app.get("/stations/:id", getOne); // importar es público
app.delete("/stations/:id", requireAuth, remove);

// Cobro / suscripción
app.get("/billing/status", requireAuth, status);
app.post("/billing/checkout", requireAuth, checkout); // Stripe -> devuelve url
app.post("/billing/apple", requireAuth, verifyApple); // App Store receipt
app.post("/billing/google", requireAuth, verifyGoogle); // Google Play token

// Reconocimiento ambiente (audio en base64 -> AudD)
app.post("/recognize", ipLimit(60), requireAuth, recognize);

// Validación de configuración al arrancar: avisa (no rompe) de claves que faltan,
// para diagnosticar en los logs de Render por qué algo no funciona en producción.
function checkEnv() {
  const want: Record<string, string> = {
    ANTHROPIC_KEY: "IA incluida (/commentary, /program)",
    DB_PATH: "BD persistente (sin esto, se pierde todo en cada deploy)",
    STRIPE_SECRET: "cobro Stripe", STRIPE_PRICE_ID: "precio Stripe", STRIPE_WEBHOOK_SECRET: "verificación del webhook Stripe",
    ELEVENLABS_KEY: "voces premium (/tts)", AUDD_TOKEN: "reconocimiento (/recognize)",
    GOOGLE_CLIENT_ID: "login Google",
  };
  const missing = Object.entries(want).filter(([k]) => !process.env[k]).map(([k, v]) => `  - ${k}: ${v}`);
  if (missing.length) console.warn("[config] faltan variables de entorno:\n" + missing.join("\n"));
  const IS_PROD = process.env.NODE_ENV === "production";
  // dev-auth en prod: la ruta /auth/dev ya NO se registra en producción y authDev la rechaza,
  // así que el bypass está neutralizado; avisamos fuerte para que quiten la variable igualmente.
  if (IS_PROD && process.env.ALLOW_DEV_AUTH === "1") {
    console.error("[config] ⚠️ ALLOW_DEV_AUTH=1 en producción (ignorado: /auth/dev está desactivada). Quita esa variable.");
  }
  const cap = Number(process.env.GLOBAL_DAILY_CAP ?? "0");
  if (IS_PROD && !(cap > 0)) {
    // Aviso FUERTE (no abortamos para no tumbar un server en marcha): el breaker de gasto
    // está desactivado. Pon GLOBAL_DAILY_CAP>0 en Render para protegerte de una factura desbocada.
    console.error("[config] ⚠️⚠️ GLOBAL_DAILY_CAP=0 en producción: SIN tope de gasto contra tu factura. Pon un número (€/día) ya.");
  }
  console.log(cap > 0 ? `[config] tope de gasto global: ${cap}/día` : "[config] sin tope de gasto global (GLOBAL_DAILY_CAP=0)");
  // Aviso fuerte si la BD parece efímera en producción (sin disco persistente -> se pierde todo).
  const dbp = process.env.DB_PATH || "";
  if (IS_PROD && (!dbp || dbp.startsWith("/tmp") || !dbp.startsWith("/"))) {
    console.error("[config] ⚠️ DB_PATH no parece un disco persistente (" + (dbp || "ausente") + "): se perderán usuarios/contadores/idempotencia en cada reinicio. Monta un disco y usa DB_PATH=/data/sintonia.db");
  }
}

const PORT = Number(process.env.PORT ?? "8787");
checkEnv();   // valida ANTES de escuchar: aborta en problemas críticos de producción
app.listen(PORT, () => { console.log("SINTONÍA server en http://localhost:" + PORT); });
