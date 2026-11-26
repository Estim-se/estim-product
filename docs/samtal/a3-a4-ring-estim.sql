-- estim Samtal A3 + A4 (Ring estim voice notes) – DOCUMENTATION-ONLY SQL CANDIDATE. NOT A MIGRATION.
-- Applies after priority-1-coordinated-v2.sql, a1-provider-transcript.sql and a7-durable-webhook.sql, and only in a
-- disposable local database or an approved isolated staging environment.
--
-- Ring estim: one shared number for every company. The destination number therefore identifies nobody, and caller ID
-- is never treated as identity. A voice note is attributed only from an authenticated provider account identity that
-- an authorized person enrolled for a company member (samtal_ring_identities). Resolution fails closed:
--   * no active identity (unknown, revoked, inactive member, inactive or retired company) -> rejected, nothing stored
--     except a content-free rejection row;
--   * the same account enrolled for two different people -> rejected (identity_conflict);
--   * unverified provider account (signature/account check failed upstream) -> rejected;
--   * one person, exactly one authorized company -> attributed automatically;
--   * one person, several companies -> attributed only through a short-lived company context the employee chose in
--     the app before calling ("Välj företag"); otherwise held as a pending note visible to that employee only, who
--     chooses the company afterwards. A pending note stores a provider transcript only (no audio outside a company
--     folder); an audio-only note without context is rejected with reason company_context_required.
-- Transcript content is never used to pick a company or person.
--
-- Voice notes reuse samtal_calls/samtal_jobs (kind = 'rostanteckning'), the V2 lease fencing, review hold, private
-- deletion, retention and cleanup. Results are Samtal-owned internal drafts (samtal_ring_drafts); nothing is sent,
-- ordered or quoted to a customer. All functions are service-role only; the actor is the verified auth user passed
-- by an authenticated Samtal server handler, as for samtal_confirm_review.

ALTER TABLE public.samtal_calls ADD COLUMN kind text NOT NULL DEFAULT 'telefonsamtal' CHECK (kind IN ('telefonsamtal','rostanteckning'));

CREATE TABLE public.samtal_ring_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  account_ref text NOT NULL CHECK (length(account_ref) BETWEEN 1 AND 200),
  verified_at timestamptz NOT NULL,
  verified_by uuid NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, account_ref, company_id),
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE CASCADE
);
CREATE TABLE public.samtal_ring_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE CASCADE
);
-- Held for the employee's own choice of company. No company_id: nothing here is visible to any company.
CREATE TABLE public.samtal_ring_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  provider text NOT NULL,
  provider_call_id text NOT NULL,
  started_at timestamptz NOT NULL,
  duration_seconds integer,
  transcript jsonb NOT NULL,
  delete_after timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  assigned_call uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_call_id)
);
-- Content-free record of refused voice notes (operations only): no company, person, number or text.
CREATE TABLE public.samtal_ring_rejections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_digest text NOT NULL,
  reason text NOT NULL CHECK (reason ~ '^[a-z_]{1,60}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
-- Internal drafts prepared from a voice note. Never sent anywhere; quotation and material drafts need a person.
CREATE TABLE public.samtal_ring_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('uppgift','paminnelse','materialunderlag','offertutkast','kundanteckning')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(body::text) <= 20000),
  due_at timestamptz,
  customer_id uuid,
  state text NOT NULL DEFAULT 'utkast' CHECK (state IN ('utkast','bekraftad','avvisad','klar')),
  needs_review boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, kind, title),
  FOREIGN KEY (company_id, call_id) REFERENCES public.samtal_calls(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE SET NULL (user_id),
  FOREIGN KEY (company_id, customer_id) REFERENCES public.customers(company_id, id) ON DELETE SET NULL (customer_id)
);

