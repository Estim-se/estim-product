GRANT DELETE ON public.tender_documents TO authenticated;
CREATE POLICY tender_documents_delete ON public.tender_documents FOR DELETE TO authenticated USING(company_id=public.my_company());
CREATE POLICY tender_storage_delete ON storage.objects FOR DELETE TO authenticated USING(bucket_id='tender-documents' AND (storage.foldername(name))[1]=public.my_company()::text);