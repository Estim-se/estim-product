CREATE FUNCTION public.samtal_monitor_bump_safe(p_company uuid, p_metric text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM samtal_monitor_bump(p_company, p_metric, 1);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE FUNCTION public.samtal_monitor_on_call() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM samtal_monitor_bump_safe(NEW.company_id, 'mottagna');
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'fel' THEN
    PERFORM samtal_monitor_bump_safe(NEW.company_id, CASE WHEN NEW.error_code LIKE 'invalid_transcript%' OR NEW.error_code LIKE 'transcript\_%' THEN 'ogiltig_transkription'
      WHEN NEW.error_code LIKE 'stt%' OR NEW.error_code LIKE 'transcription%' THEN 'transkribering_misslyckad' ELSE 'ai_misslyckad' END);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER samtal_monitor_call AFTER INSERT OR UPDATE OF status ON public.samtal_calls
  FOR EACH ROW EXECUTE FUNCTION public.samtal_monitor_on_call();

CREATE FUNCTION public.samtal_monitor_on_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NULL;END IF;
  IF NEW.state = 'done' THEN PERFORM samtal_monitor_bump_safe(NEW.company_id, 'bearbetade');
  ELSIF NEW.state = 'queued' AND OLD.state = 'running' THEN PERFORM samtal_monitor_bump_safe(NEW.company_id, 'omforsok');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER samtal_monitor_job AFTER UPDATE OF state ON public.samtal_jobs
  FOR EACH ROW EXECUTE FUNCTION public.samtal_monitor_on_job();

CREATE FUNCTION public.samtal_monitor_on_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.state = 'completed' AND OLD.state IS DISTINCT FROM 'completed' AND NEW.call_id IS NOT NULL THEN
    BEGIN
      IF samtal_monitor_completion(NEW.company_id, NEW.call_id) = 'slutford' THEN PERFORM samtal_monitor_bump_safe(NEW.company_id, 'slutforda');END IF;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER samtal_monitor_outbox AFTER UPDATE OF state ON public.samtal_dispatch_outbox
  FOR EACH ROW EXECUTE FUNCTION public.samtal_monitor_on_outbox();

CREATE FUNCTION public.samtal_monitor_on_ring_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.state = 'done' AND OLD.state IS DISTINCT FROM 'done'
     AND EXISTS (SELECT 1 FROM samtal_calls c WHERE c.id = NEW.call_id AND c.kind = 'rostanteckning')
     AND NOT EXISTS (SELECT 1 FROM samtal_dispatch_outbox o WHERE o.call_id = NEW.call_id) THEN
    PERFORM samtal_monitor_bump_safe(NEW.company_id, 'slutforda');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE TRIGGER samtal_monitor_ring_job AFTER UPDATE OF state ON public.samtal_jobs
  FOR EACH ROW EXECUTE FUNCTION public.samtal_monitor_on_ring_job();

CREATE FUNCTION public.samtal_monitor_on_ledger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.attempts > coalesce(OLD.attempts, 0) AND NEW.error_code IS NOT NULL AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    PERFORM samtal_monitor_bump_safe(NEW.company_id, 'radering_misslyckad');
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
CREATE TRIGGER samtal_monitor_ledger AFTER UPDATE OF attempts ON public.samtal_audio_ledger
  FOR EACH ROW EXECUTE FUNCTION public.samtal_monitor_on_ledger();

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['samtal_monitor_bump_safe(uuid,text)','samtal_monitor_on_call()','samtal_monitor_on_job()','samtal_monitor_on_outbox()',
    'samtal_monitor_on_ring_job()','samtal_monitor_on_ledger()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;