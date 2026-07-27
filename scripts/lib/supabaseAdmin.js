const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers(){
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };
}

// Trae TODAS las filas de la tabla estado (bypassa RLS con la service_role key).
export async function fetchAllEstados(){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/estado?select=user_id,data`, { headers: headers() });
  if(!res.ok) throw new Error(`Supabase fetchAllEstados: ${res.status} ${await res.text()}`);
  return res.json();
}

// Aplica mutatorFn sobre el objeto data en memoria y sube la fila completa.
export async function updateEstadoData(userId, data, mutatorFn){
  mutatorFn(data);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/estado?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ data })
  });
  if(!res.ok) throw new Error(`Supabase updateEstadoData(${userId}): ${res.status} ${await res.text()}`);
}

// Inserta una copia (snapshot) del estado de un usuario en estado_backups.
export async function insertBackupSnapshot(userId, data){
  const res = await fetch(`${SUPABASE_URL}/rest/v1/estado_backups`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ user_id: userId, data })
  });
  if(!res.ok) throw new Error(`Supabase insertBackupSnapshot(${userId}): ${res.status} ${await res.text()}`);
}

// Borra snapshots de estado_backups con mas de maxAgeDays de antiguedad (de todos los usuarios).
export async function pruneBackupsOlderThan(maxAgeDays){
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/estado_backups?created_at=lt.${cutoff}`, {
    method: 'DELETE',
    headers: { ...headers(), Prefer: 'return=minimal' }
  });
  if(!res.ok) throw new Error(`Supabase pruneBackupsOlderThan: ${res.status} ${await res.text()}`);
}
