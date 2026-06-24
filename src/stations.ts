import { Request, Response } from "express";
import { randomUUID } from "crypto";
import db from "./db";
import { AuthedRequest } from "./auth";

function safeTags(s: string): string[] {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Publica la emisora actual. body: { payload, public? } */
export function publish(req: AuthedRequest, res: Response) {
  const b: any = req.body?.payload ?? req.body ?? {};
  const name = (b.name || "").toString().trim();
  if (!name) return res.status(400).json({ error: "nombre requerido" });
  const id = randomUUID();
  db.prepare(
    `INSERT INTO stations (id, owner_id, name, descr, emoji, color, tags, payload, is_public, plays, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    req.userId,
    name,
    (b.desc || "").toString(),
    (b.emoji || "📻").toString(),
    Number(b.color) || 0xffff2d55,
    JSON.stringify(Array.isArray(b.tags) ? b.tags : []),
    JSON.stringify(b),
    req.body?.public === false ? 0 : 1,
    0,
    Date.now()
  );
  res.json({ id });
}

/** Explora emisoras públicas. query: q, tag, sort=recent|popular, page */
export function browse(req: Request, res: Response) {
  const q = (req.query.q || "").toString().trim().toLowerCase();
  const tag = (req.query.tag || "").toString().trim();
  const sort = (req.query.sort || "recent").toString();
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const page = Math.max(0, Number(req.query.page) || 0);
  const offset = page * limit;

  const where: string[] = ["is_public = 1"];
  const params: any[] = [];
  if (q) {
    where.push("(LOWER(name) LIKE ? OR LOWER(descr) LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like);
  }
  if (tag) {
    // tags se guarda como JSON; filtro aproximado por substring del tag entre comillas.
    where.push("tags LIKE ?");
    params.push(`%"${tag}"%`);
  }
  const order = sort === "popular" ? "plays DESC, created_at DESC" : "created_at DESC";
  const sql =
    `SELECT id, name, descr, emoji, color, tags, plays FROM stations ` +
    `WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows: any[] = db.prepare(sql).all(...params, limit, offset);

  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      desc: r.descr,
      emoji: r.emoji,
      color: r.color,
      tags: safeTags(r.tags),
      plays: r.plays,
    }))
  );
}

/** Devuelve el payload completo para importar. Suma una reproducción. */
export function getOne(req: Request, res: Response) {
  const r: any = db.prepare("SELECT * FROM stations WHERE id = ?").get(req.params.id);
  if (!r || !r.is_public) return res.status(404).json({ error: "no encontrada" });
  db.prepare("UPDATE stations SET plays = plays + 1 WHERE id = ?").run(r.id);
  let payload: any = null;
  try {
    payload = JSON.parse(r.payload);
  } catch {
    payload = null;
  }
  res.json({ id: r.id, payload });
}

/** Borra una emisora (solo el dueño). */
export function remove(req: AuthedRequest, res: Response) {
  const r: any = db.prepare("SELECT owner_id FROM stations WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "no encontrada" });
  if (r.owner_id !== req.userId) return res.status(403).json({ error: "no eres el dueño" });
  db.prepare("DELETE FROM stations WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
}
