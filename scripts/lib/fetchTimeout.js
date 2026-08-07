// fetch con timeout: evita que un job de GitHub Actions quede colgado (y sea
// cancelado desde afuera) si Supabase o Telegram no responden.
const TIMEOUT_MS = 10000;

export async function fetchConTimeout(url, options = {}, timeoutMs = TIMEOUT_MS){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch(err){
    if(err.name === 'AbortError') throw new Error(`Timeout de ${timeoutMs}ms al pedir ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
