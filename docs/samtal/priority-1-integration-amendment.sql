-- DOCUMENTATION CANDIDATE ONLY. Not approved for live installation or application activation.
-- Apply only after the accepted safety draft, only in the isolated regression below until separately approved.
-- Preserve cleanup ownership when the old upload token reports late success/failure. Signature/grants unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION public.samtal_finish_audio(p_call uuid,p_company uuid,p_audio uuid,p_token uuid,p_uploaded boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls; a public.samtal_audio_ledger;
BEGIN
  c := public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO a FROM public.samtal_audio_ledger WHERE id=p_audio AND company_id=p_company AND call_id=p_call FOR UPDATE;
  IF a.id IS NULL OR p_token IS NULL OR a.upload_token<>p_token THEN RETURN false; END IF;
  IF a.state='attached' AND c.audio_path=a.audio_path AND c.content_deleted_at IS NULL
     AND c.delete_after>clock_timestamp() AND c.status<>'privat' AND c.classification IS DISTINCT FROM 'privat' THEN RETURN true; END IF;
  IF p_uploaded IS DISTINCT FROM true OR a.state<>'reserved' OR a.upload_until<=clock_timestamp()
     OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.classification='privat'
     OR c.delete_after<=clock_timestamp() OR c.audio_path IS NOT NULL
     OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=p_company AND active) THEN
    UPDATE public.samtal_audio_ledger SET state='cleanup',retry_after=least(retry_after,clock_timestamp()) WHERE id=a.id;
    RETURN false;
  END IF;
  UPDATE public.samtal_audio_ledger SET state='attached' WHERE id=a.id;
  UPDATE public.samtal_calls SET audio_path=a.audio_path,status='mottagen',error_code=NULL WHERE id=p_call;
  RETURN true;
END $$;
COMMIT;