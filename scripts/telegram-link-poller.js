// Corre cada ~10 min via GitHub Actions. Matchea codigos de vinculacion (RADAR-XXXX)
// generados desde la web contra mensajes "/start RADAR-XXXX" recibidos por el bot,
// y guarda el chat_id resultante en perfil.telegramChatId de ese usuario.
import { fetchAllEstados, updateEstadoData } from './lib/supabaseAdmin.js';
import { getUpdates, sendMessage } from './lib/telegram.js';

const START_RE = /^\/start\s+(RADAR-[A-F0-9]{4})$/i;

async function main(){
  const rows = await fetchAllEstados();

  const pendientes = new Map(); // codigo (mayusculas) -> {userId, data}
  for(const row of rows){
    const code = row.data?.perfil?.telegramLinkCode;
    const yaVinculado = row.data?.perfil?.telegramChatId;
    if(code && !yaVinculado){
      pendientes.set(code.toUpperCase(), { userId: row.user_id, data: row.data });
    }
  }

  if(pendientes.size === 0){
    console.log('Sin codigos de vinculacion pendientes, no se consulta Telegram.');
    return;
  }

  const updates = await getUpdates();
  let vinculados = 0;
  let lastUpdateId = null;

  for(const update of updates){
    lastUpdateId = update.update_id;
    const text = update.message?.text;
    const chatId = update.message?.chat?.id;
    if(!text || !chatId) continue;

    const match = text.trim().match(START_RE);
    if(!match) continue;

    const codigo = match[1].toUpperCase();
    const pendiente = pendientes.get(codigo);
    if(!pendiente) continue;

    await updateEstadoData(pendiente.userId, pendiente.data, (data) => {
      data.perfil = data.perfil || {};
      data.perfil.telegramChatId = chatId;
      data.perfil.telegramLinkedAt = new Date().toISOString();
      delete data.perfil.telegramLinkCode;
    });
    await sendMessage(chatId, '✅ Cuenta vinculada correctamente a Radar de Trading. A partir de ahora vas a recibir tus avisos por acá.');
    pendientes.delete(codigo);
    vinculados++;
  }

  // Confirma (descarta) los updates ya procesados para que la proxima corrida no los vuelva a ver.
  if(lastUpdateId != null){
    await getUpdates(lastUpdateId + 1);
  }

  console.log(`Vinculaciones nuevas: ${vinculados}. Codigos aun pendientes: ${pendientes.size}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
