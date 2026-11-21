CREATE OR REPLACE FUNCTION public.estim_finish_tender_insights(tid uuid,rid uuid,p_result jsonb,p_error text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
p_error:=nullif(p_error,'');
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND analysis_run=rid AND status='analyzing' FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Analysen har ersatts.'; END IF;
IF p_result IS NOT NULL AND (jsonb_typeof(p_result)<>'object' OR NOT (p_result ?& ARRAY['key_data','risks','questions'])) THEN RAISE EXCEPTION 'Invalid result'; END IF;
UPDATE public.tender_insights SET result=p_result,error=left(p_error,500),status=CASE WHEN p_error IS NULL THEN 'analysed' ELSE 'error' END WHERE tender_id=tid AND analysis_run=rid AND status='analyzing';
IF NOT FOUND THEN RAISE EXCEPTION 'Underlaget har ändrats. Analysera igen.'; END IF;
UPDATE public.tenders SET status=CASE WHEN p_error IS NULL THEN 'analysed' ELSE 'error' END,error=left(p_error,500) WHERE id=tid; END $$;