-- estim Samtal: run the processing queue every minute (pg_cron → pg_net → /api/public/samtal-worker), with the same
-- Vault secret as the purge. Runs after samtal-sletting-cron.sql. Without the flag SAMTAL the route claims nothing.
-- Re-running replaces the job instead of adding a second one.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'samtal-worker';
SELECT cron.schedule('samtal-worker', '* * * * *', $cron$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'samtal_base_url') || '/api/public/samtal-worker',
    headers := jsonb_build_object('Content-Type', 'application/json',
               'x-estim-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'samtal_purge_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 600000)
$cron$);
