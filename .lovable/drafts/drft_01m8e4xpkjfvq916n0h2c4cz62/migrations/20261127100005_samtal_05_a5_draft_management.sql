-- estim Samtal staged migration 5/13 from docs/samtal/a5-draft-management.sql (approved for Bygg Demo AB test, 2026-11-27).
-- estim Samtal A5 (UNAPPLIED SQL CANDIDATE – documentation only, never run against preview or production).
-- Applies after priority-1-coordinated-v2.sql, a1-provider-transcript.sql and a3-a4-ring-estim.sql.
--
-- Draft management, date-only deadlines, material lists and employee enrollment for Ring estim.
--   * Drafts get Swedish states (behover_granskas, kund_saknas, godkand, avvisad, klar), an optimistic version, the
--     deciding actor id and time. Every change goes through samtal_ring_decide, which locks the row, checks the
--     actor's membership/role in the draft's company and the expected version, and is idempotent: repeating the
--     same decision returns ok without a new version; a different decision on a decided draft returns 'conflict'
--     with the current state, so nobody's decision is overwritten silently.
--   * Approval only changes the state of an internal Samtal draft. Nothing here sends a quotation, places an order,
--     contacts a customer or writes to quotes/threads/drafts/messages.
--   * Deletion removes the draft and leaves a content-free tombstone (call id, kind, sha256 of the title), so a
--     retried commit, a stale worker or a duplicate provider event cannot recreate it.
--   * Deadlines: due_date (a date) is always kept; due_at only when a time was spoken or a default was applied, and
--     due_time_source says which ('angiven' or 'standard').
--   * Enrollment: an owner registers a phone number for a member ("Väntar på verifiering"). That is never an
--     identity: samtal_ring_identities rows are created only by samtal_ring_verify_enrollment, called by the
--     server with trusted provider evidence. Revocation revokes the identity immediately (fail closed).
-- All functions are service-role only; the actor is the verified auth user passed by an authenticated server handler.

-- ---- Drafts ----
ALTER TABLE public.samtal_ring_drafts DROP CONSTRAINT IF EXISTS samtal_ring_drafts_state_check;
UPDATE public.samtal_ring_drafts SET state = CASE state WHEN 'utkast' THEN 'behover_granskas' WHEN 'bekraftad' THEN 'godkand' ELSE state END;
ALTER TABLE public.samtal_ring_drafts
  ALTER COLUMN state SET DEFAULT 'behover_granskas',
  ADD CONSTRAINT samtal_ring_drafts_state_check CHECK (state IN ('behover_granskas','kund_saknas','godkand','avvisad','klar')),
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN project_ref text CHECK (project_ref IS NULL OR length(project_ref) BETWEEN 1 AND 120),
  ADD COLUMN due_date date,
  ADD COLUMN due_time_source text CHECK (due_time_source IS NULL OR due_time_source IN ('angiven','standard')),
  ADD COLUMN decided_by uuid,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN edited_by uuid,
  ADD COLUMN edited_at timestamptz;
-- A3/A4 rows carried a 16:00 time that nobody said; keep their date and drop the invented time.
UPDATE public.samtal_ring_drafts SET due_date = (due_at AT TIME ZONE 'Europe/Stockholm')::date, due_at = NULL WHERE due_at IS NOT NULL;
ALTER TABLE public.samtal_ring_drafts ADD CONSTRAINT samtal_ring_drafts_time_source CHECK ((due_at IS NULL) = (due_time_source IS NULL));

