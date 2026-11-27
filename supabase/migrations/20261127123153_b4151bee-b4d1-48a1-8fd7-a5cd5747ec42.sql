-- Tasks from confirmed calls: the server may save them (company/call checked in code and by FKs); users still only read via RLS.
ALTER TABLE public.samtal_tasks ADD COLUMN IF NOT EXISTS due_date date, ADD COLUMN IF NOT EXISTS due_hint text CHECK (length(due_hint) <= 40);
GRANT INSERT ON public.samtal_tasks TO service_role;
GRANT UPDATE (due_date, due_hint) ON public.samtal_tasks TO service_role;

-- A duplicate or irrelevant call awaiting confirmation can be dismissed without creating anything.
ALTER TABLE public.samtal_a9_matches DROP CONSTRAINT samtal_a9_matches_state_check;
ALTER TABLE public.samtal_a9_matches ADD CONSTRAINT samtal_a9_matches_state_check CHECK (state = ANY (ARRAY['pending','resolved','new','general','deleted','dismissed']));

CREATE OR REPLACE FUNCTION public.samtal_a9_dismiss(p_call uuid, p_company uuid, p_actor uuid, p_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE c samtal_calls; m samtal_a9_matches;
BEGIN
  c:=samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM company_members x JOIN companies y ON y.id=x.company_id
     WHERE x.company_id=p_company AND x.user_id=p_actor AND y.active AND (x.role='ägare' OR c.user_id=p_actor)) THEN
    RETURN jsonb_build_object('status','not_found'); END IF;
  SELECT * INTO m FROM samtal_a9_matches WHERE company_id=p_company AND call_id=p_call FOR UPDATE;
  IF m.call_id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF m.state='dismissed' THEN RETURN jsonb_build_object('status','ok'); END IF;
  IF m.state NOT IN ('pending','new') THEN RETURN jsonb_build_object('status','not_pending'); END IF;
  IF m.version<>p_version THEN RETURN jsonb_build_object('status','stale'); END IF;
  UPDATE samtal_a9_matches SET state='dismissed',customer_candidates='{}',assignment_candidates='{}',customer_id=NULL,assignment_id=NULL,quote_requested=false,version=version+1
    WHERE company_id=p_company AND call_id=p_call;
  UPDATE samtal_jobs SET state='done',step='klar',lease_token=NULL,lease_until=NULL,error_code='dismissed' WHERE call_id=p_call AND company_id=p_company AND state IN ('paused','queued','failed');
  UPDATE samtal_calls SET status='klar',error_code='dismissed' WHERE id=p_call AND company_id=p_company;
  RETURN jsonb_build_object('status','ok');
END $$;
REVOKE ALL ON FUNCTION public.samtal_a9_dismiss(uuid,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_a9_dismiss(uuid,uuid,uuid,integer) TO service_role;