// fetch con timeout (AbortController). Evita que una dependencia lenta
// (Anthropic, ElevenLabs, Stripe, Google…) deje un handler colgado para siempre.
export async function fetchT(
  url: string,
  opts: any = {},
  ms = 30000
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("upstream timeout");
    throw e;
  } finally {
    clearTimeout(t);
  }
}
