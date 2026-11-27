-- estim Samtal staged migration 8/13 from docs/samtal/a9-matching.sql (approved for Bygg Demo AB test, 2026-11-27).
-- A9 DOCUMENTATION-ONLY proposal. Apply ONLY to disposable synthetic databases for validation.
-- Prerequisites: coordinated V2 and A1–A8 SQL; a9-lookup-indexes.sql (separate shared-index approval).
-- New Samtal tables/functions only. No replacement of estim_receive or the existing quote engine.
CREATE FUNCTION public.samtal_a9_text(v text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT trim(regexp_replace(lower(coalesce(v,'')), '[^[:alnum:]]+', ' ', 'g'));
$$;
CREATE FUNCTION public.samtal_a9_phone(v text) RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE d text;
BEGIN
 IF v IS NULL OR trim(v) !~ '^[+0-9[:space:]().-]+$' THEN RETURN NULL; END IF;
 d:=regexp_replace(v,'[^0-9]','','g');
 IF left(trim(v),1)='+' THEN NULL;
 ELSIF left(d,2)='00' THEN d:=substr(d,3);
 ELSIF left(d,1)='0' THEN d:='46'||substr(d,2);
 ELSIF left(d,2)<>'46' THEN RETURN NULL; END IF;
 RETURN CASE WHEN d ~ '^[1-9][0-9]{6,14}$' THEN '+'||d ELSE NULL END;
END $$;
CREATE TABLE public.samtal_a9_matches (
 company_id uuid NOT NULL REFERENCES public.companies(id), call_id uuid NOT NULL,
 customer_candidates uuid[] NOT NULL DEFAULT '{}', assignment_candidates uuid[] NOT NULL DEFAULT '{}',
 customer_truncated boolean NOT NULL DEFAULT false, assignment_truncated boolean NOT NULL DEFAULT false,
 customer_id uuid, assignment_id uuid, quote_id uuid, intent text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','resolved','new','general','deleted')),
 quote_requested boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, request_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,call_id), FOREIGN KEY(company_id,call_id) REFERENCES public.samtal_calls(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id) ON DELETE SET NULL (customer_id),
 FOREIGN KEY(company_id,assignment_id) REFERENCES public.threads(company_id,id) ON DELETE SET NULL (assignment_id)
);
GRANT SELECT ON public.samtal_a9_matches TO authenticated;
GRANT ALL ON public.samtal_a9_matches TO service_role;
ALTER TABLE public.samtal_a9_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY samtal_a9_read ON public.samtal_a9_matches FOR SELECT TO authenticated USING (
 state<>'deleted' AND company_id=public.my_company() AND EXISTS(SELECT 1 FROM public.samtal_calls c JOIN public.company_members m ON m.company_id=c.company_id
 WHERE c.id=call_id AND c.company_id=samtal_a9_matches.company_id AND c.content_deleted_at IS NULL AND c.delete_after>now() AND m.user_id=auth.uid() AND(c.user_id=auth.uid() OR m.role='ägare')));
CREATE TRIGGER samtal_a9_touch BEFORE UPDATE ON public.samtal_a9_matches FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE TABLE public.samtal_a9_quote_receipts (
 company_id uuid NOT NULL, call_id uuid NOT NULL, match_version integer NOT NULL, quote_id uuid NOT NULL,
 quote_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,call_id), FOREIGN KEY(company_id,call_id) REFERENCES public.samtal_calls(company_id,id) ON DELETE CASCADE
);
GRANT SELECT ON public.samtal_a9_quote_receipts TO authenticated;
GRANT ALL ON public.samtal_a9_quote_receipts TO service_role;
ALTER TABLE public.samtal_a9_quote_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY samtal_a9_receipt_read ON public.samtal_a9_quote_receipts FOR SELECT TO authenticated USING (
 company_id=public.my_company() AND EXISTS(SELECT 1 FROM public.samtal_a9_matches m WHERE m.company_id=samtal_a9_quote_receipts.company_id AND m.call_id=samtal_a9_quote_receipts.call_id));
CREATE TRIGGER samtal_a9_receipt_touch BEFORE UPDATE ON public.samtal_a9_quote_receipts FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

