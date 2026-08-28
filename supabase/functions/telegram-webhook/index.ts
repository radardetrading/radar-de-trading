// Reemplaza al poller de GitHub Actions (telegram-link-poller.js).
// Telegram llama a esto al instante cuando llega un mensaje al bot, en vez de
// que nosotros tengamos que ir a preguntar cada X minutos (cron nada confiable).
import { createClient } from "npm:@supabase/supabase-js@2";

const START_RE = /^\/start\s+(RADAR[A-F0-9]{4})$/i;

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

Deno.serve(async (req) => {
  // Solo Telegram (que manda este header con el secreto que configuramos en setWebhook) puede pegarle a esto.
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const update = await req.json().catch(() => null);
  const text = update?.message?.text;
  const chatId = update?.message?.chat?.id;
  const match = typeof text === "string" ? text.trim().match(START_RE) : null;

  // Siempre devolvemos 200: si le devolvemos error a Telegram, reintenta sin parar.
  if (!match || !chatId) return new Response("ok");

  const codigo = match[1].toUpperCase();

  const { data: rows, error } = await supabase
    .from("estado")
    .select("user_id, data")
    .eq("data->perfil->>telegramLinkCode", codigo);

  if (error || !rows?.length) return new Response("ok");

  const row = rows[0];
  if (row.data?.perfil?.telegramChatId) return new Response("ok"); // ya estaba vinculado

  row.data.perfil.telegramChatId = chatId;
  row.data.perfil.telegramLinkedAt = new Date().toISOString();
  delete row.data.perfil.telegramLinkCode;

  await supabase.from("estado").update({ data: row.data }).eq("user_id", row.user_id);
  await sendMessage(chatId, "✅ Cuenta vinculada correctamente a Radar de Trading. A partir de ahora vas a recibir tus avisos por acá.");

  return new Response("ok");
});
