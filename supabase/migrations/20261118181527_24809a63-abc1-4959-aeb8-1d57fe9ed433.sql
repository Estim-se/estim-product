CREATE TABLE public.platform_admin_invitations(email text PRIMARY KEY,expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',accepted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON public.platform_admin_invitations TO service_role;
ALTER TABLE public.platform_admin_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_invitation_deny ON public.platform_admin_invitations FOR ALL TO authenticated USING(false) WITH CHECK(false);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.platform_admin_invitations FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
INSERT INTO public.platform_admins(user_id) SELECT id FROM auth.users WHERE lower(email) IN ('moi-ali@hotmail.com','selden.dennis@gmail.com','hassan@futureventures.se') ON CONFLICT DO NOTHING;
INSERT INTO public.platform_admin_invitations(email) VALUES('selden.dennis@gmail.com'),('hassan@futureventures.se') ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.estim_registration_gate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
IF NEW.invited_at IS NULL OR NOT(EXISTS(SELECT 1 FROM public.company_invitations WHERE email=lower(NEW.email) AND expires_at>now() AND accepted_at IS NULL AND revoked_at IS NULL) OR EXISTS(SELECT 1 FROM public.platform_admin_invitations WHERE email=lower(NEW.email) AND expires_at>now() AND accepted_at IS NULL)) THEN RAISE EXCEPTION 'Registration requires an invitation'; END IF; RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.estim_new_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
INSERT INTO public.profiles(id,display_name) VALUES(NEW.id,coalesce(NEW.raw_user_meta_data->>'display_name',''));
IF NEW.invited_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.platform_admin_invitations WHERE email=lower(NEW.email) AND expires_at>now() AND accepted_at IS NULL) THEN INSERT INTO public.platform_admins(user_id) VALUES(NEW.id); UPDATE public.platform_admin_invitations SET accepted_at=now() WHERE email=lower(NEW.email); END IF; RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.estim_manage_member(cid uuid,uid uuid,new_role text,actor uuid) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ DECLARE old_role text; normalized text=nullif(new_role,''); BEGIN
PERFORM 1 FROM public.companies WHERE id=cid FOR UPDATE;
SELECT role INTO old_role FROM public.company_members WHERE company_id=cid AND user_id=uid;
IF old_role IS NULL OR (normalized IS NOT NULL AND normalized NOT IN ('ägare','användare')) THEN RAISE EXCEPTION 'Invalid member'; END IF;
IF old_role='ägare' AND normalized IS DISTINCT FROM 'ägare' AND (SELECT count(*) FROM public.company_members WHERE company_id=cid AND role='ägare')<=1 THEN RAISE EXCEPTION 'Last owner'; END IF;
IF normalized IS NULL THEN DELETE FROM public.company_members WHERE company_id=cid AND user_id=uid; UPDATE public.profiles SET company_id=NULL WHERE id=uid; ELSE UPDATE public.company_members SET role=normalized WHERE company_id=cid AND user_id=uid; END IF;
INSERT INTO public.audit_log(company_id,user_id,event,"before","after") VALUES(cid,actor,CASE WHEN normalized IS NULL THEN 'Användare borttagen' ELSE 'Roll ändrad' END,jsonb_build_object('user_id',uid,'role',old_role),jsonb_build_object('user_id',uid,'role',normalized)); END $$;