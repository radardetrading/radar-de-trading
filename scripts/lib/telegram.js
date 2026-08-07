import { fetchConTimeout } from './fetchTimeout.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// offset: si se pasa, le pide a Telegram que confirme (descarte) los updates anteriores a ese id.
export async function getUpdates(offset){
  const url = new URL(`${API}/getUpdates`);
  url.searchParams.set('timeout', '0');
  if(offset != null) url.searchParams.set('offset', String(offset));
  const res = await fetchConTimeout(url);
  const json = await res.json();
  if(!json.ok) throw new Error(`Telegram getUpdates: ${JSON.stringify(json)}`);
  return json.result;
}

// Devuelve true/false en vez de tirar excepción: un chat inválido (bot bloqueado, etc.)
// no debe frenar el resto del job.
export async function sendMessage(chatId, text){
  const res = await fetchConTimeout(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const json = await res.json();
  if(!json.ok){
    console.error(`Telegram sendMessage falló para chat ${chatId}:`, json.description);
    return false;
  }
  return true;
}
