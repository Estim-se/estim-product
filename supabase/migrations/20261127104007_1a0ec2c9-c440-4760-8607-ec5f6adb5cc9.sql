ALTER TABLE public.samtal_ring_identities ADD COLUMN evidence_kind text NOT NULL DEFAULT 'leverantor'
  CHECK (evidence_kind IN ('leverantor','referens'));
ALTER TABLE public.samtal_ring_identities ADD CONSTRAINT samtal_ring_identities_reference_only
  CHECK ((evidence_kind = 'referens') = (provider = 'referens'));

CREATE TABLE public.samtal_ring_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL REFERENCES public.samtal_ring_enrollments(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9_]{1,40}$'),
  challenge_hash text NOT NULL UNIQUE CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'vantar' CHECK (state IN ('vantar','anvand','utgangen','avbruten')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE UNIQUE INDEX samtal_ring_verifications_open ON public.samtal_ring_verifications(enrollment_id) WHERE state = 'vantar';
CREATE INDEX samtal_ring_verifications_company ON public.samtal_ring_verifications(company_id, created_at);
CREATE TABLE public.samtal_ring_verification_events (
  provider text NOT NULL, event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  result text NOT NULL CHECK (result ~ '^[a-z_]{1,40}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX samtal_ring_verification_events_age ON public.samtal_ring_verification_events(received_at);

CREATE FUNCTION public.samtal_ring_start_verification(p_actor uuid, p_enrollment uuid, p_challenge_hash text, p_ttl_minutes integer DEFAULT 30) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e samtal_ring_enrollments; v uuid;
BEGIN
  SELECT * INTO e FROM samtal_ring_enrollments WHERE id = p_enrollment FOR UPDATE;
  IF NOT FOUND OR NOT samtal_ring_is_owner(p_actor, e.company_id) THEN RETURN jsonb_build_object('status','not_found');END IF;
  IF e.state <> 'vantar' THEN RETURN jsonb_build_object('status','invalid','reason',e.state);END IF;
  IF p_challenge_hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('status','invalid');END IF;
  UPDATE samtal_ring_verifications SET state = 'avbruten' WHERE enrollment_id = e.id AND state = 'vantar';
  INSERT INTO samtal_ring_verifications(enrollment_id, company_id, user_id, provider, challenge_hash, expires_at)
    VALUES (e.id, e.company_id, e.user_id, e.provider, p_challenge_hash, clock_timestamp() + make_interval(mins => least(greatest(p_ttl_minutes, 5), 1440)))
    RETURNING id INTO v;
  RETURN jsonb_build_object('status','ok','id',v);
END $$;

CREATE FUNCTION public.samtal_ring_apply_verification(p_provider text, p_event_id text, p_challenge_hash text, p_account_ref text, p_evidence_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c samtal_ring_verifications; e samtal_ring_enrollments; prior text; holder samtal_ring_identities; i uuid; r text;
BEGIN
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 200 OR p_account_ref IS NULL OR length(p_account_ref) NOT BETWEEN 1 AND 200
     OR p_challenge_hash IS NULL OR p_challenge_hash !~ '^[0-9a-f]{64}$' OR p_evidence_kind NOT IN ('leverantor','referens')
     OR (p_evidence_kind = 'referens') <> (p_provider = 'referens') THEN
    RETURN jsonb_build_object('status','rejected','reason','unverified');
  END IF;
  SELECT result INTO prior FROM samtal_ring_verification_events WHERE provider = p_provider AND event_id = p_event_id;
  IF FOUND THEN RETURN jsonb_build_object('status', CASE WHEN prior = 'ok' THEN 'ok' ELSE 'rejected' END, 'reason', prior, 'repeat', true);END IF;
  r := 'ok';
  SELECT * INTO c FROM samtal_ring_verifications WHERE challenge_hash = p_challenge_hash FOR UPDATE;
  IF NOT FOUND OR c.provider <> p_provider THEN r := 'unknown';
  ELSIF c.state = 'anvand' THEN r := 'used';
  ELSIF c.state <> 'vantar' OR c.expires_at <= clock_timestamp() THEN r := 'expired';
  END IF;
  IF r = 'ok' THEN
    SELECT * INTO e FROM samtal_ring_enrollments WHERE id = c.enrollment_id FOR UPDATE;
    IF NOT FOUND OR e.company_id <> c.company_id OR e.user_id <> c.user_id THEN r := 'unknown';
    ELSIF e.state = 'aterkallad' THEN r := 'revoked';
    ELSIF e.state = 'verifierad' THEN r := 'conflict';
    ELSIF NOT EXISTS (SELECT 1 FROM companies WHERE id = e.company_id AND active) THEN r := 'inactive';
    ELSIF NOT EXISTS (SELECT 1 FROM company_members WHERE company_id = e.company_id AND user_id = e.user_id) THEN r := 'inactive';
    END IF;
  END IF;
  IF r = 'ok' THEN
    SELECT * INTO holder FROM samtal_ring_identities WHERE provider = p_provider AND account_ref = p_account_ref AND revoked_at IS NULL LIMIT 1;
    IF FOUND THEN r := 'conflict';
    ELSE
      DELETE FROM samtal_ring_identities WHERE provider = p_provider AND account_ref = p_account_ref AND company_id = e.company_id AND revoked_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM samtal_ring_enrollments x WHERE x.identity_id = samtal_ring_identities.id AND x.state = 'verifierad');
      INSERT INTO samtal_ring_identities(company_id, user_id, provider, account_ref, verified_at, verified_by, evidence_kind)
        VALUES (e.company_id, e.user_id, p_provider, p_account_ref, clock_timestamp(), e.requested_by, p_evidence_kind) RETURNING id INTO i;
      UPDATE samtal_ring_enrollments SET state = 'verifierad', identity_id = i, updated_at = clock_timestamp() WHERE id = e.id;
      UPDATE samtal_ring_verifications SET state = 'anvand', used_at = clock_timestamp() WHERE id = c.id;
    END IF;
  ELSIF r = 'expired' AND c.id IS NOT NULL AND c.state = 'vantar' THEN
    UPDATE samtal_ring_verifications SET state = 'utgangen' WHERE id = c.id;
  END IF;
  INSERT INTO samtal_ring_verification_events(provider, event_id, result) VALUES (p_provider, p_event_id, r);
  IF r <> 'ok' THEN PERFORM samtal_monitor_bump(c.company_id, 'verifiering_misslyckad', 1);END IF;
  RETURN jsonb_build_object('status', CASE WHEN r = 'ok' THEN 'ok' ELSE 'rejected' END, 'reason', r);
END $$;

CREATE TABLE public.samtal_ring_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL UNIQUE REFERENCES public.samtal_ring_drafts(id) ON DELETE CASCADE,
  draft_version integer NOT NULL,
  customer_id uuid NOT NULL,
  project_ref text,
  state text NOT NULL DEFAULT 'vantar' CHECK (state IN ('vantar','overlamnad','misslyckad')),
  quote_ref text CHECK (quote_ref IS NULL OR length(quote_ref) BETWEEN 1 AND 100),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,60}$'),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (company_id, customer_id) REFERENCES public.customers(company_id, id) ON DELETE CASCADE
);
CREATE INDEX samtal_ring_handoffs_open ON public.samtal_ring_handoffs(company_id, requested_at) WHERE state = 'vantar';

CREATE FUNCTION public.samtal_ring_request_handoff(p_actor uuid, p_draft uuid, p_expected_version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d samtal_ring_drafts; h samtal_ring_handoffs;
BEGIN
  SELECT * INTO d FROM samtal_ring_drafts WHERE id = p_draft FOR UPDATE;
  IF NOT FOUND OR NOT samtal_ring_is_owner(p_actor, d.company_id) THEN RETURN jsonb_build_object('status','not_found');END IF;
  SELECT * INTO h FROM samtal_ring_handoffs WHERE draft_id = d.id;
  IF FOUND THEN RETURN jsonb_build_object('status','ok','id',h.id,'state',h.state,'repeat',true);END IF;
  IF d.kind <> 'offertutkast' THEN RETURN jsonb_build_object('status','invalid','reason','kind');END IF;
  IF d.state <> 'godkand' THEN RETURN jsonb_build_object('status','invalid','reason','not_approved');END IF;
  IF d.customer_id IS NULL THEN RETURN jsonb_build_object('status','invalid','reason','customer');END IF;
  IF p_expected_version IS DISTINCT FROM d.version THEN RETURN jsonb_build_object('status','stale','version',d.version);END IF;
  INSERT INTO samtal_ring_handoffs(company_id, draft_id, draft_version, customer_id, project_ref, requested_by)
    VALUES (d.company_id, d.id, d.version, d.customer_id, d.project_ref, p_actor) RETURNING * INTO h;
  RETURN jsonb_build_object('status','ok','id',h.id,'state',h.state);
END $$;

CREATE FUNCTION public.samtal_ring_claim_handoff(p_handoff uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE h samtal_ring_handoffs; d samtal_ring_drafts;
BEGIN
  SELECT * INTO h FROM samtal_ring_handoffs WHERE id = p_handoff AND state = 'vantar' FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','busy');END IF;
  SELECT * INTO d FROM samtal_ring_drafts WHERE id = h.draft_id;
  IF NOT FOUND OR d.state <> 'godkand' OR d.version <> h.draft_version THEN
    UPDATE samtal_ring_handoffs SET state = 'misslyckad', error_code = 'draft_changed' WHERE id = h.id;
    RETURN jsonb_build_object('status','invalid','reason','draft_changed');
  END IF;
  UPDATE samtal_ring_handoffs SET attempts = attempts + 1 WHERE id = h.id;
  RETURN jsonb_build_object('status','ok','id',h.id,'company_id',h.company_id,'customer_id',h.customer_id,'project_ref',h.project_ref,'title',d.title,'body',d.body);
END $$;

CREATE FUNCTION public.samtal_ring_finish_handoff(p_handoff uuid, p_quote_ref text, p_error text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE h samtal_ring_handoffs;
BEGIN
  SELECT * INTO h FROM samtal_ring_handoffs WHERE id = p_handoff FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found');END IF;
  IF h.state = 'overlamnad' THEN RETURN jsonb_build_object('status','ok','repeat',true,'quote_ref',h.quote_ref);END IF;
  IF h.state = 'misslyckad' THEN RETURN jsonb_build_object('status','invalid','reason','closed');END IF;
  IF p_quote_ref IS NOT NULL THEN
    UPDATE samtal_ring_handoffs SET state = 'overlamnad', quote_ref = left(p_quote_ref, 100), error_code = NULL, completed_at = clock_timestamp() WHERE id = h.id;
    UPDATE samtal_ring_drafts SET state = 'klar', version = version + 1 WHERE id = h.draft_id AND state = 'godkand';
    RETURN jsonb_build_object('status','ok');
  END IF;
  IF coalesce(p_error,'') !~ '^[a-z0-9_]{1,60}$' THEN p_error := 'handoff_failed';END IF;
  UPDATE samtal_ring_handoffs SET state = CASE WHEN h.attempts >= 5 THEN 'misslyckad' ELSE 'vantar' END, error_code = p_error WHERE id = h.id;
  RETURN jsonb_build_object('status','retry','attempts',h.attempts);
END $$;

CREATE TABLE public.samtal_monitor_counters (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  metric text NOT NULL CHECK (metric IN ('inkommande','mottagna','avvisade','dubbletter','hastighetsbegransade','bearbetade','slutforda',
    'transkribering_misslyckad','ai_misslyckad','ogiltig_transkription','verifiering_misslyckad','omforsok','utgangna_lan','radering_misslyckad','mottryck')),
  n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (company_id, hour, metric)
);
CREATE INDEX samtal_monitor_counters_hour ON public.samtal_monitor_counters(hour);
CREATE TABLE public.samtal_monitor_platform_counters (
  hour timestamptz NOT NULL, metric text NOT NULL CHECK (metric ~ '^[a-z_]{1,40}$'), n integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (hour, metric)
);

CREATE FUNCTION public.samtal_monitor_bump(p_company uuid, p_metric text, p_n integer DEFAULT 1) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_n IS NULL OR p_n <= 0 THEN RETURN;END IF;
  IF p_company IS NULL THEN
    INSERT INTO samtal_monitor_platform_counters(hour, metric, n) VALUES (date_trunc('hour', clock_timestamp()), p_metric, least(p_n, 100000))
      ON CONFLICT (hour, metric) DO UPDATE SET n = least(samtal_monitor_platform_counters.n + excluded.n, 2000000000);
  ELSE
    INSERT INTO samtal_monitor_counters(company_id, hour, metric, n) VALUES (p_company, date_trunc('hour', clock_timestamp()), p_metric, least(p_n, 100000))
      ON CONFLICT (company_id, hour, metric) DO UPDATE SET n = least(samtal_monitor_counters.n + excluded.n, 2000000000);
  END IF;
END $$;

CREATE FUNCTION public.samtal_monitor_completion(p_company uuid, p_call uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND call_id = p_call AND state <> 'done') THEN RETURN 'bearbetning';END IF;
  IF EXISTS (SELECT 1 FROM samtal_dispatch_outbox WHERE company_id = p_company AND call_id = p_call AND state <> 'completed') THEN RETURN 'utkorg';END IF;
  IF EXISTS (SELECT 1 FROM samtal_ring_handoffs h JOIN samtal_ring_drafts d ON d.id = h.draft_id WHERE d.company_id = p_company AND d.call_id = p_call AND h.state = 'vantar') THEN RETURN 'overlamning';END IF;
  RETURN 'slutford';
END $$;

CREATE FUNCTION public.samtal_monitor_snapshot(p_company uuid, p_cap integer DEFAULT 1000) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE cap integer := least(greatest(p_cap, 10), 10000); now_ timestamptz := clock_timestamp(); res jsonb;
BEGIN
  SELECT jsonb_build_object(
    'vantande', (SELECT count(*) FROM (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND state = 'queued' LIMIT cap) s),
    'pausade', (SELECT count(*) FROM (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND state = 'paused' LIMIT cap) s),
    'aldsta_ko_sekunder', (SELECT coalesce(extract(epoch FROM now_ - min(run_after))::integer, 0) FROM (SELECT run_after FROM samtal_jobs WHERE company_id = p_company AND state = 'queued' AND run_after <= now_ ORDER BY run_after LIMIT 1) s),
    'bearbetas', (SELECT count(*) FROM (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND state = 'running' AND lease_until > now_ LIMIT cap) s),
    'utgangna_lan', (SELECT count(*) FROM (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND state = 'running' AND lease_until <= now_ LIMIT cap) s),
    'fastnade', (SELECT count(*) FROM (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND state = 'running' AND lease_until <= now_ - interval '15 minutes' LIMIT cap) s),
    'forsoker_igen', (SELECT count(*) FROM (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND state = 'queued' AND attempts > 0 LIMIT cap) s),
    'misslyckade', (SELECT count(*) FROM (SELECT 1 FROM samtal_jobs WHERE company_id = p_company AND state = 'failed' AND updated_at > now_ - interval '24 hours' LIMIT cap) s),
    'radering_forsenad', (SELECT count(*) FROM (SELECT 1 FROM samtal_calls WHERE company_id = p_company AND content_deleted_at IS NULL AND delete_after < now_ - interval '1 hour' LIMIT cap) s),
    'stadning_misslyckad', (SELECT count(*) FROM (SELECT 1 FROM samtal_audio_ledger WHERE company_id = p_company AND state = 'cleanup' AND attempts > 0 LIMIT cap) s),
    'utkorg_vantar', (SELECT count(*) FROM (SELECT 1 FROM samtal_dispatch_outbox WHERE company_id = p_company AND state IN ('pending','in_flight') LIMIT cap) s),
    'utkorg_blockerad', (SELECT count(*) FROM (SELECT 1 FROM samtal_dispatch_outbox WHERE company_id = p_company AND state = 'blocked' LIMIT cap) s),
    'ai_jobb_vantar_aterhamtning', (SELECT count(*) FROM (SELECT 1 FROM samtal_dispatch_outbox WHERE company_id = p_company AND state = 'accepted' AND next_attempt <= now_ LIMIT cap) s),
    'overlamningar_vantar', (SELECT count(*) FROM (SELECT 1 FROM samtal_ring_handoffs WHERE company_id = p_company AND state = 'vantar' LIMIT cap) s),
    'ej_verifierade', (SELECT count(*) FROM (SELECT 1 FROM samtal_ring_enrollments WHERE company_id = p_company AND state = 'vantar' LIMIT cap) s),
    'tak', cap) INTO res;
  SELECT res || jsonb_build_object('senaste_dygnet', coalesce(jsonb_object_agg(metric, total), '{}'::jsonb)) INTO res
  FROM (SELECT metric, sum(n)::bigint AS total FROM samtal_monitor_counters WHERE company_id = p_company AND hour > date_trunc('hour', now_) - interval '24 hours' GROUP BY metric) s;
  RETURN res;
END $$;

CREATE FUNCTION public.samtal_monitor_company(p_actor uuid, p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT samtal_ring_is_owner(p_actor, p_company) THEN RETURN jsonb_build_object('status','not_found');END IF;
  RETURN jsonb_build_object('status','ok','snapshot', samtal_monitor_snapshot(p_company, 1000),
    'larm', coalesce((SELECT jsonb_agg(jsonb_build_object('regel', rule, 'niva', level, 'sedan', first_at) ORDER BY first_at) FROM
      (SELECT rule, level, first_at FROM samtal_alerts WHERE company_id = p_company AND level <> 'aterstalld' ORDER BY first_at LIMIT 50) a), '[]'::jsonb));
END $$;

CREATE FUNCTION public.samtal_monitor_platform(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE since timestamptz := date_trunc('hour', clock_timestamp()) - interval '24 hours';
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = p_actor) THEN RETURN jsonb_build_object('status','not_found');END IF;
  RETURN jsonb_build_object('status','ok',
    'senaste_dygnet', coalesce((SELECT jsonb_object_agg(metric, total) FROM (SELECT metric, sum(n)::bigint total FROM samtal_monitor_counters WHERE hour > since GROUP BY metric) s), '{}'::jsonb),
    'utan_foretag', coalesce((SELECT jsonb_object_agg(metric, total) FROM (SELECT metric, sum(n)::bigint total FROM samtal_monitor_platform_counters WHERE hour > since GROUP BY metric) s), '{}'::jsonb),
    'oppna_larm', (SELECT count(*) FROM (SELECT 1 FROM samtal_alerts WHERE level <> 'aterstalld' LIMIT 10000) s),
    'mest_fel', coalesce((SELECT jsonb_agg(jsonb_build_object('company_id', company_id, 'fel', total)) FROM (SELECT company_id, sum(n)::bigint total FROM samtal_monitor_counters
      WHERE hour > since AND metric IN ('transkribering_misslyckad','ai_misslyckad','radering_misslyckad','avvisade') GROUP BY company_id ORDER BY total DESC LIMIT 20) s), '[]'::jsonb));
END $$;

CREATE TABLE public.samtal_alert_rules (
  rule text PRIMARY KEY CHECK (rule ~ '^[a-z_]{1,40}$'),
  metric text NOT NULL CHECK (metric ~ '^[a-z_]{1,40}(\.[a-z_]{1,40})?$'),
  warning numeric NOT NULL CHECK (warning > 0),
  critical numeric NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  CHECK (critical >= warning)
);
INSERT INTO public.samtal_alert_rules(rule, metric, warning, critical) VALUES
  ('ko_alder', 'aldsta_ko_sekunder', 600, 1800),
  ('utgangna_lan', 'utgangna_lan', 3, 10),
  ('fastnade_jobb', 'fastnade', 1, 5),
  ('misslyckade_jobb', 'misslyckade', 5, 20),
  ('leverantorsfel', 'senaste_dygnet.avvisade', 20, 100),
  ('transkribering', 'senaste_dygnet.transkribering_misslyckad', 3, 10),
  ('radering_forsenad', 'radering_forsenad', 1, 10),
  ('utkorg', 'utkorg_vantar', 20, 100),
  ('dubbletter', 'senaste_dygnet.dubbletter', 50, 200),
  ('hastighetsbegransning', 'senaste_dygnet.hastighetsbegransade', 20, 100),
  ('identitetskonflikter', 'senaste_dygnet.verifiering_misslyckad', 3, 10);

CREATE TABLE public.samtal_alerts (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule text NOT NULL REFERENCES public.samtal_alert_rules(rule) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('varning','kritisk','aterstalld')),
  value numeric NOT NULL,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  notified_level text,
  notified_at timestamptz,
  PRIMARY KEY (company_id, rule)
);
CREATE INDEX samtal_alerts_open ON public.samtal_alerts(company_id) WHERE level <> 'aterstalld';
CREATE TABLE public.samtal_alert_notifications (
  id bigserial PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  rule text NOT NULL, level text NOT NULL CHECK (level IN ('varning','kritisk','aterstalld')),
  destination text NOT NULL DEFAULT 'syntetisk' CHECK (destination = 'syntetisk'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX samtal_alert_notifications_age ON public.samtal_alert_notifications(created_at);

CREATE FUNCTION public.samtal_alert_evaluate(p_company uuid, p_cooldown_minutes integer DEFAULT 60) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s jsonb := samtal_monitor_snapshot(p_company, 1000); r samtal_alert_rules; a samtal_alerts; v numeric; lvl text; sent integer := 0;
BEGIN
  FOR r IN SELECT * FROM samtal_alert_rules WHERE enabled ORDER BY rule LOOP
    v := coalesce(CASE WHEN r.metric LIKE 'senaste_dygnet.%' THEN (s->'senaste_dygnet'->>substr(r.metric, 16))::numeric ELSE (s->>r.metric)::numeric END, 0);
    SELECT * INTO a FROM samtal_alerts WHERE company_id = p_company AND rule = r.rule FOR UPDATE;
    lvl := CASE WHEN v >= r.critical THEN 'kritisk' WHEN v >= r.warning THEN 'varning'
                WHEN FOUND AND a.level <> 'aterstalld' AND v >= r.warning * 0.8 THEN a.level ELSE 'aterstalld' END;
    IF NOT FOUND THEN
      IF lvl = 'aterstalld' THEN CONTINUE;END IF;
      INSERT INTO samtal_alerts(company_id, rule, level, value) VALUES (p_company, r.rule, lvl, v) RETURNING * INTO a;
    ELSE
      UPDATE samtal_alerts SET level = lvl, value = v, last_at = clock_timestamp(),
        first_at = CASE WHEN a.level = 'aterstalld' AND lvl <> 'aterstalld' THEN clock_timestamp() ELSE first_at END
        WHERE company_id = p_company AND rule = r.rule RETURNING * INTO a;
    END IF;
    IF a.notified_level IS DISTINCT FROM lvl AND (lvl <> 'aterstalld' OR a.notified_level IS NOT NULL)
       AND (a.notified_at IS NULL OR a.notified_level IS DISTINCT FROM lvl OR a.notified_at < clock_timestamp() - make_interval(mins => p_cooldown_minutes)) THEN
      INSERT INTO samtal_alert_notifications(company_id, rule, level) VALUES (p_company, r.rule, lvl);
      UPDATE samtal_alerts SET notified_level = CASE WHEN lvl = 'aterstalld' THEN NULL ELSE lvl END, notified_at = clock_timestamp() WHERE company_id = p_company AND rule = r.rule;
      sent := sent + 1;
    END IF;
  END LOOP;
  RETURN sent;
END $$;

CREATE FUNCTION public.samtal_recover_expired(p_limit integer DEFAULT 100, p_per_company integer DEFAULT 10, p_max_attempts integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE j record; requeued integer := 0; failed integer := 0; delay numeric;
BEGIN
  FOR j IN
    SELECT x.id, x.company_id, x.attempts, c.content_deleted_at FROM (
      SELECT id, company_id, attempts, call_id, row_number() OVER (PARTITION BY company_id ORDER BY lease_until) rn
      FROM samtal_jobs WHERE state = 'running' AND lease_until <= clock_timestamp() ORDER BY lease_until LIMIT least(p_limit, 1000) * 4) x
    JOIN samtal_calls c ON c.id = x.call_id AND c.company_id = x.company_id
    WHERE x.rn <= p_per_company LIMIT least(p_limit, 1000)
  LOOP
    PERFORM 1 FROM samtal_jobs WHERE id = j.id AND state = 'running' AND lease_until <= clock_timestamp() FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE;END IF;
    PERFORM samtal_monitor_bump(j.company_id, 'utgangna_lan', 1);
    IF j.content_deleted_at IS NOT NULL OR j.attempts >= p_max_attempts THEN
      UPDATE samtal_jobs SET state = 'failed', lease_token = NULL, lease_until = NULL,
        error_code = CASE WHEN j.content_deleted_at IS NOT NULL THEN 'content_deleted' ELSE 'retries_exhausted' END WHERE id = j.id;
      failed := failed + 1;
    ELSE
      delay := least(30 * power(2, j.attempts), 3600) * (0.5 + random() * 0.5);
      UPDATE samtal_jobs SET state = 'queued', lease_token = NULL, lease_until = NULL, error_code = 'lease_expired',
        run_after = clock_timestamp() + make_interval(secs => delay) WHERE id = j.id;
      PERFORM samtal_monitor_bump(j.company_id, 'omforsok', 1);
      requeued := requeued + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('requeued', requeued, 'failed', failed);
END $$;

CREATE FUNCTION public.samtal_monitor_prune(p_batch integer DEFAULT 5000) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a integer; b integer; c integer; d integer; e integer;
BEGIN
  DELETE FROM samtal_monitor_counters WHERE ctid IN (SELECT ctid FROM samtal_monitor_counters WHERE hour < clock_timestamp() - interval '30 days' LIMIT p_batch); GET DIAGNOSTICS a = ROW_COUNT;
  DELETE FROM samtal_monitor_platform_counters WHERE ctid IN (SELECT ctid FROM samtal_monitor_platform_counters WHERE hour < clock_timestamp() - interval '30 days' LIMIT p_batch); GET DIAGNOSTICS b = ROW_COUNT;
  DELETE FROM samtal_alert_notifications WHERE id IN (SELECT id FROM samtal_alert_notifications WHERE created_at < clock_timestamp() - interval '7 days' LIMIT p_batch); GET DIAGNOSTICS c = ROW_COUNT;
  DELETE FROM samtal_alerts WHERE ctid IN (SELECT ctid FROM samtal_alerts WHERE level = 'aterstalld' AND last_at < clock_timestamp() - interval '30 days' LIMIT p_batch); GET DIAGNOSTICS d = ROW_COUNT;
  DELETE FROM samtal_ring_verification_events WHERE ctid IN (SELECT ctid FROM samtal_ring_verification_events WHERE received_at < clock_timestamp() - interval '30 days' LIMIT p_batch); GET DIAGNOSTICS e = ROW_COUNT;
  DELETE FROM samtal_ring_verifications WHERE id IN (SELECT id FROM samtal_ring_verifications WHERE state <> 'vantar' AND created_at < clock_timestamp() - interval '30 days' LIMIT p_batch);
  RETURN jsonb_build_object('counters', a + b, 'notifications', c, 'alerts', d, 'events', e);
END $$;

DO $$ DECLARE t text; f record; BEGIN
  FOREACH t IN ARRAY ARRAY['samtal_ring_verifications','samtal_ring_verification_events','samtal_ring_handoffs','samtal_monitor_counters',
    'samtal_monitor_platform_counters','samtal_alert_rules','samtal_alerts','samtal_alert_notifications'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  GRANT USAGE ON SEQUENCE public.samtal_alert_notifications_id_seq TO service_role;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN
    ('samtal_ring_start_verification','samtal_ring_apply_verification','samtal_ring_request_handoff','samtal_ring_claim_handoff','samtal_ring_finish_handoff',
     'samtal_monitor_bump','samtal_monitor_completion','samtal_monitor_snapshot','samtal_monitor_company','samtal_monitor_platform','samtal_alert_evaluate',
     'samtal_recover_expired','samtal_monitor_prune') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
  END LOOP;
END $$;