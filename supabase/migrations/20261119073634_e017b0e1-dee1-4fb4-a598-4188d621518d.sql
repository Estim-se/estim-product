CREATE OR REPLACE FUNCTION public.estim_audit_name()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$ BEGIN
IF NEW."after"->>'by'='ai' THEN NEW.actor_name='AI';
ELSE SELECT display_name INTO NEW.actor_name FROM public.profiles WHERE id=NEW.user_id; END IF;
NEW.actor_name=coalesce(NEW.actor_name,'');
NEW.approved_name=CASE WHEN NEW.event='Svar godkänt' THEN NEW.actor_name ELSE '' END; RETURN NEW; END $function$;

CREATE OR REPLACE FUNCTION public.estim_quote(tid uuid, payload jsonb)
 RETURNS integer LANGUAGE plpgsql SET search_path TO 'public'
AS $function$ DECLARE cid uuid=public.my_company(); old public.quotes; ver integer; line jsonb; number text; by_ai boolean=coalesce(payload->>'by','')='ai'; clean jsonb=payload-'by'; BEGIN
PERFORM 1 FROM public.companies WHERE id=cid FOR UPDATE;
PERFORM 1 FROM public.threads WHERE id=tid AND company_id=cid FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
IF jsonb_typeof(clean->'lines') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid lines'; END IF;
FOR line IN SELECT * FROM jsonb_array_elements(clean->'lines') LOOP IF coalesce((line->>'q')::numeric,-1)<0 OR coalesce((line->>'p')::numeric,-1)<0 OR length(trim(line->>'t'))<1 THEN RAISE EXCEPTION 'Invalid quote line'; END IF; END LOOP;
SELECT * INTO old FROM public.quotes WHERE thread_id=tid AND company_id=cid ORDER BY version DESC LIMIT 1;
ver=coalesce(old.version,0)+1;
IF old.id IS NOT NULL THEN number=old.nr; ELSE SELECT (coalesce(max(nr::bigint),1000)+1)::text INTO number FROM public.quotes WHERE company_id=cid; END IF;
INSERT INTO public.quotes(company_id,thread_id,nr,version,owners,add_on,prisform,lines,status) VALUES(cid,tid,number,ver,(clean->>'owners')::integer,coalesce((clean->>'addOn')::boolean,false),clean->>'prisform',clean->'lines','utkast');
INSERT INTO public.audit_log(company_id,user_id,event,"before","after") VALUES(cid,auth.uid(),CASE WHEN by_ai AND old.id IS NULL THEN 'Offert skapad' ELSE 'Offert ändrad' END,to_jsonb(old),jsonb_build_object('thread_id',tid,'version',ver,'quote',clean||jsonb_build_object('nr',number))||CASE WHEN by_ai THEN jsonb_build_object('by','ai') ELSE '{}'::jsonb END);
RETURN ver; END $function$;

UPDATE public.audit_log SET actor_name='AI', "after"="after"||'{"by":"ai"}'::jsonb
WHERE event='Offert ändrad' AND "before" IS NULL AND ("after"->'quote'->>'nr') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.ai_calls a WHERE a.step='interpret-request' AND a.request_id=("after"->>'thread_id') AND abs(extract(epoch FROM a.created_at-audit_log.created_at))<10);