-- Dispara la Edge Function session-reminder cada 5 minutos desde adentro de Supabase.
-- Reemplaza al cron de GitHub Actions (telegram-session-reminder.yml), que en este repo
-- publico de poco trafico GitHub degrada a corridas cada varias horas en vez de cada 15 min
-- (ver TELEGRAM-WEBHOOK-FIX.md). pg_cron corre en el propio Postgres del proyecto, sin
-- depender de la infraestructura de GitHub Actions.
--
-- El secreto que autentica la llamada (x-cron-secret) vive en Supabase Vault
-- (nombre 'cron_secret_session_reminder'), nunca en este archivo ni en el repo.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select
  cron.schedule(
    'session-reminder-5min',
    '*/5 * * * *',
    $$
    select net.http_post(
      url := 'https://mbcdwdpaxrcaplfnjsml.supabase.co/functions/v1/session-reminder',
      headers := jsonb_build_object(
        'x-cron-secret',
        (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret_session_reminder')
      ),
      timeout_milliseconds := 20000
    );
    $$
  );
