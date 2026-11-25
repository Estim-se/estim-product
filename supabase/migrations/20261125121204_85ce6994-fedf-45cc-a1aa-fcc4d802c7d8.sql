-- estim Samtal: automatic deletion after the number of days the company chose (samtal_settings.retention_days).
-- Approved. Runs after samtal.sql; the schedule itself is in samtal-sletting-cron.sql.
--
-- How it runs: pg_cron calls the app's purge route every hour through pg_net (the same way tender jobs are kicked).
-- The route (server side, secret-verified) asks for the calls that are due, deletes their audio files through the
-- Storage API, and then marks each call purged. Deleting storage.objects rows directly in SQL is avoided, because it
-- would leave the file itself behind in storage.

-- Due calls (server only): audio and content past their deletion time and not deleted yet. Oldest first, bounded.
CREATE FUNCTION public.samtal_due_for_deletion(p_limit integer) RETURNS TABLE (call_id uuid, company_id uuid, audio_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.company_id, c.audio_path FROM public.samtal_calls c
   WHERE c.delete_after <= now() AND c.content_deleted_at IS NULL
   ORDER BY c.delete_after LIMIT least(greatest(p_limit, 1), 500)
$$;

-- Mark a call purged after its audio file is deleted: transcript, extraction, audio path and caller are removed;
-- only the fact that a call took place remains (time, duration, employee, status). The company is checked here too.
CREATE FUNCTION public.samtal_mark_deleted(p_call uuid, p_company uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.samtal_calls SET transcript = NULL, extraction = NULL, audio_path = NULL, caller_phone = NULL, content_deleted_at = now()
   WHERE id = p_call AND company_id = p_company AND content_deleted_at IS NULL;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.samtal_due_for_deletion(integer), public.samtal_mark_deleted(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_due_for_deletion(integer), public.samtal_mark_deleted(uuid, uuid) TO service_role;
