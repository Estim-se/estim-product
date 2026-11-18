ALTER TABLE public.audit_log ADD COLUMN actor_name text NOT NULL DEFAULT '';
UPDATE public.audit_log SET actor_name=approved_name, approved_name=CASE WHEN event='Svar godkänt' THEN approved_name ELSE '' END WHERE approved_name<>'';
CREATE OR REPLACE FUNCTION public.estim_audit_name() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
SELECT display_name INTO NEW.actor_name FROM public.profiles WHERE id=auth.uid(); NEW.actor_name=coalesce(NEW.actor_name,''); NEW.approved_name=CASE WHEN NEW.event='Svar godkänt' THEN NEW.actor_name ELSE '' END; RETURN NEW; END $$;
WITH numbers AS (SELECT company_id,thread_id,(1000+row_number() OVER(PARTITION BY company_id ORDER BY min(created_at),thread_id))::text AS nr FROM public.quotes GROUP BY company_id,thread_id)
UPDATE public.drafts d SET attachments=(SELECT coalesce(jsonb_agg(CASE WHEN a.value LIKE 'Offert #% ' THEN to_jsonb(a.value) WHEN a.value LIKE 'Offert #%' THEN to_jsonb('Offert #'||n.nr) ELSE to_jsonb(a.value) END),'[]'::jsonb) FROM jsonb_array_elements_text(d.attachments) a(value)) FROM numbers n WHERE d.thread_id=n.thread_id AND d.company_id=n.company_id;
WITH numbers AS (SELECT company_id,thread_id,(1000+row_number() OVER(PARTITION BY company_id ORDER BY min(created_at),thread_id))::text AS nr FROM public.quotes GROUP BY company_id,thread_id)
UPDATE public.messages m SET attachments=(SELECT coalesce(jsonb_agg(CASE WHEN a.value LIKE 'Offert #%' THEN to_jsonb('Offert #'||n.nr) ELSE to_jsonb(a.value) END),'[]'::jsonb) FROM jsonb_array_elements_text(m.attachments) a(value)) FROM numbers n WHERE m.thread_id=n.thread_id AND m.company_id=n.company_id;
WITH numbers AS (SELECT company_id,thread_id,(1000+row_number() OVER(PARTITION BY company_id ORDER BY min(created_at),thread_id))::text AS nr FROM public.quotes GROUP BY company_id,thread_id)
UPDATE public.quotes q SET nr=n.nr FROM numbers n WHERE q.thread_id=n.thread_id AND q.company_id=n.company_id;
CREATE OR REPLACE FUNCTION public.estim_quote(tid uuid,payload jsonb) RETURNS integer LANGUAGE plpgsql SET search_path=public AS $$ DECLARE cid uuid=public.my_company(); old public.quotes; ver integer; line jsonb; number text; BEGIN
PERFORM 1 FROM public.companies WHERE id=cid FOR UPDATE;
PERFORM 1 FROM public.threads WHERE id=tid AND company_id=cid FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
IF jsonb_typeof(payload->'lines') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid lines'; END IF;
FOR line IN SELECT * FROM jsonb_array_elements(payload->'lines') LOOP IF coalesce((line->>'q')::numeric,-1)<0 OR coalesce((line->>'p')::numeric,-1)<0 OR length(trim(line->>'t'))<1 THEN RAISE EXCEPTION 'Invalid quote line'; END IF; END LOOP;
SELECT * INTO old FROM public.quotes WHERE thread_id=tid AND company_id=cid ORDER BY version DESC LIMIT 1;
ver=coalesce(old.version,0)+1;
IF old.id IS NOT NULL THEN number=old.nr; ELSE SELECT (coalesce(max(nr::bigint),1000)+1)::text INTO number FROM public.quotes WHERE company_id=cid; END IF;
INSERT INTO public.quotes(company_id,thread_id,nr,version,owners,add_on,prisform,lines,status) VALUES(cid,tid,number,ver,(payload->>'owners')::integer,coalesce((payload->>'addOn')::boolean,false),payload->>'prisform',payload->'lines','utkast');
INSERT INTO public.audit_log(company_id,user_id,event,"before","after") VALUES(cid,auth.uid(),'Offert ändrad',to_jsonb(old),jsonb_build_object('thread_id',tid,'version',ver,'quote',payload||jsonb_build_object('nr',number)));
RETURN ver; END $$;