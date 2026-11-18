ALTER TABLE public.companies ADD COLUMN active boolean NOT NULL DEFAULT true;
CREATE TABLE public.platform_admins(user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON public.platform_admins TO authenticated; GRANT ALL ON public.platform_admins TO service_role;
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_admin_self ON public.platform_admins FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.platform_admins FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE TABLE public.company_invitations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES public.companies(id),email text NOT NULL,role text NOT NULL,token_hash text NOT NULL UNIQUE,invited_by uuid NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',accepted_at timestamptz,revoked_at timestamptz,user_id uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
GRANT ALL ON public.company_invitations TO service_role;
ALTER TABLE public.company_invitations ENABLE ROW LEVEL SECURITY;
CREATE INDEX company_invitations_company ON public.company_invitations(company_id);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.company_invitations FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE UNIQUE INDEX company_members_single_company ON public.company_members(user_id);
CREATE OR REPLACE FUNCTION public.my_company() RETURNS uuid LANGUAGE sql STABLE SET search_path=public AS $$ SELECT m.company_id FROM public.company_members m JOIN public.companies c ON c.id=m.company_id AND c.active WHERE m.user_id=auth.uid() $$;
-- Avoid recursion: checking activation uses a narrow definer helper, never a tenant-wide read policy.
CREATE OR REPLACE FUNCTION public.estim_company_active(cid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$ SELECT coalesce((SELECT active FROM public.companies WHERE id=cid),false) $$;
REVOKE ALL ON FUNCTION public.estim_company_active(uuid) FROM PUBLIC,anon; GRANT EXECUTE ON FUNCTION public.estim_company_active(uuid) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION public.my_company() RETURNS uuid LANGUAGE sql STABLE SET search_path=public AS $$ SELECT company_id FROM public.company_members WHERE user_id=auth.uid() AND public.estim_company_active(company_id) $$;
DROP POLICY company_create ON public.companies; DROP POLICY membership_create ON public.company_members;
REVOKE INSERT ON public.companies FROM authenticated; REVOKE INSERT ON public.company_members FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.estim_onboard(jsonb) FROM PUBLIC,anon,authenticated;
-- Reject self-registration even if the externally managed signup switch is still enabled.
CREATE OR REPLACE FUNCTION public.estim_new_profile() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
IF current_user NOT IN ('supabase_admin','service_role','postgres') AND coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' AND coalesce((current_setting('request.jwt.claims',true)::jsonb)->>'role','')<>'service_role' AND NEW.invited_at IS NULL THEN RAISE EXCEPTION 'Registration requires an invitation'; END IF;
INSERT INTO public.profiles(id,display_name) VALUES(NEW.id,coalesce(NEW.raw_user_meta_data->>'display_name','')); RETURN NEW; END $$;
-- Auth creation enforcement is handled by a separate trigger because definer current_user is the function owner.
CREATE OR REPLACE FUNCTION public.estim_registration_gate() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN
IF current_user NOT IN ('supabase_admin','service_role','postgres') AND coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' AND coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb)->>'role','')<>'service_role' AND NEW.invited_at IS NULL THEN RAISE EXCEPTION 'Registration requires an invitation'; END IF; RETURN NEW; END $$;
CREATE TRIGGER estim_invite_only BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.estim_registration_gate();
CREATE OR REPLACE FUNCTION public.estim_accept_invitation(iid uuid,uid uuid,expected_hash text,display text) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$ DECLARE inv public.company_invitations; BEGIN
SELECT * INTO inv FROM public.company_invitations WHERE id=iid FOR UPDATE;
IF inv.id IS NULL OR inv.token_hash<>expected_hash OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at<=now() OR NOT public.estim_company_active(inv.company_id) THEN RAISE EXCEPTION 'Invalid invitation'; END IF;
IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=uid AND lower(email)=inv.email) THEN RAISE EXCEPTION 'Wrong recipient'; END IF;
IF EXISTS(SELECT 1 FROM public.company_members WHERE user_id=uid) THEN RAISE EXCEPTION 'Already a member'; END IF;
INSERT INTO public.company_members(company_id,user_id,role) VALUES(inv.company_id,uid,inv.role);
UPDATE public.profiles SET display_name=display WHERE id=uid;
UPDATE public.company_invitations SET accepted_at=now(),user_id=uid WHERE id=iid;
INSERT INTO public.audit_log(company_id,user_id,event,actor_name,"after") VALUES(inv.company_id,uid,'Inbjudan accepterad',display,jsonb_build_object('invitation_id',iid)); RETURN inv.company_id; END $$;
REVOKE ALL ON FUNCTION public.estim_accept_invitation(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.estim_accept_invitation(uuid,uuid,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.estim_manage_member(cid uuid,uid uuid,new_role text,actor uuid) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$ DECLARE old_role text; BEGIN
PERFORM 1 FROM public.companies WHERE id=cid FOR UPDATE;
SELECT role INTO old_role FROM public.company_members WHERE company_id=cid AND user_id=uid;
IF old_role IS NULL OR (new_role IS NOT NULL AND new_role NOT IN ('ägare','användare')) THEN RAISE EXCEPTION 'Invalid member'; END IF;
IF old_role='ägare' AND new_role IS DISTINCT FROM 'ägare' AND (SELECT count(*) FROM public.company_members WHERE company_id=cid AND role='ägare')<=1 THEN RAISE EXCEPTION 'Last owner'; END IF;
IF new_role IS NULL THEN DELETE FROM public.company_members WHERE company_id=cid AND user_id=uid; UPDATE public.profiles SET company_id=NULL WHERE id=uid;
ELSE UPDATE public.company_members SET role=new_role WHERE company_id=cid AND user_id=uid; END IF;
INSERT INTO public.audit_log(company_id,user_id,event,"before","after") VALUES(cid,actor,CASE WHEN new_role IS NULL THEN 'Användare borttagen' ELSE 'Roll ändrad' END,jsonb_build_object('user_id',uid,'role',old_role),jsonb_build_object('user_id',uid,'role',new_role)); END $$;
REVOKE ALL ON FUNCTION public.estim_manage_member(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.estim_manage_member(uuid,uuid,text,uuid) TO service_role;
-- Capture the explicitly authorized actor during service-role administration.
CREATE OR REPLACE FUNCTION public.estim_audit_name() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN SELECT display_name INTO NEW.actor_name FROM public.profiles WHERE id=NEW.user_id; NEW.actor_name=coalesce(NEW.actor_name,''); NEW.approved_name=CASE WHEN NEW.event='Svar godkänt' THEN NEW.actor_name ELSE '' END; RETURN NEW; END $$;