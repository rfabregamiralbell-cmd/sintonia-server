import "dotenv/config";
import express from "express";
import cors from "cors";
import { authApple, authGoogle, authDev, authGuest, requireAuth } from "./auth";
import { commentary } from "./commentary";
import { getUsage, setBudget, resetUsage } from "./me";
import { publish, browse, getOne, remove } from "./stations";
import { checkout, webhook, status, verifyApple, verifyGoogle } from "./billing";
import { recognize } from "./recognize";

const app = express();
app.use(cors());

// Stripe webhook: necesita el body crudo y va ANTES de express.json().
app.post("/billing/webhook", express.raw({ type: "application/json" }), webhook);

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Autenticación (el móvil manda el idToken nativo; dev = solo pruebas)
app.post("/auth/apple", authApple);
app.post("/auth/google", authGoogle);
app.post("/auth/guest", authGuest); // web sin login: sesión de invitado
app.post("/auth/dev", authDev);

// IA (requiere sesión)
app.post("/commentary", requireAuth, commentary);
app.get("/me/usage", requireAuth, getUsage);
app.post("/me/budget", requireAuth, setBudget);
app.post("/me/reset", requireAuth, resetUsage);

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
app.post("/recognize", requireAuth, recognize);

const PORT = Number(process.env.PORT ?? "8787");
app.listen(PORT, () => console.log("SINTONÍA server en http://localhost:" + PORT));
