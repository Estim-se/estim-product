CREATE TABLE public.channels(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES public.companies(id),type text NOT NULL,phone_number_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(type,phone_number_id),UNIQUE(company_id,type));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.channels TO authenticated; GRANT ALL ON public.channels TO service_role;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY channels_company ON public.channels FOR ALL TO authenticated USING(company_id=public.my_company()) WITH CHECK(company_id=public.my_company());
CREATE TRIGGER channels_touch BEFORE UPDATE ON public.channels FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
ALTER TABLE public.threads ADD COLUMN last_customer_wa_at timestamptz;
ALTER TABLE public.messages ADD COLUMN delivery_status text NOT NULL DEFAULT 'sent', ADD COLUMN delivery_error text;
CREATE UNIQUE INDEX messages_provider_unique ON public.messages(company_id,channel,provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE public.ai_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES public.companies(id),thread_id uuid NOT NULL REFERENCES public.threads(id),interpret boolean NOT NULL DEFAULT true,state text NOT NULL DEFAULT 'queued',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON public.ai_jobs TO service_role;
ALTER TABLE public.ai_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY jobs_service ON public.ai_jobs FOR ALL TO service_role USING(true) WITH CHECK(true);
CREATE INDEX ai_jobs_thread_idx ON public.ai_jobs(thread_id);
CREATE TRIGGER ai_jobs_touch BEFORE UPDATE ON public.ai_jobs FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE OR REPLACE FUNCTION public.estim_receive(cid uuid,payload jsonb,actor uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE cust uuid; tid uuid; jid uuid; fresh boolean=false; ch text=payload->>'channel'; stamp timestamptz=coalesce((payload->>'sent_at')::timestamptz,now()); pid text=nullif(payload->>'provider_message_id',''); BEGIN
IF current_user NOT IN ('postgres','service_role') AND cid IS DISTINCT FROM public.my_company() THEN RAISE EXCEPTION 'Not allowed'; END IF;
PERFORM 1 FROM public.companies WHERE id=cid AND active FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Inactive company'; END IF;
IF ch NOT IN ('wa','email','sms','form') OR length(trim(coalesce(payload->>'text','')))=0 OR length(payload->>'text')>30000 THEN RAISE EXCEPTION 'Invalid message'; END IF;
IF pid IS NOT NULL AND EXISTS(SELECT 1 FROM public.messages WHERE company_id=cid AND channel=ch AND provider_message_id=pid) THEN RETURN jsonb_build_object('duplicate',true); END IF;
SELECT id INTO cust FROM public.customers WHERE company_id=cid AND ((nullif(payload->>'customer_phone','') IS NOT NULL AND phone=payload->>'customer_phone') OR (nullif(payload->>'customer_email','') IS NOT NULL AND lower(email)=lower(payload->>'customer_email'))) ORDER BY created_at LIMIT 1;
IF cust IS NULL THEN INSERT INTO public.customers(company_id,name,phone,email,address,place) VALUES(cid,coalesce(nullif(payload->>'customer_name',''),'Okänd kund'),nullif(payload->>'customer_phone',''),nullif(payload->>'customer_email',''),payload->>'address',payload->>'place') RETURNING id INTO cust; END IF;
SELECT id INTO tid FROM public.threads WHERE company_id=cid AND customer_id=cust AND channel=ch AND status NOT IN ('vunnen','stangd') ORDER BY created_at DESC LIMIT 1;
IF tid IS NULL THEN fresh=true; INSERT INTO public.threads(company_id,customer_id,job,place,channel,status) VALUES(cid,cust,coalesce(payload->>'job','Ny förfrågan'),payload->>'place',ch,'analys') RETURNING id INTO tid; END IF;
INSERT INTO public.messages(company_id,thread_id,"from",channel,text,provider_message_id,sent_at) VALUES(cid,tid,'kund',ch,payload->>'text',pid,stamp);
UPDATE public.threads SET status='analys',read=false,last_message_at=greatest(last_message_at,stamp),last_customer_wa_at=CASE WHEN ch='wa' THEN greatest(last_customer_wa_at,stamp) ELSE last_customer_wa_at END WHERE id=tid;
INSERT INTO public.drafts(company_id,thread_id,channel,text,needs_review) VALUES(cid,tid,CASE WHEN ch='form' THEN 'email' ELSE ch END,'',true) ON CONFLICT(thread_id) DO UPDATE SET text='',needs_review=true,edited=false;
INSERT INTO public.ai_jobs(company_id,thread_id,interpret) VALUES(cid,tid,fresh) RETURNING id INTO jid;
IF actor IS NOT NULL THEN INSERT INTO public.audit_log(company_id,user_id,event,"after") VALUES(cid,actor,'Förfrågan skapad',jsonb_build_object('thread_id',tid)); END IF;
RETURN jsonb_build_object('id',tid,'job_id',jid,'duplicate',false); END $$;
REVOKE ALL ON FUNCTION public.estim_receive(uuid,jsonb,uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.estim_receive(uuid,jsonb,uuid) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.estim_job_quote(cid uuid,tid uuid,payload jsonb) RETURNS integer LANGUAGE plpgsql SET search_path=public AS $$
DECLARE ver int; number text; old public.quotes; BEGIN
PERFORM 1 FROM public.companies WHERE id=cid AND active FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Inactive company'; END IF;
PERFORM 1 FROM public.threads WHERE id=tid AND company_id=cid; IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
SELECT * INTO old FROM public.quotes WHERE company_id=cid AND thread_id=tid ORDER BY version DESC LIMIT 1;
ver=coalesce(old.version,0)+1; IF old.id IS NOT NULL THEN number=old.nr; ELSE SELECT (coalesce(max(nr::bigint),1000)+1)::text INTO number FROM public.quotes WHERE company_id=cid; END IF;
INSERT INTO public.quotes(company_id,thread_id,nr,version,owners,add_on,prisform,lines) VALUES(cid,tid,number,ver,1,false,'ungefar',payload->'lines');
INSERT INTO public.audit_log(company_id,event,"after") VALUES(cid,CASE WHEN old.id IS NULL THEN 'Offert skapad' ELSE 'Offert ändrad' END,jsonb_build_object('thread_id',tid,'by','ai','version',ver)); RETURN ver; END $$;
REVOKE ALL ON FUNCTION public.estim_job_quote(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.estim_job_quote(uuid,uuid,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.estim_prepare_send(tid uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE cid uuid=public.my_company(); d public.drafts; mid uuid; BEGIN
PERFORM 1 FROM public.threads WHERE id=tid AND company_id=cid FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
SELECT * INTO d FROM public.drafts WHERE thread_id=tid AND company_id=cid FOR UPDATE; IF NOT FOUND OR length(trim(d.text))=0 OR (d.needs_review AND NOT d.edited AND jsonb_array_length(d.warnings)>0) THEN RAISE EXCEPTION 'Draft required'; END IF;
IF EXISTS(SELECT 1 FROM public.messages WHERE thread_id=tid AND delivery_status='sending') THEN RAISE EXCEPTION 'Already sending'; END IF;
INSERT INTO public.messages(company_id,thread_id,"from",channel,text,attachments,approved_by,delivery_status) VALUES(cid,tid,'vv',d.channel,d.text,d.attachments,auth.uid(),'sending') RETURNING id INTO mid;
INSERT INTO public.audit_log(company_id,user_id,event,"after") VALUES(cid,auth.uid(),'Svar godkänt',jsonb_build_object('thread_id',tid,'message_id',mid,'delivered',false)); RETURN mid; END $$;
REVOKE ALL ON FUNCTION public.estim_prepare_send(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.estim_prepare_send(uuid) TO authenticated,service_role;