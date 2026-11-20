DROP POLICY document_delivery_update ON public.company_document_deliveries;
REVOKE UPDATE ON public.company_document_deliveries FROM authenticated;
CREATE OR REPLACE FUNCTION public.estim_snapshot_documents() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
IF NEW.channel='wa' AND NEW."from" IN ('ai','vv') AND NEW.delivery_status='sending' THEN
SELECT coalesce(document_ids,'[]'::jsonb) INTO NEW.document_ids FROM public.drafts WHERE thread_id=NEW.thread_id AND company_id=NEW.company_id;
NEW.document_ids=coalesce(NEW.document_ids,'[]'::jsonb);
END IF;
RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.estim_snapshot_documents() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER snapshot_whatsapp_documents BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.estim_snapshot_documents();