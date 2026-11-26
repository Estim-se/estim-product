-- estim Samtal A7 hardening: durable webhook security and database-enforced provider tenancy.
-- CANDIDATE ONLY. Not a migration. Applies after priority-1-coordinated-v2.sql and a1-provider-transcript.sql and is
-- tested only in disposable local PostgreSQL (src/test/samtal-a7-hardening.test.ts).
--
-- Everything here is service-role only: RLS is enabled with no policies, and nothing is granted to anon/authenticated.
-- No raw webhook bodies are stored; events are the validated normalised form, and their content (transcript,
-- customer number, recording link) is stripped as soon as the call is ingested and deleted after a bounded retention.

-- 1. Providers that are wired to webhooks, with their durable limits. A provider listed here is subject to the
--    tenant-binding trigger below; the folder test adapter ('test') is never listed.
CREATE TABLE public.samtal_webhook_providers (
  provider text PRIMARY KEY CHECK (provider ~ '^[a-z0-9_]{1,40}$' AND provider <> 'test'),
  per_minute integer NOT NULL DEFAULT 600 CHECK (per_minute BETWEEN 1 AND 100000),
  max_pending integer NOT NULL DEFAULT 5000 CHECK (max_pending BETWEEN 1 AND 1000000),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 50),
  retention_hours integer NOT NULL DEFAULT 72 CHECK (retention_hours BETWEEN 1 AND 720),
  replay_seconds integer NOT NULL DEFAULT 900 CHECK (replay_seconds BETWEEN 60 AND 86400)
);

