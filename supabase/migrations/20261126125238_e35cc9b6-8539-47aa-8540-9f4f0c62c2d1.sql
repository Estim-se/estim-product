ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS rfc_message_id text;
CREATE INDEX IF NOT EXISTS messages_company_rfc_message_id_idx ON public.messages(company_id, rfc_message_id) WHERE rfc_message_id IS NOT NULL;
ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS pending_sender jsonb;
ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS suggested_merge_thread_id uuid REFERENCES public.threads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS threads_suggested_merge_thread_id_idx ON public.threads(suggested_merge_thread_id) WHERE suggested_merge_thread_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.estim_receive_email(cid uuid, payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE
  mode text := coalesce(payload->>'mode','new_thread');
  cust uuid; tid uuid; jid uuid; sug uuid; fresh boolean := true;
  stamp timestamptz := coalesce((payload->>'sent_at')::timestamptz, now());
  pid text := nullif(payload->>'provider_message_id','');
  rfc text := nullif(payload->>'rfc_message_id','');
  irt text := nullif(payload->>'in_reply_to','');
BEGIN
  IF current_user NOT IN ('postgres','service_role') THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM 1 FROM public.companies WHERE id=cid AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inactive company'; END IF;
  IF mode NOT IN ('quarantine','join_thread','new_thread') OR length(trim(coalesce(payload->>'text','')))=0 OR length(payload->>'text')>30000 THEN
    RAISE EXCEPTION 'Invalid message';
  END IF;
  IF pid IS NOT NULL AND EXISTS(SELECT 1 FROM public.messages WHERE company_id=cid AND channel='email' AND provider_message_id=pid) THEN
    RETURN jsonb_build_object('duplicate',true);
  END IF;

  -- Optional merge suggestion is only kept when it belongs to the same company.
  IF nullif(payload->>'suggested_merge_thread_id','') IS NOT NULL THEN
    SELECT id INTO sug FROM public.threads WHERE id=(payload->>'suggested_merge_thread_id')::uuid AND company_id=cid;
  END IF;

  IF mode='join_thread' AND nullif(payload->>'target_thread_id','') IS NOT NULL THEN
    SELECT id INTO tid FROM public.threads
    WHERE id=(payload->>'target_thread_id')::uuid AND company_id=cid AND channel='email' AND status NOT IN ('vunnen','stangd')
    FOR UPDATE;
    IF tid IS NOT NULL THEN fresh := false; END IF;
  END IF;
  IF mode='join_thread' AND tid IS NULL THEN mode := 'new_thread'; END IF;

  IF mode='quarantine' THEN
    INSERT INTO public.customers(company_id,name,email,phone)
    VALUES(cid, coalesce(nullif(payload->'pending_sender'->>'name',''),'Okänd avsändare'), NULL, NULL)
    RETURNING id INTO cust;
    INSERT INTO public.threads(company_id,customer_id,job,place,channel,status,pending_sender,suggested_merge_thread_id)
    VALUES(cid,cust,coalesce(payload->>'job','Ny förfrågan'),payload->>'place','email','analys',payload->'pending_sender',sug)
    RETURNING id INTO tid;
  ELSIF mode='new_thread' THEN
    -- Read-only customer lookup: existing customer fields are never changed here.
    IF nullif(trim(payload->>'customer_email'),'') IS NOT NULL THEN
      SELECT id INTO cust FROM public.customers
      WHERE company_id=cid AND lower(email)=lower(trim(payload->>'customer_email'))
      ORDER BY created_at LIMIT 1;
    END IF;
    IF cust IS NULL THEN
      INSERT INTO public.customers(company_id,name,email,address,place)
      VALUES(cid,coalesce(nullif(payload->>'customer_name',''),'Okänd kund'),nullif(trim(payload->>'customer_email'),''),payload->>'address',payload->>'place')
      RETURNING id INTO cust;
    END IF;
    INSERT INTO public.threads(company_id,customer_id,job,place,channel,status,suggested_merge_thread_id)
    VALUES(cid,cust,coalesce(payload->>'job','Ny förfrågan'),payload->>'place','email','analys',sug)
    RETURNING id INTO tid;
  END IF;

  INSERT INTO public.messages(company_id,thread_id,"from",channel,text,provider_message_id,rfc_message_id,in_reply_to,sent_at,email_subject)
  VALUES(cid,tid,'kund','email',payload->>'text',pid,rfc,irt,stamp,nullif(payload->>'email_subject',''));
  UPDATE public.threads SET status='analys',read=false,last_message_at=greatest(last_message_at,stamp) WHERE id=tid;
  INSERT INTO public.drafts(company_id,thread_id,channel,text,needs_review) VALUES(cid,tid,'email','',true)
  ON CONFLICT(thread_id) DO UPDATE SET text='',needs_review=true,edited=false;
  INSERT INTO public.ai_jobs(company_id,thread_id,interpret) VALUES(cid,tid,fresh) RETURNING id INTO jid;
  RETURN jsonb_build_object('id',tid,'job_id',jid,'duplicate',false);
END $function$;
REVOKE ALL ON FUNCTION public.estim_receive_email(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estim_receive_email(uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.estim_approve_email_sender(tid uuid, edited_name text DEFAULT NULL, edited_email text DEFAULT NULL, edited_phone text DEFAULT NULL, use_customer_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  cid uuid := public.my_company(); actor uuid := auth.uid(); t public.threads;
  nm text; em text; ph text; cust uuid;
BEGIN
  IF cid IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO t FROM public.threads WHERE id=tid AND company_id=cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF t.pending_sender IS NULL THEN RAISE EXCEPTION 'Nothing pending'; END IF;
  nm := coalesce(nullif(trim(edited_name),''), nullif(trim(t.pending_sender->>'name'),''));
  em := coalesce(nullif(trim(edited_email),''), nullif(trim(t.pending_sender->>'email'),''));
  ph := coalesce(nullif(trim(edited_phone),''), nullif(trim(t.pending_sender->>'phone'),''));
  IF use_customer_id IS NOT NULL THEN
    SELECT id INTO cust FROM public.customers WHERE id=use_customer_id AND company_id=cid FOR UPDATE;
    IF cust IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
    -- Fill only empty fields on the existing customer.
    UPDATE public.customers SET
      email=CASE WHEN nullif(trim(email),'') IS NULL THEN em ELSE email END,
      phone=CASE WHEN nullif(trim(phone),'') IS NULL THEN ph ELSE phone END
    WHERE id=cust AND company_id=cid;
    UPDATE public.threads SET customer_id=cust, pending_sender=NULL WHERE id=tid AND company_id=cid;
  ELSE
    cust := t.customer_id;
    UPDATE public.customers SET name=coalesce(nm,name), email=em, phone=ph WHERE id=cust AND company_id=cid;
    UPDATE public.threads SET pending_sender=NULL WHERE id=tid AND company_id=cid;
  END IF;
  INSERT INTO public.audit_log(company_id,user_id,event,"before","after")
  VALUES(cid,actor,'Avsändare godkänd',jsonb_build_object('thread_id',tid,'customer_id',t.customer_id),jsonb_build_object('thread_id',tid,'customer_id',cust));
  RETURN jsonb_build_object('id',tid,'customer_id',cust);
END $function$;
REVOKE ALL ON FUNCTION public.estim_approve_email_sender(uuid,text,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estim_approve_email_sender(uuid,text,text,text,uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.estim_merge_email_thread(source_tid uuid, target_tid uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
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
  -- Quotes and call records are not moved; refuse rather than lose them.
  IF EXISTS(SELECT 1 FROM public.quotes WHERE company_id=cid AND thread_id=source_tid)
     OR EXISTS(SELECT 1 FROM public.samtal_calls WHERE thread_id=source_tid) THEN RAISE EXCEPTION 'Has quotes'; END IF;

  UPDATE public.messages SET thread_id=target_tid WHERE company_id=cid AND thread_id=source_tid;
  UPDATE public.company_document_deliveries SET thread_id=target_tid WHERE company_id=cid AND thread_id=source_tid;
  UPDATE public.ai_jobs SET thread_id=target_tid WHERE company_id=cid AND thread_id=source_tid;
  DELETE FROM public.drafts WHERE company_id=cid AND thread_id=source_tid;
  UPDATE public.threads SET suggested_merge_thread_id=NULL WHERE company_id=cid AND suggested_merge_thread_id IN (source_tid,target_tid);
  UPDATE public.threads SET suggested_merge_thread_id=NULL,
    last_message_at=coalesce((SELECT max(sent_at) FROM public.messages WHERE company_id=cid AND thread_id=target_tid), last_message_at)
  WHERE id=target_tid AND company_id=cid;
  DELETE FROM public.threads WHERE id=source_tid AND company_id=cid;
  INSERT INTO public.audit_log(company_id,user_id,event,"after")
  VALUES(cid,actor,'Tråd sammanslagen',jsonb_build_object('thread_id',target_tid,'from_thread_id',source_tid));
  RETURN jsonb_build_object('id',target_tid,'merged_from',source_tid);
END $function$;
REVOKE ALL ON FUNCTION public.estim_merge_email_thread(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estim_merge_email_thread(uuid,uuid) TO authenticated, service_role;