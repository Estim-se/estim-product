ALTER TABLE public.companies ADD COLUMN whatsapp_auto_reply boolean NOT NULL DEFAULT false;
ALTER TABLE public.threads ADD COLUMN whatsapp_auto_override boolean;
UPDATE public.threads SET whatsapp_auto_override=true WHERE autopilot=true;
CREATE OR REPLACE FUNCTION public.estim_prepare_auto_send(jid uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE j public.ai_jobs; t public.threads; incoming public.messages; d public.drafts; mid uuid; enabled boolean; BEGIN
SELECT * INTO j FROM public.ai_jobs WHERE id=jid AND state='running'; IF NOT FOUND OR j.incoming_message_id IS NULL THEN RETURN NULL; END IF;
SELECT * INTO t FROM public.threads WHERE id=j.thread_id AND company_id=j.company_id FOR UPDATE;
IF NOT FOUND OR t.channel<>'wa' THEN RETURN NULL; END IF;
SELECT coalesce(t.whatsapp_auto_override,whatsapp_auto_reply) INTO enabled FROM public.companies WHERE id=j.company_id AND active;
IF NOT FOUND OR NOT enabled THEN RETURN NULL; END IF;
SELECT * INTO incoming FROM public.messages WHERE id=j.incoming_message_id AND company_id=j.company_id AND thread_id=j.thread_id AND "from"='kund' AND channel='wa';
IF NOT FOUND OR incoming.provider_message_id IS NULL THEN RETURN NULL; END IF;
IF EXISTS(SELECT 1 FROM public.messages WHERE thread_id=t.id AND "from"='kund' AND created_at>incoming.created_at) THEN RETURN NULL; END IF;
IF EXISTS(SELECT 1 FROM public.messages WHERE thread_id=t.id AND "from"<>'kund' AND (delivery_status='sending' OR (in_reply_to=incoming.provider_message_id AND ("from"='ai' OR delivery_status='sent')) OR (delivery_status='sent' AND created_at>=incoming.created_at))) THEN RETURN NULL; END IF;
SELECT * INTO d FROM public.drafts WHERE thread_id=t.id AND company_id=j.company_id FOR UPDATE;
IF NOT FOUND OR d.channel<>'wa' OR length(trim(d.text))=0 OR d.edited OR (d.needs_review AND jsonb_array_length(d.warnings)>0) THEN RETURN NULL; END IF;
INSERT INTO public.messages(company_id,thread_id,"from",channel,text,attachments,in_reply_to,delivery_status) VALUES(j.company_id,t.id,'ai','wa',d.text,d.attachments,incoming.provider_message_id,'sending') RETURNING id INTO mid;
RETURN mid; END $$;
REVOKE ALL ON FUNCTION public.estim_prepare_auto_send(uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.estim_prepare_auto_send(uuid) TO service_role;