-- estim Samtal: the hourly deletion schedule. Runs after samtal-sletting.sql.
-- pg_cron calls the app's purge route through pg_net (as tender jobs are kicked). The app's address and the shared
-- secret are read from Supabase Vault at run time (secrets 'samtal_base_url' and 'samtal_purge_secret'), so no
-- secret value is ever written into a migration or the repository. The same secret is set as SAMTAL_PURGE_SECRET
-- for the app, which rejects any call without it.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Re-running replaces the job instead of adding a second one.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'samtal-purge';
SELECT cron.schedule('samtal-purge', '17 * * * *', $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'samtal_base_url') || '/api/public/samtal-purge',
    headers := jsonb_build_object('Content-Type', 'application/json',
               'x-estim-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'samtal_purge_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000)
$cron$);
