CREATE FUNCTION public.samtal_a9_commit_quote(p_call uuid,p_company uuid,p_expected_version integer,p_lines jsonb,p_expected_quote uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls; m samtal_a9_matches; receipt samtal_a9_quote_receipts; old quotes; q quotes; v integer; actor uuid:=auth.uid();
BEGIN
 c:=samtal_safety_lock(p_call,p_company);
 IF actor IS NULL OR p_company IS DISTINCT FROM my_company() OR c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() OR c.classification<>'jobb'
 OR NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company AND user_id=actor AND(role='ägare' OR c.user_id=actor)) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call FOR UPDATE;
 IF m.state<>'resolved' OR m.call_id IS NULL OR m.assignment_id IS NULL THEN RETURN jsonb_build_object('status','assignment_required'); END IF;
 PERFORM 1 FROM companies WHERE id=p_company AND active FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 PERFORM 1 FROM threads WHERE id=m.assignment_id AND company_id=p_company AND customer_id=m.customer_id AND status NOT IN('vunnen','stangd') FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','assignment_closed'); END IF;
 SELECT * INTO receipt FROM samtal_a9_quote_receipts WHERE call_id=p_call AND company_id=p_company;
 IF FOUND THEN RETURN jsonb_build_object('status','ok','repeat',true,'quote_id',receipt.quote_id,'version',receipt.quote_version); END IF;
 IF m.version<>p_expected_version THEN RETURN jsonb_build_object('status','stale'); END IF;
 SELECT * INTO old FROM quotes WHERE company_id=p_company AND thread_id=m.assignment_id ORDER BY version DESC LIMIT 1;
 IF old.id IS DISTINCT FROM p_expected_quote THEN RETURN jsonb_build_object('status','quote_changed'); END IF;
 IF p_lines IS NULL OR jsonb_typeof(p_lines)<>'array' OR jsonb_array_length(p_lines)=0 OR jsonb_array_length(p_lines)>200 OR octet_length(p_lines::text)>200000 THEN RAISE EXCEPTION 'invalid_reviewed_quote'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE jsonb_typeof(l) IS DISTINCT FROM 'object' OR jsonb_typeof(l->'q') IS DISTINCT FROM 'number' OR jsonb_typeof(l->'p') IS DISTINCT FROM 'number') THEN RETURN jsonb_build_object('status','incomplete_quote'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE jsonb_typeof(l->'t') IS DISTINCT FROM 'string' OR length(trim(coalesce(l->>'t','')))=0 OR length(l->>'t')>500 OR jsonb_typeof(l->'u') IS DISTINCT FROM 'string' OR length(l->>'u')>30 OR l->>'typ' IS NULL OR l->>'typ' NOT IN('arbete','material','resa') OR jsonb_typeof(l->'rot') IS DISTINCT FROM 'boolean') THEN RETURN jsonb_build_object('status','invalid_quote_line'); END IF;
 v:=estim_quote(m.assignment_id,jsonb_build_object('nr',coalesce(old.nr,'pending'),'owners',coalesce(old.owners,1),'addOn',coalesce(old.add_on,false),'prisform',coalesce(old.prisform,'ungefar'),'lines',p_lines));
 SELECT * INTO q FROM quotes WHERE company_id=p_company AND thread_id=m.assignment_id AND version=v;
 IF q.id IS NULL THEN RAISE EXCEPTION 'quote_not_saved'; END IF;
 INSERT INTO samtal_a9_quote_receipts(company_id,call_id,match_version,quote_id,quote_version) VALUES(p_company,p_call,m.version,q.id,v);
 PERFORM samtal_v2_deadline(c.delete_after);
 RETURN jsonb_build_object('status','ok','quote_id',q.id,'version',v);
END $$;
REVOKE ALL ON FUNCTION public.samtal_a9_commit_quote(uuid,uuid,integer,jsonb,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.samtal_a9_commit_quote(uuid,uuid,integer,jsonb,uuid) TO authenticated;