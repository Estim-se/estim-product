ALTER TABLE public.tender_documents ADD COLUMN doc_type text, ADD COLUMN summary text, ADD COLUMN page_count integer, ADD COLUMN analysis_status text NOT NULL DEFAULT 'pending', ADD COLUMN error text;
ALTER TABLE public.tenders ADD COLUMN error text, ADD COLUMN analysis_run uuid, ADD COLUMN analysis_started_at timestamptz;
GRANT UPDATE(doc_type,summary,page_count,analysis_status,error) ON public.tender_documents TO authenticated;
CREATE POLICY tender_documents_analysis ON public.tender_documents FOR UPDATE TO authenticated USING(company_id=public.my_company()) WITH CHECK(company_id=public.my_company());
CREATE OR REPLACE FUNCTION public.estim_validate_tender() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
IF length(trim(NEW.name)) NOT BETWEEN 1 AND 160 OR NEW.status NOT IN ('uploading','ready','analyzing','analysed','error') THEN RAISE EXCEPTION 'Invalid tender'; END IF;
IF TG_OP='UPDATE' AND (NEW.company_id<>OLD.company_id OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'Immutable company'; END IF;
RETURN NEW; END $$;
CREATE FUNCTION public.estim_validate_tender_analysis() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
IF NEW.analysis_status NOT IN ('pending','analyzing','analysed','too_large','error') OR (NEW.doc_type IS NOT NULL AND NEW.doc_type NOT IN ('AF','Teknisk beskrivning/Rambeskrivning','Ritning','Tidsplan','Mängdförteckning','Förfrågningsbrev','Övrigt')) OR (NEW.page_count IS NOT NULL AND NEW.page_count<1) OR length(NEW.summary)>2000 OR length(NEW.error)>500 THEN RAISE EXCEPTION 'Invalid analysis'; END IF;
IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.tender_id<>OLD.tender_id OR NEW.file_name<>OLD.file_name OR NEW.file_type<>OLD.file_type OR NEW.size<>OLD.size OR NEW.path<>OLD.path) THEN RAISE EXCEPTION 'Immutable file'; END IF;
RETURN NEW; END $$;
CREATE TRIGGER tender_analysis_validation BEFORE INSERT OR UPDATE ON public.tender_documents FOR EACH ROW EXECUTE FUNCTION public.estim_validate_tender_analysis();
CREATE FUNCTION public.estim_begin_tender_analysis(tid uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$ DECLARE rid uuid:=gen_random_uuid(); t public.tenders; BEGIN
SELECT * INTO t FROM public.tenders WHERE id=tid AND company_id=public.my_company() FOR UPDATE;
IF NOT FOUND OR t.status='uploading' THEN RAISE EXCEPTION 'Anbudet är inte redo för analys.'; END IF;
IF t.status='analyzing' AND t.analysis_started_at>now()-interval '10 minutes' THEN RAISE EXCEPTION 'Anbudet analyseras redan.'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid) THEN RAISE EXCEPTION 'Anbudet saknar filer.'; END IF;
UPDATE public.tender_documents SET doc_type=NULL,summary=NULL,page_count=NULL,analysis_status='pending',error=NULL WHERE tender_id=tid;
UPDATE public.tenders SET status='analyzing',error=NULL,analysis_run=rid,analysis_started_at=now() WHERE id=tid;
RETURN rid; END $$;
CREATE FUNCTION public.estim_claim_tender_document(did uuid,rid uuid) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$ DECLARE tid uuid; BEGIN
SELECT tender_id INTO tid FROM public.tender_documents WHERE id=did AND company_id=public.my_company();
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND status='analyzing' AND analysis_run=rid FOR UPDATE;
IF NOT FOUND THEN RETURN false; END IF;
UPDATE public.tender_documents SET analysis_status='analyzing',error=NULL WHERE id=did AND analysis_status='pending';
RETURN FOUND; END $$;
CREATE FUNCTION public.estim_finish_tender_document(did uuid,rid uuid,result jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ DECLARE tid uuid; failure text; BEGIN
SELECT tender_id INTO tid FROM public.tender_documents WHERE id=did AND company_id=public.my_company();
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND status='analyzing' AND analysis_run=rid FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Analysen har ersatts av en ny körning.'; END IF;
IF result->>'analysis_status' NOT IN ('analysed','too_large','error') THEN RAISE EXCEPTION 'Invalid result'; END IF;
UPDATE public.tender_documents SET doc_type=result->>'doc_type',summary=result->>'summary',page_count=(result->>'page_count')::integer,analysis_status=result->>'analysis_status',error=result->>'error' WHERE id=did AND analysis_status='analyzing';
IF NOT FOUND THEN RAISE EXCEPTION 'Dokumentet analyseras inte.'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid AND analysis_status IN ('pending','analyzing')) THEN
SELECT error INTO failure FROM public.tender_documents WHERE tender_id=tid AND analysis_status='error' ORDER BY file_name LIMIT 1;
UPDATE public.tenders SET status=CASE WHEN EXISTS(SELECT 1 FROM public.tender_documents WHERE tender_id=tid AND analysis_status='error') THEN 'error' ELSE 'analysed' END,error=failure WHERE id=tid;
END IF; END $$;
CREATE FUNCTION public.estim_abort_tender_analysis(tid uuid,rid uuid,failure text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=public.my_company() AND analysis_run=rid AND status='analyzing' FOR UPDATE;
IF NOT FOUND THEN RETURN; END IF;
UPDATE public.tender_documents SET analysis_status='error',error=left(failure,500) WHERE tender_id=tid AND analysis_status IN ('pending','analyzing');
UPDATE public.tenders SET status='error',error=left(failure,500) WHERE id=tid;
END $$;
REVOKE ALL ON FUNCTION public.estim_begin_tender_analysis(uuid),public.estim_claim_tender_document(uuid,uuid),public.estim_finish_tender_document(uuid,uuid,jsonb),public.estim_abort_tender_analysis(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.estim_begin_tender_analysis(uuid),public.estim_claim_tender_document(uuid,uuid),public.estim_finish_tender_document(uuid,uuid,jsonb),public.estim_abort_tender_analysis(uuid,uuid,text) TO authenticated;