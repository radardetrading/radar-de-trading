// Reemplaza el cron de GitHub Actions (telegram-session-reminder.yml) como disparador del
// aviso de sesion + alertas de riesgo. GitHub degrada el schedule en este repo publico de
// poco trafico (corridas cada varias horas en vez de cada 15 min — ver TELEGRAM-WEBHOOK-FIX.md,
// mismo problema que ya se resolvio para el poller de vinculacion).
//
// Esta funcion la llaman disparadores confiables externos a GitHub Actions:
//   - pg_cron de Supabase (supabase/migrations/*_session_reminder_cron.sql)
//   - cron-job.org como respaldo (ver TELEGRAM-WEBHOOK-FIX.md)
// Llamarla de mas no rompe nada: el dedupe por dia (perfil.telegramLastNotified) hace que
// mandar el mismo chequeo varias veces en la ventana sea un no-op despues del primer envio.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CRON_SECRET = Deno.env.get("CRON_SECRET")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

webpush.setVapidDetails(
  "mailto:jonatanguidobaldi@gmail.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

// Manda el push a una suscripción; devuelve false si la suscripción esta vencida/invalida
// (404/410 — el navegador la dio de baja) para que se pueda limpiar del perfil.
async function sendPush(sub: any, title: string, body: string) {
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    return true;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.statusCode === 410) return false;
    console.error("push falló:", err?.statusCode, err?.body || err);
    return true; // error transitorio: no se descarta la suscripción
  }
}

// Espejo de TELEGRAM_SESION_AVISO_MIN en index.html.
const AVISO_MINUTOS_ANTES = 30;
// Con disparadores confiables (pg_cron/cron-job.org corren al minuto) la ventana solo tiene
// que cubrir el margen normal entre corridas, no horas de demora como con GitHub Actions.
const VENTANA_MINUTOS = 15;

const TZ_ARGENTINA = "America/Argentina/Buenos_Aires";
// Espejo de TELEGRAM_SESION_PRESETS en index.html — mismos horarios y zonas.
const SESION_PRESETS: Record<string, { tz: string; hora: string }> = {
  londres: { tz: "Europe/London", hora: "08:00" },
  nuevayork: { tz: "America/New_York", hora: "08:00" },
  asia: { tz: "Asia/Tokyo", hora: "09:00" },
};

// ── Espejo de calcularAlertas() en scripts/lib/alertas.js ──
const DEFAULT_PREFS = { inactividad: true, drawdown: true, rutina: true, metas: true };
const DEFAULT_THRESHOLDS = { inactividadDias: 7, drawdownPct: 80, metasDias: 7, cooldownDias: 3 };

function debeAvisar(lastDateStr: string | undefined, minDias: number, hoy: string) {
  if (!lastDateStr) return true;
  const diff = Math.floor((new Date(hoy + "T00:00:00").getTime() - new Date(lastDateStr + "T00:00:00").getTime()) / 86400000);
  return diff >= minDias;
}

function getFechaLimiteInactividad(a: any, trades: any[], hoy: string) {
  const last = trades.filter((t) => t.accountId === a.id && t.date).sort((x, y) => y.date.localeCompare(x.date))[0];
  const lastDate = last ? last.date : (a.startDate || null);
  if (!lastDate) return { diasRest: 0, zone: "ok" };
  const today = new Date(hoy + "T00:00:00");
  const base = new Date(lastDate + "T00:00:00");
  const fechaLimite = new Date(base);
  fechaLimite.setDate(fechaLimite.getDate() + 30);
  const dow = fechaLimite.getDay();
  if (dow === 6) fechaLimite.setDate(fechaLimite.getDate() - 1);
  else if (dow === 0) fechaLimite.setDate(fechaLimite.getDate() - 2);
  const diasRest = Math.round((fechaLimite.getTime() - today.getTime()) / 86400000);
  const zone = diasRest < 0 ? "dead" : diasRest < 7 ? "danger" : diasRest < 14 ? "warn" : "ok";
  return { diasRest, zone };
}

function getEffectiveBalance(a: any, trades: any[]) {
  if (a.manualBalance != null) return a.manualBalance;
  const base = a.initialBalance != null ? a.initialBalance : (a.size || 0);
  const pnl = trades.filter((t) => t.accountId === a.id).reduce((s, t) => s + (t.pnl || 0), 0);
  return base + pnl;
}
function getEffectiveDD(a: any, trades: any[]) {
  const bal = getEffectiveBalance(a, trades);
  const base = (a.size != null && a.size > 0) ? a.size : (a.initialBalance || 0);
  const drop = base - bal;
  const ddFromPnl = (base > 0 && drop > 0) ? (drop / base * 100) : 0;
  const ddManual = parseFloat(a.cMax) || 0;
  return Math.max(ddFromPnl, ddManual);
}
function getEffectiveDailyDD(a: any, trades: any[]) {
  if (a.dayOpen && a.dayOpen > 0) {
    const drop = a.dayOpen - getEffectiveBalance(a, trades);
    return drop > 0 ? (drop / a.dayOpen * 100) : 0;
  }
  return 0;
}

