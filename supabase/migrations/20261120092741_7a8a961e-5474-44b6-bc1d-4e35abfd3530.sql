CREATE TABLE public.company_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT public.my_company() REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  doc_type text NOT NULL CHECK (doc_type IN ('forsakring','fskatt','certifikat','ovrigt')),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  file_path text NOT NULL,
  file_name text NOT NULL DEFAULT '',
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (split_part(file_path,'/',1) = company_id::text)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_documents TO authenticated;
GRANT ALL ON public.company_documents TO service_role;
ALTER TABLE public.company_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_documents_own ON public.company_documents FOR ALL TO authenticated
  USING (company_id = public.my_company()) WITH CHECK (company_id = public.my_company());
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.company_documents FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

CREATE POLICY company_documents_read ON storage.objects FOR SELECT TO authenticated
 USING (bucket_id='company-documents' AND (storage.foldername(name))[1] = public.my_company()::text);
CREATE POLICY company_documents_upload ON storage.objects FOR INSERT TO authenticated
 WITH CHECK (bucket_id='company-documents' AND (storage.foldername(name))[1] = public.my_company()::text);
CREATE POLICY company_documents_remove ON storage.objects FOR DELETE TO authenticated
 USING (bucket_id='company-documents' AND (storage.foldername(name))[1] = public.my_company()::text);