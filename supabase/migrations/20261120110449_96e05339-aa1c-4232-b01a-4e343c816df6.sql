ALTER TABLE public.company_document_deliveries DROP CONSTRAINT company_document_deliveries_thread_id_document_id_key;
ALTER TABLE public.company_document_deliveries ADD COLUMN source_message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE;
ALTER TABLE public.company_document_deliveries ADD CONSTRAINT document_delivery_message_unique UNIQUE(message_id,document_id), ADD CONSTRAINT document_delivery_source_unique UNIQUE(source_message_id,document_id);
CREATE OR REPLACE FUNCTION public.estim_document_requested(txt text, doc_name text, doc_type text, prior boolean) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
SELECT coalesce(txt ~* '(skicka|sänd|send|bifoga|skickar|sänder)' AND (
position(lower(doc_name) in lower(txt))>0 OR
(txt ~* '(försäkring|insurance)' AND doc_type ~* '(forsakring|försäkring)') OR
(txt ~* '(certifikat|certificate)' AND doc_type ~* 'certifikat') OR
(txt ~* 'f[- ]?skatt' AND doc_type ~* 'f[-_ ]?skatt') OR
(prior AND txt ~* '(igen|på nytt|en gång till|again|mistat|tappat|förlorat)' AND txt !~* '(försäkring|insurance|certifikat|certificate|f[- ]?skatt)')
),false)
$$;
REVOKE ALL ON FUNCTION public.estim_document_requested(text,text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.estim_document_requested(text,text,text,boolean) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.estim_reserve_documents() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE selected jsonb; d record; incoming public.messages; previous_mid uuid; requested boolean;
BEGIN
IF NEW.channel IS DISTINCT FROM 'wa' OR NEW."from" NOT IN ('ai','vv') OR NEW.delivery_status <> 'sending' THEN RETURN NEW; END IF;
PERFORM 1 FROM public.threads WHERE id=NEW.thread_id AND company_id=NEW.company_id FOR UPDATE;
IF NOT EXISTS(SELECT 1 FROM public.companies WHERE id=NEW.company_id AND settings->3='true'::jsonb AND active) THEN RETURN NEW; END IF;
SELECT * INTO incoming FROM public.messages WHERE company_id=NEW.company_id AND thread_id=NEW.thread_id AND "from"='kund' AND channel='wa' ORDER BY sent_at DESC,created_at DESC,id DESC LIMIT 1;
IF incoming.id IS NULL THEN RETURN NEW; END IF;
IF NEW."from"='ai' AND NEW.in_reply_to IS DISTINCT FROM incoming.provider_message_id THEN RETURN NEW; END IF;
SELECT message_id INTO previous_mid FROM public.company_document_deliveries WHERE company_id=NEW.company_id AND thread_id=NEW.thread_id ORDER BY created_at DESC,id DESC LIMIT 1;
SELECT document_ids INTO selected FROM public.drafts WHERE thread_id=NEW.thread_id AND company_id=NEW.company_id;
IF jsonb_typeof(selected) IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
FOR d IN SELECT * FROM public.company_documents WHERE company_id=NEW.company_id AND selected ? id::text AND length(trim(description))>0 LOOP
requested=public.estim_document_requested(incoming.text,d.name,d.doc_type,EXISTS(SELECT 1 FROM public.company_document_deliveries WHERE company_id=NEW.company_id AND message_id=previous_mid AND document_id=d.id));
IF requested OR NOT EXISTS(SELECT 1 FROM public.company_document_deliveries WHERE company_id=NEW.company_id AND thread_id=NEW.thread_id AND document_id=d.id) THEN
INSERT INTO public.company_document_deliveries(company_id,thread_id,message_id,document_id,name,file_path,file_name,source_message_id) VALUES(NEW.company_id,NEW.thread_id,NEW.id,d.id,d.name,d.file_path,d.file_name,incoming.id) ON CONFLICT DO NOTHING;
END IF;
END LOOP;
RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.estim_reserve_documents() FROM PUBLIC,anon,authenticated;