ALTER TABLE public.drafts ADD COLUMN document_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE public.messages ADD COLUMN document_ids jsonb NOT NULL DEFAULT '[]';
CREATE TABLE public.company_document_deliveries (
id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), thread_id uuid NOT NULL, message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE, document_id uuid NOT NULL, name text NOT NULL, file_path text NOT NULL, file_name text NOT NULL, state text NOT NULL DEFAULT 'reserved', provider_message_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(thread_id,document_id), FOREIGN KEY(company_id,thread_id) REFERENCES public.threads(company_id,id) ON DELETE CASCADE);
GRANT SELECT, UPDATE ON public.company_document_deliveries TO authenticated;
GRANT ALL ON public.company_document_deliveries TO service_role;
ALTER TABLE public.company_document_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_delivery_read ON public.company_document_deliveries FOR SELECT TO authenticated USING(company_id=public.my_company());
CREATE POLICY document_delivery_update ON public.company_document_deliveries FOR UPDATE TO authenticated USING(company_id=public.my_company()) WITH CHECK(company_id=public.my_company());
CREATE TRIGGER document_delivery_touch BEFORE UPDATE ON public.company_document_deliveries FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE OR REPLACE FUNCTION public.estim_reserve_documents() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE selected jsonb; d record; reserved uuid;
BEGIN
IF NEW.channel IS DISTINCT FROM 'wa' OR NEW."from" NOT IN ('ai','vv') OR NEW.delivery_status <> 'sending' THEN RETURN NEW; END IF;
PERFORM 1 FROM public.threads WHERE id=NEW.thread_id AND company_id=NEW.company_id FOR UPDATE;
IF NOT EXISTS(SELECT 1 FROM public.companies WHERE id=NEW.company_id AND settings->3='true'::jsonb AND active) THEN RETURN NEW; END IF;
SELECT document_ids INTO selected FROM public.drafts WHERE thread_id=NEW.thread_id AND company_id=NEW.company_id;
IF jsonb_typeof(selected) IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
FOR d IN SELECT * FROM public.company_documents WHERE company_id=NEW.company_id AND selected ? id::text AND length(trim(description))>0 LOOP
INSERT INTO public.company_document_deliveries(company_id,thread_id,message_id,document_id,name,file_path,file_name) VALUES(NEW.company_id,NEW.thread_id,NEW.id,d.id,d.name,d.file_path,d.file_name) ON CONFLICT(thread_id,document_id) DO NOTHING RETURNING id INTO reserved;
END LOOP;
RETURN NEW;
END $$;
CREATE TRIGGER reserve_whatsapp_documents AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.estim_reserve_documents();