-- Content-free record of deleted drafts. Service role only.
CREATE TABLE public.samtal_ring_draft_tombstones (
  call_id uuid NOT NULL,
  kind text NOT NULL,
  title_hash text NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, kind, title_hash)
);
REVOKE ALL ON public.samtal_ring_draft_tombstones FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.samtal_ring_draft_tombstones TO service_role;
ALTER TABLE public.samtal_ring_draft_tombstones ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.samtal_ring_title_hash(t text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_catalog AS $$
  SELECT encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

-- On insert (samtal_ring_commit): skip tombstoned drafts, move the date out of the body, start in the right state.
CREATE FUNCTION public.samtal_ring_draft_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM samtal_ring_draft_tombstones t WHERE t.call_id = NEW.call_id AND t.kind = NEW.kind AND t.title_hash = samtal_ring_title_hash(NEW.title)) THEN RETURN NULL;END IF;
  IF NEW.due_date IS NULL AND NEW.body ? 'due_date' AND NEW.body->>'due_date' ~ '^\d{4}-\d{2}-\d{2}$' THEN NEW.due_date := (NEW.body->>'due_date')::date;END IF;
  IF NEW.due_at IS NOT NULL AND NEW.due_time_source IS NULL THEN NEW.due_time_source := 'angiven';END IF;
  IF NEW.due_at IS NOT NULL AND NEW.due_date IS NULL THEN NEW.due_date := (NEW.due_at AT TIME ZONE 'Europe/Stockholm')::date;END IF;
  NEW.body := NEW.body - 'due_date' - 'due_time_source';
  IF NEW.state IN ('utkast','behover_granskas') THEN
    NEW.state := CASE WHEN NEW.customer_id IS NULL AND NEW.kind IN ('offertutkast','materialunderlag','kundanteckning') THEN 'kund_saknas' ELSE 'behover_granskas' END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER samtal_ring_draft_insert BEFORE INSERT ON public.samtal_ring_drafts FOR EACH ROW EXECUTE FUNCTION public.samtal_ring_draft_insert();

-- The actor may act on a draft when the company is active and they are its owner, or the draft is their own.
CREATE FUNCTION public.samtal_ring_may_act(p_actor uuid, d public.samtal_ring_drafts) RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM company_members m JOIN companies x ON x.id = m.company_id AND x.active
    WHERE m.company_id = d.company_id AND m.user_id = p_actor AND (m.role = 'ägare' OR d.user_id = p_actor)) $$;

-- Validates an edit. Only listed keys; no prices are required; material rows are bounded and typed.
CREATE FUNCTION public.samtal_ring_valid_patch(d public.samtal_ring_drafts, p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE r jsonb;
BEGIN
  IF jsonb_typeof(p) <> 'object' OR octet_length(p::text) > 20000 THEN RETURN false;END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('title','text','items','due_date','due_time')) THEN RETURN false;END IF;
  IF p ? 'title' AND (jsonb_typeof(p->'title') <> 'string' OR length(trim(p->>'title')) NOT BETWEEN 1 AND 200) THEN RETURN false;END IF;
  IF p ? 'text' AND (jsonb_typeof(p->'text') <> 'string' OR length(p->>'text') > 4000) THEN RETURN false;END IF;
  IF p ? 'due_date' AND jsonb_typeof(p->'due_date') <> 'null' AND (p->>'due_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN false;END IF;
  IF p ? 'due_time' AND jsonb_typeof(p->'due_time') <> 'null' AND (p->>'due_time') !~ '^([01]\d|2[0-3]):[0-5]\d$' THEN RETURN false;END IF;
  IF p ? 'due_time' AND jsonb_typeof(p->'due_time') <> 'null' AND NOT (p ? 'due_date' AND jsonb_typeof(p->'due_date') <> 'null' OR d.due_date IS NOT NULL) THEN RETURN false;END IF;
  IF p ? 'items' THEN
    IF d.kind NOT IN ('materialunderlag','offertutkast') OR jsonb_typeof(p->'items') <> 'array' OR jsonb_array_length(p->'items') > 60 THEN RETURN false;END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(p->'items') LOOP
      IF jsonb_typeof(r) <> 'object' OR length(trim(coalesce(r->>'item',''))) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN ('item','quantity','unit','certainty','evidence','supplier','product_id','price')) THEN RETURN false;END IF;
      IF jsonb_typeof(r->'quantity') NOT IN ('null','number') OR jsonb_typeof(r->'quantity') = 'number' AND ((r->>'quantity')::numeric <= 0 OR (r->>'quantity')::numeric > 100000) THEN RETURN false;END IF;
      IF jsonb_typeof(r->'price') NOT IN ('null','number') OR jsonb_typeof(r->'price') = 'number' AND ((r->>'price')::numeric < 0 OR (r->>'price')::numeric > 10000000) THEN RETURN false;END IF;
      IF coalesce(r->>'certainty','osaker') NOT IN ('angiven','uppskattad','osaker','bekraftad') THEN RETURN false;END IF;
      IF length(coalesce(r->>'unit','')) > 20 OR length(coalesce(r->>'supplier','')) > 120 OR length(coalesce(r->>'product_id','')) > 80 OR length(coalesce(r->>'evidence','')) > 200 THEN RETURN false;END IF;
    END LOOP;
  END IF;
  RETURN true;
