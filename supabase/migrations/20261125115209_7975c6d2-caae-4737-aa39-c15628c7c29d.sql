-- estim Samtal (flag SAMTAL, off by default): customer phone calls become requests, tasks and quote drafts.
-- Only new tables, functions and one private storage bucket. Nothing existing is changed.
--
-- Isolation: every table has RLS through public.my_company(). Owners (role 'ägare') see the whole company, other
-- members only what is assigned to them. Calls, jobs and audio are written only by the server (service_role);
-- a signed-in user never writes them directly. The audio bucket has no storage policies at all: files are reached
-- only through short-lived signed links that the server creates after checking company and role.

-- Settings per company: automatic processing on/off and retention. The provider fields are written by the server.
CREATE TABLE public.samtal_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  auto_process boolean NOT NULL DEFAULT false,
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  provider text CHECK (provider IN ('test','lynes','telavox','telia_touchpoint','46elks')),
  provider_status text NOT NULL DEFAULT 'ej_ansluten' CHECK (provider_status IN ('ej_ansluten','ansluten','fel')),
  provider_error text CHECK (length(provider_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A phone number belongs to exactly one company and one employee (unique over all companies).
CREATE TABLE public.samtal_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE CASCADE
);

-- One received call. Idempotent on provider + provider call id. The employee is the assignee.
CREATE TABLE public.samtal_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid,
  number_id uuid,
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  provider_call_id text NOT NULL CHECK (length(provider_call_id) BETWEEN 1 AND 200),
  caller_phone text CHECK (length(caller_phone) <= 40),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds BETWEEN 0 AND 86400),
  audio_path text CHECK (audio_path IS NULL OR audio_path LIKE company_id::text || '/%'),
  status text NOT NULL DEFAULT 'mottagen' CHECK (status IN ('mottagen','bearbetas','klar','privat','fel')),
  classification text CHECK (classification IN ('jobb','privat','osaker')),
  transcript jsonb,
  extraction jsonb,
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  thread_id uuid,
  customer_id uuid,
  delete_after timestamptz NOT NULL,
  content_deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE SET NULL (user_id),
  FOREIGN KEY (company_id, number_id) REFERENCES public.samtal_numbers(company_id, id) ON DELETE SET NULL (number_id),
  FOREIGN KEY (company_id, thread_id) REFERENCES public.threads(company_id, id) ON DELETE SET NULL (thread_id),
  FOREIGN KEY (company_id, customer_id) REFERENCES public.customers(company_id, id) ON DELETE SET NULL (customer_id)
);
CREATE INDEX samtal_calls_company_idx ON public.samtal_calls (company_id, started_at DESC);
CREATE INDEX samtal_calls_user_idx ON public.samtal_calls (company_id, user_id);
CREATE INDEX samtal_calls_delete_idx ON public.samtal_calls (delete_after) WHERE content_deleted_at IS NULL;

-- Background processing queue, one job per call. Server only; no access for signed-in users.
CREATE TABLE public.samtal_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  call_id uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('paused','queued','running','done','failed')),
  step text NOT NULL DEFAULT 'transkribera' CHECK (step IN ('transkribera','klassificera','tolka','inkorg','klar')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, call_id) REFERENCES public.samtal_calls(company_id, id) ON DELETE CASCADE
);
CREATE INDEX samtal_jobs_ready_idx ON public.samtal_jobs (run_after) WHERE state IN ('queued','running');

-- Suggested next steps from a call; the assignee (or an owner) confirms or rejects with one tap.
CREATE TABLE public.samtal_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('ring_tillbaka','platsbesok','offert')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  due_at timestamptz,
  address text CHECK (length(address) <= 300),
  state text NOT NULL DEFAULT 'forslag' CHECK (state IN ('forslag','bekraftad','avvisad','klar')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, call_id) REFERENCES public.samtal_calls(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE SET NULL (user_id)
);
CREATE INDEX samtal_tasks_call_idx ON public.samtal_tasks (company_id, call_id);

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_settings FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_numbers FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_calls FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_jobs FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_tasks FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

