-- estim Samtal: the inbox accepts the channel 'samtal' (approved by the product owner).
-- The only changes to existing objects, each the smallest possible:
--   1. threads: the channel check also allows 'samtal'.
--   2. estim_receive: 'samtal' is an accepted channel, and its reply draft is an SMS (sent only after approval,
--      like every SMS draft). Copied verbatim from migration 20261123144202 with exactly these two edits.
--   3. estim_split_thread: a split-off call thread also gets an SMS draft. Copied verbatim from migration
--      20261123143501 with exactly this one edit.
-- CREATE OR REPLACE keeps the existing grants of both functions. WhatsApp, e-mail, SMS and form behave as before.

DO $do$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'public.threads'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%channel%';
  IF c IS NULL THEN RAISE EXCEPTION 'threads channel check not found'; END IF;
  EXECUTE format('ALTER TABLE public.threads DROP CONSTRAINT %I', c);
END $do$;
ALTER TABLE public.threads ADD CONSTRAINT threads_channel_check CHECK (channel IN ('email','sms','wa','form','samtal'));

CREATE OR REPLACE FUNCTION public.estim_receive(cid uuid, payload jsonb, actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE cust uuid; tid uuid; jid uuid; fresh boolean=false; ch text=payload->>'channel'; stamp timestamptz=coalesce((payload->>'sent_at')::timestamptz,now()); pid text=nullif(payload->>'provider_message_id',''); BEGIN
IF current_user NOT IN ('postgres','service_role') AND cid IS DISTINCT FROM public.my_company() THEN RAISE EXCEPTION 'Not allowed'; END IF;
PERFORM 1 FROM public.companies WHERE id=cid AND active FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Inactive company'; END IF;
IF ch NOT IN ('wa','email','sms','form','samtal') OR length(trim(coalesce(payload->>'text','')))=0 OR length(payload->>'text')>30000 THEN RAISE EXCEPTION 'Invalid message'; END IF;
IF pid IS NOT NULL AND EXISTS(SELECT 1 FROM public.messages WHERE company_id=cid AND channel=ch AND provider_message_id=pid) THEN RETURN jsonb_build_object('duplicate',true); END IF;
SELECT id INTO cust FROM public.customers WHERE company_id=cid AND (((payload->>'customer_phone') IS NOT NULL AND public.estim_norm_phone(phone)=public.estim_norm_phone(payload->>'customer_phone')) OR (nullif(trim(payload->>'customer_email'),'') IS NOT NULL AND lower(email)=lower(payload->>'customer_email'))) ORDER BY created_at LIMIT 1;
IF cust IS NULL THEN INSERT INTO public.customers(company_id,name,phone,email,address,place) VALUES(cid,coalesce(nullif(payload->>'customer_name',''),'Okänd kund'),nullif(payload->>'customer_phone',''),nullif(payload->>'customer_email',''),payload->>'address',payload->>'place') RETURNING id INTO cust;
ELSE
UPDATE public.customers c SET
 phone=CASE WHEN nullif(trim(c.phone),'') IS NULL AND nullif(trim(payload->>'customer_phone'),'') IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.customers other WHERE other.company_id=cid AND other.id<>cust AND public.estim_norm_phone(other.phone)=public.estim_norm_phone(payload->>'customer_phone'))
   THEN payload->>'customer_phone' ELSE c.phone END,
 email=CASE WHEN nullif(trim(c.email),'') IS NULL AND nullif(trim(payload->>'customer_email'),'') IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.customers other WHERE other.company_id=cid AND other.id<>cust AND lower(other.email)=lower(payload->>'customer_email'))
   THEN payload->>'customer_email' ELSE c.email END
WHERE c.id=cust AND c.company_id=cid AND (
 (nullif(trim(c.phone),'') IS NULL AND nullif(trim(payload->>'customer_phone'),'') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers other WHERE other.company_id=cid AND other.id<>cust AND public.estim_norm_phone(other.phone)=public.estim_norm_phone(payload->>'customer_phone')))
 OR (nullif(trim(c.email),'') IS NULL AND nullif(trim(payload->>'customer_email'),'') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers other WHERE other.company_id=cid AND other.id<>cust AND lower(other.email)=lower(payload->>'customer_email'))));
END IF;
IF actor IS NULL THEN
SELECT id INTO tid FROM public.threads WHERE company_id=cid AND customer_id=cust AND channel=ch AND status NOT IN ('vunnen','stangd') ORDER BY created_at DESC LIMIT 1;
ELSIF NOT coalesce((payload->>'new_thread')::boolean,false) THEN
SELECT id INTO tid FROM public.threads WHERE company_id=cid AND customer_id=cust AND channel=ch AND status NOT IN ('vunnen','stangd') ORDER BY created_at DESC LIMIT 1;
END IF;
IF tid IS NULL THEN fresh=true; INSERT INTO public.threads(company_id,customer_id,job,place,channel,status) VALUES(cid,cust,coalesce(payload->>'job','Ny förfrågan'),payload->>'place',ch,'analys') RETURNING id INTO tid; END IF;
INSERT INTO public.messages(company_id,thread_id,"from",channel,text,provider_message_id,sent_at) VALUES(cid,tid,'kund',ch,payload->>'text',pid,stamp);
UPDATE public.threads SET status='analys',read=false,last_message_at=greatest(last_message_at,stamp),last_customer_wa_at=CASE WHEN ch='wa' THEN greatest(last_customer_wa_at,stamp) ELSE last_customer_wa_at END WHERE id=tid;
INSERT INTO public.drafts(company_id,thread_id,channel,text,needs_review) VALUES(cid,tid,CASE WHEN ch='form' THEN 'email' WHEN ch='samtal' THEN 'sms' ELSE ch END,'',true) ON CONFLICT(thread_id) DO UPDATE SET text='',needs_review=true,edited=false;
INSERT INTO public.ai_jobs(company_id,thread_id,interpret) VALUES(cid,tid,fresh) RETURNING id INTO jid;
IF actor IS NOT NULL THEN INSERT INTO public.audit_log(company_id,user_id,event,"after") VALUES(cid,actor,'Förfrågan skapad',jsonb_build_object('thread_id',tid)); END IF;
RETURN jsonb_build_object('id',tid,'job_id',jid,'duplicate',false); END $function$;

