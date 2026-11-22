DROP FUNCTION public.estim_reread_tender_job(uuid,text);
CREATE FUNCTION public.estim_reread_tender_job(tid uuid,p_company_id uuid,p_base_url text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE t public.tenders; rid uuid; p jsonb; BEGIN
IF p_base_url IS NOT NULL AND p_base_url !~ '^https://[A-Za-z0-9.-]+$' THEN RAISE EXCEPTION 'Invalid base url'; END IF;
SELECT * INTO t FROM public.tenders WHERE id=tid AND company_id=p_company_id FOR UPDATE;
IF NOT FOUND OR t.status='uploading' THEN RAISE EXCEPTION 'Anbudet kunde inte hittas.'; END IF;
IF EXISTS(SELECT 1 FROM public.tender_jobs WHERE tender_id=tid AND status='running') THEN RAISE EXCEPTION 'Anbudet analyseras redan.'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid) THEN RAISE EXCEPTION 'Anbudet saknar filer.'; END IF;
rid:=gen_random_uuid();
SELECT coalesce(jsonb_agg('doc:'||id::text ORDER BY file_name,id),'[]'::jsonb)||'["key_data","risks:1","risks:2","risks:3","questions","quantities","calculation"]'::jsonb INTO p FROM public.tender_documents WHERE tender_id=tid;
UPDATE public.tenders SET reading_version=gen_random_uuid()::text,analysis_run=rid,status='analyzing',error=NULL,analysis_started_at=now() WHERE id=tid;
UPDATE public.tender_documents SET doc_type=NULL,summary=NULL,page_count=NULL,analysis_status='pending',error=NULL WHERE tender_id=tid;
INSERT INTO public.tender_jobs(tender_id,company_id,analysis_run,status,plan,steps,parts) VALUES(tid,p_company_id,rid,'running',p,'{}','{}') ON CONFLICT(tender_id) DO UPDATE SET analysis_run=rid,status='running',plan=p,steps='{}',parts='{}',error=NULL,failed_step=NULL,lease_until=NULL,hops=0;
INSERT INTO public.tender_job_secrets(tender_id,token,base_url) VALUES(tid,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),p_base_url) ON CONFLICT(tender_id) DO UPDATE SET token=EXCLUDED.token,base_url=EXCLUDED.base_url;
PERFORM public.estim_kick_tender_job(tid); RETURN rid;
END $$;
REVOKE ALL ON FUNCTION public.estim_reread_tender_job(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.estim_reread_tender_job(uuid,uuid,text) TO service_role;