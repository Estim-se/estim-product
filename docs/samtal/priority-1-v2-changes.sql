-- DOCUMENTATION / LOCAL TEST ONLY. V2 corrections appended within the coordinated candidate's single transaction.
-- Not an executable migration. No live changes, secrets, cron, shared workers or shared records are modified.

CREATE TABLE public.samtal_runtime_limits (
  id boolean PRIMARY KEY DEFAULT true CHECK(id),
  global_processing integer NOT NULL DEFAULT 128 CHECK(global_processing BETWEEN 1 AND 4096),
  global_dispatch integer NOT NULL DEFAULT 64 CHECK(global_dispatch BETWEEN 1 AND 4096),
  default_tenant_processing integer NOT NULL DEFAULT 4 CHECK(default_tenant_processing BETWEEN 1 AND 128),
  default_tenant_dispatch integer NOT NULL DEFAULT 2 CHECK(default_tenant_dispatch BETWEEN 1 AND 128),
  tenant_pending integer NOT NULL DEFAULT 1000 CHECK(tenant_pending BETWEEN 1 AND 100000),
  scan_budget integer NOT NULL DEFAULT 64 CHECK(scan_budget BETWEEN 1 AND 512),
  ingest_hourly_reservations integer NOT NULL DEFAULT 5 CHECK(ingest_hourly_reservations BETWEEN 1 AND 100),
  dispatch_retry_budget integer NOT NULL DEFAULT 20 CHECK(dispatch_retry_budget BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.samtal_runtime_limits FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_runtime_limits TO service_role;
ALTER TABLE public.samtal_runtime_limits ENABLE ROW LEVEL SECURITY;
INSERT INTO public.samtal_runtime_limits(id) VALUES(true);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_runtime_limits FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

CREATE TABLE public.samtal_tenant_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE RESTRICT,
  process_limit integer CHECK(process_limit BETWEEN 1 AND 128),dispatch_limit integer CHECK(dispatch_limit BETWEEN 1 AND 128),
  retired_at timestamptz,legacy_inventory_verified_at timestamptz,erasure_cursor uuid,
  process_cursor timestamptz NOT NULL DEFAULT '-infinity',cleanup_cursor timestamptz NOT NULL DEFAULT '-infinity',dispatch_cursor timestamptz NOT NULL DEFAULT '-infinity',
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.samtal_tenant_state FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_tenant_state TO service_role;
ALTER TABLE public.samtal_tenant_state ENABLE ROW LEVEL SECURITY;
INSERT INTO public.samtal_tenant_state(company_id) SELECT id FROM public.companies;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_tenant_state FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE INDEX samtal_tenant_process_cursor_idx ON public.samtal_tenant_state(process_cursor,company_id);
CREATE INDEX samtal_tenant_cleanup_cursor_idx ON public.samtal_tenant_state(cleanup_cursor,company_id);
CREATE INDEX samtal_tenant_dispatch_cursor_idx ON public.samtal_tenant_state(dispatch_cursor,company_id);

CREATE TABLE public.samtal_reviews (
  call_id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  decision text NOT NULL DEFAULT 'pending' CHECK(decision IN('pending','business','private')),
  request_id uuid UNIQUE,actor_id uuid,decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,call_id) REFERENCES public.samtal_calls(company_id,id) ON DELETE CASCADE
);
REVOKE ALL ON public.samtal_reviews FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_reviews TO service_role;
ALTER TABLE public.samtal_reviews ENABLE ROW LEVEL SECURITY;
CREATE INDEX samtal_reviews_call_idx ON public.samtal_reviews(company_id,call_id);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_reviews FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

CREATE TABLE public.samtal_dispatch_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid,job_id uuid UNIQUE REFERENCES public.ai_jobs(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','in_flight','accepted','completed','blocked')),
  token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),accepted_at timestamptz,running_observed_at timestamptz,completed_at timestamptz,error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,call_id) REFERENCES public.samtal_calls(company_id,id) ON DELETE SET NULL(call_id),
  CHECK((token IS NULL)=(lease_until IS NULL)),CHECK(attempts>=0)
);
REVOKE ALL ON public.samtal_dispatch_outbox FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_dispatch_outbox TO service_role;
ALTER TABLE public.samtal_dispatch_outbox ENABLE ROW LEVEL SECURITY;
CREATE INDEX samtal_dispatch_company_call_idx ON public.samtal_dispatch_outbox(company_id,call_id);
CREATE INDEX samtal_dispatch_due_idx ON public.samtal_dispatch_outbox(company_id,next_attempt) WHERE state IN('pending','in_flight','accepted');
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_dispatch_outbox FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

CREATE TABLE public.samtal_erasure_requests (
  id uuid PRIMARY KEY,company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid,actor_id uuid NOT NULL,scope text NOT NULL CHECK(scope IN('call','tenant')),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(company_id,call_id) REFERENCES public.samtal_calls(company_id,id) ON DELETE SET NULL(call_id)
);
REVOKE ALL ON public.samtal_erasure_requests FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_erasure_requests TO service_role;
ALTER TABLE public.samtal_erasure_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX samtal_erasure_call_idx ON public.samtal_erasure_requests(company_id,call_id);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_erasure_requests FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

