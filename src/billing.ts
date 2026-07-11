import { Request, Response } from "express";
import db from "./db";
import { AuthedRequest } from "./auth";
import { fetchT } from "./fetchT";

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

// Fin del período de una suscripción Stripe en ms. En la API nueva
// `current_period_end` se movió a items.data[]; leemos ambos sitios.
function subUntilMs(sub: any): number {
  const cpe = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? 0;
  // Si Stripe no trae el fin de período, NO conceder premium perpetuo: caducidad conservadora
  // (~32 días). El reconcile periódico (checkSubscribed) la renueva si la suscripción sigue activa.
  return cpe ? cpe * 1000 : (Date.now() + 32 * 24 * 60 * 60 * 1000);
}
function clearSub(userId: string) {
  db.prepare("UPDATE users SET subscribed = 0 WHERE id = ?").run(userId);
}

export async function status(req: AuthedRequest, res: Response) {
  const subscribed = await checkSubscribed(req.userId!, req.email);
  const u: any = db.prepare("SELECT sub_provider, sub_until FROM users WHERE id = ?").get(req.userId!);
  res.json({
    subscribed,
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
// Dominio para los retornos de Checkout. Si no se define APP_BASE_URL, usa el dominio
// que Render inyecta automáticamente (RENDER_EXTERNAL_URL) -> /billing/ok y /billing/cancel
// resuelven solos sin configurar nada. Último recurso: el dominio de marca.
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "https://sintonia.app").replace(/\/$/, "");
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
  } catch (e: any) {
    console.error("checkout:", e?.message || e);   // el detalle solo en el log del servidor
    res.status(500).json({ error: "No se pudo iniciar el pago. Inténtalo de nuevo." });
  }
}

/** DIAGNÓSTICO TEMPORAL (quitar tras usar): estado de la config de Stripe SIN exponer secretos. */
export async function diag(_req: AuthedRequest, res: Response) {
  const out: any = {
    secretPrefix: STRIPE_SECRET ? STRIPE_SECRET.slice(0, 8) : "(vacío)",   // sk_live_ / sk_test_ (no es la clave)
    priceIdSet: !!STRIPE_PRICE_ID,
    priceIdTail: STRIPE_PRICE_ID ? "…" + STRIPE_PRICE_ID.slice(-6) : "",
    webhookSecretSet: !!STRIPE_WEBHOOK_SECRET,
    appBaseUrl: APP_BASE_URL,
  };
  if (stripe && STRIPE_PRICE_ID) {
    try {
      const p: any = await stripe.prices.retrieve(STRIPE_PRICE_ID);
      out.price = { ok: true, livemode: p.livemode, active: p.active, amount: p.unit_amount, currency: p.currency, recurring: p.recurring?.interval };
    } catch (e: any) { out.price = { ok: false, error: (e?.message || String(e)).slice(0, 200) }; }
  }
  if (stripe) {
    try {
      const c: any = await stripe.customers.create({ metadata: { diag: "1" } });
      out.keyCheck = { ok: true, livemode: c.livemode };
      try { await stripe.customers.del(c.id); } catch {}
    } catch (e: any) { out.keyCheck = { ok: false, error: (e?.message || String(e)).slice(0, 200) }; }
  }
  res.json(out);
}

/** Webhook de Stripe. Necesita el body crudo (ver index.ts). */
export async function webhook(req: Request, res: Response) {
  // Si Stripe aún no está configurado (faltan claves), respondemos 200 para que
  // Stripe pueda VALIDAR la URL al crear el webhook. No hay nada que verificar
  // todavía. En cuanto STRIPE_WEBHOOK_SECRET esté puesto, se verifica la firma.
  // Stripe del todo sin configurar -> 200 para que Stripe pueda VALIDAR la URL al crear el
  // webhook (aún no hay whsec_). Pero si STRIPE_SECRET está puesto y FALTA el whsec_, es una
  // mala configuración que haría perder eventos en silencio: avisamos FUERTE en los logs.
  if (!STRIPE_WEBHOOK_SECRET) {
    if (stripe) console.error("[billing] ⚠️⚠️ STRIPE configurado pero FALTA STRIPE_WEBHOOK_SECRET: se están IGNORANDO eventos de Stripe (pagos no se reflejan). Pon el whsec_ en Render.");
    return res.status(200).json({ received: true, note: "stripe sin configurar" });
  }
  let event: Stripe.Event;
  try {
    const sig = req.headers["stripe-signature"] as string;
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send("firma inválida");
  }

  // Idempotencia: si YA procesamos (con éxito) este evento, no repetir (Stripe reenvía).
  try {
    const seen = db.prepare("SELECT 1 FROM stripe_events WHERE id = ?").get(event.id);
    if (seen) return res.json({ received: true, duplicate: true });
  } catch { /* si la tabla falla, seguimos */ }

  try {
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.paused" ||
      event.type === "customer.subscription.resumed"
    ) {
      const sub = event.data.object as Stripe.Subscription;
      const userId = (sub.metadata?.userId as string) || (await userIdFromCustomer(sub.customer as string));
      // Recalcula mirando TODAS las suscripciones del cliente: una suscripción
      // incompleta o cancelada NO debe borrar el estado si hay otra activa.
      await reconcileSubscription(userId, sub.customer as string);
    } else if (
      event.type === "invoice.payment_failed" ||
      event.type === "invoice.paid"
    ) {
      // Impago/pago: reconciliar por cliente (un impago acaba quitando el premium).
      const inv = event.data.object as Stripe.Invoice;
      const customer = inv.customer as string;
      await reconcileSubscription(await userIdFromCustomer(customer), customer);
    }
    // Marca el evento como procesado SOLO tras reconciliar con éxito (idempotencia correcta).
    try { db.prepare("INSERT OR IGNORE INTO stripe_events (id, ts) VALUES (?, ?)").run(event.id, Date.now()); } catch { /* idempotencia best-effort */ }
    return res.json({ received: true });
  } catch (e) {
    console.error("webhook reconcile:", e);
    // NO lo marcamos como procesado y devolvemos 5xx para que Stripe REINTENTE.
    return res.status(500).json({ error: "reconcile failed, retry please" });
  }
}

