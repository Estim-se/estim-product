-- Automatic handoff for clearly new customers/assignments ('new' match state); every duplicate check is unchanged.
CREATE OR REPLACE FUNCTION public.samtal_a10_handoff(p_call uuid, p_company uuid, p_version integer, p_request uuid, p_customer uuid, p_assignment uuid, p_create boolean, p_identity jsonb, p_title text, p_actor uuid DEFAULT NULL::uuid, p_job uuid DEFAULT NULL::uuid, p_token uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c samtal_calls; m samtal_a9_matches; r samtal_a10_handoffs; cust uuid; tid uuid; mid uuid;
 n text; a text; ph text; candidates uuid[]; body text; deadline timestamptz;
BEGIN
 c:=samtal_safety_lock(p_call,p_company);
 IF c.id IS NULL OR c.classification<>'jobb' OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp()
 OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 PERFORM 1 FROM companies WHERE id=p_company AND active FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF p_actor IS NULL THEN
  IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN jsonb_build_object('status','stopped'); END IF;
  deadline:=least(c.delete_after,(SELECT lease_until FROM samtal_jobs WHERE id=p_job));
 ELSE
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company AND user_id=p_actor AND(role='ägare' OR c.user_id=p_actor)) THEN RETURN jsonb_build_object('status','not_found'); END IF;
  deadline:=c.delete_after;
 END IF;
 SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call FOR UPDATE;
 IF m.call_id IS NULL OR m.state='deleted' OR p_request IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT * INTO r FROM samtal_a10_handoffs WHERE company_id=p_company AND call_id=p_call;
 IF FOUND THEN
  IF p_customer IS NOT NULL AND p_customer IS DISTINCT FROM r.customer_id OR p_assignment IS NOT NULL AND p_assignment IS DISTINCT FROM r.thread_id THEN RETURN jsonb_build_object('status','conflict'); END IF;
  RETURN jsonb_build_object('status','ok','repeat',true,'customer_id',r.customer_id,'thread_id',r.thread_id,'message_id',r.message_id);
 END IF;
 IF m.version<>p_version THEN RETURN jsonb_build_object('status','stale'); END IF;
 IF p_title IS NULL OR length(trim(p_title))=0 OR length(p_title)>200 OR octet_length(coalesce(p_identity::text,''))>2000 THEN RETURN jsonb_build_object('status','invalid_input'); END IF;
 IF p_actor IS NULL AND NOT (m.state='new' AND p_create AND p_customer IS NOT DISTINCT FROM m.customer_id AND p_assignment IS NULL) AND (p_create OR m.state<>'resolved' OR p_customer IS DISTINCT FROM m.customer_id OR p_assignment IS DISTINCT FROM m.assignment_id) THEN RETURN jsonb_build_object('status','review_required'); END IF;
 IF p_create THEN
  IF p_actor IS NULL AND m.state<>'new' THEN RETURN jsonb_build_object('status','review_required'); END IF;
  cust:=p_customer;
  IF cust IS NULL THEN
   n:=nullif(trim(p_identity->>'name'),''); a:=nullif(trim(p_identity->>'address'),''); ph:=samtal_a9_phone(p_identity->>'phone');
   IF n IS NULL OR a IS NULL OR length(n)>200 OR length(a)>200 THEN RETURN jsonb_build_object('status','identity_required'); END IF;
   SELECT coalesce(array_agg(id),'{}') INTO candidates FROM customers WHERE company_id=p_company AND
    (samtal_a9_text(name)=samtal_a9_text(n) AND samtal_a9_text(address)=samtal_a9_text(a) OR ph IS NOT NULL AND samtal_a9_phone(phone)=ph);
   IF cardinality(candidates)>1 THEN RETURN jsonb_build_object('status','customer_ambiguous'); END IF;
   IF cardinality(candidates)=1 THEN
    SELECT id INTO cust FROM customers WHERE id=candidates[1] AND company_id=p_company AND samtal_a9_text(name)=samtal_a9_text(n) AND samtal_a9_text(address)=samtal_a9_text(a);
    IF cust IS NULL THEN RETURN jsonb_build_object('status','customer_conflict'); END IF;
   ELSE
    INSERT INTO customers(company_id,name,address,phone) VALUES(p_company,n,a,ph) RETURNING id INTO cust;
   END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM customers WHERE id=cust AND company_id=p_company) THEN RAISE EXCEPTION 'invalid_customer'; END IF;
  SELECT coalesce(array_agg(id),'{}') INTO candidates FROM threads WHERE company_id=p_company AND customer_id=cust AND status NOT IN('stangd','vunnen')
   AND samtal_a9_text(job)=samtal_a9_text(p_title) AND samtal_a9_text(place)=samtal_a9_text(coalesce(p_identity->>'address',(SELECT address FROM customers WHERE id=cust AND company_id=p_company)));
  IF cardinality(candidates)>1 THEN RAISE EXCEPTION 'assignment_ambiguous'; END IF;
  tid:=candidates[1];
  IF tid IS NULL THEN INSERT INTO threads(company_id,customer_id,job,place,channel,status) VALUES(p_company,cust,p_title,coalesce(p_identity->>'address',(SELECT address FROM customers WHERE id=cust AND company_id=p_company)),'samtal','svar') RETURNING id INTO tid; END IF;
 ELSE
  cust:=p_customer; tid:=p_assignment;
  IF cust IS NULL OR tid IS NULL OR NOT(cust=ANY(m.customer_candidates) OR cust=m.customer_id) OR NOT(tid=ANY(m.assignment_candidates) OR tid=m.assignment_id) THEN RETURN jsonb_build_object('status','invalid_choice'); END IF;
 END IF;
 PERFORM 1 FROM threads WHERE id=tid AND company_id=p_company AND customer_id=cust AND status<>'stangd' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid_assignment'; END IF;
 body:=coalesce(nullif(c.extraction#>>'{interpretation,fields,description,value}',''),nullif(c.extraction#>>'{voice_note,work,0}',''),p_title);
 INSERT INTO messages(company_id,thread_id,"from",channel,text,provider_message_id,sent_at)
 VALUES(p_company,tid,'kund','samtal',body,'samtal-a10:'||p_call::text,c.started_at) RETURNING id INTO mid;
 UPDATE threads SET read=false,last_message_at=greatest(last_message_at,c.started_at) WHERE id=tid AND company_id=p_company;
 INSERT INTO samtal_a10_handoffs(company_id,call_id,customer_id,thread_id,message_id,request_id) VALUES(p_company,p_call,cust,tid,mid,p_request);
 UPDATE samtal_a9_matches SET customer_id=cust,assignment_id=tid,quote_id=CASE WHEN p_actor IS NULL THEN quote_id ELSE NULL END,
 intent=CASE WHEN p_create THEN 'new_assignment' WHEN p_actor IS NOT NULL AND assignment_id IS DISTINCT FROM tid THEN 'ambiguous' ELSE intent END,
 quote_requested=quote_requested OR coalesce((c.extraction#>>'{voice_note,quote,needed}')::boolean,false) OR coalesce((c.extraction#>>'{interpretation,quote_ready}')::boolean,false),state='resolved',version=version+1 WHERE company_id=p_company AND call_id=p_call;
 UPDATE samtal_calls SET customer_id=cust,thread_id=tid WHERE id=p_call AND company_id=p_company;
 IF p_actor IS NOT NULL THEN UPDATE samtal_jobs SET state='done',step='klar',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE call_id=p_call AND company_id=p_company AND state='paused'; END IF;
 IF p_job IS NOT NULL THEN UPDATE samtal_jobs SET state='done',step='klar',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=p_job AND company_id=p_company; END IF;
 PERFORM samtal_v2_deadline(deadline);
 RETURN jsonb_build_object('status','ok','customer_id',cust,'thread_id',tid,'message_id',mid);
END $function$;