CREATE OR REPLACE FUNCTION public.estim_split_thread(tid uuid, mid uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  cid uuid := public.my_company();
  actor uuid := auth.uid();
  t public.threads;
  m public.messages;
  new_tid uuid;
  new_jid uuid;
  moved_ids uuid[];
  latest_customer uuid;
  latest_from text;
  new_status text;
BEGIN
  IF cid IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO t FROM public.threads
  WHERE id = tid AND company_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF (t.status = 'analys' AND t.updated_at > now() - interval '90 seconds')
    OR EXISTS (SELECT 1 FROM public.ai_jobs j WHERE j.thread_id = tid AND j.company_id = cid AND j.state IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'AI busy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.messages x WHERE x.thread_id = tid AND x.company_id = cid AND x.delivery_status = 'sending') THEN
    RAISE EXCEPTION 'Busy';
  END IF;
  SELECT * INTO m FROM public.messages
  WHERE id = mid AND thread_id = tid AND company_id = cid AND "from" = 'kund';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.messages x WHERE x.thread_id = tid AND x.company_id = cid
    AND (x.sent_at, x.created_at, x.id) < (m.sent_at, m.created_at, m.id)
  ) THEN RAISE EXCEPTION 'Nothing to split'; END IF;

  INSERT INTO public.threads(company_id, customer_id, place, channel, autopilot, whatsapp_auto_override, job, status, read)
  VALUES (cid, t.customer_id, t.place, t.channel, t.autopilot, t.whatsapp_auto_override, 'Nytt ärende', 'analys', false)
  RETURNING id INTO new_tid;

  SELECT array_agg(x.id) INTO moved_ids FROM public.messages x
  WHERE x.thread_id = tid AND x.company_id = cid
    AND (x.sent_at, x.created_at, x.id) >= (m.sent_at, m.created_at, m.id);
  UPDATE public.messages SET thread_id = new_tid
  WHERE company_id = cid AND thread_id = tid AND id = ANY(moved_ids);

  -- Reviewed all public thread references: deliveries and completed jobs follow their messages;
  -- quotes stay on the source thread, and drafts are reset separately.
  UPDATE public.company_document_deliveries SET thread_id = new_tid
  WHERE company_id = cid AND thread_id = tid AND message_id = ANY(moved_ids);
  UPDATE public.ai_jobs SET thread_id = new_tid
  WHERE company_id = cid AND thread_id = tid AND incoming_message_id = ANY(moved_ids);

  UPDATE public.threads SET
    last_message_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = new_tid),
    last_customer_wa_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = new_tid AND x."from" = 'kund' AND x.channel = 'wa')
  WHERE id = new_tid AND company_id = cid;
  INSERT INTO public.drafts(company_id, thread_id, channel, text, needs_review)
  VALUES (cid, new_tid, CASE WHEN t.channel = 'form' THEN 'email' WHEN t.channel = 'samtal' THEN 'sms' ELSE t.channel END, '', true);
  SELECT x.id INTO latest_customer FROM public.messages x
  WHERE x.company_id = cid AND x.thread_id = new_tid AND x."from" = 'kund'
  ORDER BY x.sent_at DESC, x.created_at DESC, x.id DESC LIMIT 1;
  INSERT INTO public.ai_jobs(company_id, thread_id, interpret, incoming_message_id)
  VALUES (cid, new_tid, true, latest_customer) RETURNING id INTO new_jid;
  -- The existing insert trigger orders by creation time; restore the requested sent-time ordering
  -- on this newly created job without changing that trigger or its function.
  UPDATE public.ai_jobs SET incoming_message_id = latest_customer WHERE id = new_jid AND company_id = cid;

  SELECT x."from" INTO latest_from FROM public.messages x
  WHERE x.company_id = cid AND x.thread_id = tid
  ORDER BY x.sent_at DESC, x.created_at DESC, x.id DESC LIMIT 1;
  new_status := CASE WHEN t.status = 'vunnen' THEN 'vunnen' WHEN latest_from = 'kund' THEN 'svar' ELSE 'skickad' END;
  UPDATE public.threads SET
    last_message_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = tid),
    last_customer_wa_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = tid AND x."from" = 'kund' AND x.channel = 'wa'),
    status = new_status
  WHERE id = tid AND company_id = cid;
  UPDATE public.drafts SET text = '', edited = false, warnings = '[]'::jsonb, needs_review = true
  WHERE company_id = cid AND thread_id = tid;

  INSERT INTO public.audit_log(company_id, user_id, event, "after") VALUES
    (cid, actor, 'Meddelanden flyttade till nytt ärende', jsonb_build_object('thread_id', tid, 'new_thread_id', new_tid)),
    (cid, actor, 'Utbrutet från tidigare ärende', jsonb_build_object('thread_id', new_tid, 'from_thread_id', tid));
  RETURN jsonb_build_object('id', new_tid, 'job_id', new_jid);
END;
$function$;
