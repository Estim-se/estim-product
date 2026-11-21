CREATE TABLE public.tender_insights (tender_id uuid PRIMARY KEY REFERENCES public.tenders(id) ON DELETE CASCADE, company_id uuid NOT NULL REFERENCES public.companies(id), analysis_run uuid NOT NULL, status text NOT NULL CHECK(status IN ('analyzing','analysed','error')), result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tender_insights TO authenticated;
GRANT ALL ON public.tender_insights TO service_role;
ALTER TABLE public.tender_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY tender_insights_company ON public.tender_insights FOR ALL TO authenticated USING(company_id=public.my_company()) WITH CHECK(company_id=public.my_company() AND EXISTS(SELECT 1 FROM public.tenders t WHERE t.id=tender_id AND t.company_id=public.my_company()));
CREATE FUNCTION public.estim_validate_tender_insights() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
IF TG_OP='UPDATE' AND (NEW.tender_id<>OLD.tender_id OR NEW.company_id<>OLD.company_id) THEN RAISE EXCEPTION 'Immutable tender'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.tenders t WHERE t.id=NEW.tender_id AND t.company_id=NEW.company_id AND t.analysis_run=NEW.analysis_run) OR pg_column_size(NEW.result)>524288 THEN RAISE EXCEPTION 'Invalid tender analysis'; END IF;
NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER tender_insights_validate BEFORE INSERT OR UPDATE ON public.tender_insights FOR EACH ROW EXECUTE FUNCTION public.estim_validate_tender_insights();
CREATE FUNCTION public.estim_clear_tender_insights() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
IF TG_TABLE_NAME='tenders' THEN IF NEW.analysis_run IS DISTINCT FROM OLD.analysis_run THEN DELETE FROM public.tender_insights WHERE tender_id=NEW.id; END IF; RETURN NEW;
ELSE DELETE FROM public.tender_insights WHERE tender_id=OLD.tender_id; RETURN OLD; END IF; END $$;
CREATE TRIGGER tender_insights_reset AFTER UPDATE ON public.tenders FOR EACH ROW EXECUTE FUNCTION public.estim_clear_tender_insights();
CREATE TRIGGER tender_insights_file_removed AFTER DELETE ON public.tender_documents FOR EACH ROW EXECUTE FUNCTION public.estim_clear_tender_insights();
CREATE FUNCTION public.estim_claim_tender_insights(tid uuid,rid uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$ DECLARE cid uuid; BEGIN
SELECT company_id INTO cid FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND analysis_run=rid AND status='analysed' FOR UPDATE;
IF NOT FOUND OR EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid AND analysis_status NOT IN ('analysed','too_large')) OR NOT EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid AND analysis_status='analysed') THEN RETURN false; END IF;
INSERT INTO public.tender_insights(tender_id,company_id,analysis_run,status) VALUES(tid,cid,rid,'analyzing') ON CONFLICT(tender_id) DO NOTHING;
IF NOT FOUND THEN RETURN false; END IF;
UPDATE public.tenders SET status='analyzing',analysis_started_at=now() WHERE id=tid; RETURN true; END $$;
CREATE FUNCTION public.estim_finish_tender_insights(tid uuid,rid uuid,p_result jsonb,p_error text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND analysis_run=rid AND status='analyzing' FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Analysen har ersatts.'; END IF;
IF p_result IS NOT NULL AND (jsonb_typeof(p_result)<>'object' OR NOT (p_result ?& ARRAY['key_data','risks','questions'])) THEN RAISE EXCEPTION 'Invalid result'; END IF;
UPDATE public.tender_insights SET result=p_result,error=left(p_error,500),status=CASE WHEN p_error IS NULL THEN 'analysed' ELSE 'error' END WHERE tender_id=tid AND analysis_run=rid AND status='analyzing';
IF NOT FOUND THEN RAISE EXCEPTION 'Underlaget har ändrats. Analysera igen.'; END IF;
UPDATE public.tenders SET status=CASE WHEN p_error IS NULL THEN 'analysed' ELSE 'error' END,error=left(p_error,500) WHERE id=tid; END $$;
REVOKE ALL ON FUNCTION public.estim_claim_tender_insights(uuid,uuid), public.estim_finish_tender_insights(uuid,uuid,jsonb,text),public.estim_validate_tender_insights(),public.estim_clear_tender_insights() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.estim_claim_tender_insights(uuid,uuid), public.estim_finish_tender_insights(uuid,uuid,jsonb,text) TO authenticated;