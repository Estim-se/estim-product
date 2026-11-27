CREATE FUNCTION public.samtal_a10_commit_quote(p_call uuid,p_company uuid,p_version integer,p_lines jsonb,p_expected_quote uuid,p_mode text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls; m samtal_a9_matches; old quotes; merged jsonb; receipt samtal_a9_quote_receipts; h samtal_ring_handoffs; d samtal_ring_drafts; result jsonb;
BEGIN
 c:=samtal_safety_lock(p_call,p_company);
 IF auth.uid() IS NULL OR p_company IS DISTINCT FROM my_company() OR c.id IS NULL OR c.classification<>'jobb' OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp()
 OR NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company AND user_id=auth.uid() AND(role='ägare' OR c.user_id=auth.uid())) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 PERFORM 1 FROM companies WHERE id=p_company AND active FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call FOR UPDATE;
 SELECT * INTO receipt FROM samtal_a9_quote_receipts WHERE company_id=p_company AND call_id=p_call;
 SELECT d0.* INTO d FROM samtal_ring_drafts d0 JOIN samtal_ring_handoffs h0 ON h0.draft_id=d0.id AND h0.company_id=d0.company_id WHERE d0.call_id=p_call AND d0.company_id=p_company AND h0.state='vantar' FOR UPDATE OF d0;
 IF d.id IS NOT NULL THEN
  SELECT * INTO h FROM samtal_ring_handoffs WHERE draft_id=d.id AND company_id=p_company FOR UPDATE;
  IF d.version<>h.draft_version OR d.state<>'godkand' THEN RETURN jsonb_build_object('status','draft_changed'); END IF;
 END IF;
 IF receipt.call_id IS NOT NULL THEN
  IF h.id IS NOT NULL THEN PERFORM samtal_ring_finish_handoff(h.id,receipt.quote_id::text,NULL); END IF;
  RETURN jsonb_build_object('status','ok','repeat',true,'quote_id',receipt.quote_id,'version',receipt.quote_version);
 END IF;
 IF m.call_id IS NULL OR m.version<>p_version THEN RETURN jsonb_build_object('status','stale'); END IF;
 PERFORM 1 FROM threads WHERE company_id=p_company AND id=m.assignment_id AND customer_id=m.customer_id AND status NOT IN('stangd','vunnen') FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','assignment_closed'); END IF;
 IF p_mode NOT IN('append','replace') OR p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines)=0 OR jsonb_array_length(p_lines)>200 OR octet_length(p_lines::text)>200000 THEN RETURN jsonb_build_object('status','invalid_lines'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE jsonb_typeof(l->'q') IS DISTINCT FROM 'number' OR jsonb_typeof(l->'p') IS DISTINCT FROM 'number') THEN RETURN jsonb_build_object('status','incomplete_quote'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE (l->>'q')::numeric<=0 OR (l->>'p')::numeric<0 OR (l->>'q')::numeric>100000 OR (l->>'p')::numeric>100000000) THEN RETURN jsonb_build_object('status','invalid_lines'); END IF;
 SELECT * INTO old FROM quotes WHERE company_id=p_company AND thread_id=m.assignment_id ORDER BY version DESC LIMIT 1;
 IF old.id IS DISTINCT FROM p_expected_quote THEN RETURN jsonb_build_object('status','quote_changed'); END IF;
 merged:=CASE WHEN p_mode='append' THEN coalesce(old.lines,'[]'::jsonb)||p_lines ELSE p_lines END;
 IF jsonb_array_length(merged)>200 THEN RETURN jsonb_build_object('status','line_limit'); END IF;
 result:=samtal_a9_commit_quote(p_call,p_company,p_version,merged,p_expected_quote);
 IF result->>'status'='ok' AND h.id IS NOT NULL THEN PERFORM samtal_ring_finish_handoff(h.id,result->>'quote_id',NULL); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.samtal_a10_commit_quote(uuid,uuid,integer,jsonb,uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.samtal_a10_commit_quote(uuid,uuid,integer,jsonb,uuid,text) TO authenticated;