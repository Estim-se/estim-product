CREATE OR REPLACE FUNCTION public.samtal_a9_save(p_call uuid, p_company uuid, p_job uuid, p_token uuid, p_customer jsonb, p_assignment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
 -- A clearly new customer (code decided 'new': name and address heard, no candidate at all) is not a review case.
 IF customer IS NULL AND p_customer->>'state'='new' AND p_assignment IS NULL AND cardinality(coalesce(m.customer_candidates,'{}'))=0 AND NOT m.customer_truncated THEN result_state:='new';
 ELSIF customer IS NULL OR m.customer_truncated OR m.assignment_truncated OR p_assignment->>'state'='ambiguous' THEN result_state:='pending';
 ELSIF assignment IS NOT NULL AND p_assignment->>'state'='linked' THEN result_state:='resolved';
 ELSIF p_assignment->>'state' IN('new','general') THEN result_state:=p_assignment->>'state'; ELSE result_state:='pending'; END IF;
 UPDATE samtal_a9_matches SET customer_id=customer,assignment_id=CASE WHEN result_state='resolved' THEN assignment END,intent=p_assignment->>'intent',
 state=result_state,quote_id=CASE WHEN result_state='resolved' THEN quote END,quote_requested=coalesce((p_assignment->>'quoteRequested')::boolean,false),version=version+1 WHERE company_id=p_company AND call_id=p_call;
 UPDATE samtal_calls SET customer_id=customer,thread_id=CASE WHEN result_state='resolved' THEN assignment END WHERE company_id=p_company AND id=p_call;
 IF result_state='pending' THEN UPDATE samtal_jobs SET state='paused',lease_token=NULL,lease_until=NULL,error_code='matching_needs_review' WHERE id=p_job; END IF;
 PERFORM samtal_v2_deadline(deadline);
 RETURN jsonb_build_object('status',result_state,'version',m.version+1);
END $function$;