REVOKE ALL ON public.samtal_ring_identities, public.samtal_ring_contexts, public.samtal_ring_pending, public.samtal_ring_rejections FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.samtal_ring_identities, public.samtal_ring_contexts, public.samtal_ring_pending, public.samtal_ring_rejections TO service_role;
GRANT SELECT ON public.samtal_ring_drafts TO authenticated;
GRANT ALL ON public.samtal_ring_drafts TO service_role;
ALTER TABLE public.samtal_ring_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_ring_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_ring_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_ring_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.samtal_ring_drafts ENABLE ROW LEVEL SECURITY;
-- Owners see the company's drafts, employees their own (same rule as samtal_calls).
CREATE POLICY ring_drafts_read ON public.samtal_ring_drafts FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.company_members m JOIN public.companies x ON x.id = m.company_id
    WHERE m.company_id = samtal_ring_drafts.company_id AND m.user_id = auth.uid() AND x.active AND (m.role = 'ägare' OR samtal_ring_drafts.user_id = auth.uid())));

-- Identity resolution. Pure function of database state and the authenticated provider account; never of content.
CREATE FUNCTION public.samtal_ring_resolve(p_provider text, p_account_ref text, p_account_verified boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE people integer; companies uuid[]; person uuid;
BEGIN
  IF p_account_verified IS DISTINCT FROM true OR p_provider IS NULL OR p_account_ref IS NULL THEN RETURN jsonb_build_object('status','rejected','reason','unverified_account');END IF;
  SELECT count(DISTINCT i.user_id), array_agg(DISTINCT i.company_id ORDER BY i.company_id), min(i.user_id::text)::uuid INTO people, companies, person
    FROM samtal_ring_identities i
    JOIN company_members m ON m.company_id = i.company_id AND m.user_id = i.user_id
    JOIN companies x ON x.id = i.company_id AND x.active
    WHERE i.provider = p_provider AND i.account_ref = p_account_ref AND i.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM samtal_tenant_state t WHERE t.company_id = i.company_id AND t.retired_at IS NOT NULL);
  IF coalesce(people, 0) = 0 THEN RETURN jsonb_build_object('status','rejected','reason','unknown_identity');END IF;
  IF people > 1 THEN RETURN jsonb_build_object('status','rejected','reason','identity_conflict');END IF;
  IF array_length(companies, 1) = 1 THEN RETURN jsonb_build_object('status','attributed','user_id',person,'company_id',companies[1]);END IF;
  RETURN jsonb_build_object('status','choose_company','user_id',person,'companies',to_jsonb(companies));
END $$;

-- Creates (or finds) the voice-note call for an attributed company. Same tenant lock, backpressure and replay rules
-- as samtal_ingest_recover; audio uses the existing reservation ledger.
CREATE FUNCTION public.samtal_ring_create_call(p_company uuid, p_user uuid, payload jsonb) RETURNS public.samtal_calls
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c samtal_calls; s samtal_settings;
BEGIN
  SELECT * INTO c FROM samtal_calls WHERE provider = payload->>'provider' AND provider_call_id = payload->>'provider_call_id' FOR UPDATE;
  IF c.id IS NOT NULL THEN
    IF c.company_id <> p_company OR c.kind <> 'rostanteckning' OR c.content_deleted_at IS NOT NULL OR c.status = 'privat' OR c.delete_after <= clock_timestamp() THEN RETURN NULL;END IF;
    RETURN c;
  END IF;
  SELECT * INTO s FROM samtal_settings WHERE company_id = p_company;
  INSERT INTO samtal_calls(company_id, user_id, provider, provider_call_id, caller_phone, started_at, ended_at, duration_seconds, delete_after, safety_version, kind)
    VALUES (p_company, p_user, payload->>'provider', payload->>'provider_call_id', NULL, (payload->>'started_at')::timestamptz, (payload->>'ended_at')::timestamptz,
      (payload->>'duration_seconds')::integer, clock_timestamp() + make_interval(days => coalesce(s.retention_days, 30)), 2, 'rostanteckning')
    ON CONFLICT (provider, provider_call_id) DO NOTHING RETURNING * INTO c;
  IF c.id IS NULL THEN RETURN NULL;END IF;
  -- An intentional note from a verified employee is processed automatically; classification still decides the outcome.
  INSERT INTO samtal_jobs(company_id, call_id, state) VALUES (c.company_id, c.id, 'queued');
  RETURN c;
END $$;

