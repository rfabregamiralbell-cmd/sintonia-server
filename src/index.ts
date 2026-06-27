import "dotenv/config";
import express from "express";
import cors from "cors";
import { authApple, authGoogle, authGoogleWeb, authDev, authGuest, requireAuth } from "./auth";
import { commentary } from "./commentary";
import { program } from "./program";
import { getUsage, setBudget, resetUsage, syncSave, syncLoad } from "./me";
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

app.get("/health", (_req, res) => res.json({ ok: true }));

// Autenticación (el móvil manda el idToken nativo; dev = solo pruebas)
app.post("/auth/apple", authApple);
app.post("/auth/google", authGoogle);
app.post("/auth/google/web", authGoogleWeb); // web: login Google por código (PKCE)
app.post("/auth/guest", ipLimit(20), authGuest); // web sin login: sesión de invitado (máx 20/h por IP)
app.post("/auth/dev", authDev);

// IA (requiere sesión). ipLimit añade un tope por IP además del tope por usuario,
// para que ni siquiera BYOK (x-user-key) ni invitados puedan martillear.
app.post("/commentary", ipLimit(120), requireAuth, commentary); // 1 locutor (freemium)
app.post("/program", ipLimit(120), requireAuth, program); // varios locutores (premium / BYOK)
app.post("/tts", requireAuth, tts); // voces premium ElevenLabs incluidas (solo suscriptores)
app.get("/me/usage", requireAuth, getUsage);
app.post("/me/budget", requireAuth, setBudget);
app.post("/me/reset", requireAuth, resetUsage);
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

const PORT = Number(process.env.PORT ?? "8787");
app.listen(PORT, () => console.log("SINTONÍA server en http://localhost:" + PORT));
