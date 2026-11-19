ALTER TABLE public.ai_jobs ADD COLUMN incoming_message_id uuid REFERENCES public.messages(id);
CREATE OR REPLACE FUNCTION public.estim_bind_job_message() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
SELECT id INTO NEW.incoming_message_id FROM public.messages WHERE thread_id=NEW.thread_id AND company_id=NEW.company_id AND "from"='kund' ORDER BY created_at DESC,id DESC LIMIT 1; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION public.estim_bind_job_message() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER ai_jobs_bind_message BEFORE INSERT ON public.ai_jobs FOR EACH ROW EXECUTE FUNCTION public.estim_bind_job_message();
CREATE UNIQUE INDEX messages_auto_reply_once ON public.messages(company_id,thread_id,in_reply_to) WHERE "from"='ai' AND channel='wa' AND in_reply_to IS NOT NULL;
CREATE OR REPLACE FUNCTION public.estim_prepare_auto_send(jid uuid) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE j public.ai_jobs; t public.threads; incoming public.messages; d public.drafts; mid uuid; BEGIN
SELECT * INTO j FROM public.ai_jobs WHERE id=jid AND state='running'; IF NOT FOUND OR j.incoming_message_id IS NULL THEN RETURN NULL; END IF;
SELECT * INTO t FROM public.threads WHERE id=j.thread_id AND company_id=j.company_id FOR UPDATE;
IF NOT FOUND OR NOT t.autopilot OR t.channel<>'wa' THEN RETURN NULL; END IF;
PERFORM 1 FROM public.companies WHERE id=j.company_id AND active; IF NOT FOUND THEN RETURN NULL; END IF;
SELECT * INTO incoming FROM public.messages WHERE id=j.incoming_message_id AND company_id=j.company_id AND thread_id=j.thread_id AND "from"='kund' AND channel='wa';
IF NOT FOUND OR incoming.provider_message_id IS NULL THEN RETURN NULL; END IF;
IF EXISTS(SELECT 1 FROM public.messages WHERE thread_id=t.id AND "from"='kund' AND created_at>incoming.created_at) THEN RETURN NULL; END IF;
IF EXISTS(SELECT 1 FROM public.messages WHERE thread_id=t.id AND "from"<>'kund' AND (delivery_status='sending' OR (in_reply_to=incoming.provider_message_id AND ("from"='ai' OR delivery_status='sent')) OR (delivery_status='sent' AND created_at>=incoming.created_at))) THEN RETURN NULL; END IF;
SELECT * INTO d FROM public.drafts WHERE thread_id=t.id AND company_id=j.company_id FOR UPDATE;
IF NOT FOUND OR d.channel<>'wa' OR length(trim(d.text))=0 OR d.edited OR (d.needs_review AND jsonb_array_length(d.warnings)>0) THEN RETURN NULL; END IF;
INSERT INTO public.messages(company_id,thread_id,"from",channel,text,attachments,in_reply_to,delivery_status) VALUES(j.company_id,t.id,'ai','wa',d.text,d.attachments,incoming.provider_message_id,'sending') RETURNING id INTO mid;
RETURN mid; END $$;
REVOKE ALL ON FUNCTION public.estim_prepare_auto_send(uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.estim_prepare_auto_send(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.estim_finish_send(mid uuid,delivered boolean,failure text DEFAULT NULL,provider_id text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE m public.messages; BEGIN
SELECT * INTO m FROM public.messages WHERE id=mid AND delivery_status='sending' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
IF m.channel='wa' AND delivered AND nullif(trim(provider_id),'') IS NULL THEN RAISE EXCEPTION 'Provider acknowledgement required'; END IF;
UPDATE public.messages SET delivery_status=CASE WHEN delivered THEN 'sent' ELSE 'not_sent' END,delivery_error=failure,provider_message_id=provider_id WHERE id=mid;
IF delivered THEN
UPDATE public.threads SET status='skickad',read=true,last_message_at=now() WHERE id=m.thread_id AND company_id=m.company_id AND (m."from"<>'ai' OR NOT EXISTS(SELECT 1 FROM public.messages n WHERE n.thread_id=m.thread_id AND n."from"='kund' AND n.created_at>m.created_at));
DELETE FROM public.drafts WHERE thread_id=m.thread_id AND company_id=m.company_id AND text=m.text AND attachments=m.attachments;
IF m."from"='ai' THEN INSERT INTO public.audit_log(company_id,event,"after") VALUES(m.company_id,'Skickat automatiskt',jsonb_build_object('thread_id',m.thread_id,'message_id',m.id,'by','ai')); END IF;
ELSIF m."from"='ai' OR m.channel IS DISTINCT FROM 'wa' THEN
UPDATE public.threads SET status='svar' WHERE id=m.thread_id AND company_id=m.company_id AND status<>'analys';
END IF; END $$;
REVOKE ALL ON FUNCTION public.estim_finish_send(uuid,boolean,text,text) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.estim_finish_send(uuid,boolean,text,text) TO service_role;