import { Request, Response, NextFunction } from "express";
import { SignJWT, jwtVerify, createRemoteJWKSet } from "jose";
import { randomUUID } from "crypto";
import db from "./db";
import { fetchT } from "./fetchT";

const IS_PROD = process.env.NODE_ENV === "production";
const RAW_SECRET = process.env.JWT_SECRET || "";
if (IS_PROD && (RAW_SECRET.length < 24)) {
  throw new Error("JWT_SECRET ausente o demasiado corto: define un secreto largo y aleatorio en producción.");
}
const secret = new TextEncoder().encode(RAW_SECRET || "dev-secret-change-me");
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

const appleJWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
const googleJWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export interface AuthedRequest extends Request {
  userId?: string;
  email?: string;
}

function upsertUser(id: string, email: string, provider: string) {
  db.prepare(
    `INSERT INTO users (id, email, provider, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET email = excluded.email`
  ).run(id, email, provider, Date.now());
}

async function issueToken(id: string, email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime("60d")
    .sign(secret);
}

/** iOS: Sign in with Apple -> el móvil manda identityToken aquí. */
export async function authApple(req: Request, res: Response) {
  try {
    const idToken = req.body?.idToken;
    if (!idToken) return res.status(400).json({ error: "idToken requerido" });
    if (!APPLE_CLIENT_ID) return res.status(500).json({ error: "APPLE_CLIENT_ID no configurado" });
    const { payload } = await jwtVerify(idToken, appleJWKS, {
      issuer: "https://appleid.apple.com",
      audience: APPLE_CLIENT_ID,
    });
    const id = `apple:${payload.sub}`;
    const email = (payload.email as string) || "";
    upsertUser(id, email, "apple");
    res.json({ token: await issueToken(id, email), email });
  } catch {
    res.status(401).json({ error: "token de Apple inválido" });
  }
}

/** Android/iOS: Google Sign-In -> el móvil manda el idToken aquí. */
export async function authGoogle(req: Request, res: Response) {
  try {
    const idToken = req.body?.idToken;
    if (!idToken) return res.status(400).json({ error: "idToken requerido" });
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: "GOOGLE_CLIENT_ID no configurado" });
    const { payload } = await jwtVerify(idToken, googleJWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: GOOGLE_CLIENT_ID,
    });
    if (payload.email_verified !== true) return res.status(401).json({ error: "email de Google no verificado" });
    const id = `google:${payload.sub}`;
    const email = (payload.email as string) || "";
    upsertUser(id, email, "google");
    res.json({ token: await issueToken(id, email), email });
  } catch {
    res.status(401).json({ error: "token de Google inválido" });
  }
}

/** WEB: login con Google por código (Authorization Code + PKCE). El navegador
 *  obtiene un `code`; aquí lo canjeamos con el client_secret (seguro en servidor),
 *  verificamos el id_token y emitimos sesión propia. Requiere GOOGLE_CLIENT_ID y
 *  GOOGLE_CLIENT_SECRET. */
export async function authGoogleWeb(req: Request, res: Response) {
  try {
    const { code, codeVerifier, redirectUri } = req.body || {};
    if (!code || !redirectUri) return res.status(400).json({ error: "code y redirectUri requeridos" });
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return res.status(500).json({ error: "google web no configurado" });
    const params = new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (codeVerifier) params.set("code_verifier", codeVerifier);
    const r = await fetchT("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }, 15000);
    if (!r.ok) return res.status(401).json({ error: "intercambio con Google falló" });
    const data: any = await r.json();
    const idToken = data.id_token;
    if (!idToken) return res.status(401).json({ error: "sin id_token" });
    const { payload } = await jwtVerify(idToken, googleJWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: GOOGLE_CLIENT_ID,
    });
    if (payload.email_verified !== true) return res.status(401).json({ error: "email de Google no verificado" });
    const id = `google:${payload.sub}`;
    const email = (payload.email as string) || "";
    upsertUser(id, email, "google");
    res.json({ token: await issueToken(id, email), email });
  } catch {
    res.status(401).json({ error: "login de Google inválido" });
  }
}

/** Sesión de INVITADO (web sin login): crea una cuenta anónima ligada al
 *  navegador (deviceId) para que la IA funcione sin registro. La cuenta real
 *  (Apple/Google) es opcional y sirve para sincronizar entre dispositivos.
 *  Producción: conviene limitar la creación por IP (anti-abuso del free-tier). */
export async function authGuest(req: Request, res: Response) {
  const deviceId = (req.body?.deviceId || "").toString().trim().slice(0, 64);
  const id = `guest:${deviceId || randomUUID()}`;
  upsertUser(id, "", "guest");
  res.json({ token: await issueToken(id, ""), email: "", guest: true });
}

/** SOLO pruebas: login por email sin verificar. Desactívalo en producción. */
export async function authDev(req: Request, res: Response) {
  if (process.env.ALLOW_DEV_AUTH !== "1") return res.status(403).json({ error: "dev auth deshabilitado" });
  const email = (req.body?.email || "").toString().trim();
  if (!email) return res.status(400).json({ error: "email requerido" });
  const id = `dev:${email.toLowerCase()}`;
  upsertUser(id, email, "dev");
  res.json({ token: await issueToken(id, email), email });
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization || "";
    const t = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!t) return res.status(401).json({ error: "no autenticado" });
    const { payload } = await jwtVerify(t, secret);
    req.userId = payload.sub as string;
    req.email = (payload.email as string) || "";
    // Auto-cura la fila de usuario (la BD de Render es efímera y puede borrarse):
    // si el token es válido pero no hay fila, la recreamos.
    upsertUser(req.userId, req.email, (req.userId.split(":")[0] || "session"));
    next();
  } catch {
    res.status(401).json({ error: "sesión inválida o caducada" });
  }
}
