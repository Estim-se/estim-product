ALTER TABLE public.tender_insights ADD COLUMN steps jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE FUNCTION public.estim_save_tender_insight_step(tid uuid,rid uuid,p_step text,p_value jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
IF p_step NOT IN ('key_data','risks','questions') OR (p_value IS NOT NULL AND (p_step='questions' OR jsonb_typeof(p_value)<>'array')) THEN RAISE EXCEPTION 'Invalid step'; END IF;
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND analysis_run=rid AND status='analyzing' FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Analysen har ersatts.'; END IF;
UPDATE public.tender_insights SET
  result=CASE WHEN p_value IS NULL THEN result ELSE coalesce(result,'{}'::jsonb)||jsonb_build_object(p_step,p_value) END,
  steps=steps||jsonb_build_object(p_step,CASE WHEN p_value IS NULL THEN 'error' ELSE 'done' END)
WHERE tender_id=tid AND analysis_run=rid AND status='analyzing' AND (p_step<>'risks' OR p_value IS NULL OR steps ? 'key_data');
IF NOT FOUND THEN RAISE EXCEPTION 'Underlaget har ändrats. Analysera igen.'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.estim_finish_tender_insights(tid uuid,rid uuid,p_result jsonb,p_error text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
p_error:=nullif(p_error,'');
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND analysis_run=rid AND status='analyzing' FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Analysen har ersatts.'; END IF;
IF p_result IS NOT NULL AND (jsonb_typeof(p_result)<>'object' OR NOT (p_result ?& ARRAY['key_data','risks','questions'])) THEN RAISE EXCEPTION 'Invalid result'; END IF;
UPDATE public.tender_insights SET result=coalesce(p_result,result),error=left(p_error,500),status=CASE WHEN p_error IS NULL THEN 'analysed' ELSE 'error' END,
  steps=CASE WHEN p_error IS NULL THEN steps||'{"questions":"done"}'::jsonb ELSE steps END
WHERE tender_id=tid AND analysis_run=rid AND status='analyzing';
IF NOT FOUND THEN RAISE EXCEPTION 'Underlaget har ändrats. Analysera igen.'; END IF;
UPDATE public.tenders SET status=CASE WHEN p_error IS NULL THEN 'analysed' ELSE 'error' END,error=left(p_error,500) WHERE id=tid; END $$;
REVOKE ALL ON FUNCTION public.estim_save_tender_insight_step(uuid,uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.estim_save_tender_insight_step(uuid,uuid,text,jsonb) TO authenticated;