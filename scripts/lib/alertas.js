// Calcula las alertas de riesgo (inactividad, drawdown, rutina, metas) de un usuario.
// Extraido de telegram-daily-digest.js para que telegram-session-reminder.js pueda
// incluir la misma info en el aviso que se manda a la hora de sesion elegida.
export const DEFAULT_PREFS = { inactividad: true, drawdown: true, rutina: true, metas: true };
// Espejo de TELEGRAM_THRESHOLD_DEFAULTS en index.html — mismos nombres de campo.
export const DEFAULT_THRESHOLDS = { inactividadDias: 7, drawdownPct: 80, metasDias: 7, cooldownDias: 3 };

// true si ya pasaron al menos minDias desde lastDateStr (o si nunca se avisó antes).
function debeAvisar(lastDateStr, minDias, hoy){
  if(!lastDateStr) return true;
  const diff = Math.floor((new Date(hoy + 'T00:00:00') - new Date(lastDateStr + 'T00:00:00')) / 86400000);
  return diff >= minDias;
}

// ── Inactividad — espejo de getFechaLimiteInactividad() en index.html ──
function getFechaLimiteInactividad(a, trades, hoy){
  const last = trades.filter(t => t.accountId === a.id && t.date).sort((x, y) => y.date.localeCompare(x.date))[0];
  const lastDate = last ? last.date : (a.startDate || null);
  if(!lastDate) return { diasRest: 0, zone: 'ok' };
  const today = new Date(hoy + 'T00:00:00');
  const base = new Date(lastDate + 'T00:00:00');
  const fechaLimite = new Date(base);
  fechaLimite.setDate(fechaLimite.getDate() + 30);
  const dow = fechaLimite.getDay();
  if(dow === 6) fechaLimite.setDate(fechaLimite.getDate() - 1);
  else if(dow === 0) fechaLimite.setDate(fechaLimite.getDate() - 2);
  const diasRest = Math.round((fechaLimite - today) / 86400000);
  const zone = diasRest < 0 ? 'dead' : diasRest < 7 ? 'danger' : diasRest < 14 ? 'warn' : 'ok';
  return { diasRest, zone };
}

// ── Drawdown — espejo de getEffectiveBalance/getEffectiveDD/getEffectiveDailyDD ──
function getEffectiveBalance(a, trades){
  if(a.manualBalance != null) return a.manualBalance;
  const base = a.initialBalance != null ? a.initialBalance : (a.size || 0);
  const pnl = trades.filter(t => t.accountId === a.id).reduce((s, t) => s + (t.pnl || 0), 0);
  return base + pnl;
}
function getEffectiveDD(a, trades){
  const bal = getEffectiveBalance(a, trades);
  const base = (a.size != null && a.size > 0) ? a.size : (a.initialBalance || 0);
  const drop = base - bal;
  const ddFromPnl = (base > 0 && drop > 0) ? (drop / base * 100) : 0;
  const ddManual = parseFloat(a.cMax) || 0;
  return Math.max(ddFromPnl, ddManual);
}
function getEffectiveDailyDD(a, trades){
  if(a.dayOpen && a.dayOpen > 0){
    const drop = a.dayOpen - getEffectiveBalance(a, trades);
    return drop > 0 ? (drop / a.dayOpen * 100) : 0;
  }
  return 0;
}

// ── Rutina — espejo de dayPct() ──
function dayPct(day, habitos){
  if(!day || !habitos.length) return 0;
  let done = 0;
  habitos.forEach(h => {
    if(h.type === 'check' && day[h.id]) done++;
    else if(h.type === 'minutes' && (parseInt(day[h.id + '_min']) || 0) > 0) done++;
  });
  return (done / habitos.length) * 100;
}

function nombreCuenta(a){
  return a.name || a.firm || 'Cuenta';
}

