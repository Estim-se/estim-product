-- estim Samtal: the purge secret exists in one place only, Supabase Vault ('samtal_purge_secret').
-- Runs after samtal-sletting-cron.sql. Replaces the app secret SAMTAL_PURGE_SECRET, which is no longer used.
--
-- The hourly job already reads the secret from Vault and sends it in the header x-estim-secret. The purge route
-- does not read the secret at all: it passes the header it received to this function and gets only true or false
-- back, so the secret never leaves the database. Only service_role (the app's server) may call it. Hashes are
-- compared, and a missing or short secret in Vault never matches.
CREATE FUNCTION public.samtal_purge_secret_valid(p_secret text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((
    SELECT p_secret IS NOT NULL AND length(s.decrypted_secret) >= 32
       AND sha256(convert_to(s.decrypted_secret, 'UTF8')) = sha256(convert_to(p_secret, 'UTF8'))
      FROM vault.decrypted_secrets s WHERE s.name = 'samtal_purge_secret' LIMIT 1), false)
$$;
REVOKE ALL ON FUNCTION public.samtal_purge_secret_valid(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_purge_secret_valid(text) TO service_role;
