DROP FUNCTION public.estim_recalculate_tender_job(uuid,text);
CREATE FUNCTION public.estim_recalculate_tender_job(tid uuid,p_company_id uuid,p_base_url text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE t public.tenders; j public.tender_jobs; BEGIN
IF p_base_url IS NOT NULL AND p_base_url !~ '^https://[A-Za-z0-9.-]+$' THEN RAISE EXCEPTION 'Invalid base url'; END IF;
SELECT * INTO t FROM public.tenders WHERE id=tid AND company_id=p_company_id FOR UPDATE;
IF NOT FOUND OR t.analysis_run IS NULL OR t.status='uploading' THEN RAISE EXCEPTION 'Analysera underlaget först.'; END IF;
SELECT * INTO j FROM public.tender_jobs WHERE tender_id=tid FOR UPDATE;
IF FOUND AND j.status='running' THEN RAISE EXCEPTION 'Anbudet analyseras redan.'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.tender_insights WHERE tender_id=tid AND analysis_run=t.analysis_run AND status='analysed') OR EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid AND analysis_status NOT IN ('analysed','too_large')) THEN RAISE EXCEPTION 'Analysera underlaget först.'; END IF;
INSERT INTO public.tender_jobs(tender_id,company_id,analysis_run,status,plan,steps,parts,error,failed_step,lease_until,kicked_at,hops) VALUES(tid,t.company_id,t.analysis_run,'running','["quantities","calculation"]','{"quantities":"pending","calculation":"pending"}','{}',NULL,NULL,NULL,NULL,0) ON CONFLICT(tender_id) DO UPDATE SET status='running',analysis_run=EXCLUDED.analysis_run,plan=EXCLUDED.plan,steps=EXCLUDED.steps,parts='{}',error=NULL,failed_step=NULL,lease_until=NULL,kicked_at=NULL,hops=0;
UPDATE public.tenders SET status='analyzing',error=NULL,analysis_started_at=now() WHERE id=tid;
INSERT INTO public.tender_job_secrets(tender_id,token,base_url) VALUES(tid,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),p_base_url) ON CONFLICT(tender_id) DO UPDATE SET token=EXCLUDED.token,base_url=EXCLUDED.base_url;
PERFORM public.estim_kick_tender_job(tid); RETURN t.analysis_run; END $$;
REVOKE ALL ON FUNCTION public.estim_recalculate_tender_job(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.estim_recalculate_tender_job(uuid,uuid,text) TO service_role;