-- 2. Trusted enrolments: one provider account per employee, created by us (never from a payload).
CREATE TABLE public.samtal_provider_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL REFERENCES public.samtal_webhook_providers(provider) ON DELETE CASCADE,
  account_ref text NOT NULL CHECK (length(account_ref) BETWEEN 1 AND 200),
  number_id uuid NOT NULL,
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, account_ref),
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE CASCADE,
  -- The enrolled business number must be the same company's own number.
  FOREIGN KEY (company_id, number_id) REFERENCES public.samtal_numbers(company_id, id) ON DELETE CASCADE
);
-- Numbers that never identify a tenant (e.g. the shared Ring estim number).
CREATE TABLE public.samtal_shared_numbers (phone_e164 text PRIMARY KEY CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'));

-- 3. Call and recording bindings: the first trusted resolution of a provider call fixes its company, employee and
--    recording. Later events can never move it.
CREATE TABLE public.samtal_call_bindings (
  provider text NOT NULL REFERENCES public.samtal_webhook_providers(provider) ON DELETE CASCADE,
  provider_call_id text NOT NULL CHECK (length(provider_call_id) BETWEEN 1 AND 200),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  number_id uuid NOT NULL,
  account_id uuid REFERENCES public.samtal_provider_accounts(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  recording_id text CHECK (length(recording_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_call_id),
  UNIQUE (provider, recording_id)
);

-- 4. Durable event store, replay keys, rate windows and per-call processing leases.
CREATE TABLE public.samtal_webhook_events (
  provider text NOT NULL REFERENCES public.samtal_webhook_providers(provider) ON DELETE CASCADE,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  provider_call_id text NOT NULL CHECK (length(provider_call_id) BETWEEN 1 AND 200),
  event jsonb CHECK (event IS NULL OR length(event::text) <= 262144),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','seen','done','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  run_after timestamptz NOT NULL DEFAULT now(),
  result_code text CHECK (result_code ~ '^[a-z0-9_:]{1,80}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  purge_after timestamptz NOT NULL,
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX samtal_webhook_events_call ON public.samtal_webhook_events (provider, provider_call_id);
CREATE INDEX samtal_webhook_events_due ON public.samtal_webhook_events (run_after) WHERE state = 'pending';
CREATE INDEX samtal_webhook_events_purge ON public.samtal_webhook_events (purge_after);
CREATE TABLE public.samtal_webhook_replays (
  provider text NOT NULL, replay_key text NOT NULL CHECK (replay_key ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('claimed','accepted')),
  claim_until timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY (provider, replay_key)
);
CREATE INDEX samtal_webhook_replays_expiry ON public.samtal_webhook_replays (expires_at);
CREATE TABLE public.samtal_webhook_rate (
  provider text NOT NULL, window_start timestamptz NOT NULL, hits integer NOT NULL,
  PRIMARY KEY (provider, window_start)
);
CREATE TABLE public.samtal_webhook_call_leases (
  provider text NOT NULL, provider_call_id text NOT NULL, token uuid NOT NULL, lease_until timestamptz NOT NULL,
  PRIMARY KEY (provider, provider_call_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['samtal_webhook_providers','samtal_provider_accounts','samtal_shared_numbers','samtal_call_bindings',
    'samtal_webhook_events','samtal_webhook_replays','samtal_webhook_rate','samtal_webhook_call_leases'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- 5. Database-enforced tenancy: a webhook provider's call row can only exist in the company and for the employee and
--    number its binding names. ingest_recover / ingest_transcript resolve the company from the number; if that ever
--    differs from the binding the insert fails and the whole registration rolls back.
CREATE FUNCTION public.samtal_enforce_provider_binding() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE b samtal_call_bindings;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM samtal_webhook_providers WHERE provider = NEW.provider) THEN RETURN NEW; END IF;
  SELECT * INTO b FROM samtal_call_bindings WHERE provider = NEW.provider AND provider_call_id = NEW.provider_call_id;
  IF b.provider IS NULL THEN RAISE EXCEPTION 'provider_call_unbound' USING ERRCODE = 'P0001'; END IF;
  IF b.company_id <> NEW.company_id OR b.user_id IS DISTINCT FROM NEW.user_id OR b.number_id IS DISTINCT FROM NEW.number_id THEN
    RAISE EXCEPTION 'provider_call_tenant_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER samtal_calls_provider_binding BEFORE INSERT OR UPDATE OF company_id, user_id, number_id, provider, provider_call_id
  ON public.samtal_calls FOR EACH ROW EXECUTE FUNCTION public.samtal_enforce_provider_binding();

-- Resolves identity entirely from our own enrolments and binds the call (and its recording) once.
-- The customer's number is not a parameter at all.
CREATE FUNCTION public.samtal_bind_provider_call(p_provider text, p_call text, p_direction text,
  p_account_ref text DEFAULT NULL, p_business_number text DEFAULT NULL, p_recording_id text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE acc samtal_provider_accounts; num samtal_numbers; b samtal_call_bindings; shared boolean; n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM samtal_webhook_providers WHERE provider = p_provider) THEN RETURN jsonb_build_object('code','unsupported_provider'); END IF;
  IF p_call IS NULL OR length(p_call) NOT BETWEEN 1 AND 200 OR p_direction IS NULL OR p_direction NOT IN ('inbound','outbound') THEN RETURN jsonb_build_object('code','call_invalid'); END IF;
  shared := p_business_number IS NOT NULL AND EXISTS (SELECT 1 FROM samtal_shared_numbers WHERE phone_e164 = p_business_number);
  IF p_account_ref IS NOT NULL THEN
    SELECT * INTO acc FROM samtal_provider_accounts WHERE provider = p_provider AND account_ref = p_account_ref AND revoked_at IS NULL;
    IF acc.id IS NULL THEN RETURN jsonb_build_object('code', CASE WHEN shared THEN 'shared_number_unresolvable' ELSE 'identity_unknown' END); END IF;
    IF acc.verified_at IS NULL THEN RETURN jsonb_build_object('code','identity_unverified'); END IF;
    SELECT * INTO num FROM samtal_numbers WHERE id = acc.number_id AND company_id = acc.company_id AND active;
    IF num.id IS NULL THEN RETURN jsonb_build_object('code','identity_unknown'); END IF;
    IF p_business_number IS NOT NULL AND NOT shared AND p_business_number <> num.phone_e164 THEN RETURN jsonb_build_object('code','identity_conflict'); END IF;
  ELSE
    IF p_business_number IS NULL THEN RETURN jsonb_build_object('code','identity_missing'); END IF;
    IF shared THEN RETURN jsonb_build_object('code','shared_number_unresolvable'); END IF;
    SELECT count(*) INTO n FROM samtal_provider_accounts a JOIN samtal_numbers s ON s.id = a.number_id AND s.company_id = a.company_id
      WHERE a.provider = p_provider AND s.phone_e164 = p_business_number AND a.revoked_at IS NULL AND a.verified_at IS NOT NULL AND s.active;
    IF n = 0 THEN RETURN jsonb_build_object('code','identity_unknown'); END IF;
    IF n > 1 THEN RETURN jsonb_build_object('code','identity_ambiguous'); END IF;
    SELECT a.* INTO acc FROM samtal_provider_accounts a JOIN samtal_numbers s ON s.id = a.number_id AND s.company_id = a.company_id
      WHERE a.provider = p_provider AND s.phone_e164 = p_business_number AND a.revoked_at IS NULL AND a.verified_at IS NOT NULL AND s.active;
    SELECT * INTO num FROM samtal_numbers WHERE id = acc.number_id;
  END IF;
  IF acc.user_id IS DISTINCT FROM num.user_id THEN RETURN jsonb_build_object('code','identity_conflict'); END IF;
  INSERT INTO samtal_call_bindings(provider, provider_call_id, company_id, user_id, number_id, account_id, direction, recording_id)
    VALUES (p_provider, p_call, acc.company_id, acc.user_id, num.id, acc.id, p_direction, p_recording_id)
    ON CONFLICT (provider, provider_call_id) DO NOTHING;
  SELECT * INTO b FROM samtal_call_bindings WHERE provider = p_provider AND provider_call_id = p_call FOR UPDATE;
  IF b.company_id <> acc.company_id OR b.user_id <> acc.user_id OR b.number_id <> num.id OR b.direction <> p_direction THEN
    RETURN jsonb_build_object('code','identity_conflict');
  END IF;
  IF p_recording_id IS NOT NULL THEN
    IF b.recording_id IS NULL THEN
      BEGIN UPDATE samtal_call_bindings SET recording_id = p_recording_id WHERE provider = p_provider AND provider_call_id = p_call;
      EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('code','recording_conflict'); END;
    ELSIF b.recording_id <> p_recording_id THEN RETURN jsonb_build_object('code','recording_conflict');
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'company_id', b.company_id, 'user_id', b.user_id, 'business_number', num.phone_e164);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('code','recording_conflict');
END $$;

-- 6. Admission: replay, durable rate limit and backpressure in one step, shared by every application instance.
--    A replay key is first 'claimed' for a short window; it becomes 'accepted' only together with the stored events,
--    so a crash between admission and storage lets the provider's identical retry through after the claim window.
CREATE FUNCTION public.samtal_webhook_admit(p_provider text, p_replay_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p samtal_webhook_providers; hits integer; pending integer; r samtal_webhook_replays; w timestamptz := date_trunc('minute', clock_timestamp());
BEGIN
  SELECT * INTO p FROM samtal_webhook_providers WHERE provider = p_provider;
  IF p.provider IS NULL OR p_replay_key !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('status','rejected'); END IF;
  INSERT INTO samtal_webhook_rate(provider, window_start, hits) VALUES (p_provider, w, 1)
    ON CONFLICT (provider, window_start) DO UPDATE SET hits = samtal_webhook_rate.hits + 1 RETURNING samtal_webhook_rate.hits INTO hits;
  IF hits > p.per_minute THEN
    RETURN jsonb_build_object('status','rate_limited','retry_after', greatest(1, ceil(extract(epoch FROM (w + interval '1 minute' - clock_timestamp())))::int));
  END IF;
  SELECT count(*) INTO pending FROM samtal_webhook_events WHERE provider = p_provider AND state = 'pending';
  IF pending >= p.max_pending THEN RETURN jsonb_build_object('status','backpressure','retry_after',30); END IF;
  INSERT INTO samtal_webhook_replays(provider, replay_key, state, claim_until, expires_at)
    VALUES (p_provider, p_replay_key, 'claimed', clock_timestamp() + interval '60 seconds', clock_timestamp() + make_interval(secs => p.replay_seconds))
    ON CONFLICT (provider, replay_key) DO UPDATE SET claim_until = EXCLUDED.claim_until
      WHERE samtal_webhook_replays.state = 'claimed' AND samtal_webhook_replays.claim_until < clock_timestamp()
    RETURNING * INTO r;
  IF r.provider IS NULL THEN RETURN jsonb_build_object('status','replay'); END IF;
  RETURN jsonb_build_object('status','ok');
END $$;

-- Stores validated normalised events (deduplicated by provider + event id) and accepts the replay key atomically.
CREATE FUNCTION public.samtal_webhook_accept(p_provider text, p_replay_key text, p_events jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p samtal_webhook_providers; e jsonb; stored integer := 0; dup integer := 0; k integer;
BEGIN
  SELECT * INTO p FROM samtal_webhook_providers WHERE provider = p_provider;
  IF p.provider IS NULL OR jsonb_typeof(p_events) <> 'array' OR jsonb_array_length(p_events) > 100 THEN RETURN jsonb_build_object('status','rejected'); END IF;
  UPDATE samtal_webhook_replays SET state = 'accepted' WHERE provider = p_provider AND replay_key = p_replay_key AND state = 'claimed';
  IF NOT FOUND THEN RETURN jsonb_build_object('status','replay'); END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(p_events) LOOP
    IF e->>'provider' IS DISTINCT FROM p_provider OR coalesce(e->>'event_id','') = '' OR coalesce(e->>'provider_call_id','') = ''
       OR e ? 'company_id' OR e ? 'user_id' OR e ? 'employee_id' THEN RAISE EXCEPTION 'event_invalid' USING ERRCODE = 'P0001'; END IF;
    INSERT INTO samtal_webhook_events(provider, event_id, provider_call_id, event, purge_after)
      VALUES (p_provider, e->>'event_id', e->>'provider_call_id', e, clock_timestamp() + make_interval(hours => p.retention_hours))
      ON CONFLICT (provider, event_id) DO NOTHING;
    GET DIAGNOSTICS k = ROW_COUNT;
    IF k = 1 THEN stored := stored + 1; ELSE dup := dup + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('status','ok','stored',stored,'duplicates',dup);
END $$;

-- Releases a claimed (not yet accepted) replay key when the delivery is answered with an error, so the provider's
-- identical retry is processed.
CREATE FUNCTION public.samtal_webhook_release(p_provider text, p_replay_key text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  WITH d AS (DELETE FROM samtal_webhook_replays WHERE provider = p_provider AND replay_key = p_replay_key AND state = 'claimed' RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM d) $$;

-- 7. Processing: one lease per provider call (fencing token), crash-safe through lease expiry.
CREATE FUNCTION public.samtal_webhook_claim(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(provider text, provider_call_id text, token uuid, events jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
#variable_conflict use_column
DECLARE c record; t uuid; n integer := 0;
BEGIN
  FOR c IN SELECT e.provider AS p, e.provider_call_id AS cid, min(e.received_at) AS first FROM samtal_webhook_events e
      WHERE e.state = 'pending' AND e.run_after <= clock_timestamp() GROUP BY 1, 2 ORDER BY 3 LIMIT greatest(1, least(p_limit, 50)) * 4 LOOP
    EXIT WHEN n >= least(p_limit, 50);
    t := gen_random_uuid();
    INSERT INTO samtal_webhook_call_leases AS l(provider, provider_call_id, token, lease_until)
      VALUES (c.p, c.cid, t, clock_timestamp() + make_interval(secs => greatest(10, least(p_lease_seconds, 600))))
      ON CONFLICT ON CONSTRAINT samtal_webhook_call_leases_pkey DO UPDATE SET token = EXCLUDED.token, lease_until = EXCLUDED.lease_until
        WHERE l.lease_until < clock_timestamp()
      RETURNING l.token INTO t;
    CONTINUE WHEN t IS NULL;
    UPDATE samtal_webhook_events e SET lease_token = t, attempts = e.attempts + 1
      WHERE e.provider = c.p AND e.provider_call_id = c.cid AND e.state = 'pending' AND e.run_after <= clock_timestamp();
    provider := c.p; provider_call_id := c.cid; token := t;
    SELECT coalesce(jsonb_agg(e.event ORDER BY e.received_at), '[]') INTO events FROM samtal_webhook_events e
      WHERE e.provider = c.p AND e.provider_call_id = c.cid AND e.event IS NOT NULL AND e.state <> 'dead';
    n := n + 1;
    RETURN NEXT;
  END LOOP;
END $$;

-- The newest recording link of a bound call, only to the lease holder and only for the bound company.
CREATE FUNCTION public.samtal_webhook_recording(p_provider text, p_call text, p_company uuid, p_token uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT e.event->'recording' FROM samtal_webhook_events e
    JOIN samtal_call_bindings b ON b.provider = e.provider AND b.provider_call_id = e.provider_call_id
    JOIN samtal_webhook_call_leases l ON l.provider = e.provider AND l.provider_call_id = e.provider_call_id
    WHERE e.provider = p_provider AND e.provider_call_id = p_call AND b.company_id = p_company AND l.token = p_token AND l.lease_until > clock_timestamp()
      AND e.event->'recording'->>'recording_id' = b.recording_id
    ORDER BY e.received_at DESC LIMIT 1 $$;

-- Finishes a lease. Only the current token can finish (a worker whose lease expired is fenced out).
--   p_outcome 'done'  : call ingested; content (transcript, customer number, link) stripped from all its events
--   p_outcome 'wait'  : not ready yet; events kept for the next fold
--   p_outcome 'reject': identity or content refused; content stripped
--   p_outcome 'retry' : transient; events back to pending with backoff, dead after max_attempts (content stripped)
CREATE FUNCTION public.samtal_webhook_finish(p_provider text, p_call text, p_token uuid, p_outcome text, p_code text, p_retry_seconds integer DEFAULT 30) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p samtal_webhook_providers; strip text[] := ARRAY['transcript','remote_number','recording'];
BEGIN
  IF p_outcome NOT IN ('done','wait','reject','retry') OR p_code !~ '^[a-z0-9_:]{1,80}$' THEN RETURN false; END IF;
  SELECT * INTO p FROM samtal_webhook_providers WHERE provider = p_provider;
  PERFORM 1 FROM samtal_webhook_call_leases WHERE provider = p_provider AND provider_call_id = p_call AND token = p_token AND lease_until > clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_outcome = 'retry' THEN
    UPDATE samtal_webhook_events SET lease_token = NULL, result_code = p_code,
        state = CASE WHEN attempts >= p.max_attempts THEN 'dead' ELSE 'pending' END,
        event = CASE WHEN attempts >= p.max_attempts THEN event - strip ELSE event END,
        run_after = clock_timestamp() + make_interval(secs => least(3600, greatest(5, p_retry_seconds) * attempts))
      WHERE provider = p_provider AND provider_call_id = p_call AND lease_token = p_token;
  ELSIF p_outcome = 'wait' THEN
    UPDATE samtal_webhook_events SET lease_token = NULL, state = 'seen', result_code = p_code
      WHERE provider = p_provider AND provider_call_id = p_call AND lease_token = p_token;
  ELSE
    UPDATE samtal_webhook_events SET lease_token = NULL, result_code = CASE WHEN lease_token = p_token THEN p_code ELSE result_code END,
        state = CASE WHEN lease_token = p_token OR state = 'seen' THEN 'done' ELSE state END,
        event = CASE WHEN lease_token = p_token OR state IN ('seen','done') THEN event - strip ELSE event END
      WHERE provider = p_provider AND provider_call_id = p_call AND (lease_token = p_token OR state IN ('seen','done'));
  END IF;
  DELETE FROM samtal_webhook_call_leases WHERE provider = p_provider AND provider_call_id = p_call AND token = p_token;
  RETURN true;
END $$;

-- 8. Bounded retention of security metadata. Run by the existing hourly purge (separately approved wiring).
CREATE FUNCTION public.samtal_webhook_purge() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE ev integer; rp integer; rt integer; ls integer; bd integer;
BEGIN
  -- Unfinished events past retention are closed and their content removed.
  DELETE FROM samtal_webhook_events WHERE purge_after <= clock_timestamp(); GET DIAGNOSTICS ev = ROW_COUNT;
  DELETE FROM samtal_webhook_replays WHERE expires_at <= clock_timestamp(); GET DIAGNOSTICS rp = ROW_COUNT;
  DELETE FROM samtal_webhook_rate WHERE window_start < clock_timestamp() - interval '1 hour'; GET DIAGNOSTICS rt = ROW_COUNT;
  DELETE FROM samtal_webhook_call_leases WHERE lease_until < clock_timestamp() - interval '1 hour'; GET DIAGNOSTICS ls = ROW_COUNT;
  -- A binding outlives its events only while its call exists with content; it holds no customer data.
  DELETE FROM samtal_call_bindings b WHERE b.created_at < clock_timestamp() - interval '1 hour'
    AND NOT EXISTS (SELECT 1 FROM samtal_webhook_events e WHERE e.provider = b.provider AND e.provider_call_id = b.provider_call_id)
    AND NOT EXISTS (SELECT 1 FROM samtal_calls c WHERE c.provider = b.provider AND c.provider_call_id = b.provider_call_id AND c.content_deleted_at IS NULL);
  GET DIAGNOSTICS bd = ROW_COUNT;
  RETURN jsonb_build_object('events',ev,'replays',rp,'rate',rt,'leases',ls,'bindings',bd);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['samtal_enforce_provider_binding()','samtal_bind_provider_call(text,text,text,text,text,text)','samtal_webhook_admit(text,text)',
    'samtal_webhook_accept(text,text,jsonb)','samtal_webhook_release(text,text)','samtal_webhook_claim(integer,integer)',
    'samtal_webhook_recording(text,text,uuid,uuid)','samtal_webhook_finish(text,text,uuid,text,text,integer)','samtal_webhook_purge()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION public.samtal_enforce_provider_binding() FROM service_role;
