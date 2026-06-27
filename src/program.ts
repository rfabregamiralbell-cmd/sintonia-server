import { Response } from "express";
import db from "./db";
import { AuthedRequest } from "./auth";
import { isSubscribed, checkSubscribed } from "./billing";
import { fetchT } from "./fetchT";
import { globalCapHit, addGlobalSpend } from "./globalbudget";

// Programa = conversación entre VARIOS locutores (entrada, debate, cierre).
// Es la función PREMIUM: el cliente envía {system, prompt} ya construidos
// (mismo contrato genérico que la IA por clave) y el modelo devuelve un JSON
// con los turnos. Requiere suscripción activa (o BYOK con clave propia); el
// tier gratis se queda en /commentary (un solo locutor).

const FREE_TIER_CALLS = Number(process.env.FREE_TIER_CALLS ?? "10");
const DAILY_CAP = Number(process.env.DAILY_CAP ?? "200");
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || "";
const MODEL = "claude-sonnet-4-6";
const PRICE_IN = 3 / 1000000;
const PRICE_OUT = 15 / 1000000;
const MARKUP = Number(process.env.MARKUP ?? "0.15");
const RL_MAX = Number(process.env.RATE_LIMIT_HOUR ?? "120");

// Topes por usuario (en memoria; para multi-instancia, mover a Redis).
const daily = new Map<string, { n: number; day: string }>();
function dailyExceeded(userId: string): boolean {
  if (DAILY_CAP <= 0) return false;
  const day = new Date().toISOString().slice(0, 10);
  const d = daily.get(userId);
  if (!d || d.day !== day) {
    daily.set(userId, { n: 1, day });
    return false;
  }
  if (d.n >= DAILY_CAP) return true;
  d.n++;
  return false;
}
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

export async function program(req: AuthedRequest, res: Response) {
  try {
    const userId = req.userId!;
    const userKeyHeader = req.headers["x-user-key"];
    const userKey = typeof userKeyHeader === "string" ? userKeyHeader : "";
    const key = userKey || ANTHROPIC_KEY; // BYOK usa la clave del usuario.
    if (!key) return res.status(500).json({ error: "falta clave de IA" });

    const u: any = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!u) return res.status(401).json({ error: "usuario no encontrado" });

    // Multi-locutor es PREMIUM: sin BYOK y sin suscripción no se permite.
    if (!userKey) {
      const subscribed = await checkSubscribed(userId, req.email);
      if (!subscribed) return res.status(402).json({ error: userId.startsWith("guest:") ? "login" : "subscription" });
      if (dailyExceeded(userId)) return res.status(429).json({ error: "límite diario alcanzado" });
      if (rateLimited(userId)) return res.status(429).json({ error: "límite por hora alcanzado" });
      if (globalCapHit()) return res.status(503).json({ error: "servicio saturado, prueba más tarde" }); // tope de gasto global
      // El presupuesto NO bloquea a suscriptores (aquí siempre lo son).
      if (!subscribed && u.budget > 0 && u.spend >= u.budget) return res.status(402).json({ error: "budget" });
    }

    const b: any = req.body ?? {};
    const system = typeof b.system === "string" ? b.system : "";
    const prompt = typeof b.prompt === "string" ? b.prompt : "";
    if (!prompt) return res.status(400).json({ error: "prompt requerido" });

    const r = await fetchT("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1000, system, messages: [{ role: "user", content: prompt }] }),
    }, 60000);

    if (!r.ok) return res.status(502).json({ error: "modelo " + r.status });
    const data: any = await r.json();
    const text = (data.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("").trim();
    const usage = data.usage ?? { input_tokens: 0, output_tokens: 0 };

    let charged = 0;
    if (!userKey) {
      const raw = usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT;
      charged = raw * (1 + MARKUP); // + mantenimiento
      db.prepare(
        "UPDATE users SET spend = spend + ?, calls = calls + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?"
      ).run(charged, usage.input_tokens, usage.output_tokens, userId);
      addGlobalSpend(charged); // acumula al tope de gasto global del día
    }

    const after: any = db.prepare("SELECT spend, budget, calls, subscribed, sub_until FROM users WHERE id = ?").get(userId);
    res.json({
      text,
      usage,
      charged,
      spend: after.spend,
      budget: after.budget,
      remaining: after.budget > 0 ? Math.max(0, after.budget - after.spend) : null,
      freeRemaining: Math.max(0, FREE_TIER_CALLS - (after.calls ?? 0)),
      subscribed: isSubscribed(after),
    });
  } catch (e) {
    console.error("program:", e);
    res.status(500).json({ error: "interno" });
  }
}
