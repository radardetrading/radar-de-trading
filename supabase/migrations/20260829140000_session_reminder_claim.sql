-- Candado atomico para evitar el doble aviso de sesion: con pg_cron y cron-job.org
-- corriendo en paralelo cada 5 min (ambos alineados a minutos redondos), las dos
-- llamadas podian caer casi juntas y mandar el mensaje dos veces (chequeo de
-- "ya avise hoy" y guardado de esa marca no eran atomicos). Esta tabla obliga a
-- reclamar el dia con un INSERT unico antes de mandar nada: si dos invocaciones
-- llegan a la vez, el segundo INSERT choca contra la restriccion y se descarta.
create table if not exists public.session_reminder_claim (
  user_id uuid not null,
  dia date not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, dia)
);
alter table public.session_reminder_claim enable row level security;
-- Sin policies: solo la service_role (que bypassea RLS) usa esta tabla.
