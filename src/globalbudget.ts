// Circuit breaker de gasto GLOBAL: corta la IA incluida (no BYOK) cuando el gasto
// agregado del día supera GLOBAL_DAILY_CAP (en las mismas unidades que `spend`,
// ~USD con markup). Protege tu factura ante abusos. En memoria (se reinicia con el
// proceso, como los demás topes); con GLOBAL_DAILY_CAP=0 (por defecto) NO limita.
const CAP = Number(process.env.GLOBAL_DAILY_CAP ?? "0");

let day = "";
let spentToday = 0;

function roll() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; spentToday = 0; }
}

/** ¿Se ha alcanzado el tope global de hoy? */
export function globalCapHit(): boolean {
  if (CAP <= 0) return false;
  roll();
  return spentToday >= CAP;
}

/** Suma el coste cobrado de una llamada al acumulado del día. */
export function addGlobalSpend(amount: number) {
  if (CAP <= 0 || !(amount > 0)) return;
  roll();
  spentToday += amount;
}
