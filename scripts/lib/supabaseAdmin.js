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
