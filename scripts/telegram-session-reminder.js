// Corre cada 15 minutos via GitHub Actions. Le avisa a cada usuario que activó el
// recordatorio de sesion (perfil.telegramPrefs.sesion) unos minutos antes de que
// arranque su sesion configurada (preset Londres/Nueva York/Asia u horario personalizado
// en hora Argentina). Este es el ÚNICO disparador de avisos por Telegram: el mensaje
// incluye tanto el aviso de sesión como las alertas de riesgo (inactividad, drawdown,
// rutina, metas) calculadas con la misma lógica que antes vivía en telegram-daily-digest.js
// (fusionadas acá para que todo llegue en el horario de sesión elegido, en vez de a una
// hora fija separada).
import { fetchAllEstados, updateEstadoData } from './lib/supabaseAdmin.js';
import { sendMessage } from './lib/telegram.js';
import { calcularAlertas } from './lib/alertas.js';

// Espejo de TELEGRAM_SESION_AVISO_MIN en index.html.
const AVISO_MINUTOS_ANTES = 30;
// GitHub tira el cron declarado (cada 15 min) por la borda en repos públicos de poco
// trafico: en la práctica corre cada 1-3 horas. Ventana ancha para no perder el aviso
// por esa demora; el dedupe por día evita duplicados si varias corridas caen adentro.
const VENTANA_MINUTOS = 180;

const TZ_ARGENTINA = 'America/Argentina/Buenos_Aires';
// Espejo de TELEGRAM_SESION_PRESETS en index.html — mismos horarios y zonas.
const SESION_PRESETS = {
  londres:   { tz: 'Europe/London',    hora: '08:00' },
  nuevayork: { tz: 'America/New_York', hora: '08:00' },
  asia:      { tz: 'Asia/Tokyo',       hora: '09:00' }
};

function fechaEnZona(date, timeZone){
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date); // 'YYYY-MM-DD'
}

// Convierte "HH:MM" tal como se lee en timeZone (para la fecha dateStr) a un instante UTC real.
function horaLocalAUtc(dateStr, hhmm, timeZone){
  const guess = new Date(`${dateStr}T${hhmm}:00Z`);
  const comoEnZona = new Date(guess.toLocaleString('en-US', { timeZone }));
  const comoEnUtc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = comoEnUtc.getTime() - comoEnZona.getTime();
  return new Date(guess.getTime() + offsetMs);
}

// Devuelve el instante (Date) en que hay que avisar, o null si la config es inválida/incompleta.
function calcularHoraAviso(sesionCfg, ahora){
  if(!sesionCfg) return null;
  const modo = sesionCfg.modo || 'personalizado';
  let tz, hora;
  if(modo === 'personalizado'){
    tz = TZ_ARGENTINA;
    hora = sesionCfg.hora;
  } else {
    const preset = SESION_PRESETS[modo];
    if(!preset) return null;
    tz = preset.tz;
    hora = preset.hora;
  }
  if(!hora || !/^\d{2}:\d{2}$/.test(hora)) return null;
  const dateStr = fechaEnZona(ahora, tz);
  const inicioSesion = horaLocalAUtc(dateStr, hora, tz);
  return new Date(inicioSesion.getTime() - AVISO_MINUTOS_ANTES * 60000);
}

async function main(){
  const ahora = new Date();
  const rows = await fetchAllEstados();
  let enviados = 0;

  for(const row of rows){
    const data = row.data;
    const chatId = data?.perfil?.telegramChatId;
    if(!chatId) continue;
    if(data?.perfil?.telegramPrefs?.sesion !== true) continue; // opt-in explícito

    const horaAviso = calcularHoraAviso(data?.perfil?.telegramSesion, ahora);
    if(!horaAviso) continue;

    const diffMin = (ahora.getTime() - horaAviso.getTime()) / 60000;
    if(diffMin < 0 || diffMin >= VENTANA_MINUTOS) continue; // no cae en la ventana de este run

    const hoy = fechaEnZona(ahora, TZ_ARGENTINA);
    if(data.perfil.telegramLastNotified?.sesion === hoy) continue; // ya avisado hoy

    const { lines, lastNotified, huboCambios } = calcularAlertas(data, hoy);

    const nombre = data.perfil?.apodo || data.perfil?.nombre || '';
    const encabezado = nombre ? `📡 Radar de Trading — ${nombre}` : '📡 Radar de Trading';
    // La corrida puede llegar tarde (ver VENTANA_MINUTOS), así que el minutaje es el real
    // restante y no siempre AVISO_MINUTOS_ANTES fijo.
    const minutosRestantes = Math.round(AVISO_MINUTOS_ANTES - diffMin);
    const lineaAviso = minutosRestantes > 0
      ? `⏰ Tu sesión empieza en ${minutosRestantes} minutos. Preparate.`
      : `⏰ Tu sesión ya arrancó (hace ${Math.abs(minutosRestantes)} min). ¡Vamos!`;
    const partes = [encabezado, '', lineaAviso];
    if(lines.length) partes.push('', ...lines);
    const texto = partes.join('\n');

    if(await sendMessage(chatId, texto)){
      enviados++;
      lastNotified.sesion = hoy;
      await updateEstadoData(row.user_id, data, (d) => {
        d.perfil = d.perfil || {};
        d.perfil.telegramLastNotified = lastNotified;
      });
    } else if(huboCambios){
      // El envío falló pero igual guardamos el dedupe de las alertas para no reintentar
      // de más en la próxima corrida (mismo criterio que usaba telegram-daily-digest.js).
      await updateEstadoData(row.user_id, data, (d) => {
        d.perfil = d.perfil || {};
        d.perfil.telegramLastNotified = lastNotified;
      });
    }
  }

  console.log(`Recordatorio de sesión enviado a ${enviados} usuario(s) de ${rows.length} fila(s) revisada(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
