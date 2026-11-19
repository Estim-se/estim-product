-- ============ E-post via Nylas: schema (v4, built on the channel/ai_jobs system) ============
-- To be run through Lovable as ONE new migration. Requires the existing estim_receive, ai_jobs and messages.delivery_status.
-- Mail is received through the existing estim_receive (thread + AI job); this migration only adds the mailbox connection,
-- attachment storage and a few mail columns.

-- Received mail: attachments saved in the private bucket (names only go in "attachments", which the UI shows) and the original subject,
-- so replies keep the same subject (Gmail/Outlook group threads by subject and headers).
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS attachment_files jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS email_subject text;

-- 1) The company's connected mailbox. Closed to every browser user: grant_id is a key in practice.
CREATE TABLE IF NOT EXISTS public.email_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL UNIQUE REFERENCES public.companies(id),
  grant_id text NOT NULL UNIQUE,
  email text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft', 'imap')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  watch_address text,
  connected_by uuid,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.email_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_connections_deny ON public.email_connections FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.email_connections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_connections TO service_role;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.email_connections
  FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

-- 2) One-time OAuth "state" (CSRF protection). Only a hash is stored.
CREATE TABLE IF NOT EXISTS public.oauth_states (
  state_hash text PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY oauth_states_deny ON public.oauth_states FOR ALL TO authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.oauth_states FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.oauth_states TO service_role;

-- (The private bucket "mail-attachments" and its read policy are NOT part of this migration: see nylas-storage.sql, run in the Supabase SQL editor.)

-- ============ Functions ============

-- Members may see THEIR mailbox status (never grant_id).
CREATE OR REPLACE FUNCTION public.estim_email_connection() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT to_jsonb(x) FROM (
    SELECT c.email, c.provider, c.status, c.watch_address
    FROM public.email_connections c WHERE c.company_id = public.my_company()
  ) x
$$;
REVOKE ALL ON FUNCTION public.estim_email_connection() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estim_email_connection() TO authenticated;

-- Delivery status from Nylas (send_success / send_failed / bounce_detected). Uses the existing delivery_status values.
CREATE OR REPLACE FUNCTION public.estim_email_status(p_grant text, p_msg text, new_status text, err text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF new_status NOT IN ('sent', 'not_sent') THEN RETURN; END IF;
  UPDATE public.messages m
  SET delivery_status = new_status, delivery_error = CASE WHEN new_status = 'not_sent' THEN left(err, 200) ELSE m.delivery_error END
  FROM public.email_connections c
  WHERE c.grant_id = p_grant AND c.company_id = m.company_id
    AND m.provider_message_id = p_msg AND m."from" = 'vv' AND m.channel = 'email';
END $$;
REVOKE ALL ON FUNCTION public.estim_email_status(text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estim_email_status(text, text, text, text) TO service_role;

-- The connection expired or was removed at the provider
CREATE OR REPLACE FUNCTION public.estim_email_grant_state(p_grant text, new_state text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_company uuid;
BEGIN
  IF new_state NOT IN ('expired', 'revoked') THEN RETURN; END IF;
  UPDATE public.email_connections SET status = new_state, last_event_at = now()
  WHERE grant_id = p_grant AND status <> 'revoked' RETURNING company_id INTO v_company;
  IF v_company IS NOT NULL THEN
    INSERT INTO public.audit_log (company_id, event, "after")
    VALUES (v_company, CASE WHEN new_state = 'expired' THEN 'E-postanslutning har gått ut' ELSE 'E-postanslutning borttagen' END,
            jsonb_build_object('state', new_state));
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.estim_email_grant_state(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estim_email_grant_state(text, text) TO service_role;
