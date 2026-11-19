CREATE OR REPLACE FUNCTION public.estim_finish_send(mid uuid, delivered boolean, failure text DEFAULT NULL::text, provider_id text DEFAULT NULL::text)
RETURNS void LANGUAGE plpgsql SET search_path TO 'public' AS $function$
DECLARE m public.messages;
BEGIN
SELECT * INTO m FROM public.messages WHERE id=mid AND delivery_status='sending' FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
UPDATE public.messages SET delivery_status=CASE WHEN delivered THEN 'sent' ELSE 'not_sent' END,delivery_error=failure,provider_message_id=provider_id WHERE id=mid;
IF delivered THEN
UPDATE public.threads SET status='skickad',read=true,last_message_at=now() WHERE id=m.thread_id AND company_id=m.company_id;
DELETE FROM public.drafts WHERE thread_id=m.thread_id AND company_id=m.company_id AND text=m.text AND attachments=m.attachments;
ELSIF m.channel IS DISTINCT FROM 'wa' THEN
UPDATE public.threads SET status='svar' WHERE id=m.thread_id AND company_id=m.company_id;
END IF;
END $function$;
REVOKE ALL ON FUNCTION public.estim_finish_send(uuid,boolean,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.estim_finish_send(uuid,boolean,text,text) TO service_role;