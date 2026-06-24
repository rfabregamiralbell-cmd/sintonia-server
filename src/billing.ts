import { Request, Response } from "express";
import db from "./db";
import { AuthedRequest } from "./auth";

// ---------------------------------------------------------------------------
// Estado de suscripción
// ---------------------------------------------------------------------------
export function isSubscribed(u: any): boolean {
  if (!u || !u.subscribed) return false;
  // sub_until = 0 significa "sin caducidad conocida" (p. ej. Stripe activo).
  return u.sub_until === 0 || u.sub_until > Date.now();
}

function setSub(userId: string, provider: string, until: number) {
  db.prepare(
    "UPDATE users SET subscribed = 1, sub_provider = ?, sub_until = ? WHERE id = ?"
  ).run(provider, until, userId);
}
function clearSub(userId: string) {
  db.prepare("UPDATE users SET subscribed = 0 WHERE id = ?").run(userId);
}

export function status(req: AuthedRequest, res: Response) {
  const u: any = db.prepare("SELECT subscribed, sub_provider, sub_until FROM users WHERE id = ?").get(req.userId!);
  res.json({
    subscribed: isSubscribed(u),
    provider: u?.sub_provider ?? null,
    until: u?.sub_until ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Stripe (web/escritorio/Android sin tienda). Suscripción mensual.
// ---------------------------------------------------------------------------
import Stripe from "stripe";
const STRIPE_SECRET = process.env.STRIPE_SECRET || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://sintonia.app";
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : (null as any);

/** Crea una sesión de Checkout y devuelve la URL para abrir en el navegador. */
export async function checkout(req: AuthedRequest, res: Response) {
  try {
    if (!stripe || !STRIPE_PRICE_ID) return res.status(500).json({ error: "stripe no configurado" });
    const u: any = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId!);
    if (!u) return res.status(401).json({ error: "usuario no encontrado" });

    let customer = u.stripe_customer as string | null;
    if (!customer) {
      const c = await stripe.customers.create({ email: u.email || undefined, metadata: { userId: u.id } });
      customer = c.id;
      db.prepare("UPDATE users SET stripe_customer = ? WHERE id = ?").run(customer, u.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      // El userId también va en metadata por si el customer es nuevo.
      subscription_data: { metadata: { userId: u.id } },
      success_url: `${APP_BASE_URL}/billing/ok`,
      cancel_url: `${APP_BASE_URL}/billing/cancel`,
    });
    res.json({ url: session.url });
  } catch {
    res.status(500).json({ error: "checkout" });
  }
}

/** Webhook de Stripe. Necesita el body crudo (ver index.ts). */
export async function webhook(req: Request, res: Response) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).end();
  let event: Stripe.Event;
  try {
    const sig = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send("firma inválida");
  }

  try {
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
      const sub = event.data.object as Stripe.Subscription;
      const userId = (sub.metadata?.userId as string) || (await userIdFromCustomer(sub.customer as string));
      if (userId) {
        const active = sub.status === "active" || sub.status === "trialing";
        if (active) setSub(userId, "stripe", (sub.current_period_end ?? 0) * 1000);
        else clearSub(userId);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const userId = (sub.metadata?.userId as string) || (await userIdFromCustomer(sub.customer as string));
      if (userId) clearSub(userId);
    }
  } catch {
    /* no romper el webhook: Stripe reintenta */
  }
  res.json({ received: true });
}

async function userIdFromCustomer(customerId: string): Promise<string | null> {
  const u: any = db.prepare("SELECT id FROM users WHERE stripe_customer = ?").get(customerId);
  return u?.id ?? null;
}

// ---------------------------------------------------------------------------
// Apple (App Store). El móvil manda el receipt en base64; verificamos contra Apple.
// (verifyReceipt: válido para suscripciones auto-renovables; StoreKit2 ver nota en DEPLOY.md)
// ---------------------------------------------------------------------------
const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET || "";

export async function verifyApple(req: AuthedRequest, res: Response) {
  try {
    const receipt = req.body?.receipt;
    if (!receipt) return res.status(400).json({ error: "receipt requerido" });

    const body = JSON.stringify({
      "receipt-data": receipt,
      password: APPLE_SHARED_SECRET,
      "exclude-old-transactions": true,
    });
    // Producción primero; si devuelve 21007, reintentar en sandbox.
    let data = await appleVerify("https://buy.itunes.apple.com/verifyReceipt", body);
    if (data.status === 21007) data = await appleVerify("https://sandbox.itunes.apple.com/verifyReceipt", body);
    if (data.status !== 0) return res.status(402).json({ error: "receipt inválido", status: data.status });

    const infos: any[] = data.latest_receipt_info || [];
    const until = infos.reduce((m, t) => Math.max(m, Number(t.expires_date_ms || 0)), 0);
    if (until <= Date.now()) return res.status(402).json({ error: "suscripción expirada" });

    setSub(req.userId!, "apple", until);
    res.json({ subscribed: true, until });
  } catch {
    res.status(500).json({ error: "apple" });
  }
}
async function appleVerify(url: string, body: string): Promise<any> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  return r.json();
}

// ---------------------------------------------------------------------------
// Google Play. El móvil manda purchaseToken + productId; verificamos con la API.
// Requiere una cuenta de servicio con acceso a Android Publisher.
// ---------------------------------------------------------------------------
const GOOGLE_PACKAGE_NAME = process.env.GOOGLE_PACKAGE_NAME || "";

export async function verifyGoogle(req: AuthedRequest, res: Response) {
  try {
    const { purchaseToken, productId } = req.body || {};
    if (!purchaseToken || !productId) return res.status(400).json({ error: "purchaseToken y productId requeridos" });

    const token = await googleAccessToken();
    if (!token) return res.status(500).json({ error: "google no configurado" });

    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(GOOGLE_PACKAGE_NAME)}/purchases/subscriptions/` +
      `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(402).json({ error: "token inválido", status: r.status });
    const data: any = await r.json();
    const until = Number(data.expiryTimeMillis || 0);
    if (until <= Date.now()) return res.status(402).json({ error: "suscripción expirada" });

    setSub(req.userId!, "google", until);
    res.json({ subscribed: true, until });
  } catch {
    res.status(500).json({ error: "google" });
  }
}

// Token OAuth de la cuenta de servicio para la API de Android Publisher.
import { JWT } from "google-auth-library";
let _jwt: JWT | null = null;
async function googleAccessToken(): Promise<string | null> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  if (!_jwt) {
    const creds = JSON.parse(raw);
    _jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
  }
  const t = await _jwt.getAccessToken();
  return t?.token ?? null;
}
