-- Merge of email threads: automatic quote drafts (status 'utkast') on the source thread are deleted like drafts;
-- sent/approved quotes (status <> 'utkast') and call records still block the merge.
CREATE OR REPLACE FUNCTION public.estim_merge_email_thread(source_tid uuid, target_tid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  cid uuid := public.my_company(); actor uuid := auth.uid(); n int;
BEGIN
  IF cid IS NULL OR actor IS NULL OR source_tid IS NULL OR target_tid IS NULL OR source_tid=target_tid THEN RAISE EXCEPTION 'Not allowed'; END IF;
  -- Lock both threads in UUID order to avoid deadlocks.
  PERFORM 1 FROM public.threads WHERE id IN (source_tid,target_tid) AND company_id=cid ORDER BY id FOR UPDATE;
  SELECT count(*) INTO n FROM public.threads WHERE id IN (source_tid,target_tid) AND company_id=cid AND channel='email';
  IF n<>2 THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF EXISTS(SELECT 1 FROM public.ai_jobs WHERE company_id=cid AND thread_id IN (source_tid,target_tid) AND state IN ('queued','running')) THEN RAISE EXCEPTION 'AI busy'; END IF;
  IF EXISTS(SELECT 1 FROM public.messages WHERE company_id=cid AND thread_id IN (source_tid,target_tid) AND delivery_status='sending') THEN RAISE EXCEPTION 'Busy'; END IF;
  -- Sent/approved quotes and call records are not moved; refuse rather than lose them.
  IF EXISTS(SELECT 1 FROM public.quotes WHERE company_id=cid AND thread_id=source_tid AND status<>'utkast')
     OR EXISTS(SELECT 1 FROM public.samtal_calls WHERE thread_id=source_tid) THEN RAISE EXCEPTION 'Has quotes'; END IF;

  UPDATE public.messages SET thread_id=target_tid WHERE company_id=cid AND thread_id=source_tid;
  UPDATE public.company_document_deliveries SET thread_id=target_tid WHERE company_id=cid AND thread_id=source_tid;
  UPDATE public.ai_jobs SET thread_id=target_tid WHERE company_id=cid AND thread_id=source_tid;
  DELETE FROM public.drafts WHERE company_id=cid AND thread_id=source_tid;
  -- Only automatic quote drafts can remain here (checked above).
  DELETE FROM public.quotes WHERE company_id=cid AND thread_id=source_tid AND status='utkast';
  UPDATE public.threads SET suggested_merge_thread_id=NULL WHERE company_id=cid AND suggested_merge_thread_id IN (source_tid,target_tid);
  UPDATE public.threads SET suggested_merge_thread_id=NULL,
    last_message_at=coalesce((SELECT max(sent_at) FROM public.messages WHERE company_id=cid AND thread_id=target_tid), last_message_at)
  WHERE id=target_tid AND company_id=cid;
  DELETE FROM public.threads WHERE id=source_tid AND company_id=cid;
  INSERT INTO public.audit_log(company_id,user_id,event,"after")
  VALUES(cid,actor,'Tråd sammanslagen',jsonb_build_object('thread_id',target_tid,'from_thread_id',source_tid));
  RETURN jsonb_build_object('id',target_tid,'merged_from',source_tid);
END $function$;