-- Is the signed-in user an owner of their own (active) company? Reads only the user's own membership row.
CREATE FUNCTION public.samtal_is_owner() RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.company_members m WHERE m.user_id = auth.uid() AND m.company_id = public.my_company() AND m.role = 'ägare')
$$;

ALTER TABLE public.samtal_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_numbers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_tasks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.samtal_settings, public.samtal_numbers, public.samtal_calls, public.samtal_jobs, public.samtal_tasks FROM PUBLIC, anon, authenticated;

-- Settings: members of the company read; owners create and change only processing and retention.
GRANT SELECT, INSERT (company_id, auto_process, retention_days), UPDATE (auto_process, retention_days) ON public.samtal_settings TO authenticated;
CREATE POLICY samtal_settings_read ON public.samtal_settings FOR SELECT TO authenticated USING (company_id = (SELECT public.my_company()));
CREATE POLICY samtal_settings_add ON public.samtal_settings FOR INSERT TO authenticated WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.samtal_is_owner()));
CREATE POLICY samtal_settings_change ON public.samtal_settings FOR UPDATE TO authenticated
  USING (company_id = (SELECT public.my_company()) AND (SELECT public.samtal_is_owner())) WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.samtal_is_owner()));

-- Numbers: owners manage the company's numbers; an employee sees only their own.
GRANT SELECT, INSERT (company_id, user_id, phone_e164, active), UPDATE (user_id, phone_e164, active), DELETE ON public.samtal_numbers TO authenticated;
CREATE POLICY samtal_numbers_read ON public.samtal_numbers FOR SELECT TO authenticated
  USING (company_id = (SELECT public.my_company()) AND ((SELECT public.samtal_is_owner()) OR user_id = (SELECT auth.uid())));
CREATE POLICY samtal_numbers_add ON public.samtal_numbers FOR INSERT TO authenticated WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.samtal_is_owner()));
CREATE POLICY samtal_numbers_change ON public.samtal_numbers FOR UPDATE TO authenticated
  USING (company_id = (SELECT public.my_company()) AND (SELECT public.samtal_is_owner())) WITH CHECK (company_id = (SELECT public.my_company()) AND (SELECT public.samtal_is_owner()));
CREATE POLICY samtal_numbers_remove ON public.samtal_numbers FOR DELETE TO authenticated USING (company_id = (SELECT public.my_company()) AND (SELECT public.samtal_is_owner()));

-- Calls and tasks: read-only for signed-in users; owners see the company, an employee only their own.
GRANT SELECT ON public.samtal_calls, public.samtal_tasks TO authenticated;
CREATE POLICY samtal_calls_read ON public.samtal_calls FOR SELECT TO authenticated
  USING (company_id = (SELECT public.my_company()) AND ((SELECT public.samtal_is_owner()) OR user_id = (SELECT auth.uid())));
CREATE POLICY samtal_tasks_read ON public.samtal_tasks FOR SELECT TO authenticated
  USING (company_id = (SELECT public.my_company()) AND ((SELECT public.samtal_is_owner()) OR user_id = (SELECT auth.uid())));
-- samtal_jobs: RLS on and no policy, so no access for signed-in users.

-- Confirm, reject or complete a suggested task (one tap). Only the assignee or an owner of the same company.
CREATE FUNCTION public.samtal_decide_task(p_task uuid, p_decision text) RETURNS public.samtal_tasks
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.my_company(); t public.samtal_tasks;
BEGIN
  IF cid IS NULL OR auth.uid() IS NULL OR p_decision NOT IN ('bekraftad','avvisad','klar') THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE public.samtal_tasks SET state = p_decision, decided_by = auth.uid(), decided_at = now()
   WHERE id = p_task AND company_id = cid AND (user_id = auth.uid() OR public.samtal_is_owner())
     AND (state = 'forslag' OR (state = 'bekraftad' AND p_decision = 'klar'))
   RETURNING * INTO t;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
  RETURN t;
