-- DOCUMENTATION-ONLY compatibility bridge for previously approved A5/A6 Ring quote drafts.
-- Reuses the existing handoff request/receipt; no prices, quantities or assignment IDs are invented.
CREATE FUNCTION public.samtal_a10_stage_ring_draft(p_actor uuid,p_company uuid,p_draft uuid,p_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE d samtal_ring_drafts; c samtal_calls; m samtal_a9_matches; h jsonb; existing samtal_ring_handoffs; receipt samtal_a9_quote_receipts; ids uuid[]; overflow boolean;
BEGIN
 SELECT * INTO d FROM samtal_ring_drafts WHERE id=p_draft AND company_id=p_company;
 IF NOT FOUND OR NOT samtal_ring_is_owner(p_actor,p_company) OR d.kind<>'offertutkast' OR d.state<>'godkand' OR d.customer_id IS NULL OR d.version<>p_version THEN RETURN jsonb_build_object('status','not_found'); END IF;
 c:=samtal_safety_lock(d.call_id,p_company);
 IF c.id IS NULL OR c.classification<>'jobb' OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() THEN RETURN jsonb_build_object('status','not_found'); END IF;
 PERFORM 1 FROM companies WHERE id=p_company AND active FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL) THEN RETURN jsonb_build_object('status','not_found'); END IF;
 SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=d.call_id FOR UPDATE;
 SELECT * INTO d FROM samtal_ring_drafts WHERE id=p_draft AND company_id=p_company FOR UPDATE;
 IF d.id IS NULL OR d.state<>'godkand' OR d.version<>p_version OR d.call_id<>c.id THEN RETURN jsonb_build_object('status','draft_changed'); END IF;
 IF NOT EXISTS(SELECT 1 FROM customers WHERE id=d.customer_id AND company_id=p_company) THEN RETURN jsonb_build_object('status','invalid_customer'); END IF;
 h:=samtal_ring_request_handoff(p_actor,p_draft,p_version);
 IF h->>'status'<>'ok' THEN RETURN h; END IF;
 SELECT * INTO existing FROM samtal_ring_handoffs WHERE id=(h->>'id')::uuid FOR UPDATE;
 IF existing.draft_version<>d.version OR existing.state='misslyckad' THEN RAISE EXCEPTION 'handoff_conflict'; END IF;
 SELECT * INTO receipt FROM samtal_a9_quote_receipts WHERE company_id=p_company AND call_id=d.call_id;
 IF receipt.call_id IS NOT NULL THEN
  IF existing.state='overlamnad' AND existing.quote_ref IS DISTINCT FROM receipt.quote_id::text THEN RAISE EXCEPTION 'handoff_conflict'; END IF;
  PERFORM samtal_ring_finish_handoff(existing.id,receipt.quote_id::text,NULL);
  RETURN jsonb_build_object('status','ok','call_id',d.call_id,'already_completed',true);
 END IF;
 IF existing.state='overlamnad' THEN RAISE EXCEPTION 'handoff_conflict'; END IF;
 IF m.call_id IS NULL THEN
  SELECT coalesce(array_agg(id),'{}'),count(*)>20 INTO ids,overflow FROM (SELECT id FROM threads WHERE company_id=p_company AND customer_id=d.customer_id AND status<>'stangd' ORDER BY last_message_at DESC,id LIMIT 21) t;
  INSERT INTO samtal_a9_matches(company_id,call_id,customer_candidates,assignment_candidates,assignment_truncated,customer_id,state,quote_requested)
  VALUES(p_company,d.call_id,ARRAY[d.customer_id],ids,overflow,d.customer_id,'pending',true);
 ELSIF m.state='deleted' OR m.customer_id IS NOT NULL AND m.customer_id<>d.customer_id THEN RAISE EXCEPTION 'customer_conflict';
 ELSE UPDATE samtal_a9_matches SET quote_requested=true WHERE company_id=p_company AND call_id=d.call_id;
 END IF;
 PERFORM samtal_v2_deadline(c.delete_after);
 RETURN jsonb_build_object('status','ok','call_id',d.call_id);
END $$;
REVOKE ALL ON FUNCTION public.samtal_a10_stage_ring_draft(uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_a10_stage_ring_draft(uuid,uuid,uuid,integer) TO service_role;