async function userIdFromCustomer(customerId: string): Promise<string | null> {
  const u: any = db.prepare("SELECT id FROM users WHERE stripe_customer = ?").get(customerId);
  return u?.id ?? null;
}

// Recalcula el estado del usuario preguntando a Stripe si el cliente tiene
// ALGUNA suscripción activa o en prueba (robusto a múltiples suscripciones:
// una incompleta/cancelada no pisa a la activa).
async function reconcileSubscription(userId: string | null, customerId: string | null) {
  if (!userId || !customerId) return;
  const active = await stripe.subscriptions.list({ customer: customerId, status: "active", limit: 1 });
  let sub = active.data[0];
  if (!sub) {
    const trial = await stripe.subscriptions.list({ customer: customerId, status: "trialing", limit: 1 });
    sub = trial.data[0];
  }
  if (!sub) {
    // Periodo de GRACIA: un pago fallido (past_due) NO expulsa al instante; mantenemos
    // Premium hasta el fin del periodo ya pagado, para no echar a quien está reintentando.
    const pd = await stripe.subscriptions.list({ customer: customerId, status: "past_due", limit: 1 });
    sub = pd.data[0];
  }
  if (sub) setSub(userId, "stripe", subUntilMs(sub));
  else clearSub(userId);
}

// Auto-reconciliación: ¿el usuario está suscrito? Mira la BD; si no consta (p. ej.
// la BD efímera de Render se borró en un deploy) y tenemos su email, pregunta a
// Stripe por un cliente con suscripción activa y RESTAURA el estado en la BD.
// Así el Premium de una cuenta real sobrevive aunque se pierda la BD.
const subNegCache = new Map<string, number>(); // userId -> ts del último "no" (evita martillear Stripe)
export async function checkSubscribed(userId: string, email?: string | null): Promise<boolean> {
  const u: any = db.prepare("SELECT subscribed, sub_until, stripe_customer FROM users WHERE id = ?").get(userId);
  if (isSubscribed(u)) return true;
  if (!stripe || !email) return false;
  if (Date.now() - (subNegCache.get(userId) || 0) < 60_000) return false; // no consultar Stripe más de 1/min
  try {
    const customers = await stripe.customers.list({ email, limit: 5 });
    for (const c of customers.data) {
      const active = await stripe.subscriptions.list({ customer: c.id, status: "active", limit: 1 });
      let sub = active.data[0];
      if (!sub) {
        const trial = await stripe.subscriptions.list({ customer: c.id, status: "trialing", limit: 1 });
        sub = trial.data[0];
      }
      if (!sub) {
        const pd = await stripe.subscriptions.list({ customer: c.id, status: "past_due", limit: 1 }); // gracia
        sub = pd.data[0];
      }
      if (sub) {
        db.prepare("UPDATE users SET subscribed = 1, sub_provider = 'stripe', sub_until = ?, stripe_customer = ? WHERE id = ?")
          .run(subUntilMs(sub), c.id, userId);
        subNegCache.delete(userId);
        return true;
      }
    }
  } catch { /* si Stripe falla, no concedemos premium por las bravas */ }
  subNegCache.set(userId, Date.now());
  return false;
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
  const r = await fetchT(url, { method: "POST", headers: { "content-type": "application/json" }, body }, 15000);
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
    const r = await fetchT(url, { headers: { authorization: `Bearer ${token}` } }, 15000);
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