END $$;
REVOKE ALL ON FUNCTION public.samtal_decide_task(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.samtal_decide_task(uuid, text) TO authenticated;

-- Server only: register a call from an adapter. Company and employee come from the receiving number in our own
-- database, never from the payload. Unknown or inactive numbers and inactive companies are not stored at all.
-- Without automatic processing the call is kept with a paused job.
CREATE FUNCTION public.samtal_register_call(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n public.samtal_numbers; s public.samtal_settings; call_id uuid; started timestamptz;
BEGIN
  SELECT * INTO n FROM public.samtal_numbers WHERE phone_e164 = payload->>'to_phone' AND active;
  IF NOT FOUND OR NOT public.estim_company_active(n.company_id) THEN RETURN jsonb_build_object('ignored', 'unknown_number'); END IF;
  SELECT * INTO s FROM public.samtal_settings WHERE company_id = n.company_id;
  started := (payload->>'started_at')::timestamptz;
  INSERT INTO public.samtal_calls (company_id, user_id, number_id, provider, provider_call_id, caller_phone, started_at, ended_at, duration_seconds, delete_after)
  VALUES (n.company_id, n.user_id, n.id, payload->>'provider', payload->>'provider_call_id', nullif(payload->>'from_phone', ''), started,
          (payload->>'ended_at')::timestamptz, (payload->>'duration_seconds')::integer, now() + make_interval(days => coalesce(s.retention_days, 30)))
  ON CONFLICT (provider, provider_call_id) DO NOTHING
  RETURNING id INTO call_id;
  IF call_id IS NULL THEN RETURN jsonb_build_object('duplicate', true); END IF;
  INSERT INTO public.samtal_jobs (company_id, call_id, state) VALUES (n.company_id, call_id, CASE WHEN coalesce(s.auto_process, false) THEN 'queued' ELSE 'paused' END);
  RETURN jsonb_build_object('duplicate', false, 'call_id', call_id, 'company_id', n.company_id, 'auto_process', coalesce(s.auto_process, false));
END $$;

-- Server only: claim up to p_limit ready jobs under a lease (concurrent workers never take the same job).
CREATE FUNCTION public.samtal_claim_jobs(p_limit integer, p_lease_seconds integer) RETURNS SETOF public.samtal_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.samtal_jobs j SET state = 'running', lease_token = gen_random_uuid(), lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 10)), attempts = j.attempts + 1
   WHERE j.id IN (SELECT id FROM public.samtal_jobs
                   WHERE run_after <= now() AND (state = 'queued' OR (state = 'running' AND lease_until < now()))
                   ORDER BY run_after LIMIT least(greatest(p_limit, 1), 50) FOR UPDATE SKIP LOCKED)
  RETURNING j.*;
END $$;

-- Server only: end a claimed job (holder of the lease only): next step, done, retry later or failed.
CREATE FUNCTION public.samtal_release_job(p_job uuid, p_token uuid, p_state text, p_step text, p_error text, p_retry_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_state NOT IN ('queued','done','failed') THEN RAISE EXCEPTION 'Invalid state'; END IF;
  UPDATE public.samtal_jobs SET state = p_state, step = coalesce(p_step, step), error_code = p_error, lease_token = NULL, lease_until = NULL,
         run_after = now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 0), 0))
   WHERE id = p_job AND lease_token = p_token AND state = 'running';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.samtal_register_call(jsonb), public.samtal_claim_jobs(integer, integer), public.samtal_release_job(uuid, uuid, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_register_call(jsonb), public.samtal_claim_jobs(integer, integer), public.samtal_release_job(uuid, uuid, text, text, text, integer) TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.samtal_settings, public.samtal_numbers, public.samtal_calls, public.samtal_jobs, public.samtal_tasks TO service_role;