END $$;

-- One decision or edit. Actions: godkann, avvisa, klar, redigera, koppla_kund, koppla_projekt.
-- Returns {status: ok|conflict|denied|not_found|invalid, state, version}.
CREATE FUNCTION public.samtal_ring_decide(p_actor uuid, p_draft uuid, p_expected_version integer, p_action text, p_value jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d samtal_ring_drafts; target text; dd date; tt text; items jsonb;
BEGIN
  SELECT * INTO d FROM samtal_ring_drafts WHERE id = p_draft FOR UPDATE;
  -- Not found and not allowed look the same to the caller: no existence oracle across companies.
  IF NOT FOUND OR p_actor IS NULL OR NOT samtal_ring_may_act(p_actor, d) THEN RETURN jsonb_build_object('status','not_found');END IF;
  -- A draft whose call content was deleted is not decided on (private deletion wins).
  IF EXISTS (SELECT 1 FROM samtal_calls c WHERE c.id = d.call_id AND c.content_deleted_at IS NOT NULL) AND p_action <> 'avvisa'
    THEN RETURN jsonb_build_object('status','denied','reason','content_deleted','state',d.state,'version',d.version);END IF;
  target := CASE p_action WHEN 'godkann' THEN 'godkand' WHEN 'avvisa' THEN 'avvisad' WHEN 'klar' THEN 'klar' ELSE NULL END;
  IF target IS NOT NULL THEN
    -- Idempotent repeat of the same decision.
    IF d.state = target THEN RETURN jsonb_build_object('status','ok','state',d.state,'version',d.version,'repeat',true);END IF;
    IF p_expected_version IS DISTINCT FROM d.version THEN RETURN jsonb_build_object('status','conflict','state',d.state,'version',d.version);END IF;
    IF target = 'godkand' AND d.state <> 'behover_granskas' THEN
      RETURN jsonb_build_object('status', CASE WHEN d.state = 'kund_saknas' THEN 'denied' ELSE 'conflict' END, 'reason', CASE WHEN d.state = 'kund_saknas' THEN 'customer_required' END, 'state',d.state,'version',d.version);END IF;
    IF target = 'avvisad' AND d.state NOT IN ('behover_granskas','kund_saknas') THEN RETURN jsonb_build_object('status','conflict','state',d.state,'version',d.version);END IF;
    IF target = 'klar' AND d.state <> 'godkand' THEN RETURN jsonb_build_object('status','conflict','state',d.state,'version',d.version);END IF;
    UPDATE samtal_ring_drafts SET state = target, version = version + 1, decided_by = p_actor, decided_at = clock_timestamp(), needs_review = false WHERE id = d.id RETURNING * INTO d;
    RETURN jsonb_build_object('status','ok','state',d.state,'version',d.version);
  END IF;
  IF p_action NOT IN ('redigera','koppla_kund','koppla_projekt') THEN RETURN jsonb_build_object('status','invalid');END IF;
  IF p_expected_version IS DISTINCT FROM d.version THEN RETURN jsonb_build_object('status','conflict','state',d.state,'version',d.version);END IF;
  -- Decided drafts are not edited; reject and start from a new note instead.
  IF d.state IN ('avvisad','klar') OR d.state = 'godkand' AND p_action <> 'koppla_projekt' THEN RETURN jsonb_build_object('status','conflict','state',d.state,'version',d.version);END IF;
  IF p_action = 'koppla_kund' THEN
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = (p_value->>'customer_id')::uuid AND company_id = d.company_id) THEN RETURN jsonb_build_object('status','invalid','reason','customer');END IF;
    UPDATE samtal_ring_drafts SET customer_id = (p_value->>'customer_id')::uuid, state = CASE WHEN state = 'kund_saknas' THEN 'behover_granskas' ELSE state END,
      version = version + 1, edited_by = p_actor, edited_at = clock_timestamp() WHERE id = d.id RETURNING * INTO d;
  ELSIF p_action = 'koppla_projekt' THEN
    IF jsonb_typeof(p_value->'project') <> 'string' OR length(trim(p_value->>'project')) NOT BETWEEN 1 AND 120 THEN RETURN jsonb_build_object('status','invalid','reason','project');END IF;
    UPDATE samtal_ring_drafts SET project_ref = trim(p_value->>'project'), version = version + 1, edited_by = p_actor, edited_at = clock_timestamp() WHERE id = d.id RETURNING * INTO d;
  ELSE
    IF NOT samtal_ring_valid_patch(d, p_value) THEN RETURN jsonb_build_object('status','invalid');END IF;
    dd := CASE WHEN p_value ? 'due_date' THEN (p_value->>'due_date')::date ELSE d.due_date END;
    tt := CASE WHEN p_value ? 'due_time' THEN p_value->>'due_time' ELSE NULL END;
    -- Manually edited rows are marked by the editor; evidence is kept only for rows that still exist unchanged.
    items := p_value->'items';
    UPDATE samtal_ring_drafts SET
      title = CASE WHEN p_value ? 'title' THEN trim(p_value->>'title') ELSE title END,
      body = CASE WHEN items IS NOT NULL THEN jsonb_set(body, CASE WHEN kind = 'offertutkast' THEN '{rows}' ELSE '{items}' END::text[], items)
                  ELSE body END || CASE WHEN p_value ? 'text' THEN jsonb_build_object('text', p_value->>'text') ELSE '{}'::jsonb END,
      due_date = dd,
      due_at = CASE WHEN p_value ? 'due_time' AND tt IS NOT NULL THEN ((dd::text || ' ' || tt)::timestamp AT TIME ZONE 'Europe/Stockholm')
                    WHEN p_value ? 'due_time' OR p_value ? 'due_date' AND dd IS DISTINCT FROM d.due_date THEN NULL ELSE due_at END,
      due_time_source = CASE WHEN p_value ? 'due_time' AND tt IS NOT NULL THEN 'angiven'
                    WHEN p_value ? 'due_time' OR p_value ? 'due_date' AND dd IS DISTINCT FROM d.due_date THEN NULL ELSE due_time_source END,
      version = version + 1, edited_by = p_actor, edited_at = clock_timestamp()
    WHERE id = d.id RETURNING * INTO d;
  END IF;
  RETURN jsonb_build_object('status','ok','state',d.state,'version',d.version);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('status','conflict','reason','title_exists');
          WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN RETURN jsonb_build_object('status','invalid');
