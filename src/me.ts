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

export function resetUsage(req: AuthedRequest, res: Response) {
  db.prepare("UPDATE users SET spend = 0, calls = 0, input_tokens = 0, output_tokens = 0 WHERE id = ?").run(req.userId);
  getUsage(req, res);
}

// --- Sincronización de contenido del usuario (emisoras + historial) ---
export function syncSave(req: AuthedRequest, res: Response) {
  const stations = Array.isArray(req.body?.stations) ? req.body.stations : [];
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const content = JSON.stringify({ stations, history }).slice(0, 2_000_000); // tope 2MB
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
