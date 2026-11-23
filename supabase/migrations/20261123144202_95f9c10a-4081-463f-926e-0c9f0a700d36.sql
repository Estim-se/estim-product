CREATE OR REPLACE FUNCTION public.estim_receive(cid uuid, payload jsonb, actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE cust uuid; tid uuid; jid uuid; fresh boolean=false; ch text=payload->>'channel'; stamp timestamptz=coalesce((payload->>'sent_at')::timestamptz,now()); pid text=nullif(payload->>'provider_message_id',''); BEGIN
IF current_user NOT IN ('postgres','service_role') AND cid IS DISTINCT FROM public.my_company() THEN RAISE EXCEPTION 'Not allowed'; END IF;
PERFORM 1 FROM public.companies WHERE id=cid AND active FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Inactive company'; END IF;
IF ch NOT IN ('wa','email','sms','form') OR length(trim(coalesce(payload->>'text','')))=0 OR length(payload->>'text')>30000 THEN RAISE EXCEPTION 'Invalid message'; END IF;
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
INSERT INTO public.drafts(company_id,thread_id,channel,text,needs_review) VALUES(cid,tid,CASE WHEN ch='form' THEN 'email' ELSE ch END,'',true) ON CONFLICT(thread_id) DO UPDATE SET text='',needs_review=true,edited=false;
INSERT INTO public.ai_jobs(company_id,thread_id,interpret) VALUES(cid,tid,fresh) RETURNING id INTO jid;
IF actor IS NOT NULL THEN INSERT INTO public.audit_log(company_id,user_id,event,"after") VALUES(cid,actor,'Förfrågan skapad',jsonb_build_object('thread_id',tid)); END IF;
RETURN jsonb_build_object('id',tid,'job_id',jid,'duplicate',false); END $function$;

-- CREATE OR REPLACE preserves the existing service_role-only execution ACL.
-- Connected components prevent a blank-contact bridge from partially merging
-- a group containing conflicting nonempty contact details.
DO $cleanup$
DECLARE
 grp record; duplicate_customer public.customers; keeper uuid; audit_user uuid:=auth.uid(); audit_user_required boolean;
BEGIN
 LOCK TABLE public.customers,public.threads IN SHARE ROW EXCLUSIVE MODE;
 SELECT is_nullable='NO' INTO audit_user_required FROM information_schema.columns
 WHERE table_schema='public' AND table_name='audit_log' AND column_name='user_id';
 FOR grp IN
  WITH RECURSIVE edges AS (
   SELECT a.id AS a,b.id AS b FROM public.customers a JOIN public.customers b
    ON a.company_id=b.company_id AND (a.id=b.id
     OR (public.estim_norm_phone(a.phone) IS NOT NULL AND public.estim_norm_phone(a.phone)=public.estim_norm_phone(b.phone))
     OR (nullif(trim(a.email),'') IS NOT NULL AND lower(a.email)=lower(b.email)))
  ), reach(origin,node) AS (
   SELECT a,b FROM edges UNION SELECT r.origin,e.b FROM reach r JOIN edges e ON e.a=r.node
  ), membership AS (
   SELECT node,min(origin::text) AS component FROM reach GROUP BY node
  )
  SELECT c.company_id,array_agg(c.id ORDER BY c.created_at,c.id) AS ids
  FROM membership m JOIN public.customers c ON c.id=m.node GROUP BY c.company_id,m.component
  HAVING count(*)>1
   AND count(DISTINCT coalesce(public.estim_norm_phone(c.phone),nullif(trim(c.phone),'')))<=1
   AND count(DISTINCT CASE WHEN nullif(trim(c.email),'') IS NOT NULL THEN lower(c.email) END)<=1
 LOOP
  keeper:=grp.ids[1];
  FOR duplicate_customer IN SELECT * FROM public.customers
   WHERE company_id=grp.company_id AND id=ANY(grp.ids) AND id<>keeper ORDER BY created_at,id
  LOOP
   UPDATE public.threads SET customer_id=keeper WHERE company_id=grp.company_id AND customer_id=duplicate_customer.id;
   UPDATE public.customers SET
    phone=CASE WHEN nullif(trim(phone),'') IS NULL THEN duplicate_customer.phone ELSE phone END,
    email=CASE WHEN nullif(trim(email),'') IS NULL THEN duplicate_customer.email ELSE email END,
    name=CASE WHEN nullif(trim(name),'') IS NULL THEN duplicate_customer.name ELSE name END,
    address=CASE WHEN nullif(trim(address),'') IS NULL THEN duplicate_customer.address ELSE address END,
    place=CASE WHEN nullif(trim(place),'') IS NULL THEN duplicate_customer.place ELSE place END
   WHERE company_id=grp.company_id AND id=keeper;
   DELETE FROM public.customers WHERE company_id=grp.company_id AND id=duplicate_customer.id;
   IF audit_user IS NOT NULL OR NOT coalesce(audit_user_required,false) THEN
    INSERT INTO public.audit_log(company_id,user_id,event,"after")
    VALUES(grp.company_id,audit_user,'Kunder sammanslagna',jsonb_build_object('customer_id',keeper,'merged_customer_id',duplicate_customer.id));
   END IF;
  END LOOP;
 END LOOP;
END $cleanup$;