END $$;

-- "Radera": removes the draft for good and leaves a content-free tombstone. Idempotent.
CREATE FUNCTION public.samtal_ring_delete_draft(p_actor uuid, p_draft uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d samtal_ring_drafts;
BEGIN
  SELECT * INTO d FROM samtal_ring_drafts WHERE id = p_draft FOR UPDATE;
  IF NOT FOUND OR p_actor IS NULL OR NOT samtal_ring_may_act(p_actor, d) THEN RETURN jsonb_build_object('status','not_found');END IF;
  INSERT INTO samtal_ring_draft_tombstones(call_id, kind, title_hash, company_id) VALUES (d.call_id, d.kind, samtal_ring_title_hash(d.title), d.company_id) ON CONFLICT DO NOTHING;
  DELETE FROM samtal_ring_drafts WHERE id = d.id;
  RETURN jsonb_build_object('status','ok');
END $$;

-- ---- Employee enrollment ----
CREATE TABLE public.samtal_ring_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9]\d{6,14}$'),
  state text NOT NULL DEFAULT 'vantar' CHECK (state IN ('vantar','verifierad','aterkallad')),
  identity_id uuid REFERENCES public.samtal_ring_identities(id) ON DELETE SET NULL,
  requested_by uuid NOT NULL,
  revoked_by uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_members(company_id, user_id) ON DELETE CASCADE
);
-- One open enrollment per member and provider.
CREATE UNIQUE INDEX samtal_ring_enrollments_open ON public.samtal_ring_enrollments(company_id, user_id, provider) WHERE state <> 'aterkallad';
CREATE INDEX samtal_ring_enrollments_identity ON public.samtal_ring_enrollments(identity_id);
REVOKE ALL ON public.samtal_ring_enrollments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.samtal_ring_enrollments TO service_role;
ALTER TABLE public.samtal_ring_enrollments ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.samtal_ring_is_owner(p_actor uuid, p_company uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM company_members m JOIN companies x ON x.id = m.company_id AND x.active WHERE m.company_id = p_company AND m.user_id = p_actor AND m.role = 'ägare') $$;

