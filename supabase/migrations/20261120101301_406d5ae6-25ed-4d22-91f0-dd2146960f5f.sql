REVOKE ALL ON FUNCTION public.estim_reserve_documents() FROM PUBLIC, anon, authenticated;
CREATE INDEX document_deliveries_company_thread ON public.company_document_deliveries(company_id,thread_id);
CREATE INDEX document_deliveries_message ON public.company_document_deliveries(message_id);