CREATE FUNCTION public.samtal_ring_reject(p_digest text, p_reason text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO samtal_ring_rejections(event_digest, reason) VALUES (p_digest, p_reason);
  SELECT jsonb_build_object('status','rejected','reason',p_reason);
$$;

-- Ingestion of one Ring estim note. payload: provider, provider_call_id, account_ref, started_at, ended_at,
-- duration_seconds (caller number is accepted by the adapter but never stored or used). p_transcript: a validated
-- provider transcript with matching provenance, or NULL. p_extension: audio extension when audio follows, or NULL.
CREATE FUNCTION public.samtal_ring_ingest(payload jsonb, p_account_verified boolean, p_transcript jsonb, p_request uuid, p_extension text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r jsonb; digest text; company uuid; person uuid; ctx samtal_ring_contexts; c samtal_calls; j samtal_jobs; a samtal_audio_ledger; l samtal_runtime_limits; p samtal_ring_pending;
BEGIN
  IF payload IS NULL OR length(payload::text) > 16000 OR payload->>'provider' IS NULL OR payload->>'provider_call_id' IS NULL THEN RETURN jsonb_build_object('status','rejected','reason','invalid_payload');END IF;
  digest := encode(sha256(convert_to((payload->>'provider') || chr(31) || (payload->>'provider_call_id'), 'UTF8')), 'hex');
  IF p_transcript IS NULL AND p_extension IS NULL THEN RETURN samtal_ring_reject(digest, 'no_content');END IF;
  IF p_transcript IS NOT NULL AND (jsonb_typeof(p_transcript->'segments') <> 'array' OR jsonb_array_length(p_transcript->'segments') = 0
    OR octet_length(p_transcript::text) > 1000000 OR p_transcript#>>'{provenance,kind}' IS DISTINCT FROM 'provider'
    OR p_transcript#>>'{provenance,provider}' IS DISTINCT FROM payload->>'provider' OR p_transcript#>>'{provenance,provider_call_id}' IS DISTINCT FROM payload->>'provider_call_id') THEN
    RETURN samtal_ring_reject(digest, 'invalid_transcript');END IF;
  IF EXISTS (SELECT 1 FROM samtal_replay_denials WHERE event_digest = digest AND (expires_at IS NULL OR expires_at > clock_timestamp())) THEN RETURN samtal_ring_reject(digest, 'replay_denied');END IF;
  r := samtal_ring_resolve(payload->>'provider', payload->>'account_ref', p_account_verified);
  IF r->>'status' = 'rejected' THEN RETURN samtal_ring_reject(digest, r->>'reason');END IF;
  person := (r->>'user_id')::uuid;
  IF r->>'status' = 'attributed' THEN company := (r->>'company_id')::uuid;
  ELSE
    -- Several companies: only a live context the employee chose for one of THEIR enrolled companies attributes the note.
    SELECT * INTO ctx FROM samtal_ring_contexts WHERE user_id = person AND consumed_at IS NULL AND expires_at > clock_timestamp()
      AND company_id IN (SELECT jsonb_array_elements_text(r->'companies')::uuid) ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF ctx.id IS NOT NULL THEN company := ctx.company_id; UPDATE samtal_ring_contexts SET consumed_at = clock_timestamp() WHERE id = ctx.id;
    ELSIF p_transcript IS NOT NULL THEN
      INSERT INTO samtal_ring_pending(user_id, provider, provider_call_id, started_at, duration_seconds, transcript)
        VALUES (person, payload->>'provider', payload->>'provider_call_id', (payload->>'started_at')::timestamptz, (payload->>'duration_seconds')::integer, p_transcript)
        ON CONFLICT (provider, provider_call_id) DO NOTHING RETURNING * INTO p;
      IF p.id IS NULL THEN RETURN jsonb_build_object('status','duplicate');END IF;
      RETURN jsonb_build_object('status','pending_company','pending_id',p.id);
    ELSE RETURN samtal_ring_reject(digest, 'company_context_required');
    END IF;
  END IF;
  IF NOT samtal_v2_try_tenant(company) THEN RETURN jsonb_build_object('status','retry');END IF;
  SELECT * INTO l FROM samtal_runtime_limits;
  IF NOT EXISTS (SELECT 1 FROM samtal_calls WHERE provider = payload->>'provider' AND provider_call_id = payload->>'provider_call_id')
    AND (SELECT count(*) FROM samtal_jobs WHERE company_id = company AND state IN ('paused','queued','running')) >= l.tenant_pending THEN RETURN jsonb_build_object('status','backpressure');END IF;
  c := samtal_ring_create_call(company, person, payload);
  IF c.id IS NULL THEN RETURN samtal_ring_reject(digest, 'call_refused');END IF;
  IF p_transcript IS NOT NULL THEN
    SELECT * INTO j FROM samtal_jobs WHERE call_id = c.id AND company_id = c.company_id FOR UPDATE;
    IF c.transcript IS NULL AND j.step = 'transkribera' AND j.state IN ('queued','paused') THEN
      UPDATE samtal_calls SET transcript = p_transcript WHERE id = c.id; UPDATE samtal_jobs SET step = 'tolka' WHERE id = j.id;
      RETURN jsonb_build_object('status','attached','call_id',c.id,'company_id',c.company_id,'auto_process',true);
    END IF;
    IF p_extension IS NULL THEN RETURN jsonb_build_object('status','duplicate','call_id',c.id,'company_id',c.company_id);END IF;
  END IF;
  a := samtal_reserve_audio(c.id, c.company_id, p_request, p_extension);
  RETURN jsonb_build_object('status', CASE WHEN a.state = 'attached' THEN 'attached' WHEN a.id = p_request AND a.state = 'reserved' AND a.upload_until > clock_timestamp() THEN 'upload' ELSE 'pending' END,
    'call_id', c.id, 'company_id', c.company_id, 'auto_process', true,
    'audio', CASE WHEN a.id = p_request THEN to_jsonb(a) ELSE jsonb_build_object('id', a.id, 'state', a.state) END);
END $$;

-- "Välj företag" before calling: an employee sets a 30-minute context for one of their own enrolled companies.
CREATE FUNCTION public.samtal_ring_set_context(p_actor uuid, p_company uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM samtal_ring_identities i JOIN company_members m ON m.company_id = i.company_id AND m.user_id = i.user_id JOIN companies x ON x.id = i.company_id AND x.active
    WHERE i.user_id = p_actor AND i.company_id = p_company AND i.revoked_at IS NULL) THEN RETURN false;END IF;
  UPDATE samtal_ring_contexts SET consumed_at = clock_timestamp() WHERE user_id = p_actor AND consumed_at IS NULL;
  INSERT INTO samtal_ring_contexts(company_id, user_id, expires_at) VALUES (p_company, p_actor, clock_timestamp() + interval '30 minutes');
  RETURN true;
END $$;

-- "Välj företag" afterwards: only the note's own employee, only one of their enrolled companies, only once.
CREATE FUNCTION public.samtal_ring_assign(p_actor uuid, p_pending uuid, p_company uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p samtal_ring_pending; c samtal_calls;
BEGIN
  SELECT * INTO p FROM samtal_ring_pending WHERE id = p_pending FOR UPDATE;
  IF p.id IS NULL OR p.user_id IS DISTINCT FROM p_actor OR p.delete_after <= clock_timestamp() THEN RETURN jsonb_build_object('status','rejected');END IF;
  IF p.assigned_call IS NOT NULL THEN
    RETURN CASE WHEN EXISTS (SELECT 1 FROM samtal_calls WHERE id = p.assigned_call AND company_id = p_company) THEN jsonb_build_object('status','assigned','call_id',p.assigned_call) ELSE jsonb_build_object('status','rejected') END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM samtal_ring_identities i JOIN company_members m ON m.company_id = i.company_id AND m.user_id = i.user_id JOIN companies x ON x.id = i.company_id AND x.active
    WHERE i.user_id = p_actor AND i.company_id = p_company AND i.revoked_at IS NULL) THEN RETURN jsonb_build_object('status','rejected');END IF;
  c := samtal_ring_create_call(p_company, p_actor, jsonb_build_object('provider', p.provider, 'provider_call_id', p.provider_call_id, 'started_at', p.started_at, 'duration_seconds', p.duration_seconds));
  IF c.id IS NULL THEN RETURN jsonb_build_object('status','rejected');END IF;
  UPDATE samtal_calls SET transcript = p.transcript WHERE id = c.id AND transcript IS NULL;
  UPDATE samtal_jobs SET step = 'tolka' WHERE call_id = c.id AND step = 'transkribera';
  -- The held transcript now lives only in the company's call (normal retention); the pending row keeps no content.
  UPDATE samtal_ring_pending SET assigned_call = c.id, transcript = '{}'::jsonb WHERE id = p.id;
  RETURN jsonb_build_object('status','assigned','call_id',c.id);
END $$;

-- The employee's own pending notes: id and time only, never content.
CREATE FUNCTION public.samtal_ring_pending_for(p_actor uuid) RETURNS TABLE(id uuid, started_at timestamptz, companies uuid[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.started_at, array(SELECT i.company_id FROM samtal_ring_identities i JOIN companies x ON x.id = i.company_id AND x.active
      WHERE i.user_id = p.user_id AND i.revoked_at IS NULL AND i.provider = p.provider ORDER BY i.company_id)
    FROM samtal_ring_pending p WHERE p.user_id = p_actor AND p.assigned_call IS NULL AND p.delete_after > clock_timestamp() ORDER BY p.started_at DESC LIMIT 50;
$$;

-- Lease-fenced commit of a processed business voice note: the (redacted) extraction, the internal drafts and the job
-- release in one transaction. Mixed notes pass a transcript with private passages removed.
CREATE FUNCTION public.samtal_ring_commit(p_call uuid, p_company uuid, p_job uuid, p_token uuid, p_extraction jsonb, p_transcript jsonb, p_drafts jsonb, p_customer uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c samtal_calls; d jsonb; deadline timestamptz;
BEGIN
  IF NOT samtal_safety_live(p_call, p_company, p_job, p_token) THEN RETURN false;END IF;
  SELECT * INTO c FROM samtal_calls WHERE id = p_call;
  IF c.kind <> 'rostanteckning' OR p_extraction#>>'{interpretation,classification}' IS DISTINCT FROM 'jobb' OR jsonb_typeof(p_drafts) <> 'array' OR jsonb_array_length(p_drafts) > 30
    OR (p_transcript IS NOT NULL AND jsonb_typeof(p_transcript->'segments') <> 'array') THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'samtal_invalid_ring_commit';END IF;
  IF p_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer AND company_id = p_company) THEN RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'samtal_invalid_customer';END IF;
  SELECT least(j.lease_until, c.delete_after) INTO deadline FROM samtal_jobs j WHERE j.id = p_job;
  FOR d IN SELECT * FROM jsonb_array_elements(p_drafts) LOOP
    INSERT INTO samtal_ring_drafts(company_id, call_id, user_id, kind, title, body, due_at, customer_id, needs_review)
      VALUES (p_company, p_call, c.user_id, d->>'kind', d->>'title', coalesce(d->'body', '{}'::jsonb), (d->>'due_at')::timestamptz, p_customer,
        -- Quotation and material drafts always need a person; nothing is sent or ordered from here.
        CASE WHEN d->>'kind' IN ('offertutkast','materialunderlag') THEN true ELSE coalesce((d->>'needs_review')::boolean, true) END)
      ON CONFLICT (call_id, kind, title) DO NOTHING;
  END LOOP;
  UPDATE samtal_calls SET extraction = p_extraction, transcript = coalesce(p_transcript, transcript), classification = 'jobb', customer_id = p_customer, status = 'klar', error_code = NULL WHERE id = p_call;
  UPDATE samtal_jobs SET state = 'done', step = 'klar', lease_token = NULL, lease_until = NULL, error_code = NULL WHERE id = p_job;
  PERFORM samtal_v2_deadline(deadline);
  RETURN true;
END $$;

-- Pending notes that were never assigned are deleted after 24 hours by the hourly purge (bounded).
CREATE FUNCTION public.samtal_ring_purge_pending(p_limit integer) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH gone AS (DELETE FROM samtal_ring_pending WHERE id IN (SELECT id FROM samtal_ring_pending WHERE delete_after <= clock_timestamp() OR assigned_call IS NOT NULL AND created_at <= clock_timestamp() - interval '24 hours' LIMIT greatest(1, least(p_limit, 1000))) RETURNING 1)
  SELECT count(*)::integer FROM gone;
$$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'samtal_ring_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
  END LOOP;
END $$;
