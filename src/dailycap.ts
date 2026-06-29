import db from "./db";

// Tope diario por usuario PERSISTIDO en SQLite. Antes vivía en un Map en memoria por
// cada handler y se reiniciaba en CADA deploy/reinicio de Render, dejando tu margen sin
// proteger frente a un usuario concreto. Ahora sobrevive a reinicios (con disco persistente).
db.exec(
  "CREATE TABLE IF NOT EXISTS usage_daily (user_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day))"
);

const DAILY_CAP = Number(process.env.DAILY_CAP ?? "200");

// Incrementa y dice si se ha superado el tope diario. Devuelve true si YA estaba al tope
// (no incrementa en ese caso). Comparte tope entre todos los endpoints de IA del usuario.
export function dailyExceeded(userId: string, max = DAILY_CAP): boolean {
  if (max <= 0) return false;
  const day = new Date().toISOString().slice(0, 10);
  const row: any = db.prepare("SELECT calls FROM usage_daily WHERE user_id = ? AND day = ?").get(userId, day);
  if (row && row.calls >= max) return true;
  db.prepare(
    "INSERT INTO usage_daily (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1"
  ).run(userId, day);
  return false;
}
