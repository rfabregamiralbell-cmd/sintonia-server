import { Response } from "express";
import db from "./db";
import { AuthedRequest } from "./auth";

export function getUsage(req: AuthedRequest, res: Response) {
  const u: any = db.prepare("SELECT spend, calls, input_tokens, output_tokens, budget FROM users WHERE id = ?").get(req.userId);
  if (!u) return res.status(401).json({ error: "usuario no encontrado" });
  res.json({ spend: u.spend, calls: u.calls, inputTokens: u.input_tokens, outputTokens: u.output_tokens, budget: u.budget });
}

export function setBudget(req: AuthedRequest, res: Response) {
  const x = Number(req.body?.budget);
  if (!Number.isFinite(x) || x < 0) return res.status(400).json({ error: "budget inválido" });
  db.prepare("UPDATE users SET budget = ? WHERE id = ?").run(x, req.userId);
  getUsage(req, res);
}

// resetUsage ELIMINADO a propósito: permitía al propio usuario poner calls/spend a 0
// (los contadores anti-abuso del free-tier y del presupuesto) -> IA gratis ilimitada.

// --- Sincronización de contenido del usuario (emisoras + historial) ---
export function syncSave(req: AuthedRequest, res: Response) {
  let stations = Array.isArray(req.body?.stations) ? req.body.stations : [];
  let history = Array.isArray(req.body?.history) ? req.body.history : [];
  // Recortamos por NÚMERO de elementos (no por bytes a mitad de JSON, que corrompía el
  // contenido y al recargar perdía TODO en silencio). Cota generosa y siempre JSON válido.
  stations = stations.slice(0, 200);
  history = history.slice(0, 500);
  let content = JSON.stringify({ stations, history });
  // Red de seguridad por tamaño: si aún excede, se va recortando el historial (siempre válido).
  while (content.length > 2_000_000 && history.length > 0) {
    history = history.slice(0, Math.floor(history.length / 2));
    content = JSON.stringify({ stations, history });
  }
  if (content.length > 2_000_000) return res.status(413).json({ error: "demasiado contenido" });
  db.prepare("UPDATE users SET content = ? WHERE id = ?").run(content, req.userId);
  res.json({ ok: true });
}

export function syncLoad(req: AuthedRequest, res: Response) {
  const u: any = db.prepare("SELECT content FROM users WHERE id = ?").get(req.userId);
  if (!u || !u.content) return res.json({ stations: [], history: [] });
  try {
    const c = JSON.parse(u.content);
    res.json({ stations: c.stations ?? [], history: c.history ?? [] });
  } catch {
    res.json({ stations: [], history: [] });
  }
}
