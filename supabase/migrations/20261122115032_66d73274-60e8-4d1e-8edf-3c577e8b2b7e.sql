CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE public.tender_jobs (
  tender_id uuid PRIMARY KEY REFERENCES public.tenders(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  analysis_run uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running','error','done')),
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  parts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text, failed_step text,
  lease_until timestamptz, kicked_at timestamptz, hops integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tender_jobs TO authenticated;
GRANT ALL ON public.tender_jobs TO service_role;
ALTER TABLE public.tender_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tender_jobs_company_read ON public.tender_jobs FOR SELECT TO authenticated USING (company_id = public.my_company());

CREATE TABLE public.tender_job_secrets (
  tender_id uuid PRIMARY KEY REFERENCES public.tender_jobs(tender_id) ON DELETE CASCADE,
  token text NOT NULL, base_url text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.tender_job_secrets TO service_role;
ALTER TABLE public.tender_job_secrets ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.estim_touch_tender_job() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER tender_jobs_touch BEFORE UPDATE ON public.tender_jobs FOR EACH ROW EXECUTE FUNCTION public.estim_touch_tender_job();
CREATE TRIGGER tender_job_secrets_touch BEFORE UPDATE ON public.tender_job_secrets FOR EACH ROW EXECUTE FUNCTION public.estim_touch_tender_job();

-- Posts one hop to the app's public job route; the route verifies the per-job token.
CREATE FUNCTION public.estim_kick_tender_job(tid uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE s public.tender_job_secrets; BEGIN
SELECT * INTO s FROM public.tender_job_secrets WHERE tender_id=tid;
IF NOT FOUND OR s.base_url IS NULL THEN RETURN false; END IF;
PERFORM 1 FROM public.tender_jobs WHERE tender_id=tid AND status='running';
IF NOT FOUND THEN RETURN false; END IF;
UPDATE public.tender_jobs SET kicked_at=now() WHERE tender_id=tid;
PERFORM net.http_post(url:=s.base_url||'/api/public/tender-job', body:=jsonb_build_object('tender',tid,'token',s.token), headers:=jsonb_build_object('Content-Type','application/json'), timeout_milliseconds:=600000);
RETURN true; END $$;

-- Starts a fresh run, or resumes a failed run from its failed step without redoing completed steps.
CREATE FUNCTION public.estim_start_tender_job(tid uuid, p_resume boolean, p_base_url text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE t public.tenders; j public.tender_jobs; rid uuid; p jsonb; BEGIN
IF p_base_url IS NOT NULL AND p_base_url !~ '^https://[A-Za-z0-9.-]+$' THEN RAISE EXCEPTION 'Invalid base url'; END IF;
SELECT * INTO t FROM public.tenders WHERE id=tid AND company_id=public.my_company() FOR UPDATE;
IF NOT FOUND OR t.status='uploading' THEN RAISE EXCEPTION 'Anbudet är inte redo för analys.'; END IF;
SELECT * INTO j FROM public.tender_jobs WHERE tender_id=tid FOR UPDATE;
IF FOUND AND j.status='running' AND (j.lease_until>now() OR j.updated_at>now()-interval '15 minutes') THEN RAISE EXCEPTION 'Anbudet analyseras redan.'; END IF;
IF p_resume THEN
  IF NOT FOUND OR j.status<>'error' OR j.analysis_run IS DISTINCT FROM t.analysis_run THEN RAISE EXCEPTION 'Analysen kan inte fortsättas. Analysera igen.'; END IF;
  rid:=j.analysis_run;
  UPDATE public.tender_jobs SET status='running',error=NULL,failed_step=NULL,lease_until=NULL,hops=0,
    steps=coalesce((SELECT jsonb_object_agg(k, CASE WHEN v=to_jsonb('done'::text) THEN v ELSE to_jsonb('pending'::text) END) FROM jsonb_each(j.steps) AS e(k,v)),'{}'::jsonb)
  WHERE tender_id=tid;
  UPDATE public.tenders SET status='analyzing',error=NULL,analysis_started_at=now() WHERE id=tid;
ELSE
  IF NOT EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid) THEN RAISE EXCEPTION 'Anbudet saknar filer.'; END IF;
  rid:=gen_random_uuid();
  UPDATE public.tender_documents SET doc_type=NULL,summary=NULL,page_count=NULL,analysis_status='pending',error=NULL WHERE tender_id=tid;
  UPDATE public.tenders SET status='analyzing',error=NULL,analysis_run=rid,analysis_started_at=now() WHERE id=tid;
  SELECT jsonb_agg('doc:'||id ORDER BY file_name,id) INTO p FROM public.tender_documents WHERE tender_id=tid;
  p:=p||'["key_data","risks:1","risks:2","risks:3","questions","quantities","calculation"]'::jsonb;
  INSERT INTO public.tender_jobs(tender_id,company_id,analysis_run,status,plan,steps,parts,error,failed_step,lease_until,kicked_at,hops)
  VALUES(tid,t.company_id,rid,'running',p,(SELECT jsonb_object_agg(x,'pending') FROM jsonb_array_elements_text(p) x),'{}'::jsonb,NULL,NULL,NULL,NULL,0)
  ON CONFLICT(tender_id) DO UPDATE SET analysis_run=EXCLUDED.analysis_run,status='running',plan=EXCLUDED.plan,steps=EXCLUDED.steps,parts='{}'::jsonb,error=NULL,failed_step=NULL,lease_until=NULL,kicked_at=NULL,hops=0;
END IF;
INSERT INTO public.tender_job_secrets(tender_id,token,base_url) VALUES(tid,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),p_base_url)
ON CONFLICT(tender_id) DO UPDATE SET token=EXCLUDED.token,base_url=EXCLUDED.base_url;
PERFORM public.estim_kick_tender_job(tid);
RETURN rid; END $$;

-- Single-flight lease for one step; only callers holding the job token can claim.
CREATE FUNCTION public.estim_claim_tender_job(tid uuid, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE r jsonb; BEGIN
PERFORM 1 FROM public.tender_job_secrets WHERE tender_id=tid AND token=p_token;
IF NOT FOUND THEN RETURN NULL; END IF;
UPDATE public.tender_jobs SET lease_until=now()+interval '9 minutes',hops=hops+1
WHERE tender_id=tid AND status='running' AND (lease_until IS NULL OR lease_until<now())
RETURNING to_jsonb(tender_jobs.*) INTO r;
RETURN r; END $$;

REVOKE ALL ON FUNCTION public.estim_kick_tender_job(uuid), public.estim_claim_tender_job(uuid,text), public.estim_start_tender_job(uuid,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estim_kick_tender_job(uuid), public.estim_claim_tender_job(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.estim_start_tender_job(uuid,boolean,text) TO authenticated;