-- Minimal replay deny-list: no raw provider id, phone, transcript or recording. No company FK: no shared deletion cascade.
CREATE TABLE public.samtal_replay_denials (
  event_digest text PRIMARY KEY CHECK(length(event_digest)=64),company_id uuid NOT NULL,
  expires_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.samtal_replay_denials FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_replay_denials TO service_role;
ALTER TABLE public.samtal_replay_denials ENABLE ROW LEVEL SECURITY;
CREATE INDEX samtal_replay_company_idx ON public.samtal_replay_denials(company_id);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON public.samtal_replay_denials FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

ALTER TABLE public.samtal_audio_ledger ADD COLUMN queue text NOT NULL DEFAULT 'urgent' CHECK(queue IN('urgent','retry','verify')),
  ADD COLUMN writer_closed_at timestamptz,ADD COLUMN closure_evidence text,
  ADD COLUMN verified_at timestamptz,ADD COLUMN verification_count integer NOT NULL DEFAULT 0,
  ADD COLUMN retire_after timestamptz;
ALTER TABLE public.samtal_calls ADD COLUMN safety_version integer NOT NULL DEFAULT 0;
CREATE INDEX samtal_audio_queue_due_idx ON public.samtal_audio_ledger(queue,company_id,retry_after);
CREATE INDEX samtal_jobs_company_ready_v2_idx ON public.samtal_jobs(company_id,run_after) WHERE state IN('queued','running');
CREATE INDEX samtal_jobs_running_v2_idx ON public.samtal_jobs(company_id,lease_until) WHERE state='running';
CREATE INDEX samtal_calls_due_company_v2_idx ON public.samtal_calls(company_id,delete_after,id) WHERE content_deleted_at IS NULL;

CREATE FUNCTION public.samtal_v2_deadline(p_until timestamptz) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
BEGIN IF p_until IS NULL OR p_until<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='samtal_lease_expired';END IF;END $$;

CREATE FUNCTION public.samtal_v2_try_tenant(p_company uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('samtal:'||p_company::text,0)) THEN RETURN false;END IF;
  PERFORM 1 FROM public.companies WHERE id=p_company FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN false;END IF;
  INSERT INTO public.samtal_tenant_state(company_id) VALUES(p_company) ON CONFLICT DO NOTHING;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_safety_live(p_call uuid,p_company uuid,p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls;j public.samtal_jobs;
BEGIN
  c:=public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.classification='privat'
    OR c.delete_after<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM companies WHERE id=p_company AND active)
    OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL)
    OR ((c.classification='osaker' OR c.extraction#>>'{interpretation,classification}'='osaker')
      AND NOT EXISTS(SELECT 1 FROM samtal_reviews WHERE call_id=p_call AND company_id=p_company AND decision='business')) THEN RETURN false;END IF;
  SELECT * INTO j FROM samtal_jobs WHERE id=p_job AND call_id=p_call AND company_id=p_company FOR UPDATE;
  RETURN coalesce(j.id IS NOT NULL AND p_token IS NOT NULL AND j.state='running' AND j.lease_token=p_token AND j.lease_until>clock_timestamp(),false);
END $$;

CREATE OR REPLACE FUNCTION public.samtal_safety_job_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.state IN('queued','running','paused') AND EXISTS(SELECT 1 FROM samtal_calls WHERE id=NEW.call_id AND company_id=NEW.company_id
    AND(content_deleted_at IS NOT NULL OR status='privat' OR classification='privat')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_call_terminal';END IF;
  IF NEW.state IN('queued','running') AND EXISTS(SELECT 1 FROM samtal_calls c WHERE c.id=NEW.call_id AND c.company_id=NEW.company_id
    AND(c.classification='osaker' OR c.extraction#>>'{interpretation,classification}'='osaker')
    AND NOT EXISTS(SELECT 1 FROM samtal_reviews r WHERE r.call_id=c.id AND r.company_id=c.company_id AND r.decision='business')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_review_required';END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_begin_delete(p_call uuid,p_company uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls;
BEGIN
  c:=public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR p_reason IS NULL OR p_reason NOT IN('private','retention','erasure') THEN RETURN false;END IF;
  IF c.content_deleted_at IS NOT NULL THEN RETURN true;END IF;
  IF p_reason='retention' AND c.delete_after>clock_timestamp() THEN RETURN false;END IF;
  IF p_reason='erasure' AND NOT EXISTS(SELECT 1 FROM samtal_erasure_requests WHERE company_id=p_company AND state='pending' AND(scope='tenant' OR call_id=p_call)) THEN RETURN false;END IF;
  PERFORM 1 FROM samtal_jobs WHERE call_id=p_call AND company_id=p_company FOR UPDATE;
  IF c.audio_path IS NOT NULL THEN INSERT INTO samtal_audio_ledger(id,company_id,call_id,audio_path,state,upload_until)
    VALUES(gen_random_uuid(),p_company,p_call,c.audio_path,'cleanup',clock_timestamp()) ON CONFLICT(company_id,audio_path) DO NOTHING;END IF;
  UPDATE samtal_audio_ledger SET state='cleanup',queue='urgent',retry_after=least(retry_after,clock_timestamp())
    WHERE company_id=p_company AND call_id=p_call AND state NOT IN('cleanup','deleted');
  UPDATE samtal_calls SET transcript=NULL,extraction=NULL,audio_path=NULL,caller_phone=NULL,content_deleted_at=clock_timestamp(),
    classification=CASE WHEN p_reason='private' THEN 'privat' ELSE classification END,status=CASE WHEN p_reason='private' THEN 'privat' ELSE status END,error_code=NULL WHERE id=p_call;
  UPDATE samtal_jobs SET state='done',step='klar',lease_token=NULL,lease_until=NULL,error_code='content_deleted' WHERE call_id=p_call AND company_id=p_company;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_release_job(p_job uuid,p_token uuid,p_state text,p_step text,p_error text,p_retry_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j samtal_jobs;deadline timestamptz;
BEGIN
  SELECT * INTO j FROM samtal_jobs WHERE id=p_job;
  IF j.id IS NULL OR NOT samtal_safety_live(j.call_id,j.company_id,p_job,p_token) THEN RETURN false;END IF;
  SELECT * INTO j FROM samtal_jobs WHERE id=p_job;SELECT least(j.lease_until,c.delete_after) INTO deadline FROM samtal_calls c WHERE c.id=j.call_id;
  IF p_state IS NULL OR p_state NOT IN('queued','done','failed') OR(p_error IS NOT NULL AND p_error!~'^[a-z0-9_]{1,60}$') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_release';END IF;
  IF p_step IS NOT NULL AND p_step<>j.step AND NOT(p_state='done' AND p_step='klar') THEN RETURN false;END IF;
  UPDATE samtal_jobs SET state=p_state,step=coalesce(p_step,step),error_code=p_error,lease_token=NULL,lease_until=NULL,
    run_after=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_retry_seconds,0),0),86400)) WHERE id=p_job;
  PERFORM samtal_v2_deadline(deadline);RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_retry_guarded(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_error text,p_retry_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE deadline timestamptz;
BEGIN
  IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN false;END IF;
  SELECT least(j.lease_until,c.delete_after) INTO deadline FROM samtal_jobs j JOIN samtal_calls c ON c.id=j.call_id WHERE j.id=p_job;
  IF p_error IS NULL OR p_error!~'^[a-z0-9_]{1,60}$' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_retry';END IF;
  UPDATE samtal_calls SET error_code=p_error,status='mottagen' WHERE id=p_call;
  UPDATE samtal_jobs SET state='queued',lease_token=NULL,lease_until=NULL,error_code=p_error,run_after=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_retry_seconds,60),1),3600)) WHERE id=p_job;
  PERFORM samtal_v2_deadline(deadline);RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_commit_private(p_call uuid,p_company uuid,p_job uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE deadline timestamptz;result boolean;
BEGIN
  IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN false;END IF;
  SELECT least(j.lease_until,c.delete_after) INTO deadline FROM samtal_jobs j JOIN samtal_calls c ON c.id=j.call_id WHERE j.id=p_job;
  result:=samtal_begin_delete(p_call,p_company,'private');PERFORM samtal_v2_deadline(deadline);RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_finish_audio(p_call uuid,p_company uuid,p_audio uuid,p_token uuid,p_uploaded boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls;a samtal_audio_ledger;deadline timestamptz;
BEGIN
  c:=samtal_safety_lock(p_call,p_company);IF c.id IS NULL THEN RETURN false;END IF;
  SELECT * INTO a FROM samtal_audio_ledger WHERE id=p_audio AND company_id=p_company AND call_id=p_call FOR UPDATE;
  IF a.id IS NULL OR p_token IS NULL OR a.upload_token IS DISTINCT FROM p_token OR a.writer_closed_at IS NOT NULL THEN RETURN false;END IF;
  IF a.state='attached' AND c.audio_path=a.audio_path AND c.content_deleted_at IS NULL AND c.delete_after>clock_timestamp() THEN RETURN true;END IF;
  IF p_uploaded IS DISTINCT FROM true OR a.state<>'reserved' OR a.upload_until<=clock_timestamp() OR c.content_deleted_at IS NOT NULL
    OR c.status='privat' OR c.classification='privat' OR c.delete_after<=clock_timestamp() OR c.audio_path IS NOT NULL
    OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM companies WHERE id=p_company AND active) THEN
    UPDATE samtal_audio_ledger SET state='cleanup',queue='urgent',retry_after=least(retry_after,clock_timestamp()) WHERE id=a.id;
    RETURN false;END IF;
  deadline:=least(a.upload_until,c.delete_after);
  UPDATE samtal_audio_ledger SET state='attached' WHERE id=a.id;
  UPDATE samtal_calls SET audio_path=a.audio_path,status='mottagen',error_code=NULL WHERE id=p_call;
  PERFORM samtal_v2_deadline(deadline);RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_write_stage(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_stage text,p_value jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j samtal_jobs;v text;deadline timestamptz;
BEGIN
  IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN false;END IF;
  SELECT * INTO j FROM samtal_jobs WHERE id=p_job;SELECT least(j.lease_until,c.delete_after) INTO deadline FROM samtal_calls c WHERE c.id=p_call;
  IF p_value IS NULL OR jsonb_typeof(p_value)<>'object' OR octet_length(p_value::text)>1000000 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_stage';END IF;
  IF p_stage='transkribera' AND j.step='transkribera' THEN
    UPDATE samtal_calls SET transcript=p_value,status='bearbetas',error_code=NULL WHERE id=p_call;UPDATE samtal_jobs SET step='tolka' WHERE id=p_job;
  ELSIF p_stage='tolka' AND j.step IN('tolka','klassificera') THEN
    v:=p_value#>>'{interpretation,classification}';IF v IS NULL OR v NOT IN('jobb','osaker') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_stage';END IF;
    IF p_value#>>'{customer_match,kind}'='befintlig' AND NOT EXISTS(SELECT 1 FROM customers WHERE company_id=p_company AND id=(p_value#>>'{customer_match,customer_id}')::uuid) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_customer';END IF;
    -- Pause BEFORE publishing the uncertain classification, so the job trigger never sees an unauthorized running job.
    IF v='osaker' THEN UPDATE samtal_jobs SET state='paused',step='inkorg',lease_token=NULL,lease_until=NULL,error_code='uncertain_needs_review' WHERE id=p_job;
      INSERT INTO samtal_reviews(call_id,company_id) VALUES(p_call,p_company) ON CONFLICT DO NOTHING;
    ELSE UPDATE samtal_jobs SET step='inkorg' WHERE id=p_job;END IF;
    UPDATE samtal_calls SET extraction=p_value,classification=v,status='bearbetas',error_code=CASE WHEN v='osaker' THEN 'uncertain_needs_review' ELSE NULL END WHERE id=p_call;
  ELSE RETURN false;END IF;
  PERFORM samtal_v2_deadline(deadline);RETURN true;
END $$;

CREATE FUNCTION public.samtal_confirm_review(p_call uuid,p_company uuid,p_actor uuid,p_request uuid,p_decision text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls;r samtal_reviews;
BEGIN
  c:=samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR p_request IS NULL OR p_decision IS NULL OR p_decision NOT IN('business','private')
    OR NOT EXISTS(SELECT 1 FROM company_members m JOIN companies x ON x.id=m.company_id WHERE m.company_id=p_company AND m.user_id=p_actor AND x.active AND(m.role='ägare' OR c.user_id=p_actor)) THEN RETURN false;END IF;
  SELECT * INTO r FROM samtal_reviews WHERE call_id=p_call AND company_id=p_company FOR UPDATE;
  IF r.call_id IS NULL THEN RETURN false;END IF;
  IF r.decision<>'pending' THEN RETURN r.request_id=p_request AND r.decision=p_decision;END IF;
  IF c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL) THEN RETURN false;END IF;
  UPDATE samtal_reviews SET decision=p_decision,request_id=p_request,actor_id=p_actor,decided_at=clock_timestamp() WHERE call_id=p_call;
  IF p_decision='private' THEN RETURN samtal_begin_delete(p_call,p_company,'private');END IF;
  UPDATE samtal_jobs SET state='queued',run_after=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE call_id=p_call AND company_id=p_company AND state='paused';
  UPDATE samtal_calls SET error_code=NULL WHERE id=p_call;PERFORM samtal_v2_deadline(c.delete_after);RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.samtal_inbox_guarded(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_inbox_guarded(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.samtal_restart_guarded(p_call uuid,p_company uuid,p_actor uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls;
BEGIN
  c:=samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() OR c.audio_path IS NULL OR c.status='privat'
    OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL)
    OR((c.classification='osaker' OR c.extraction#>>'{interpretation,classification}'='osaker') AND NOT EXISTS(SELECT 1 FROM samtal_reviews WHERE call_id=p_call AND decision='business'))
    OR NOT EXISTS(SELECT 1 FROM company_members m JOIN companies x ON x.id=m.company_id WHERE m.company_id=p_company AND m.user_id=p_actor AND m.role='ägare' AND x.active) THEN RETURN false;END IF;
  UPDATE samtal_jobs SET state='queued',run_after=clock_timestamp(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE call_id=p_call AND company_id=p_company AND state IN('paused','failed');
  IF NOT FOUND THEN RETURN false;END IF;UPDATE samtal_calls SET status='mottagen',error_code=NULL WHERE id=p_call;PERFORM samtal_v2_deadline(c.delete_after);RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_reserve_audio(p_call uuid,p_company uuid,p_request uuid,p_extension text) RETURNS public.samtal_audio_ledger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls;a samtal_audio_ledger;
BEGIN
  c:=samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.delete_after<=clock_timestamp() OR p_request IS NULL OR p_extension IS NULL OR p_extension NOT IN('mp3','m4a','mp4','wav','ogg','oga','webm','flac','aac')
    OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM companies WHERE id=p_company AND active) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_audio_not_allowed';END IF;
  SELECT * INTO a FROM samtal_audio_ledger WHERE id=p_request AND company_id=p_company FOR UPDATE;
  IF a.id IS NOT NULL THEN IF a.call_id IS DISTINCT FROM p_call OR a.company_id IS DISTINCT FROM p_company THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_audio_not_allowed';END IF;RETURN a;END IF;
  IF EXISTS(SELECT 1 FROM samtal_audio_ledger WHERE id=p_request) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_audio_not_allowed';END IF;
  SELECT * INTO a FROM samtal_audio_ledger WHERE company_id=p_company AND call_id=p_call AND state IN('reserved','attached') ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF a.id IS NOT NULL AND(a.state='attached' OR a.upload_until>clock_timestamp()) THEN RETURN a;END IF;
  IF a.id IS NOT NULL THEN UPDATE samtal_audio_ledger SET state='cleanup',queue='urgent',retry_after=clock_timestamp() WHERE id=a.id;END IF;
  INSERT INTO samtal_audio_ledger(id,company_id,call_id,audio_path,retry_after) VALUES(p_request,p_company,p_call,p_company::text||'/'||p_call::text||'/'||p_request::text||'.'||p_extension,clock_timestamp()+interval '5 minutes') RETURNING * INTO a;
  PERFORM samtal_v2_deadline(c.delete_after);RETURN a;
END $$;
CREATE UNIQUE INDEX samtal_audio_one_live_v2_idx ON public.samtal_audio_ledger(company_id,call_id) WHERE state IN('reserved','attached') AND call_id IS NOT NULL;

CREATE FUNCTION public.samtal_ingest_recover(payload jsonb,p_request uuid,p_extension text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n samtal_numbers;c samtal_calls;a samtal_audio_ledger;s samtal_settings;l samtal_runtime_limits;digest text;
BEGIN
  IF p_request IS NULL OR length(payload::text)>16000 OR payload->>'provider' IS NULL OR payload->>'provider_call_id' IS NULL THEN RETURN jsonb_build_object('status','rejected');END IF;
  SELECT * INTO n FROM samtal_numbers WHERE phone_e164=payload->>'to_phone' AND active;IF n.id IS NULL THEN RETURN jsonb_build_object('status','rejected');END IF;
  IF NOT samtal_v2_try_tenant(n.company_id) THEN RETURN jsonb_build_object('status','retry');END IF;
  IF NOT EXISTS(SELECT 1 FROM companies WHERE id=n.company_id AND active) OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=n.company_id AND retired_at IS NOT NULL) THEN RETURN jsonb_build_object('status','rejected');END IF;
  digest:=encode(sha256(convert_to((payload->>'provider')||chr(31)||(payload->>'provider_call_id'),'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM samtal_replay_denials WHERE event_digest=digest AND(expires_at IS NULL OR expires_at>clock_timestamp())) THEN RETURN jsonb_build_object('status','rejected');END IF;
  SELECT * INTO c FROM samtal_calls WHERE provider=payload->>'provider' AND provider_call_id=payload->>'provider_call_id' AND company_id=n.company_id FOR UPDATE;
  IF c.id IS NULL AND EXISTS(SELECT 1 FROM samtal_calls WHERE provider=payload->>'provider' AND provider_call_id=payload->>'provider_call_id') THEN RETURN jsonb_build_object('status','rejected');END IF;
  IF c.id IS NOT NULL AND(c.company_id<>n.company_id OR c.number_id IS DISTINCT FROM n.id OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() OR c.status='privat') THEN RETURN jsonb_build_object('status','rejected');END IF;
  IF c.id IS NULL THEN
    SELECT * INTO l FROM samtal_runtime_limits;
    IF(SELECT count(*) FROM samtal_jobs WHERE company_id=n.company_id AND state IN('paused','queued','running'))>=l.tenant_pending THEN RETURN jsonb_build_object('status','backpressure');END IF;
    SELECT * INTO s FROM samtal_settings WHERE company_id=n.company_id;
    INSERT INTO samtal_calls(company_id,user_id,number_id,provider,provider_call_id,caller_phone,started_at,ended_at,duration_seconds,delete_after,safety_version)
      VALUES(n.company_id,n.user_id,n.id,payload->>'provider',payload->>'provider_call_id',nullif(payload->>'from_phone',''),(payload->>'started_at')::timestamptz,(payload->>'ended_at')::timestamptz,(payload->>'duration_seconds')::integer,clock_timestamp()+make_interval(days=>coalesce(s.retention_days,30)),2)
      ON CONFLICT(provider,provider_call_id) DO NOTHING RETURNING * INTO c;
    IF c.id IS NULL THEN RETURN jsonb_build_object('status','retry');END IF;
    INSERT INTO samtal_jobs(company_id,call_id,state) VALUES(c.company_id,c.id,CASE WHEN coalesce(s.auto_process,false) THEN 'queued' ELSE 'paused' END);
  END IF;
  SELECT * INTO l FROM samtal_runtime_limits;
  IF c.audio_path IS NULL AND NOT EXISTS(SELECT 1 FROM samtal_audio_ledger WHERE company_id=c.company_id AND call_id=c.id AND state='reserved' AND upload_until>clock_timestamp())
    AND(SELECT count(*) FROM samtal_audio_ledger WHERE company_id=c.company_id AND call_id=c.id AND created_at>clock_timestamp()-interval '1 hour')>=l.ingest_hourly_reservations THEN RETURN jsonb_build_object('status','backpressure');END IF;
  a:=samtal_reserve_audio(c.id,c.company_id,p_request,p_extension);
  RETURN jsonb_build_object('status',CASE WHEN a.state='attached' THEN 'attached' WHEN a.id=p_request AND a.state='reserved' AND a.upload_until>clock_timestamp() THEN 'upload' ELSE 'pending' END,'call_id',c.id,'company_id',c.company_id,'auto_process',coalesce((SELECT auto_process FROM samtal_settings WHERE company_id=c.company_id),false),
    'audio',CASE WHEN a.id=p_request THEN to_jsonb(a) ELSE jsonb_build_object('id',a.id,'state',a.state) END);
END $$;

-- Close the legacy registration bypass: same signature, no audio upload token disclosed here.
CREATE OR REPLACE FUNCTION public.samtal_register_call(payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r jsonb;BEGIN r:=samtal_ingest_recover(payload,gen_random_uuid(),'mp3');
  RETURN CASE WHEN r->>'status' IN('upload','attached','pending') THEN jsonb_build_object('duplicate',r->>'status'<>'upload','call_id',r->>'call_id','company_id',r->>'company_id','auto_process',coalesce((r->>'auto_process')::boolean,false))
    ELSE jsonb_build_object('ignored',r->>'status') END;END $$;

CREATE OR REPLACE FUNCTION public.samtal_claim_jobs(p_limit integer,p_lease_seconds integer) RETURNS SETOF public.samtal_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t record;j samtal_jobs;c samtal_calls;l samtal_runtime_limits;n integer:=0;active_global integer;tenant_active integer;target uuid;
BEGIN
  -- Nonblocking short admission mutex; never wait on a company while holding it.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('samtal:v2:process-admission',0)) THEN RETURN;END IF;
  SELECT * INTO l FROM samtal_runtime_limits;SELECT count(*) INTO active_global FROM samtal_jobs WHERE state='running' AND lease_until>clock_timestamp();
  FOR t IN SELECT q.company_id FROM samtal_tenant_state q WHERE q.retired_at IS NULL AND EXISTS(SELECT 1 FROM samtal_jobs pending_job WHERE pending_job.company_id=q.company_id AND pending_job.run_after<=clock_timestamp() AND(pending_job.state='queued' OR(pending_job.state='running' AND pending_job.lease_until<=clock_timestamp())))
    ORDER BY q.process_cursor,q.company_id LIMIT l.scan_budget FOR UPDATE OF q SKIP LOCKED LOOP
    EXIT WHEN n>=least(greatest(coalesce(p_limit,5),1),50) OR active_global>=l.global_processing;
    UPDATE samtal_tenant_state SET process_cursor=clock_timestamp() WHERE company_id=t.company_id;
    IF NOT samtal_v2_try_tenant(t.company_id) THEN CONTINUE;END IF;
    SELECT count(*) INTO tenant_active FROM samtal_jobs WHERE company_id=t.company_id AND state='running' AND lease_until>clock_timestamp();
    IF tenant_active>=coalesce((SELECT process_limit FROM samtal_tenant_state WHERE company_id=t.company_id),l.default_tenant_processing) THEN CONTINUE;END IF;
    SELECT s.id INTO target FROM samtal_jobs pending_job JOIN samtal_calls s ON s.id=pending_job.call_id AND s.company_id=pending_job.company_id
      WHERE pending_job.company_id=t.company_id AND pending_job.run_after<=clock_timestamp() AND(pending_job.state='queued' OR(pending_job.state='running' AND pending_job.lease_until<=clock_timestamp()))
      AND s.content_deleted_at IS NULL AND s.status<>'privat' AND s.delete_after>clock_timestamp() AND s.audio_path IS NOT NULL
      AND(s.classification IS DISTINCT FROM 'osaker' OR EXISTS(SELECT 1 FROM samtal_reviews r WHERE r.call_id=s.id AND r.decision='business'))
      ORDER BY pending_job.run_after,pending_job.id LIMIT 1;
    SELECT * INTO c FROM samtal_calls WHERE id=target AND company_id=t.company_id FOR UPDATE SKIP LOCKED;
    IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM companies WHERE id=t.company_id AND active) THEN CONTINUE;END IF;
    SELECT * INTO j FROM samtal_jobs WHERE call_id=c.id AND company_id=t.company_id FOR UPDATE SKIP LOCKED;
    IF j.id IS NULL THEN CONTINUE;END IF;
    UPDATE samtal_jobs SET state='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_lease_seconds,900),10),3600)) WHERE id=j.id RETURNING * INTO j;
    n:=n+1;active_global:=active_global+1;RETURN NEXT j;
  END LOOP;
END $$;

CREATE FUNCTION public.samtal_claim_cleanup_class(p_queue text,p_limit integer,p_lease_seconds integer)
RETURNS SETOF public.samtal_audio_ledger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t record;a samtal_audio_ledger;c samtal_calls;l samtal_runtime_limits;n integer:=0;candidate record;
BEGIN
  IF p_queue IS NULL OR p_queue NOT IN('urgent','retry','verify') THEN RETURN;END IF;
  SELECT * INTO l FROM samtal_runtime_limits;
  FOR t IN SELECT q.company_id FROM samtal_tenant_state q WHERE EXISTS(SELECT 1 FROM samtal_audio_ledger ledger_src WHERE ledger_src.company_id=q.company_id AND ledger_src.queue=p_queue AND ledger_src.retry_after<=clock_timestamp()
      AND(ledger_src.cleanup_until IS NULL OR ledger_src.cleanup_until<=clock_timestamp()) AND(ledger_src.state IN('cleanup','deleted') OR(ledger_src.state='reserved' AND ledger_src.upload_until<=clock_timestamp())))
    OR(p_queue='urgent' AND EXISTS(SELECT 1 FROM samtal_calls call_src WHERE call_src.company_id=q.company_id AND call_src.content_deleted_at IS NULL
      AND(call_src.delete_after<=clock_timestamp() OR call_src.status='privat' OR call_src.classification='privat')))
    ORDER BY q.cleanup_cursor,q.company_id LIMIT l.scan_budget FOR UPDATE OF q SKIP LOCKED LOOP
    EXIT WHEN n>=least(greatest(coalesce(p_limit,200),1),500);
    UPDATE samtal_tenant_state SET cleanup_cursor=clock_timestamp() WHERE company_id=t.company_id;
    IF NOT samtal_v2_try_tenant(t.company_id) THEN CONTINUE;END IF;
    IF p_queue='urgent' THEN
      FOR c IN SELECT * FROM samtal_calls WHERE company_id=t.company_id AND content_deleted_at IS NULL
        AND(delete_after<=clock_timestamp() OR status='privat' OR classification='privat') ORDER BY delete_after,id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
        PERFORM samtal_begin_delete(c.id,c.company_id,CASE WHEN c.status='privat' OR c.classification='privat' THEN 'private' ELSE 'retention' END);
      END LOOP;
    END IF;
    FOR candidate IN SELECT id,call_id FROM samtal_audio_ledger WHERE company_id=t.company_id AND queue=p_queue AND retry_after<=clock_timestamp()
      AND(cleanup_until IS NULL OR cleanup_until<=clock_timestamp()) AND(state IN('cleanup','deleted') OR(state='reserved' AND upload_until<=clock_timestamp()))
      ORDER BY retry_after,id LIMIT 4 LOOP
      EXIT WHEN n>=least(greatest(coalesce(p_limit,200),1),500);
      PERFORM 1 FROM samtal_calls WHERE id=candidate.call_id AND company_id=t.company_id FOR UPDATE SKIP LOCKED;
      IF candidate.call_id IS NOT NULL AND NOT FOUND THEN CONTINUE;END IF;
      SELECT * INTO a FROM samtal_audio_ledger WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
      IF a.id IS NULL OR a.retry_after>clock_timestamp() OR a.cleanup_until>clock_timestamp() OR a.state='attached' THEN CONTINUE;END IF;
      UPDATE samtal_audio_ledger SET state='cleanup',cleanup_token=gen_random_uuid(),cleanup_until=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_lease_seconds,120),10),600)),
        attempts=attempts+1,retry_after=clock_timestamp()+interval '1 hour' WHERE id=a.id RETURNING * INTO a;
      n:=n+1;RETURN NEXT a;
    END LOOP;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_claim_cleanup(p_limit integer,p_lease_seconds integer)
RETURNS SETOF public.samtal_audio_ledger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a samtal_audio_ledger;cap integer:=least(greatest(coalesce(p_limit,200),1),500);n integer:=0;
BEGIN
  -- Compatibility path always serves urgent work first; dedicated class RPCs provide independently budgeted retries/verification.
  FOR a IN SELECT * FROM samtal_claim_cleanup_class('urgent',cap,p_lease_seconds) LOOP n:=n+1;RETURN NEXT a;END LOOP;
  IF n<cap THEN FOR a IN SELECT * FROM samtal_claim_cleanup_class('retry',cap-n,p_lease_seconds) LOOP n:=n+1;RETURN NEXT a;END LOOP;END IF;
  IF n<cap THEN FOR a IN SELECT * FROM samtal_claim_cleanup_class('verify',least(cap-n,greatest(cap/5,1)),p_lease_seconds) LOOP RETURN NEXT a;END LOOP;END IF;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_finish_cleanup(p_audio uuid,p_company uuid,p_token uuid,p_removed boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a samtal_audio_ledger;deadline timestamptz;
BEGIN
  SELECT * INTO a FROM samtal_audio_ledger WHERE id=p_audio AND company_id=p_company;IF a.id IS NULL THEN RETURN false;END IF;
  PERFORM samtal_safety_lock(a.call_id,p_company);SELECT * INTO a FROM samtal_audio_ledger WHERE id=p_audio FOR UPDATE;
  IF p_token IS NULL OR a.cleanup_token IS DISTINCT FROM p_token OR a.cleanup_until<=clock_timestamp() OR a.state<>'cleanup' THEN RETURN false;END IF;
  deadline:=a.cleanup_until;
  UPDATE samtal_audio_ledger SET state=CASE WHEN p_removed IS TRUE THEN 'deleted' ELSE 'cleanup' END,queue=CASE WHEN p_removed IS TRUE THEN 'verify' ELSE 'retry' END,
    verified_at=CASE WHEN p_removed IS TRUE THEN clock_timestamp() ELSE NULL END,
    verification_count=CASE WHEN p_removed IS TRUE THEN verification_count+1 ELSE verification_count END,
    retire_after=CASE WHEN p_removed IS TRUE AND writer_closed_at IS NOT NULL THEN clock_timestamp()+interval '1 day' ELSE NULL END,
    retry_after=clock_timestamp()+CASE WHEN p_removed IS NOT TRUE THEN make_interval(secs=>least(3600*greatest(attempts,1),86400))
      WHEN writer_closed_at IS NOT NULL THEN interval '7 days' ELSE make_interval(days=>least(greatest(verification_count+1,1),7)) END,
    error_code=CASE WHEN p_removed IS TRUE THEN NULL ELSE 'audio_remove_failed' END,cleanup_token=NULL,cleanup_until=NULL WHERE id=p_audio;
  PERFORM samtal_v2_deadline(deadline);RETURN true;
END $$;

CREATE FUNCTION public.samtal_certify_writer_closed(p_audio uuid,p_company uuid,p_evidence text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a samtal_audio_ledger;
BEGIN
  SELECT * INTO a FROM samtal_audio_ledger WHERE id=p_audio AND company_id=p_company;IF a.id IS NULL THEN RETURN false;END IF;
  PERFORM samtal_safety_lock(a.call_id,p_company);SELECT * INTO a FROM samtal_audio_ledger WHERE id=p_audio FOR UPDATE;
  IF p_evidence IS NULL OR p_evidence NOT IN('storage_write_barrier','provider_commit_window_verified') OR a.upload_until>clock_timestamp()
    OR a.state NOT IN('deleted','cleanup') OR a.cleanup_token IS NOT NULL THEN RETURN false;END IF;
  IF a.writer_closed_at IS NOT NULL THEN RETURN true;END IF;
  -- Trusted server attestation of a PROVEN external write barrier, never inferred from timeout/age alone.
  UPDATE samtal_audio_ledger SET writer_closed_at=clock_timestamp(),closure_evidence=p_evidence,verified_at=NULL,retire_after=NULL,queue='verify',retry_after=clock_timestamp() WHERE id=p_audio;
  RETURN true;
END $$;

CREATE FUNCTION public.samtal_retire_ledger(p_company uuid,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a samtal_audio_ledger;n integer:=0;
BEGIN
  IF NOT samtal_v2_try_tenant(p_company) THEN RETURN 0;END IF;
  FOR a IN SELECT * FROM samtal_audio_ledger WHERE company_id=p_company AND state='deleted' AND cleanup_token IS NULL AND writer_closed_at IS NOT NULL
    AND verified_at>=writer_closed_at AND retire_after<=clock_timestamp()
    AND(call_id IS NULL OR EXISTS(SELECT 1 FROM samtal_calls c WHERE c.id=call_id AND c.company_id=p_company AND c.content_deleted_at IS NOT NULL))
    ORDER BY retire_after,id LIMIT least(greatest(coalesce(p_limit,200),1),500) FOR UPDATE SKIP LOCKED LOOP
    DELETE FROM samtal_audio_ledger WHERE id=a.id;n:=n+1;
  END LOOP;RETURN n;
END $$;

CREATE FUNCTION public.samtal_request_erasure(p_company uuid,p_actor uuid,p_call uuid,p_request uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls;r samtal_erasure_requests;
BEGIN
  c:=samtal_safety_lock(p_call,p_company);
  IF p_request IS NULL OR NOT EXISTS(SELECT 1 FROM company_members m WHERE m.company_id=p_company AND m.user_id=p_actor
    AND(m.role='ägare' OR(p_call IS NOT NULL AND c.id IS NOT NULL AND c.user_id=p_actor))) THEN RETURN false;END IF;
  IF p_call IS NOT NULL AND c.id IS NULL THEN RETURN false;END IF;
  SELECT * INTO r FROM samtal_erasure_requests WHERE id=p_request AND company_id=p_company FOR UPDATE;
  IF r.id IS NOT NULL THEN RETURN r.company_id=p_company AND r.call_id IS NOT DISTINCT FROM p_call AND r.actor_id=p_actor;END IF;
  IF EXISTS(SELECT 1 FROM samtal_erasure_requests WHERE id=p_request) THEN RETURN false;END IF;
  INSERT INTO samtal_tenant_state(company_id) VALUES(p_company) ON CONFLICT DO NOTHING;
  INSERT INTO samtal_erasure_requests(id,company_id,call_id,actor_id,scope) VALUES(p_request,p_company,p_call,p_actor,CASE WHEN p_call IS NULL THEN 'tenant' ELSE 'call' END);
  IF p_call IS NULL THEN UPDATE samtal_tenant_state SET retired_at=coalesce(retired_at,clock_timestamp()) WHERE company_id=p_company;
  ELSE PERFORM samtal_begin_delete(p_call,p_company,'erasure');END IF;
  UPDATE samtal_dispatch_outbox SET state='blocked',token=NULL,lease_until=NULL,error_code='erasure_fence'
    WHERE company_id=p_company AND(p_call IS NULL OR call_id=p_call) AND state<>'completed';
  RETURN true;
END $$;

CREATE FUNCTION public.samtal_erase_batch(p_company uuid,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls;n integer:=0;digest text;tenant boolean;cursor_id uuid;
BEGIN
  IF NOT samtal_v2_try_tenant(p_company) THEN RETURN 0;END IF;
  tenant:=EXISTS(SELECT 1 FROM samtal_erasure_requests WHERE company_id=p_company AND scope='tenant' AND state='pending');
  SELECT erasure_cursor INTO cursor_id FROM samtal_tenant_state WHERE company_id=p_company;
  IF cursor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM samtal_calls x WHERE x.company_id=p_company AND x.id>cursor_id
    AND(tenant OR EXISTS(SELECT 1 FROM samtal_erasure_requests r WHERE r.company_id=p_company AND r.call_id=x.id AND r.state='pending'))) THEN cursor_id:=NULL;END IF;
  FOR c IN SELECT * FROM samtal_calls x WHERE x.company_id=p_company AND(tenant OR EXISTS(SELECT 1 FROM samtal_erasure_requests r WHERE r.company_id=p_company AND r.call_id=x.id AND r.state='pending'))
    AND(cursor_id IS NULL OR x.id>cursor_id)
    ORDER BY x.id LIMIT least(greatest(coalesce(p_limit,200),1),500) FOR UPDATE SKIP LOCKED LOOP
    UPDATE samtal_tenant_state SET erasure_cursor=c.id WHERE company_id=p_company;
    PERFORM samtal_begin_delete(c.id,p_company,'erasure');
    IF c.safety_version<2 AND NOT EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND legacy_inventory_verified_at IS NOT NULL) THEN CONTINUE;END IF;
    IF EXISTS(SELECT 1 FROM samtal_audio_ledger WHERE company_id=p_company AND call_id=c.id) THEN CONTINUE;END IF;
    digest:=encode(sha256(convert_to(c.provider||chr(31)||c.provider_call_id,'UTF8')),'hex');
    INSERT INTO samtal_replay_denials(event_digest,company_id) VALUES(digest,p_company) ON CONFLICT DO NOTHING;
    DELETE FROM samtal_reviews WHERE call_id=c.id;DELETE FROM samtal_inbox_receipts WHERE call_id=c.id;DELETE FROM samtal_tasks WHERE call_id=c.id AND company_id=p_company;
    UPDATE samtal_erasure_requests SET state='closed' WHERE call_id=c.id AND company_id=p_company;
    -- Outbox's nullable call link preserves separate committed shared-job authorization without retaining raw call content.
    DELETE FROM samtal_calls WHERE id=c.id AND company_id=p_company;n:=n+1;
  END LOOP;
  IF tenant AND NOT EXISTS(SELECT 1 FROM samtal_calls WHERE company_id=p_company) AND NOT EXISTS(SELECT 1 FROM samtal_audio_ledger WHERE company_id=p_company) THEN
    DELETE FROM samtal_numbers WHERE company_id=p_company;DELETE FROM samtal_settings WHERE company_id=p_company;
    UPDATE samtal_erasure_requests SET state='closed' WHERE company_id=p_company AND scope='tenant';
  END IF;RETURN n;
END $$;

CREATE FUNCTION public.samtal_claim_dispatch(p_limit integer,p_lease_seconds integer) RETURNS SETOF public.samtal_dispatch_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE t record;o samtal_dispatch_outbox;l samtal_runtime_limits;n integer:=0;g integer;local_count integer;jstate text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('samtal:v2:dispatch-admission',0)) THEN RETURN;END IF;
  SELECT * INTO l FROM samtal_runtime_limits;SELECT count(*) INTO g FROM samtal_dispatch_outbox WHERE state='in_flight' AND lease_until>clock_timestamp();
  FOR t IN SELECT q.company_id FROM samtal_tenant_state q WHERE q.retired_at IS NULL AND EXISTS(SELECT 1 FROM companies WHERE id=q.company_id AND active) AND EXISTS(SELECT 1 FROM samtal_dispatch_outbox dispatch_src WHERE dispatch_src.company_id=q.company_id AND dispatch_src.next_attempt<=clock_timestamp()
      AND(dispatch_src.state='pending' OR(dispatch_src.state='in_flight' AND dispatch_src.lease_until<=clock_timestamp()))) ORDER BY q.dispatch_cursor,q.company_id LIMIT l.scan_budget FOR UPDATE OF q SKIP LOCKED LOOP
    EXIT WHEN n>=least(greatest(coalesce(p_limit,10),1),100) OR g>=l.global_dispatch;
    UPDATE samtal_tenant_state SET dispatch_cursor=clock_timestamp() WHERE company_id=t.company_id;
    IF NOT samtal_v2_try_tenant(t.company_id) THEN CONTINUE;END IF;
    SELECT count(*) INTO local_count FROM samtal_dispatch_outbox WHERE company_id=t.company_id AND state='in_flight' AND lease_until>clock_timestamp();
    IF local_count>=coalesce((SELECT dispatch_limit FROM samtal_tenant_state WHERE company_id=t.company_id),l.default_tenant_dispatch) THEN CONTINUE;END IF;
    SELECT * INTO o FROM samtal_dispatch_outbox WHERE company_id=t.company_id AND next_attempt<=clock_timestamp() AND(state='pending' OR(state='in_flight' AND lease_until<=clock_timestamp())) ORDER BY next_attempt,id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF o.id IS NULL THEN CONTINUE;END IF;
    SELECT state INTO jstate FROM ai_jobs WHERE id=o.job_id AND company_id=o.company_id;
    IF jstate='done' THEN UPDATE samtal_dispatch_outbox SET state='completed',completed_at=clock_timestamp(),token=NULL,lease_until=NULL WHERE id=o.id;CONTINUE;END IF;
    IF jstate='running' THEN UPDATE samtal_dispatch_outbox SET state='accepted',accepted_at=coalesce(accepted_at,clock_timestamp()),running_observed_at=coalesce(running_observed_at,clock_timestamp()),next_attempt=clock_timestamp()+interval '1 minute',token=NULL,lease_until=NULL WHERE id=o.id;CONTINUE;END IF;
    IF jstate IS DISTINCT FROM 'queued' THEN UPDATE samtal_dispatch_outbox SET state='blocked',error_code='shared_job_failed',token=NULL,lease_until=NULL WHERE id=o.id;CONTINUE;END IF;
    IF o.attempts>=l.dispatch_retry_budget THEN UPDATE samtal_dispatch_outbox SET state='blocked',error_code='dispatch_budget_exhausted',token=NULL,lease_until=NULL WHERE id=o.id;CONTINUE;END IF;
    UPDATE samtal_dispatch_outbox SET state='in_flight',token=gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_lease_seconds,60),10),600)),attempts=attempts+1 WHERE id=o.id RETURNING * INTO o;
    n:=n+1;g:=g+1;RETURN NEXT o;
  END LOOP;
END $$;

CREATE FUNCTION public.samtal_finish_dispatch(p_outbox uuid,p_company uuid,p_token uuid,p_accepted boolean,p_retry_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o samtal_dispatch_outbox;jstate text;deadline timestamptz;
BEGIN
  SELECT * INTO o FROM samtal_dispatch_outbox WHERE id=p_outbox AND company_id=p_company;IF o.id IS NULL THEN RETURN false;END IF;
  PERFORM samtal_safety_lock(o.call_id,p_company);SELECT * INTO o FROM samtal_dispatch_outbox WHERE id=p_outbox FOR UPDATE;
  IF p_token IS NULL OR o.token IS DISTINCT FROM p_token OR o.lease_until<=clock_timestamp() OR o.state<>'in_flight' THEN RETURN false;END IF;deadline:=o.lease_until;
  SELECT state INTO jstate FROM ai_jobs WHERE id=o.job_id AND company_id=p_company;
  UPDATE samtal_dispatch_outbox SET state=CASE WHEN jstate='done' THEN 'completed' WHEN jstate='running' THEN 'accepted' WHEN jstate='queued' THEN 'pending' ELSE 'blocked' END,
    accepted_at=CASE WHEN p_accepted IS TRUE OR jstate IN('running','done') THEN coalesce(accepted_at,clock_timestamp()) ELSE accepted_at END,
    running_observed_at=CASE WHEN jstate='running' THEN coalesce(running_observed_at,clock_timestamp()) ELSE NULL END,
    completed_at=CASE WHEN jstate='done' THEN clock_timestamp() ELSE NULL END,
    next_attempt=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_retry_seconds,60),1),3600)),token=NULL,lease_until=NULL,
    error_code=CASE WHEN jstate NOT IN('queued','running','done') THEN 'shared_job_failed' WHEN p_accepted IS NOT TRUE THEN 'dispatch_retry' ELSE NULL END WHERE id=p_outbox;
  PERFORM samtal_v2_deadline(deadline);RETURN true;
