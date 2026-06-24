import Database from "better-sqlite3";

const db = new Database(process.env.DB_PATH || "sintonia.db");
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

export default db;
