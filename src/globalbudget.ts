// Circuit breaker de gasto GLOBAL: corta la IA incluida (no BYOK) cuando el gasto
// agregado del día supera GLOBAL_DAILY_CAP (en las mismas unidades que `spend`,
// ~USD con markup). Protege tu factura ante abusos. Se PERSISTE en la BD por día,
// así que sobrevive a reinicios/deploys (fiable si la BD está en un disco persistente).
// Con GLOBAL_DAILY_CAP=0 (por defecto) NO limita.
import db from "./db";

const CAP = Number(process.env.GLOBAL_DAILY_CAP ?? "0");

db.exec(`CREATE TABLE IF NOT EXISTS global_spend (day TEXT PRIMARY KEY, spent REAL NOT NULL DEFAULT 0)`);

function today(): string { return new Date().toISOString().slice(0, 10); }

/** ¿Se ha alcanzado el tope global de hoy? */
export function globalCapHit(): boolean {
  if (CAP <= 0) return false;
  const row: any = db.prepare("SELECT spent FROM global_spend WHERE day = ?").get(today());
  return (row?.spent ?? 0) >= CAP;
}

/** Suma el coste cobrado de una llamada al acumulado del día (persistido). */
export function addGlobalSpend(amount: number) {
  if (CAP <= 0 || !(amount > 0)) return;
  db.prepare(
    "INSERT INTO global_spend (day, spent) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET spent = spent + ?"
  ).run(today(), amount, amount);
}