-- Worker read/write functions are service-only and bound to persisted company/call/job/lease identity.
CREATE FUNCTION public.samtal_a9_candidates(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_name text,p_phone text,p_address text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls; result jsonb; ids uuid[]; v_phone text; spoken text; n text; a text; overflow boolean;
BEGIN
 IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN jsonb_build_object('status','stopped'); END IF;
 SELECT * INTO c FROM samtal_calls WHERE id=p_call AND company_id=p_company;
 IF length(coalesce(p_name,''))>200 OR length(coalesce(p_address,''))>200 OR length(coalesce(p_phone,''))>100 THEN RAISE EXCEPTION 'invalid_matching_input'; END IF;
 -- Ring caller is an employee. The only phone considered is the spoken end-customer phone validated upstream.
 v_phone:=CASE WHEN c.kind='telefonsamtal' THEN samtal_a9_phone(c.caller_phone) ELSE NULL END;
 spoken:=samtal_a9_phone(p_phone); n:=samtal_a9_text(p_name); a:=samtal_a9_text(p_address);
 WITH hit AS (
  (SELECT x.id,x.company_id,x.name,x.phone,x.address FROM customers x WHERE x.company_id=p_company AND x.phone IS NOT NULL AND (samtal_a9_phone(x.phone)=v_phone OR samtal_a9_phone(x.phone)=spoken) ORDER BY x.id LIMIT 21)
  UNION
  (SELECT id,company_id,name,phone,address FROM customers WHERE company_id=p_company AND n<>'' AND samtal_a9_text(name)=n ORDER BY id LIMIT 21)
  UNION
  (SELECT id,company_id,name,phone,address FROM customers WHERE company_id=p_company AND a<>'' AND samtal_a9_text(address)=a ORDER BY id LIMIT 21)
 ), limited AS (SELECT * FROM hit ORDER BY id LIMIT 21)
 SELECT coalesce(jsonb_agg(to_jsonb(limited)),'[]'),coalesce(array_agg(id),'{}'),count(*)>20 INTO result,ids,overflow FROM limited;
 INSERT INTO samtal_a9_matches(company_id,call_id,customer_candidates,customer_truncated) VALUES(p_company,p_call,ids,overflow)
 ON CONFLICT(company_id,call_id) DO UPDATE SET customer_candidates=excluded.customer_candidates,customer_truncated=excluded.customer_truncated
 WHERE samtal_a9_matches.state='pending';
 PERFORM samtal_v2_deadline(least(c.delete_after,(SELECT lease_until FROM samtal_jobs WHERE id=p_job)));
 RETURN jsonb_build_object('status','ok','customers',CASE WHEN overflow THEN (SELECT coalesce(jsonb_agg(v),'[]') FROM jsonb_array_elements(result) WITH ORDINALITY t(v,i) WHERE i<=20) ELSE result END,'customer_truncated',overflow);
END $$;

CREATE FUNCTION public.samtal_a9_assignments(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb; ids uuid[]; overflow boolean; c samtal_calls;
BEGIN
 IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) OR NOT EXISTS(SELECT 1 FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call AND p_customer=ANY(customer_candidates))
 OR NOT EXISTS(SELECT 1 FROM customers WHERE id=p_customer AND company_id=p_company) THEN RETURN jsonb_build_object('status','stopped'); END IF;
 SELECT * INTO c FROM samtal_calls WHERE id=p_call;
 WITH limited AS (SELECT t.* FROM threads t WHERE t.company_id=p_company AND t.customer_id=p_customer ORDER BY t.last_message_at DESC,t.id LIMIT 21),
 expanded AS (SELECT t.id,t.company_id,t.customer_id,t.job,t.status,t.channel,
  coalesce(nullif(t.interpretation#>>'{address}',''),nullif(t.place,''),cu.address) AS address,
  coalesce((SELECT jsonb_agg(q) FROM (SELECT q.id,q.nr,q.version,q.lines FROM quotes q WHERE q.company_id=p_company AND q.thread_id=t.id ORDER BY q.version DESC LIMIT 3) q),'[]') AS quotes,
  coalesce((SELECT jsonb_agg(h) FROM (SELECT m.id,m.channel,left(m.text,1000) AS text FROM messages m WHERE m.company_id=p_company AND m.thread_id=t.id ORDER BY m.sent_at DESC,m.id DESC LIMIT 5) h),'[]') AS history
  FROM limited t JOIN customers cu ON cu.id=t.customer_id AND cu.company_id=t.company_id)
 SELECT coalesce(jsonb_agg(to_jsonb(expanded)),'[]'),coalesce(array_agg(id),'{}'),count(*)>20 INTO result,ids,overflow FROM expanded;
 UPDATE samtal_a9_matches SET assignment_candidates=ids,assignment_truncated=overflow WHERE company_id=p_company AND call_id=p_call AND state='pending';
 PERFORM samtal_v2_deadline(least(c.delete_after,(SELECT lease_until FROM samtal_jobs WHERE id=p_job)));
 RETURN jsonb_build_object('status','ok','assignments',CASE WHEN overflow THEN (SELECT coalesce(jsonb_agg(v),'[]') FROM jsonb_array_elements(result) WITH ORDINALITY t(v,i) WHERE i<=20) ELSE result END,'truncated',overflow);
END $$;

CREATE FUNCTION public.samtal_a9_save(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_customer jsonb,p_assignment jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE m samtal_a9_matches; customer uuid; assignment uuid; quote uuid; result_state text; c samtal_calls; deadline timestamptz;
BEGIN
 IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN jsonb_build_object('status','stopped'); END IF;
 SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call FOR UPDATE;
 SELECT * INTO c FROM samtal_calls WHERE company_id=p_company AND id=p_call;
 SELECT least(c.delete_after,lease_until) INTO deadline FROM samtal_jobs WHERE id=p_job;
 IF m.call_id IS NULL THEN RETURN jsonb_build_object('status','stopped'); END IF;
 IF m.state<>'pending' THEN RETURN jsonb_build_object('status','repeat','state',m.state); END IF;
 IF octet_length(coalesce(p_customer::text,''))>8000 OR octet_length(coalesce(p_assignment::text,''))>8000 THEN RAISE EXCEPTION 'invalid_matching_input'; END IF;
 customer:=nullif(p_customer->>'customer_id','')::uuid; assignment:=nullif(p_assignment->>'assignment_id','')::uuid; quote:=nullif(p_assignment->>'quote_id','')::uuid;
 IF customer IS NOT NULL AND (NOT customer=ANY(m.customer_candidates) OR NOT EXISTS(SELECT 1 FROM customers WHERE company_id=p_company AND id=customer)) THEN RETURN jsonb_build_object('status','invalid_customer'); END IF;
 IF assignment IS NOT NULL AND (NOT assignment=ANY(m.assignment_candidates) OR NOT EXISTS(SELECT 1 FROM threads WHERE company_id=p_company AND customer_id=customer AND id=assignment AND status<>'stangd')) THEN RETURN jsonb_build_object('status','invalid_assignment'); END IF;
 IF quote IS NOT NULL AND NOT EXISTS(SELECT 1 FROM quotes WHERE company_id=p_company AND thread_id=assignment AND id=quote AND version=(SELECT max(version) FROM quotes WHERE company_id=p_company AND thread_id=assignment)) THEN RETURN jsonb_build_object('status','invalid_quote'); END IF;
 IF customer IS NULL OR m.customer_truncated OR m.assignment_truncated OR p_assignment->>'state'='ambiguous' THEN result_state:='pending';
 ELSIF assignment IS NOT NULL AND p_assignment->>'state'='linked' THEN result_state:='resolved';
 ELSIF p_assignment->>'state' IN('new','general') THEN result_state:=p_assignment->>'state'; ELSE result_state:='pending'; END IF;
 UPDATE samtal_a9_matches SET customer_id=customer,assignment_id=CASE WHEN result_state='resolved' THEN assignment END,intent=p_assignment->>'intent',
 state=result_state,quote_id=CASE WHEN result_state='resolved' THEN quote END,quote_requested=coalesce((p_assignment->>'quoteRequested')::boolean,false),version=version+1 WHERE company_id=p_company AND call_id=p_call;
 -- Authoritative IDs stay on Samtal rows. No phone round-trip through estim_receive and no shared side effect.
 UPDATE samtal_calls SET customer_id=customer,thread_id=CASE WHEN result_state='resolved' THEN assignment END WHERE company_id=p_company AND id=p_call;
 IF result_state='pending' THEN UPDATE samtal_jobs SET state='paused',lease_token=NULL,lease_until=NULL,error_code='matching_needs_review' WHERE id=p_job; END IF;
 PERFORM samtal_v2_deadline(deadline);
 RETURN jsonb_build_object('status',result_state,'version',m.version+1);
END $$;

-- Service-only actor supplied by authenticated wrapper; DB rechecks employee/call access. Atomic CAS plus replay key.
CREATE FUNCTION public.samtal_a9_confirm(p_call uuid,p_company uuid,p_actor uuid,p_expected_version integer,p_request uuid,p_customer uuid,p_assignment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls; m samtal_a9_matches;
BEGIN
 c:=samtal_safety_lock(p_call,p_company);
 IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() OR c.classification='privat'
 OR(c.classification='osaker' AND NOT EXISTS(SELECT 1 FROM samtal_reviews WHERE call_id=p_call AND decision='business'))
 OR NOT EXISTS(SELECT 1 FROM companies WHERE id=p_company AND active)
 OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company AND user_id=p_actor AND(role='ägare' OR c.user_id=p_actor)) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call FOR UPDATE;
 IF m.call_id IS NULL OR m.state='deleted' OR p_request IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
 IF m.request_id=p_request THEN
  IF m.customer_id IS DISTINCT FROM p_customer OR m.assignment_id IS DISTINCT FROM p_assignment THEN RETURN jsonb_build_object('status','conflict'); END IF;
  RETURN jsonb_build_object('status','ok','repeat',true,'version',m.version);
 END IF;
 IF m.state<>'pending' OR m.version<>p_expected_version THEN RETURN jsonb_build_object('status','stale'); END IF;
 IF p_customer IS NULL OR NOT p_customer=ANY(m.customer_candidates) OR NOT EXISTS(SELECT 1 FROM customers WHERE company_id=p_company AND id=p_customer) THEN RETURN jsonb_build_object('status','invalid_customer'); END IF;
 -- For ambiguous customers, assignments can be chosen only after loading that customer's authorized candidate set.
 IF p_assignment IS NOT NULL AND (NOT p_assignment=ANY(m.assignment_candidates) OR NOT EXISTS(SELECT 1 FROM threads WHERE id=p_assignment AND company_id=p_company AND customer_id=p_customer AND status<>'stangd')) THEN RETURN jsonb_build_object('status','invalid_assignment'); END IF;
 UPDATE samtal_a9_matches SET customer_id=p_customer,assignment_id=p_assignment,quote_id=NULL,quote_requested=false,intent=CASE WHEN p_assignment IS NULL THEN 'new_assignment' ELSE 'ambiguous' END,state=CASE WHEN p_assignment IS NULL THEN 'new' ELSE 'resolved' END,request_id=p_request,version=version+1 WHERE company_id=p_company AND call_id=p_call;
 UPDATE samtal_calls SET customer_id=p_customer,thread_id=p_assignment WHERE company_id=p_company AND id=p_call;
 -- Do not release a paused job into legacy phone-based routing. Shared inbox hook needs separate approval.
 PERFORM samtal_v2_deadline(c.delete_after);
 RETURN jsonb_build_object('status','ok','version',m.version+1);
END $$;

-- Terminal deletion sanitizes all additional matching metadata in the SAME transaction as V2 content deletion.
CREATE FUNCTION public.samtal_a9_forget() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.content_deleted_at IS NOT NULL OR NEW.classification='privat' THEN
  DELETE FROM samtal_a9_quote_receipts WHERE company_id=NEW.company_id AND call_id=NEW.id;
  UPDATE samtal_a9_matches SET customer_candidates='{}',assignment_candidates='{}',customer_id=NULL,assignment_id=NULL,quote_id=NULL,intent=NULL,state='deleted',quote_requested=false,request_id=NULL,version=version+1 WHERE company_id=NEW.company_id AND call_id=NEW.id AND state<>'deleted';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER samtal_a9_forget AFTER UPDATE OF content_deleted_at,classification ON public.samtal_calls FOR EACH ROW EXECUTE FUNCTION public.samtal_a9_forget();
REVOKE ALL ON FUNCTION public.samtal_a9_candidates(uuid,uuid,uuid,uuid,text,text,text),public.samtal_a9_assignments(uuid,uuid,uuid,uuid,uuid),public.samtal_a9_save(uuid,uuid,uuid,uuid,jsonb,jsonb),public.samtal_a9_confirm(uuid,uuid,uuid,integer,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_a9_candidates(uuid,uuid,uuid,uuid,text,text,text),public.samtal_a9_assignments(uuid,uuid,uuid,uuid,uuid),public.samtal_a9_save(uuid,uuid,uuid,uuid,jsonb,jsonb),public.samtal_a9_confirm(uuid,uuid,uuid,integer,uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.samtal_a9_forget() FROM PUBLIC,anon,authenticated;

-- Ring's existing commit finishes the lease, so A9 needs a Samtal-only staging seam instead (not a shared change).
CREATE FUNCTION public.samtal_a9_ring_stage(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_extraction jsonb,p_transcript jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE deadline timestamptz;
BEGIN
 IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) OR NOT EXISTS(SELECT 1 FROM samtal_calls WHERE id=p_call AND company_id=p_company AND kind='rostanteckning') THEN RETURN false; END IF;
 IF p_extraction#>>'{interpretation,classification}' IS DISTINCT FROM 'jobb' OR octet_length(p_extraction::text)>1000000 OR jsonb_typeof(p_transcript->'segments') IS DISTINCT FROM 'array' OR octet_length(p_transcript::text)>1000000 THEN RAISE EXCEPTION 'invalid_ring_stage'; END IF;
 SELECT least(c.delete_after,j.lease_until) INTO deadline FROM samtal_calls c JOIN samtal_jobs j ON j.call_id=c.id WHERE j.id=p_job;
 -- A3/A4 redacts private segments before this interface; retain only that redacted transcript.
 UPDATE samtal_calls SET transcript=p_transcript,extraction=p_extraction,classification='jobb' WHERE id=p_call AND company_id=p_company;
 UPDATE samtal_jobs SET step='inkorg' WHERE id=p_job;
 PERFORM samtal_v2_deadline(deadline); RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.samtal_a9_ring_stage(uuid,uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_a9_ring_stage(uuid,uuid,uuid,uuid,jsonb,jsonb) TO service_role;

-- Paused-call exception lookup: cannot use a cleared worker lease. Actor/call authorization replaces it here.
-- An explicit customer choice refreshes that customer's bounded assignment candidate snapshot and version.
CREATE FUNCTION public.samtal_a9_review_options(p_call uuid,p_company uuid,p_actor uuid,p_customer uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls; m samtal_a9_matches; people jsonb; work jsonb; ids uuid[]; overflow boolean;
BEGIN
 c:=samtal_safety_lock(p_call,p_company);
 IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() OR c.classification='privat'
 OR(c.classification='osaker' AND NOT EXISTS(SELECT 1 FROM samtal_reviews WHERE call_id=p_call AND decision='business'))
 OR NOT EXISTS(SELECT 1 FROM companies WHERE id=p_company AND active)
 OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company AND user_id=p_actor AND(role='ägare' OR c.user_id=p_actor)) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call FOR UPDATE;
 IF m.call_id IS NULL OR m.state<>'pending' THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT coalesce(jsonb_agg(p),'[]') INTO people FROM (SELECT id,name,address FROM customers WHERE company_id=p_company AND id=ANY(m.customer_candidates) ORDER BY name,id LIMIT 20) p;
 IF p_customer IS NULL THEN RETURN jsonb_build_object('status','ok','version',m.version,'customers',people,'assignments','[]'::jsonb); END IF;
 IF NOT p_customer=ANY(m.customer_candidates) OR NOT EXISTS(SELECT 1 FROM customers WHERE company_id=p_company AND id=p_customer) THEN RETURN jsonb_build_object('status','invalid_customer'); END IF;
 WITH hits AS (SELECT t.id,t.job,coalesce(nullif(t.place,''),cu.address) AS address FROM threads t JOIN customers cu ON cu.id=t.customer_id AND cu.company_id=t.company_id
 WHERE t.company_id=p_company AND t.customer_id=p_customer AND t.status<>'stangd' ORDER BY t.last_message_at DESC,t.id LIMIT 21)
 SELECT coalesce(jsonb_agg(hits),'[]'),coalesce(array_agg(id),'{}'),count(*)>20 INTO work,ids,overflow FROM hits;
 UPDATE samtal_a9_matches SET assignment_candidates=ids,assignment_truncated=overflow,version=version+1 WHERE company_id=p_company AND call_id=p_call;
 PERFORM samtal_v2_deadline(c.delete_after);
 RETURN jsonb_build_object('status','ok','version',m.version+1,'customers',people,'assignments',(SELECT coalesce(jsonb_agg(v),'[]') FROM jsonb_array_elements(work) WITH ORDINALITY t(v,i) WHERE i<=20),'truncated',overflow);
END $$;
REVOKE ALL ON FUNCTION public.samtal_a9_review_options(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_a9_review_options(uuid,uuid,uuid,uuid) TO service_role;
