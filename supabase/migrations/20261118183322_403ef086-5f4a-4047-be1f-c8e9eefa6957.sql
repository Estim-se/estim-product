ALTER FUNCTION public.estim_save_invitation(uuid,uuid,text,text,text,timestamptz,uuid) CALLED ON NULL INPUT;
CREATE OR REPLACE FUNCTION public.estim_save_invitation(cid uuid,actor uuid,recipient text,invited_role text,hashed text,expiry timestamptz,previous_id uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ DECLARE iid uuid; platform boolean; BEGIN
PERFORM 1 FROM public.companies WHERE id=cid AND active FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Inactive company'; END IF;
platform=EXISTS(SELECT 1 FROM public.platform_admins WHERE user_id=actor);
IF NOT platform AND NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id=cid AND user_id=actor AND role='ägare') THEN RAISE EXCEPTION 'Not allowed'; END IF;
IF invited_role NOT IN ('ägare','användare') OR (NOT platform AND invited_role<>'användare') THEN RAISE EXCEPTION 'Not allowed'; END IF;
IF EXISTS(SELECT 1 FROM public.company_members m JOIN auth.users u ON u.id=m.user_id WHERE lower(u.email)=lower(recipient)) THEN RAISE EXCEPTION 'Already a member'; END IF;
IF previous_id IS NULL THEN INSERT INTO public.company_invitations(company_id,email,role,token_hash,expires_at,invited_by) VALUES(cid,lower(recipient),invited_role,hashed,expiry,actor) RETURNING id INTO iid; ELSE UPDATE public.company_invitations SET token_hash=hashed,expires_at=expiry WHERE id=previous_id AND company_id=cid AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id INTO iid; END IF;
IF iid IS NULL THEN RAISE EXCEPTION 'Invalid invitation'; END IF; RETURN iid; END $$;