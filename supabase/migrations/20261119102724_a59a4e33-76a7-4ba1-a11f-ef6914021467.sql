CREATE INDEX ai_jobs_company_idx ON public.ai_jobs(company_id);
CREATE OR REPLACE FUNCTION public.estim_finish_send(mid uuid,delivered boolean,failure text DEFAULT NULL,provider_id text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE m public.messages; cid uuid=public.my_company(); BEGIN
SELECT * INTO m FROM public.messages WHERE id=mid AND company_id=cid AND approved_by=auth.uid() AND delivery_status='sending' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
UPDATE public.messages SET delivery_status=CASE WHEN delivered THEN 'sent' ELSE 'not_sent' END,delivery_error=failure,provider_message_id=provider_id WHERE id=mid;
IF delivered THEN UPDATE public.threads SET status='skickad',read=true,last_message_at=now() WHERE id=m.thread_id AND company_id=cid; DELETE FROM public.drafts WHERE thread_id=m.thread_id AND company_id=cid AND text=m.text AND attachments=m.attachments; ELSE UPDATE public.threads SET status='svar' WHERE id=m.thread_id AND company_id=cid; END IF;
END $$;
REVOKE ALL ON FUNCTION public.estim_finish_send(uuid,boolean,text,text) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.estim_finish_send(uuid,boolean,text,text) TO authenticated;