END $$;

CREATE FUNCTION public.samtal_observe_dispatch(p_company uuid,p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o samtal_dispatch_outbox;jstate text;n integer:=0;
BEGIN
  IF NOT samtal_v2_try_tenant(p_company) THEN RETURN 0;END IF;
  FOR o IN SELECT * FROM samtal_dispatch_outbox WHERE company_id=p_company AND state='accepted' AND next_attempt<=clock_timestamp() ORDER BY next_attempt,id LIMIT least(greatest(coalesce(p_limit,50),1),200) FOR UPDATE SKIP LOCKED LOOP
    SELECT state INTO jstate FROM ai_jobs WHERE id=o.job_id AND company_id=p_company;
    UPDATE samtal_dispatch_outbox SET state=CASE WHEN jstate='done' THEN 'completed' WHEN jstate='queued' THEN 'pending'
      WHEN jstate='running' AND coalesce(running_observed_at,clock_timestamp())>clock_timestamp()-interval '15 minutes' THEN 'accepted' ELSE 'blocked' END,
      running_observed_at=CASE WHEN jstate='running' THEN coalesce(running_observed_at,clock_timestamp()) ELSE NULL END,
      completed_at=CASE WHEN jstate='done' THEN clock_timestamp() ELSE NULL END,next_attempt=clock_timestamp()+interval '1 minute',
      error_code=CASE WHEN jstate='running' AND running_observed_at<=clock_timestamp()-interval '15 minutes' THEN 'shared_running_dependency' ELSE error_code END WHERE id=o.id;
    n:=n+1;
  END LOOP;RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_audio_access_guarded(p_call uuid,p_company uuid,p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c samtal_calls;
BEGIN
  c:=samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.delete_after<=clock_timestamp() OR c.audio_path IS NULL
    OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM company_members m JOIN companies x ON x.id=m.company_id WHERE m.company_id=p_company AND m.user_id=p_actor AND x.active AND(m.role='ägare' OR c.user_id=p_actor)) THEN RETURN NULL;END IF;
  PERFORM samtal_v2_deadline(c.delete_after);RETURN c.audio_path;
END $$;

-- Internal interfaces retain service-only grants. Owner-only core remains deliberately excluded.
DO $$ DECLARE f record;BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND(p.proname IN('samtal_claim_cleanup_class','samtal_certify_writer_closed','samtal_retire_ledger','samtal_request_erasure','samtal_erase_batch','samtal_claim_dispatch','samtal_finish_dispatch','samtal_observe_dispatch','samtal_ingest_recover','samtal_confirm_review','samtal_inbox_guarded')
      OR p.proname IN('samtal_v2_deadline','samtal_v2_try_tenant')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END $$;

-- Guarded core is owner-only; public wrapper binds uncertainty and atomic dispatch intent.
ALTER FUNCTION public.samtal_inbox_guarded(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb) RENAME TO samtal_v2_inbox_core;
REVOKE ALL ON FUNCTION public.samtal_v2_inbox_core(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.samtal_inbox_guarded(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_extraction jsonb,p_title text,p_summary text,p_tasks jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r jsonb;deadline timestamptz;jid uuid;
BEGIN
  IF NOT samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN jsonb_build_object('accepted',false);END IF;
  SELECT least(j.lease_until,c.delete_after) INTO deadline FROM samtal_jobs j JOIN samtal_calls c ON c.id=j.call_id WHERE j.id=p_job;
  r:=samtal_v2_inbox_core(p_call,p_company,p_job,p_token,p_extraction,p_title,p_summary,p_tasks);
  IF coalesce((r->>'accepted')::boolean,false) THEN
    jid:=(r->>'job_id')::uuid;
    IF jid IS NULL OR NOT EXISTS(SELECT 1 FROM ai_jobs WHERE id=jid AND company_id=p_company) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_dispatch_link_missing';END IF;
    INSERT INTO samtal_dispatch_outbox(company_id,call_id,job_id) VALUES(p_company,p_call,jid) ON CONFLICT(job_id) DO NOTHING;
    PERFORM samtal_v2_deadline(deadline);
  END IF;RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.samtal_inbox_guarded(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_inbox_guarded(uuid,uuid,uuid,uuid,jsonb,text,text,jsonb) TO service_role;

CREATE FUNCTION public.samtal_dispatch_live(p_outbox uuid,p_company uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o samtal_dispatch_outbox;
BEGIN
  SELECT * INTO o FROM samtal_dispatch_outbox WHERE id=p_outbox AND company_id=p_company;IF o.id IS NULL THEN RETURN false;END IF;
  PERFORM samtal_safety_lock(o.call_id,p_company);SELECT * INTO o FROM samtal_dispatch_outbox WHERE id=p_outbox FOR UPDATE;
  RETURN coalesce(o.state='in_flight' AND p_token IS NOT NULL AND o.token=p_token AND o.lease_until>clock_timestamp()
    AND EXISTS(SELECT 1 FROM companies WHERE id=p_company AND active)
    AND NOT EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=p_company AND retired_at IS NOT NULL),false);
END $$;
REVOKE ALL ON FUNCTION public.samtal_dispatch_live(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_dispatch_live(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.samtal_certify_legacy_inventory(p_company uuid,p_evidence text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_evidence IS DISTINCT FROM 'complete_storage_inventory_verified' OR NOT samtal_v2_try_tenant(p_company) THEN RETURN false;END IF;
  UPDATE samtal_tenant_state SET legacy_inventory_verified_at=clock_timestamp() WHERE company_id=p_company;RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.samtal_certify_legacy_inventory(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_certify_legacy_inventory(uuid,text) TO service_role;

CREATE FUNCTION public.samtal_configure_tenant_limits(p_company uuid,p_actor uuid,p_processing integer,p_dispatch integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE l samtal_runtime_limits;
BEGIN
  PERFORM samtal_safety_lock(NULL,p_company);
  IF NOT EXISTS(SELECT 1 FROM company_members m JOIN companies c ON c.id=m.company_id WHERE m.company_id=p_company AND m.user_id=p_actor AND m.role='ägare' AND c.active) THEN RETURN false;END IF;
  SELECT * INTO l FROM samtal_runtime_limits;
  IF p_processing IS NULL OR p_dispatch IS NULL OR p_processing<1 OR p_processing>least(l.global_processing,128) OR p_dispatch<1 OR p_dispatch>least(l.global_dispatch,128) THEN RETURN false;END IF;
  INSERT INTO samtal_tenant_state(company_id,process_limit,dispatch_limit) VALUES(p_company,p_processing,p_dispatch)
    ON CONFLICT(company_id) DO UPDATE SET process_limit=EXCLUDED.process_limit,dispatch_limit=EXCLUDED.dispatch_limit;RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.samtal_configure_tenant_limits(uuid,uuid,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_configure_tenant_limits(uuid,uuid,integer,integer) TO service_role;