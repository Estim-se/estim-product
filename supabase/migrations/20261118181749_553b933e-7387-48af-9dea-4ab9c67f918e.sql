ALTER TABLE public.audit_log ALTER COLUMN company_id DROP NOT NULL; ALTER TABLE public.audit_log ALTER COLUMN user_id DROP NOT NULL;
CREATE TABLE public.login_attempts(email_hash text PRIMARY KEY,failures integer NOT NULL DEFAULT 0,locked_until timestamptz,lease_id uuid,lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON public.login_attempts TO service_role;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
CREATE POLICY login_attempts_deny ON public.login_attempts FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.login_attempts FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE OR REPLACE FUNCTION public.estim_login_begin(h text) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$ DECLARE attempt public.login_attempts; lease uuid=gen_random_uuid(); BEGIN
INSERT INTO public.login_attempts(email_hash) VALUES(h) ON CONFLICT DO NOTHING;
SELECT * INTO attempt FROM public.login_attempts WHERE email_hash=h FOR UPDATE;
IF attempt.locked_until>now() OR attempt.lease_until>now() THEN RETURN NULL; END IF;
UPDATE public.login_attempts SET failures=CASE WHEN locked_until IS NOT NULL AND locked_until<=now() THEN 0 ELSE failures END,locked_until=NULL,lease_id=lease,lease_until=now()+interval '30 seconds' WHERE email_hash=h; RETURN lease; END $$;
CREATE OR REPLACE FUNCTION public.estim_login_finish(h text,lease uuid,success boolean,email_address text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ DECLARE attempt public.login_attempts; uid uuid; cid uuid; BEGIN
SELECT * INTO attempt FROM public.login_attempts WHERE email_hash=h AND lease_id=lease FOR UPDATE;
IF attempt.email_hash IS NULL THEN RETURN; END IF;
IF success THEN UPDATE public.login_attempts SET failures=0,locked_until=NULL,lease_id=NULL,lease_until=NULL WHERE email_hash=h; RETURN; END IF;
UPDATE public.login_attempts SET failures=failures+1,locked_until=CASE WHEN failures+1>=5 THEN now()+interval '15 minutes' ELSE NULL END,lease_id=NULL,lease_until=NULL WHERE email_hash=h;
IF attempt.failures+1>=5 THEN
SELECT id INTO uid FROM auth.users WHERE lower(email)=lower(email_address); SELECT company_id INTO cid FROM public.company_members WHERE user_id=uid;
INSERT INTO public.audit_log(company_id,user_id,event,"after") VALUES(cid,uid,'Inloggning låst',jsonb_build_object('email_hash',h,'failed_attempts',5,'lock_minutes',15)); END IF; END $$;
REVOKE ALL ON FUNCTION public.estim_login_begin(text),public.estim_login_finish(text,uuid,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.estim_login_begin(text),public.estim_login_finish(text,uuid,boolean,text) TO service_role;