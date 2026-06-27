import { Request, Response, NextFunction } from "express";

// Límite por IP (en memoria). En Render free-tier (1 instancia) es suficiente;
// para multi-instancia habría que mover a Redis. Protege endpoints abiertos del
// abuso: creación masiva de invitados, reconocimiento, y hammering de BYOK.
type Bucket = { n: number; reset: number };
const store = new Map<string, Bucket>();

function clientIp(req: Request): string {
  const xff = (req.headers["x-forwarded-for"] as string) || "";
  return xff.split(",")[0].trim() || req.ip || "unknown";
}

export function ipLimit(max: number, windowMs = 3600_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.path}:${clientIp(req)}`;
    const now = Date.now();
    const b = store.get(key);
    if (!b || now > b.reset) {
      store.set(key, { n: 1, reset: now + windowMs });
      return next();
    }
    if (b.n >= max) return res.status(429).json({ error: "demasiadas peticiones, prueba más tarde" });
    b.n++;
    next();
  };
}