function dayPct(day: any, habitos: any[]) {
  if (!day || !habitos.length) return 0;
  let done = 0;
  habitos.forEach((h) => {
    if (h.type === "check" && day[h.id]) done++;
    else if (h.type === "minutes" && (parseInt(day[h.id + "_min"]) || 0) > 0) done++;
  });
  return (done / habitos.length) * 100;
}

function nombreCuenta(a: any) {
  return a.name || a.firm || "Cuenta";
}

function calcularAlertas(data: any, hoy: string) {
  const prefs = { ...DEFAULT_PREFS, ...(data.perfil?.telegramPrefs || {}) };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(data.perfil?.telegramThresholds || {}) };
  const lastNotified = data.perfil?.telegramLastNotified || {};
  const accounts = data.accounts || [];
  const trades = data.trades || [];
  const lines: string[] = [];
  let huboCambios = false;

  if (prefs.inactividad) {
    const bucket = lastNotified.inactividad || {};
    const inactLines: string[] = [];
    for (const a of accounts.filter((a: any) => a.phase !== "blown" && a.phase !== "passed")) {
      const info = getFechaLimiteInactividad(a, trades, hoy);
      if (info.diasRest <= thresholds.inactividadDias && debeAvisar(bucket[a.id], 1, hoy)) {
        inactLines.push(info.zone === "dead"
          ? `  • ${nombreCuenta(a)}: vencida hace ${-info.diasRest} día(s)`
          : `  • ${nombreCuenta(a)}: vence en ${info.diasRest} día(s)`);
        bucket[a.id] = hoy;
        huboCambios = true;
      }
    }
    lastNotified.inactividad = bucket;
    if (inactLines.length) lines.push("🔴 Cuentas en riesgo por inactividad:", ...inactLines);
  }

  if (prefs.drawdown) {
    const bucket = lastNotified.drawdown || {};
    const ddLines: string[] = [];
    for (const a of accounts.filter((a: any) => a.phase !== "blown")) {
      const cDaily = getEffectiveDailyDD(a, trades);
      const cMax = getEffectiveDD(a, trades);
      const dailyLim = parseFloat(a.dailyDD) || 5;
      const maxLim = parseFloat(a.maxDD) || 10;
      const dr = dailyLim > 0 ? cDaily / dailyLim : 0;
      const mr = maxLim > 0 ? cMax / maxLim : 0;
      const umbral = thresholds.drawdownPct / 100;
      if (dr >= umbral && debeAvisar(bucket[a.id + ":daily"], thresholds.cooldownDias, hoy)) {
        ddLines.push(`  • ${nombreCuenta(a)}: DD diario ${cDaily.toFixed(1)}%/${dailyLim}% (${Math.round(dr * 100)}%)`);
        bucket[a.id + ":daily"] = hoy;
        huboCambios = true;
      }
      if (mr >= umbral && debeAvisar(bucket[a.id + ":max"], thresholds.cooldownDias, hoy)) {
        ddLines.push(`  • ${nombreCuenta(a)}: DD máximo ${cMax.toFixed(1)}%/${maxLim}% (${Math.round(mr * 100)}%)`);
        bucket[a.id + ":max"] = hoy;
        huboCambios = true;
      }
    }
    lastNotified.drawdown = bucket;
    if (ddLines.length) lines.push("📉 Drawdown cerca del límite:", ...ddLines);
  }

  if (prefs.rutina) {
    const habitos = data.rutHabitos || [];
    const rutDays = data.rutDays || {};
    if (habitos.length && dayPct(rutDays[hoy], habitos) === 0 && lastNotified.rutina !== hoy) {
      lines.push("🧘 Rutina: todavía no registraste nada hoy.");
      lastNotified.rutina = hoy;
      huboCambios = true;
    }
  }

  if (prefs.metas) {
    const bucket = lastNotified.metas || {};
    const metaLines: string[] = [];
    const ahora = new Date();
    for (const m of (data.metas || [])) {
      if (!m.deadline || m.estado === "lograda" || m.estado === "cancelada") continue;
      const dias = Math.ceil((new Date(m.deadline + "T23:59:59").getTime() - ahora.getTime()) / 86400000);
      if (dias <= thresholds.metasDias && debeAvisar(bucket[m.id], thresholds.cooldownDias, hoy)) {
        metaLines.push(`  • "${m.titulo}": ${dias < 0 ? `venció hace ${-dias} día(s)` : dias === 0 ? "vence hoy" : `vence en ${dias} día(s)`}`);
        bucket[m.id] = hoy;
        huboCambios = true;
      }
    }
    lastNotified.metas = bucket;
    if (metaLines.length) lines.push("🎯 Metas por vencer:", ...metaLines);
  }

  return { lines, lastNotified, huboCambios };
}

// ── Fin espejo de alertas.js ──

function fechaEnZona(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date); // 'YYYY-MM-DD'
}

