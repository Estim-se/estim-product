CREATE TABLE public.tenders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), name text NOT NULL, status text NOT NULL DEFAULT 'uploading', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,company_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tenders TO authenticated;
GRANT ALL ON public.tenders TO service_role;
ALTER TABLE public.tenders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenders_company ON public.tenders FOR ALL TO authenticated USING(company_id=public.my_company()) WITH CHECK(company_id=public.my_company());
CREATE TABLE public.tender_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), tender_id uuid NOT NULL, file_name text NOT NULL, file_type text NOT NULL, size bigint NOT NULL, path text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tender_id,company_id) REFERENCES public.tenders(id,company_id) ON DELETE CASCADE);
GRANT SELECT,INSERT ON public.tender_documents TO authenticated;
GRANT ALL ON public.tender_documents TO service_role;
ALTER TABLE public.tender_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tender_documents_read ON public.tender_documents FOR SELECT TO authenticated USING(company_id=public.my_company());
CREATE POLICY tender_documents_add ON public.tender_documents FOR INSERT TO authenticated WITH CHECK(company_id=public.my_company());
CREATE INDEX tenders_company_created ON public.tenders(company_id,created_at DESC);
CREATE INDEX tender_documents_tender ON public.tender_documents(tender_id);
CREATE INDEX tender_documents_company ON public.tender_documents(company_id);
CREATE FUNCTION public.estim_validate_tender() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
IF length(trim(NEW.name)) NOT BETWEEN 1 AND 160 OR NEW.status NOT IN ('uploading','ready') THEN RAISE EXCEPTION 'Invalid tender'; END IF;
IF TG_OP='UPDATE' AND (NEW.company_id<>OLD.company_id OR NEW.id<>OLD.id) THEN RAISE EXCEPTION 'Immutable company'; END IF;
RETURN NEW; END $$;
CREATE TRIGGER tender_validate BEFORE INSERT OR UPDATE ON public.tenders FOR EACH ROW EXECUTE FUNCTION public.estim_validate_tender();
CREATE TRIGGER tender_touch BEFORE UPDATE ON public.tenders FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE FUNCTION public.estim_validate_tender_document() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ DECLARE actual_size bigint; BEGIN
PERFORM 1 FROM public.tenders WHERE id=NEW.tender_id AND company_id=NEW.company_id AND status='uploading' FOR UPDATE;
IF NOT FOUND OR NEW.company_id IS DISTINCT FROM public.my_company() THEN RAISE EXCEPTION 'Not allowed'; END IF;
IF NEW.file_type NOT IN ('pdf','docx','xlsx') OR lower(NEW.file_name) NOT LIKE '%.'||NEW.file_type OR length(NEW.file_name) NOT BETWEEN 1 AND 240 OR NEW.path NOT LIKE NEW.company_id::text||'/'||NEW.tender_id::text||'/%' THEN RAISE EXCEPTION 'Invalid file'; END IF;
SELECT (metadata->>'size')::bigint INTO actual_size FROM storage.objects WHERE bucket_id='tender-documents' AND name=NEW.path;
IF actual_size IS NULL OR actual_size<>NEW.size OR NEW.size<=0 OR NEW.size+coalesce((SELECT sum(size) FROM public.tender_documents WHERE tender_id=NEW.tender_id),0)>52428800 OR (SELECT count(*) FROM public.tender_documents WHERE tender_id=NEW.tender_id)>=1000 THEN RAISE EXCEPTION 'Invalid file size'; END IF;
RETURN NEW; END $$;
CREATE TRIGGER tender_document_validate BEFORE INSERT ON public.tender_documents FOR EACH ROW EXECUTE FUNCTION public.estim_validate_tender_document();
CREATE TRIGGER tender_document_touch BEFORE UPDATE ON public.tender_documents FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE FUNCTION public.estim_complete_tender(tid uuid, files jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ DECLARE cid uuid=public.my_company(); f jsonb; BEGIN
PERFORM 1 FROM public.tenders WHERE id=tid AND company_id=cid AND status='uploading' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
IF jsonb_typeof(files) IS DISTINCT FROM 'array' OR jsonb_array_length(files) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid files'; END IF;
FOR f IN SELECT * FROM jsonb_array_elements(files) LOOP INSERT INTO public.tender_documents(company_id,tender_id,file_name,file_type,size,path) VALUES(cid,tid,f->>'file_name',f->>'file_type',(f->>'size')::bigint,f->>'path'); END LOOP;
UPDATE public.tenders SET status='ready' WHERE id=tid AND company_id=cid; END $$;
REVOKE ALL ON FUNCTION public.estim_complete_tender(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.estim_complete_tender(uuid,jsonb) TO authenticated;
CREATE POLICY tender_storage_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='tender-documents' AND (storage.foldername(name))[1]=public.my_company()::text);
CREATE POLICY tender_storage_add ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='tender-documents' AND (storage.foldername(name))[1]=public.my_company()::text AND lower(storage.extension(name)) IN ('pdf','docx','xlsx') AND EXISTS(SELECT 1 FROM public.tenders t WHERE t.company_id=public.my_company() AND t.id::text=(storage.foldername(name))[2] AND t.status='uploading'));
CREATE POLICY tender_storage_cleanup ON storage.objects FOR DELETE TO authenticated USING(bucket_id='tender-documents' AND (storage.foldername(name))[1]=public.my_company()::text AND EXISTS(SELECT 1 FROM public.tenders t WHERE t.company_id=public.my_company() AND t.id::text=(storage.foldername(name))[2] AND t.status='uploading'));