-- "Anslut medarbetare": owner only, member of the same company; creates a pending row and nothing that resolves calls.
CREATE FUNCTION public.samtal_ring_enroll(p_actor uuid, p_company uuid, p_user uuid, p_provider text, p_phone text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e samtal_ring_enrollments;
BEGIN
  IF NOT samtal_ring_is_owner(p_actor, p_company) THEN RETURN jsonb_build_object('status','denied');END IF;
  IF NOT EXISTS (SELECT 1 FROM company_members WHERE company_id = p_company AND user_id = p_user) THEN RETURN jsonb_build_object('status','invalid','reason','member');END IF;
  IF p_provider !~ '^[a-z0-9_]{1,40}$' OR p_phone !~ '^\+[1-9]\d{6,14}$' THEN RETURN jsonb_build_object('status','invalid');END IF;
  SELECT * INTO e FROM samtal_ring_enrollments WHERE company_id = p_company AND user_id = p_user AND provider = p_provider AND state <> 'aterkallad' FOR UPDATE;
  IF FOUND THEN
    IF e.phone_e164 = p_phone THEN RETURN jsonb_build_object('status','ok','id',e.id,'state',e.state,'repeat',true);END IF;
    RETURN jsonb_build_object('status','conflict','id',e.id,'state',e.state);
  END IF;
  INSERT INTO samtal_ring_enrollments(company_id, user_id, provider, phone_e164, requested_by) VALUES (p_company, p_user, p_provider, p_phone, p_actor) RETURNING * INTO e;
  RETURN jsonb_build_object('status','ok','id',e.id,'state',e.state);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('status','conflict');
END $$;

-- Called only by the server after the provider has proven, with its own signed evidence, that account p_account_ref
-- belongs to this enrollment (p_evidence_verified). No evidence, a revoked enrollment, an inactive company or an
-- account already bound to another person fails closed. The phone number alone never verifies anything.
CREATE FUNCTION public.samtal_ring_verify_enrollment(p_enrollment uuid, p_provider text, p_account_ref text, p_evidence_verified boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e samtal_ring_enrollments; i uuid;
BEGIN
  IF p_evidence_verified IS DISTINCT FROM true OR p_account_ref IS NULL OR length(p_account_ref) NOT BETWEEN 1 AND 200 THEN RETURN jsonb_build_object('status','rejected','reason','unverified');END IF;
  SELECT * INTO e FROM samtal_ring_enrollments WHERE id = p_enrollment FOR UPDATE;
  IF NOT FOUND OR e.provider IS DISTINCT FROM p_provider THEN RETURN jsonb_build_object('status','rejected','reason','unknown');END IF;
  IF e.state = 'aterkallad' THEN RETURN jsonb_build_object('status','rejected','reason','revoked');END IF;
  IF NOT EXISTS (SELECT 1 FROM companies WHERE id = e.company_id AND active) THEN RETURN jsonb_build_object('status','rejected','reason','inactive');END IF;
  IF e.state = 'verifierad' THEN
    IF EXISTS (SELECT 1 FROM samtal_ring_identities WHERE id = e.identity_id AND account_ref = p_account_ref AND revoked_at IS NULL) THEN RETURN jsonb_build_object('status','ok','repeat',true);END IF;
    RETURN jsonb_build_object('status','rejected','reason','conflict');
  END IF;
  IF EXISTS (SELECT 1 FROM samtal_ring_identities WHERE provider = p_provider AND account_ref = p_account_ref AND revoked_at IS NULL AND user_id <> e.user_id)
    THEN RETURN jsonb_build_object('status','rejected','reason','conflict');END IF;
  INSERT INTO samtal_ring_identities(company_id, user_id, provider, account_ref, verified_at, verified_by)
    VALUES (e.company_id, e.user_id, p_provider, p_account_ref, clock_timestamp(), e.requested_by)
    ON CONFLICT (provider, account_ref, company_id) DO UPDATE SET revoked_at = NULL, verified_at = clock_timestamp()
      WHERE samtal_ring_identities.user_id = e.user_id
    RETURNING id INTO i;
  IF i IS NULL THEN RETURN jsonb_build_object('status','rejected','reason','conflict');END IF;
  UPDATE samtal_ring_enrollments SET state = 'verifierad', identity_id = i, updated_at = clock_timestamp() WHERE id = e.id;
  RETURN jsonb_build_object('status','ok');
END $$;

-- "Återkalla anslutning": owner only; revokes the identity at once so later calls fail closed. Idempotent.
CREATE FUNCTION public.samtal_ring_revoke_enrollment(p_actor uuid, p_enrollment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e samtal_ring_enrollments;
BEGIN
  SELECT * INTO e FROM samtal_ring_enrollments WHERE id = p_enrollment FOR UPDATE;
  IF NOT FOUND OR NOT samtal_ring_is_owner(p_actor, e.company_id) THEN RETURN jsonb_build_object('status','not_found');END IF;
  IF e.state = 'aterkallad' THEN RETURN jsonb_build_object('status','ok','repeat',true);END IF;
  UPDATE samtal_ring_identities SET revoked_at = clock_timestamp() WHERE id = e.identity_id AND revoked_at IS NULL;
  UPDATE samtal_ring_enrollments SET state = 'aterkallad', revoked_by = p_actor, revoked_at = clock_timestamp(), updated_at = clock_timestamp() WHERE id = e.id;
  RETURN jsonb_build_object('status','ok');
END $$;

-- Owner view of the company's enrollments (no account references are returned).
CREATE FUNCTION public.samtal_ring_enrollments_for(p_actor uuid, p_company uuid) RETURNS TABLE(id uuid, user_id uuid, provider text, phone_e164 text, state text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.user_id, e.provider, e.phone_e164, e.state, e.created_at FROM samtal_ring_enrollments e
  WHERE e.company_id = p_company AND samtal_ring_is_owner(p_actor, p_company) ORDER BY e.created_at DESC LIMIT 200 $$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
    ('samtal_ring_title_hash','samtal_ring_draft_insert','samtal_ring_may_act','samtal_ring_valid_patch','samtal_ring_decide','samtal_ring_delete_draft',
     'samtal_ring_is_owner','samtal_ring_enroll','samtal_ring_verify_enrollment','samtal_ring_revoke_enrollment','samtal_ring_enrollments_for') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
  END LOOP;
END $$;