function horaLocalAUtc(dateStr: string, hhmm: string, timeZone: string) {
  const guess = new Date(`${dateStr}T${hhmm}:00Z`);
  const comoEnZona = new Date(guess.toLocaleString("en-US", { timeZone }));
  const comoEnUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  const offsetMs = comoEnUtc.getTime() - comoEnZona.getTime();
  return new Date(guess.getTime() + offsetMs);
}

function calcularHoraAviso(sesionCfg: any, ahora: Date) {
  if (!sesionCfg) return null;
  const modo = sesionCfg.modo || "personalizado";
  let tz: string, hora: string;
  if (modo === "personalizado") {
    tz = TZ_ARGENTINA;
    hora = sesionCfg.hora;
  } else {
    const preset = SESION_PRESETS[modo];
    if (!preset) return null;
    tz = preset.tz;
    hora = preset.hora;
  }
  if (!hora || !/^\d{2}:\d{2}$/.test(hora)) return null;
  const dateStr = fechaEnZona(ahora, tz);
  const inicioSesion = horaLocalAUtc(dateStr, hora, tz);
  return new Date(inicioSesion.getTime() - AVISO_MINUTOS_ANTES * 60000);
}

async function sendMessage(chatId: number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const json = await res.json();
  if (!json.ok) console.error(`Telegram sendMessage falló para chat ${chatId}:`, json.description);
  return json.ok === true;
}

Deno.serve(async (req) => {
  // Solo nuestros disparadores (pg_cron, cron-job.org) mandan este header con el secreto.
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  const ahora = new Date();
  const { data: rows, error } = await supabase.from("estado").select("user_id, data");
  if (error) return new Response(error.message, { status: 500 });

  let enviados = 0;
  for (const row of rows) {
    const data = row.data;
    const chatId = data?.perfil?.telegramChatId;
    const pushSubs: any[] = data?.perfil?.pushSubscriptions || [];
    if (!chatId && !pushSubs.length) continue;
    if (data?.perfil?.telegramPrefs?.sesion !== true) continue; // opt-in explícito

    const horaAviso = calcularHoraAviso(data?.perfil?.telegramSesion, ahora);
    if (!horaAviso) continue;

    const diffMin = (ahora.getTime() - horaAviso.getTime()) / 60000;
    if (diffMin < 0 || diffMin >= VENTANA_MINUTOS) continue;

    const hoy = fechaEnZona(ahora, TZ_ARGENTINA);
    if (data.perfil.telegramLastNotified?.sesion === hoy) continue; // ya avisado hoy (atajo rápido)

    // Candado atomico: pg_cron y cron-job.org pueden caer casi juntos (ambos alineados a
    // minutos redondos). Solo la invocacion que gana este INSERT sigue adelante; la otra
    // choca contra la unicidad (user_id, dia) y se descarta sin mandar nada.
    const { error: claimError } = await supabase
      .from("session_reminder_claim")
      .insert({ user_id: row.user_id, dia: hoy });
    if (claimError) continue; // ya reclamado por otra invocacion concurrente

    const { lines, lastNotified, huboCambios } = calcularAlertas(data, hoy);

    const nombre = data.perfil?.apodo || data.perfil?.nombre || "";
    const encabezado = nombre ? `📡 Radar de Trading — ${nombre}` : "📡 Radar de Trading";
    const minutosRestantes = Math.round(AVISO_MINUTOS_ANTES - diffMin);
    const lineaAviso = minutosRestantes > 0
      ? `⏰ Tu sesión empieza en ${minutosRestantes} minutos. Preparate.`
      : `⏰ Tu sesión ya arrancó (hace ${Math.abs(minutosRestantes)} min). ¡Vamos!`;
    const partes = [encabezado, "", lineaAviso];
    if (lines.length) partes.push("", ...lines);
    const texto = partes.join("\n");

    let entregado = false;
    let huboCambiosPush = false;

    if (chatId && await sendMessage(chatId, texto)) entregado = true;

    if (pushSubs.length) {
      const cuerpoPush = [lineaAviso, ...lines].join("\n");
      const subsVivas: any[] = [];
      for (const sub of pushSubs) {
        const viva = await sendPush(sub, encabezado, cuerpoPush);
        if (viva) { subsVivas.push(sub); entregado = true; }
      }
      if (subsVivas.length !== pushSubs.length) {
        data.perfil.pushSubscriptions = subsVivas;
        huboCambiosPush = true;
      }
    }

    if (entregado) {
      enviados++;
      lastNotified.sesion = hoy;
      data.perfil.telegramLastNotified = lastNotified;
      await supabase.from("estado").update({ data }).eq("user_id", row.user_id);
    } else {
      // No se pudo entregar por ningún canal (Telegram caído, sin push): liberamos el
      // candado de hoy para que una corrida posterior, dentro de la misma ventana, reintente.
      await supabase.from("session_reminder_claim").delete().eq("user_id", row.user_id).eq("dia", hoy);
      if (huboCambios || huboCambiosPush) {
        data.perfil.telegramLastNotified = lastNotified;
        await supabase.from("estado").update({ data }).eq("user_id", row.user_id);
      }
    }
  }

  return new Response(JSON.stringify({ enviados, revisados: rows.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