export function calcularAlertas(data, hoy){
  const prefs = { ...DEFAULT_PREFS, ...(data.perfil?.telegramPrefs || {}) };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(data.perfil?.telegramThresholds || {}) };
  const lastNotified = data.perfil?.telegramLastNotified || {};
  const accounts = data.accounts || [];
  const trades = data.trades || [];
  const lines = [];
  let huboCambios = false;

  if(prefs.inactividad){
    const bucket = lastNotified.inactividad || {};
    const inactLines = [];
    for(const a of accounts.filter(a => a.phase !== 'blown' && a.phase !== 'passed')){
      const info = getFechaLimiteInactividad(a, trades, hoy);
      // A diferencia de drawdown/metas, la inactividad avisa TODOS los dias mientras
      // siga dentro del umbral (o ya vencida) — deja de avisar solo cuando vuelve a
      // estar por encima del umbral (ej. se cargo un trade nuevo) o la cuenta sale
      // del chequeo (blown/passed). El umbral es editable (perfil.telegramThresholds.inactividadDias).
      if(info.diasRest <= thresholds.inactividadDias && debeAvisar(bucket[a.id], 1, hoy)){
        inactLines.push(info.zone === 'dead'
          ? `  • ${nombreCuenta(a)}: vencida hace ${-info.diasRest} día(s)`
          : `  • ${nombreCuenta(a)}: vence en ${info.diasRest} día(s)`);
        bucket[a.id] = hoy;
        huboCambios = true;
      }
    }
    lastNotified.inactividad = bucket;
    if(inactLines.length){ lines.push('🔴 Cuentas en riesgo por inactividad:', ...inactLines); }
  }

  if(prefs.drawdown){
    const bucket = lastNotified.drawdown || {};
    const ddLines = [];
    for(const a of accounts.filter(a => a.phase !== 'blown')){
      const cDaily = getEffectiveDailyDD(a, trades);
      const cMax = getEffectiveDD(a, trades);
      const dailyLim = parseFloat(a.dailyDD) || 5;
      const maxLim = parseFloat(a.maxDD) || 10;
      const dr = dailyLim > 0 ? cDaily / dailyLim : 0;
      const mr = maxLim > 0 ? cMax / maxLim : 0;
      const umbral = thresholds.drawdownPct / 100;
      if(dr >= umbral && debeAvisar(bucket[a.id + ':daily'], thresholds.cooldownDias, hoy)){
        ddLines.push(`  • ${nombreCuenta(a)}: DD diario ${cDaily.toFixed(1)}%/${dailyLim}% (${Math.round(dr * 100)}%)`);
        bucket[a.id + ':daily'] = hoy;
        huboCambios = true;
      }
      if(mr >= umbral && debeAvisar(bucket[a.id + ':max'], thresholds.cooldownDias, hoy)){
        ddLines.push(`  • ${nombreCuenta(a)}: DD máximo ${cMax.toFixed(1)}%/${maxLim}% (${Math.round(mr * 100)}%)`);
        bucket[a.id + ':max'] = hoy;
        huboCambios = true;
      }
    }
    lastNotified.drawdown = bucket;
    if(ddLines.length){ lines.push('📉 Drawdown cerca del límite:', ...ddLines); }
  }

  if(prefs.rutina){
    const habitos = data.rutHabitos || [];
    const rutDays = data.rutDays || {};
    if(habitos.length && dayPct(rutDays[hoy], habitos) === 0 && lastNotified.rutina !== hoy){
      lines.push('🧘 Rutina: todavía no registraste nada hoy.');
      lastNotified.rutina = hoy;
      huboCambios = true;
    }
  }

  if(prefs.metas){
    const bucket = lastNotified.metas || {};
    const metaLines = [];
    const ahora = new Date();
    for(const m of (data.metas || [])){
      if(!m.deadline || m.estado === 'lograda' || m.estado === 'cancelada') continue;
      const dias = Math.ceil((new Date(m.deadline + 'T23:59:59') - ahora) / 86400000);
      if(dias <= thresholds.metasDias && debeAvisar(bucket[m.id], thresholds.cooldownDias, hoy)){
        metaLines.push(`  • "${m.titulo}": ${dias < 0 ? `venció hace ${-dias} día(s)` : dias === 0 ? 'vence hoy' : `vence en ${dias} día(s)`}`);
        bucket[m.id] = hoy;
        huboCambios = true;
      }
    }
    lastNotified.metas = bucket;
    if(metaLines.length){ lines.push('🎯 Metas por vencer:', ...metaLines); }
  }

  return { lines, lastNotified, huboCambios };
}
