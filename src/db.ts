import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || "sintonia.db";
// Crea el directorio del disco persistente si no existe (p. ej. /data en Render): sin esto,
// better-sqlite3 lanza SQLITE_CANTOPEN y el proceso entra en crash-loop al arrancar.
try { fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true }); } catch { /* ya existe */ }

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  provider TEXT,
  spend REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  budget REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  descr TEXT,
  emoji TEXT,
  color INTEGER,
  tags TEXT,
  payload TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 1,
  plays INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stations_public ON stations(is_public, created_at);
CREATE INDEX IF NOT EXISTS idx_stations_owner ON stations(owner_id);

-- Eventos de Stripe ya procesados (idempotencia del webhook).
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
`);

// Migración segura: añade columnas de suscripción si no existen.
const cols = new Set<string>(
  (db.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => c.name)
);
function addCol(name: string, ddl: string) {
  if (!cols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
}
addCol("subscribed", "subscribed INTEGER NOT NULL DEFAULT 0");
addCol("sub_provider", "sub_provider TEXT");
addCol("sub_until", "sub_until INTEGER NOT NULL DEFAULT 0");
addCol("stripe_customer", "stripe_customer TEXT");
addCol("content", "content TEXT"); // emisoras + historial sincronizados (JSON)

export default db;
