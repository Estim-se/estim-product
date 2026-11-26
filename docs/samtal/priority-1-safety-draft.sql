-- DOCUMENTATION DRAFT ONLY. Never run against live Supabase without separate approval.
-- Requires existing samtal.sql, samtal-indekser.sql, samtal-sletting.sql and inkorg.sql.
-- No shared function, policy, bucket or secret is changed. No app currently calls these new APIs.
BEGIN;
SET LOCAL lock_timeout='5s';
-- A legacy object referenced by multiple calls is ambiguous; refuse rather than silently assign cleanup ownership.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.samtal_calls WHERE audio_path IS NOT NULL
    GROUP BY company_id,audio_path HAVING count(*)>1) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_duplicate_audio_path';
  END IF;
END $$;

CREATE TABLE public.samtal_audio_ledger (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  call_id uuid,
  audio_path text NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','attached','cleanup','deleted')),
  upload_token uuid NOT NULL DEFAULT gen_random_uuid(),
  upload_until timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '5 minutes'),
  cleanup_token uuid,
  cleanup_until timestamptz,
  retry_after timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code text CHECK (error_code ~ '^[a-z0-9_]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, audio_path),
  FOREIGN KEY (company_id, call_id) REFERENCES public.samtal_calls(company_id,id) ON DELETE SET NULL (call_id),
  CHECK (audio_path LIKE company_id::text || '/%' AND length(audio_path) <= 200),
  CHECK ((cleanup_token IS NULL) = (cleanup_until IS NULL))
);
REVOKE ALL ON public.samtal_audio_ledger FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_audio_ledger TO service_role;
ALTER TABLE public.samtal_audio_ledger ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated grant or policy. No Storage policy.
CREATE INDEX samtal_audio_ledger_call_idx ON public.samtal_audio_ledger(company_id,call_id);
CREATE INDEX samtal_audio_ledger_due_idx ON public.samtal_audio_ledger(retry_after);
CREATE TRIGGER samtal_audio_ledger_touch BEFORE UPDATE ON public.samtal_audio_ledger
  FOR EACH ROW EXECUTE FUNCTION public.estim_touch();
CREATE FUNCTION public.samtal_ledger_detach_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF OLD.call_id IS NOT NULL AND NEW.call_id IS NULL THEN
    NEW.state:='cleanup'; NEW.retry_after:=clock_timestamp();
    NEW.cleanup_token:=NULL; NEW.cleanup_until:=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER samtal_ledger_detach_guard BEFORE UPDATE OF call_id ON public.samtal_audio_ledger
  FOR EACH ROW EXECUTE FUNCTION public.samtal_ledger_detach_guard();

-- Durable idempotency receipt: a request and tasks are committed exactly once together.
CREATE TABLE public.samtal_inbox_receipts (
  call_id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,call_id) REFERENCES public.samtal_calls(company_id,id) ON DELETE RESTRICT
);
REVOKE ALL ON public.samtal_inbox_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.samtal_inbox_receipts TO service_role;
ALTER TABLE public.samtal_inbox_receipts ENABLE ROW LEVEL SECURITY;
CREATE INDEX samtal_inbox_receipts_call_idx ON public.samtal_inbox_receipts(company_id,call_id);
CREATE TRIGGER samtal_inbox_receipts_touch BEFORE UPDATE ON public.samtal_inbox_receipts
  FOR EACH ROW EXECUTE FUNCTION public.estim_touch();

-- One advisory transaction lock per company: serializes only Samtal lifecycle operations.
-- Lock order: company advisory -> company row -> call -> job -> ledgers/receipts.
-- The company row is locked first because unchanged estim_receive also locks it.
CREATE FUNCTION public.samtal_safety_lock(p_call uuid,p_company uuid)
RETURNS public.samtal_calls LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.samtal_calls;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('samtal:' || p_company::text,0));
  PERFORM 1 FROM public.companies WHERE id=p_company FOR UPDATE;
  SELECT * INTO c FROM public.samtal_calls WHERE id=p_call AND company_id=p_company FOR UPDATE;
  RETURN c;
END $$;

CREATE FUNCTION public.samtal_safety_live(p_call uuid,p_company uuid,p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.samtal_calls; j public.samtal_jobs;
BEGIN
  c := public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.status='privat'
     OR c.classification='privat' OR c.delete_after<=clock_timestamp()
     OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=p_company AND active) THEN RETURN false; END IF;
  SELECT * INTO j FROM public.samtal_jobs WHERE id=p_job AND call_id=p_call AND company_id=p_company FOR UPDATE;
  RETURN coalesce(j.id IS NOT NULL AND p_token IS NOT NULL AND j.state='running'
     AND j.lease_token=p_token AND j.lease_until>clock_timestamp(),false);
END $$;

-- Permanent tombstone. Legacy raw content writes after deletion are rejected too.
CREATE FUNCTION public.samtal_safety_terminal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.content_deleted_at IS NOT NULL
     AND NEW.content_deleted_at IS DISTINCT FROM OLD.content_deleted_at THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_content_terminal';
  END IF;
  IF NEW.content_deleted_at IS NOT NULL AND
     (NEW.transcript IS NOT NULL OR NEW.extraction IS NOT NULL OR NEW.audio_path IS NOT NULL OR NEW.caller_phone IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_content_terminal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER samtal_safety_terminal_guard BEFORE INSERT OR UPDATE ON public.samtal_calls
  FOR EACH ROW EXECUTE FUNCTION public.samtal_safety_terminal_guard();

CREATE FUNCTION public.samtal_safety_job_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NEW.state IN ('queued','running','paused') AND EXISTS(
    SELECT 1 FROM public.samtal_calls WHERE id=NEW.call_id AND company_id=NEW.company_id
      AND (content_deleted_at IS NOT NULL OR status='privat' OR classification='privat')) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_call_terminal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER samtal_safety_job_guard BEFORE INSERT OR UPDATE ON public.samtal_jobs
  FOR EACH ROW EXECUTE FUNCTION public.samtal_safety_job_guard();

CREATE FUNCTION public.samtal_reserve_audio(p_call uuid,p_company uuid,p_request uuid,p_extension text)
RETURNS public.samtal_audio_ledger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls; a public.samtal_audio_ledger;
BEGIN
  c := public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.classification='privat'
     OR c.delete_after<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=p_company AND active)
     OR p_request IS NULL OR p_extension IS NULL OR p_extension NOT IN ('mp3','m4a','mp4','wav','ogg','oga','webm','flac','aac') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_audio_not_allowed';
  END IF;
  SELECT * INTO a FROM public.samtal_audio_ledger WHERE id=p_request FOR UPDATE;
  IF a.id IS NOT NULL THEN
    IF a.call_id<>p_call OR a.company_id<>p_company THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_audio_not_allowed';
    END IF;
    RETURN a;
  END IF;
  INSERT INTO public.samtal_audio_ledger(id,company_id,call_id,audio_path,retry_after)
    VALUES(p_request,p_company,p_call,p_company::text || '/' || p_call::text || '/' || p_request::text || '.' || p_extension,
      clock_timestamp()+interval '5 minutes') RETURNING * INTO a;
  RETURN a;
END $$;

-- Metadata-only reconciliation of existing canonical paths; no audio bytes are read.
-- Call only from a bounded, company-scoped Storage listing after old writers are drained.
CREATE FUNCTION public.samtal_track_orphan(p_company uuid,p_path text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls; candidate uuid; a public.samtal_audio_ledger;
BEGIN
  IF p_path IS NULL OR p_path !~ ('^' || p_company::text || '/[0-9a-f-]{36}([.][a-z0-9]{2,5}|/[0-9a-f-]{36}[.][a-z0-9]{2,5})$') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_audio_path';
  END IF;
  candidate:=split_part(split_part(p_path,'/',2),'.',1)::uuid;
  c:=public.samtal_safety_lock(candidate,p_company);
  IF NOT EXISTS(SELECT 1 FROM public.companies WHERE id=p_company) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_audio_path';
  END IF;
  INSERT INTO public.samtal_audio_ledger(id,company_id,call_id,audio_path,state,upload_until)
    VALUES(gen_random_uuid(),p_company,c.id,p_path,
      CASE WHEN c.audio_path=p_path AND c.content_deleted_at IS NULL AND c.status<>'privat'
        AND c.classification IS DISTINCT FROM 'privat' AND c.delete_after>clock_timestamp() THEN 'attached' ELSE 'cleanup' END,
      clock_timestamp()) ON CONFLICT(company_id,audio_path) DO NOTHING;
  SELECT * INTO a FROM public.samtal_audio_ledger WHERE company_id=p_company AND audio_path=p_path FOR UPDATE;
  IF c.audio_path=p_path AND c.content_deleted_at IS NULL AND c.status<>'privat'
     AND c.classification IS DISTINCT FROM 'privat' AND c.delete_after>clock_timestamp() THEN RETURN a.id; END IF;
  IF a.state='reserved' AND a.upload_until>clock_timestamp() AND c.id IS NOT NULL
     AND c.content_deleted_at IS NULL AND c.status<>'privat' AND c.classification IS DISTINCT FROM 'privat'
     AND c.delete_after>clock_timestamp() THEN RETURN a.id; END IF;
  -- Discovery accelerates known orphan/deleted paths, without invalidating an active cleanup lease.
  UPDATE public.samtal_audio_ledger SET state='cleanup',retry_after=least(retry_after,clock_timestamp()) WHERE id=a.id;
  RETURN a.id;
END $$;

CREATE FUNCTION public.samtal_finish_audio(p_call uuid,p_company uuid,p_audio uuid,p_token uuid,p_uploaded boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls; a public.samtal_audio_ledger;
BEGIN
  c := public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO a FROM public.samtal_audio_ledger WHERE id=p_audio AND company_id=p_company AND call_id=p_call FOR UPDATE;
  IF a.id IS NULL OR p_token IS NULL OR a.upload_token<>p_token THEN RETURN false; END IF;
  IF a.state='attached' AND c.audio_path=a.audio_path AND c.content_deleted_at IS NULL
     AND c.delete_after>clock_timestamp() AND c.status<>'privat' AND c.classification IS DISTINCT FROM 'privat' THEN RETURN true; END IF;
  IF p_uploaded IS DISTINCT FROM true OR a.state<>'reserved' OR a.upload_until<=clock_timestamp()
     OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.classification='privat'
     OR c.delete_after<=clock_timestamp() OR c.audio_path IS NOT NULL
     OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=p_company AND active) THEN
    UPDATE public.samtal_audio_ledger SET state='cleanup',retry_after=clock_timestamp(),cleanup_token=NULL,cleanup_until=NULL WHERE id=a.id;
    RETURN false;
  END IF;
  UPDATE public.samtal_audio_ledger SET state='attached' WHERE id=a.id;
  UPDATE public.samtal_calls SET audio_path=a.audio_path,status='mottagen',error_code=NULL WHERE id=p_call;
  RETURN true;
END $$;

-- Capture old paths before clearing any call field. Idempotent, including private terminalization.
CREATE FUNCTION public.samtal_begin_delete(p_call uuid,p_company uuid,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls;
BEGIN
  c := public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR p_reason IS NULL OR p_reason NOT IN ('retention','private') THEN RETURN false; END IF;
  IF p_reason='retention' AND c.content_deleted_at IS NULL AND c.delete_after>clock_timestamp() THEN RETURN false; END IF;
  PERFORM 1 FROM public.samtal_jobs WHERE call_id=p_call AND company_id=p_company FOR UPDATE;
  IF c.audio_path IS NOT NULL THEN
    INSERT INTO public.samtal_audio_ledger(id,company_id,call_id,audio_path,state,upload_until)
      VALUES(gen_random_uuid(),p_company,p_call,c.audio_path,'cleanup',clock_timestamp())
      ON CONFLICT(company_id,audio_path) DO NOTHING;
  END IF;
  UPDATE public.samtal_audio_ledger SET state='cleanup',retry_after=clock_timestamp(),cleanup_token=NULL,cleanup_until=NULL
    WHERE company_id=p_company AND call_id=p_call;
  UPDATE public.samtal_calls SET transcript=NULL,extraction=NULL,audio_path=NULL,caller_phone=NULL,
    content_deleted_at=coalesce(content_deleted_at,clock_timestamp()),
    classification=CASE WHEN p_reason='private' THEN 'privat' ELSE classification END,
    status=CASE WHEN p_reason='private' THEN 'privat' ELSE status END,error_code=NULL WHERE id=p_call;
  UPDATE public.samtal_jobs SET state='done',step='klar',lease_token=NULL,lease_until=NULL,error_code='content_deleted'
    WHERE company_id=p_company AND call_id=p_call;
  RETURN true;
END $$;

CREATE FUNCTION public.samtal_commit_private(p_call uuid,p_company uuid,p_job uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN false; END IF;
  RETURN public.samtal_begin_delete(p_call,p_company,'private');
END $$;

-- Keep existing signature/grants but atomically terminalize before any external storage cleanup.
CREATE OR REPLACE FUNCTION public.samtal_mark_deleted(p_call uuid,p_company uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN RETURN public.samtal_begin_delete(p_call,p_company,'retention'); END $$;

CREATE OR REPLACE FUNCTION public.samtal_claim_jobs(p_limit integer,p_lease_seconds integer)
RETURNS SETOF public.samtal_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE candidate record; c public.samtal_calls; j public.samtal_jobs; n integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('samtal:safety-batch',0));
  FOR candidate IN SELECT x.call_id,x.company_id FROM public.samtal_jobs x JOIN public.samtal_calls s
      ON s.id=x.call_id AND s.company_id=x.company_id
      WHERE x.run_after<=clock_timestamp() AND (x.state='queued' OR (x.state='running' AND x.lease_until<clock_timestamp()))
      AND s.content_deleted_at IS NULL AND s.status<>'privat' AND s.classification IS DISTINCT FROM 'privat'
      AND s.delete_after>clock_timestamp() AND s.audio_path IS NOT NULL
      ORDER BY x.run_after,x.company_id,x.call_id LOOP
    EXIT WHEN n>=least(greatest(coalesce(p_limit,5),1),50);
    c:=public.samtal_safety_lock(candidate.call_id,candidate.company_id);
    SELECT * INTO j FROM public.samtal_jobs WHERE call_id=c.id AND company_id=c.company_id FOR UPDATE;
    IF c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.classification='privat' OR c.audio_path IS NULL
       OR c.delete_after<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.companies WHERE id=c.company_id AND active)
       OR NOT (j.run_after<=clock_timestamp() AND (j.state='queued' OR (j.state='running' AND j.lease_until<clock_timestamp()))) THEN CONTINUE; END IF;
    UPDATE public.samtal_jobs SET state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
      lease_until=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_lease_seconds,900),10),3600))
      WHERE id=j.id RETURNING * INTO j;
    n:=n+1; RETURN NEXT j;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.samtal_release_job(p_job uuid,p_token uuid,p_state text,p_step text,p_error text,p_retry_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j public.samtal_jobs;
BEGIN
  SELECT * INTO j FROM public.samtal_jobs WHERE id=p_job;
  IF j.id IS NULL OR NOT public.samtal_safety_live(j.call_id,j.company_id,p_job,p_token) THEN RETURN false; END IF;
  SELECT * INTO j FROM public.samtal_jobs WHERE id=p_job;
  IF p_state IS NULL OR p_state NOT IN ('queued','done','failed') OR (p_error IS NOT NULL AND p_error !~ '^[a-z0-9_]{1,60}$') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_release';
  END IF;
  IF p_step IS NOT NULL AND p_step<>j.step AND NOT (p_state='done' AND p_step='klar') THEN RETURN false; END IF;
  UPDATE public.samtal_jobs SET state=p_state,step=coalesce(p_step,step),error_code=p_error,lease_token=NULL,lease_until=NULL,
    run_after=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_retry_seconds,0),0),86400)) WHERE id=p_job;
  RETURN true;
END $$;

-- Actor is the verified Supabase auth user, passed only by an authenticated Samtal server handler.
CREATE FUNCTION public.samtal_restart_guarded(p_call uuid,p_company uuid,p_actor uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls;
BEGIN
  c:=public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.classification='privat'
    OR c.delete_after<=clock_timestamp() OR c.audio_path IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.company_members m JOIN public.companies x ON x.id=m.company_id
      WHERE m.company_id=p_company AND m.user_id=p_actor AND m.role='ägare' AND x.active) THEN RETURN false; END IF;
  UPDATE public.samtal_jobs SET state='queued',run_after=clock_timestamp(),error_code=NULL
    WHERE call_id=p_call AND company_id=p_company AND state IN ('paused','failed');
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.samtal_calls SET status='mottagen',error_code=NULL WHERE id=p_call;
  RETURN true;
END $$;

CREATE FUNCTION public.samtal_write_stage(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_stage text,p_value jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE j public.samtal_jobs; v_classification text;
BEGIN
  IF NOT public.samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN false; END IF;
  SELECT * INTO j FROM public.samtal_jobs WHERE id=p_job;
  IF p_value IS NULL OR jsonb_typeof(p_value)<>'object' OR octet_length(p_value::text)>1000000 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_stage';
  END IF;
  IF p_stage='transkribera' AND j.step='transkribera' THEN
    UPDATE public.samtal_calls SET transcript=p_value,status='bearbetas',error_code=NULL WHERE id=p_call;
    UPDATE public.samtal_jobs SET step='tolka' WHERE id=p_job;
  ELSIF p_stage='tolka' AND j.step IN ('tolka','klassificera') THEN
    v_classification:=p_value#>>'{interpretation,classification}';
    IF v_classification IS NULL OR v_classification NOT IN ('jobb','osaker') THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_stage';
    END IF;
    IF p_value#>>'{customer_match,kind}'='befintlig' AND NOT EXISTS(
      SELECT 1 FROM public.customers WHERE company_id=p_company AND id=(p_value#>>'{customer_match,customer_id}')::uuid) THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_customer';
    END IF;
    UPDATE public.samtal_calls SET extraction=p_value,classification=v_classification,status='bearbetas',error_code=NULL WHERE id=p_call;
    UPDATE public.samtal_jobs SET step='inkorg' WHERE id=p_job;
  ELSE RETURN false;
  END IF;
  IF NOT public.samtal_safety_live(p_call,p_company,p_job,p_token) THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='samtal_lease_expired';
  END IF;
  RETURN true;
END $$;

-- Retry preserves the persisted stage. Retention/private-intent persistence failures must not hit an app-side cap.
CREATE FUNCTION public.samtal_retry_guarded(p_call uuid,p_company uuid,p_job uuid,p_token uuid,p_error text,p_retry_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NOT public.samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN false; END IF;
  IF p_error IS NULL OR p_error !~ '^[a-z0-9_]{1,60}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_retry';
  END IF;
  UPDATE public.samtal_calls SET error_code=p_error,status='mottagen' WHERE id=p_call;
  UPDATE public.samtal_jobs SET state='queued',lease_token=NULL,lease_until=NULL,error_code=p_error,
    run_after=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_retry_seconds,60),1),3600)) WHERE id=p_job;
  RETURN true;
END $$;

-- Returns only an eligible path to the authenticated server signer, never to the browser directly.
CREATE FUNCTION public.samtal_audio_access_guarded(p_call uuid,p_company uuid,p_actor uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls;
BEGIN
  c:=public.samtal_safety_lock(p_call,p_company);
  IF c.id IS NULL OR c.content_deleted_at IS NOT NULL OR c.status='privat' OR c.classification='privat'
     OR c.delete_after<=clock_timestamp() OR c.audio_path IS NULL
     OR NOT EXISTS(SELECT 1 FROM public.company_members m JOIN public.companies x ON x.id=m.company_id
       WHERE m.company_id=p_company AND m.user_id=p_actor AND x.active AND (m.role='ägare' OR c.user_id=p_actor)) THEN RETURN NULL; END IF;
  RETURN c.audio_path;
END $$;

-- Call/job locks cover unchanged estim_receive, tasks and receipt: one transaction, no external dispatch inside it.
-- Presentation payload/tasks are generated by existing Samtal pure helpers from this saved extraction.
-- Version equality binds them to persisted content; routing and identities are taken from the database.
CREATE FUNCTION public.samtal_inbox_guarded(p_call uuid,p_company uuid,p_job uuid,p_token uuid,
  p_extraction jsonb,p_title text,p_summary text,p_tasks jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.samtal_calls; r jsonb; task jsonb; tid uuid; v_phone text;
BEGIN
  IF NOT public.samtal_safety_live(p_call,p_company,p_job,p_token) THEN RETURN jsonb_build_object('accepted',false); END IF;
  SELECT result INTO r FROM public.samtal_inbox_receipts WHERE call_id=p_call AND company_id=p_company;
  IF FOUND THEN RETURN r || jsonb_build_object('accepted',true,'replayed',true); END IF;
  SELECT * INTO c FROM public.samtal_calls WHERE id=p_call;
  IF (SELECT step FROM public.samtal_jobs WHERE id=p_job)<>'inkorg' OR c.extraction IS DISTINCT FROM p_extraction
     OR c.classification NOT IN ('jobb','osaker') THEN RETURN jsonb_build_object('accepted',false); END IF;
  IF p_title IS NULL OR length(p_title)>200 OR p_summary IS NULL OR length(trim(p_summary))=0 OR length(p_summary)>30000
     OR p_tasks IS NULL OR jsonb_typeof(p_tasks)<>'array' OR jsonb_array_length(p_tasks)>5 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_inbox';
  END IF;
  IF c.extraction#>>'{customer_match,kind}'='befintlig' THEN
    SELECT x.phone INTO v_phone FROM public.customers x WHERE x.company_id=p_company AND x.id=(c.extraction#>>'{customer_match,customer_id}')::uuid;
  END IF;
  v_phone:=coalesce(v_phone,c.extraction#>>'{interpretation,fields,customer_phone,value}',c.caller_phone);
  r:=public.estim_receive(p_company,jsonb_build_object('channel','samtal','provider_message_id','samtal:' || p_call::text,
    'sent_at',c.started_at,'customer_phone',v_phone,'customer_name',c.extraction#>>'{interpretation,fields,customer_name,value}',
    'address',c.extraction#>>'{interpretation,fields,address,value}','place',c.extraction#>>'{interpretation,fields,place,value}',
    'job',p_title,'text',p_summary),NULL);
  tid:=(r->>'id')::uuid;
  IF tid IS NULL THEN SELECT thread_id INTO tid FROM public.messages
    WHERE company_id=p_company AND channel='samtal' AND provider_message_id='samtal:' || p_call::text LIMIT 1; END IF;
  IF tid IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='samtal_inbox_missing'; END IF;
  -- Repair retry of a pre-upgrade request without duplicating pre-existing Samtal tasks.
  IF NOT EXISTS(SELECT 1 FROM public.samtal_tasks WHERE company_id=p_company AND call_id=p_call) THEN
    FOR task IN SELECT value FROM jsonb_array_elements(p_tasks) LOOP
      IF (task->>'kind') IS NULL OR (task->>'kind') NOT IN ('ring_tillbaka','platsbesok','offert')
         OR nullif(task->>'title','') IS NULL OR length(task->>'title')>200 OR length(task->>'address')>300 THEN
        RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='samtal_invalid_tasks';
      END IF;
      INSERT INTO public.samtal_tasks(company_id,call_id,user_id,kind,title,due_at,address)
        VALUES(p_company,p_call,c.user_id,task->>'kind',task->>'title',(task->>'due_at')::timestamptz,task->>'address');
    END LOOP;
  END IF;
  UPDATE public.samtal_calls SET thread_id=tid,customer_id=(SELECT customer_id FROM public.threads WHERE id=tid AND company_id=p_company),status='klar' WHERE id=p_call;
  r:=r || jsonb_build_object('accepted',true,'id',tid);
  INSERT INTO public.samtal_inbox_receipts(call_id,company_id,result) VALUES(p_call,p_company,r);
  -- Recheck wall-clock expiry before commit; an exception rolls back ALL side effects.
  IF NOT public.samtal_safety_live(p_call,p_company,p_job,p_token) THEN
    RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='samtal_lease_expired';
  END IF;
  UPDATE public.samtal_jobs SET state='done',step='klar',lease_token=NULL,lease_until=NULL WHERE id=p_job;
  RETURN r;
END $$;

-- Terminalize all due calls even without audio; then claim durable cleanup paths.
-- Deleted ledger entries stay eligible for periodic rechecks, so a late upload/crash cannot become untracked.
CREATE FUNCTION public.samtal_claim_cleanup(p_limit integer,p_lease_seconds integer)
RETURNS SETOF public.samtal_audio_ledger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE candidate record; a public.samtal_audio_ledger; c public.samtal_calls; n integer:=0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('samtal:safety-batch',0));
  FOR candidate IN SELECT id,company_id,CASE WHEN status='privat' OR classification='privat' THEN 'private' ELSE 'retention' END AS reason
      FROM public.samtal_calls WHERE content_deleted_at IS NULL
      AND (delete_after<=clock_timestamp() OR status='privat' OR classification='privat')
      ORDER BY delete_after,company_id,id LIMIT least(greatest(coalesce(p_limit,200),1),500) LOOP
    PERFORM public.samtal_begin_delete(candidate.id,candidate.company_id,candidate.reason);
  END LOOP;
  FOR candidate IN SELECT id,call_id,company_id FROM public.samtal_audio_ledger
      WHERE retry_after<=clock_timestamp() AND (cleanup_until IS NULL OR cleanup_until<=clock_timestamp())
      AND (state IN ('cleanup','deleted') OR (state='reserved' AND upload_until<=clock_timestamp()))
      ORDER BY retry_after,company_id,call_id,id LOOP
    EXIT WHEN n>=least(greatest(coalesce(p_limit,200),1),500);
    c:=public.samtal_safety_lock(candidate.call_id,candidate.company_id);
    SELECT * INTO a FROM public.samtal_audio_ledger WHERE id=candidate.id FOR UPDATE;
    IF a.retry_after>clock_timestamp() OR a.cleanup_until>clock_timestamp() OR a.state='attached'
       OR (a.state='reserved' AND a.upload_until>clock_timestamp()) THEN CONTINUE; END IF;
    UPDATE public.samtal_audio_ledger SET state='cleanup',cleanup_token=gen_random_uuid(),
      cleanup_until=clock_timestamp()+make_interval(secs=>least(greatest(coalesce(p_lease_seconds,120),10),600)),
      retry_after=clock_timestamp()+interval '1 hour',attempts=attempts+1
      WHERE id=a.id RETURNING * INTO a;
    n:=n+1; RETURN NEXT a;
  END LOOP;
END $$;

CREATE FUNCTION public.samtal_finish_cleanup(p_audio uuid,p_company uuid,p_token uuid,p_removed boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.samtal_audio_ledger;
BEGIN
  SELECT * INTO a FROM public.samtal_audio_ledger WHERE id=p_audio AND company_id=p_company;
  IF a.id IS NULL THEN RETURN false; END IF;
  PERFORM public.samtal_safety_lock(a.call_id,p_company);
  SELECT * INTO a FROM public.samtal_audio_ledger WHERE id=p_audio FOR UPDATE;
  IF p_token IS NULL OR a.cleanup_token IS DISTINCT FROM p_token OR a.cleanup_until<=clock_timestamp() OR a.state<>'cleanup' THEN RETURN false; END IF;
  UPDATE public.samtal_audio_ledger SET state=CASE WHEN p_removed IS TRUE THEN 'deleted' ELSE 'cleanup' END,
    retry_after=clock_timestamp()+CASE WHEN p_removed IS TRUE THEN interval '1 day' ELSE interval '1 hour' END,
    error_code=CASE WHEN p_removed IS TRUE THEN NULL ELSE 'audio_remove_failed' END,cleanup_token=NULL,cleanup_until=NULL WHERE id=p_audio;
  RETURN true;
END $$;

-- Explicit internal grants: no helper is public merely because it is SECURITY DEFINER.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('samtal_ledger_detach_guard','samtal_track_orphan','samtal_safety_lock','samtal_safety_live','samtal_safety_terminal_guard',
      'samtal_safety_job_guard','samtal_reserve_audio','samtal_finish_audio','samtal_begin_delete','samtal_commit_private',
      'samtal_restart_guarded','samtal_write_stage','samtal_retry_guarded','samtal_audio_access_guarded','samtal_inbox_guarded','samtal_claim_cleanup','samtal_finish_cleanup') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END LOOP;
END $$;

-- Backfill ONLY existing call paths into durable tracking; no storage/data inspection is performed by this draft.
-- Tombstoned rows with unexpectedly restored paths become cleanup rows before their content is re-cleared.
INSERT INTO public.samtal_audio_ledger(id,company_id,call_id,audio_path,state,upload_until)
SELECT gen_random_uuid(),company_id,id,audio_path,
  CASE WHEN content_deleted_at IS NOT NULL OR status='privat' OR classification='privat' OR delete_after<=clock_timestamp()
       THEN 'cleanup' ELSE 'attached' END,clock_timestamp()
FROM public.samtal_calls WHERE audio_path IS NOT NULL ON CONFLICT(company_id,audio_path) DO NOTHING;
UPDATE public.samtal_calls SET transcript=NULL,extraction=NULL,audio_path=NULL,caller_phone=NULL WHERE content_deleted_at IS NOT NULL;
UPDATE public.samtal_jobs j SET state='done',step='klar',lease_token=NULL,lease_until=NULL,error_code='content_deleted'
FROM public.samtal_calls c WHERE j.call_id=c.id AND j.company_id=c.company_id AND c.content_deleted_at IS NOT NULL;
-- Force every server mutation through a scoped SECURITY DEFINER API. Bypass-RLS does not bypass SQL privileges.
-- Owner/employee policies and grants remain unchanged. Old app workers MUST be drained before eventual rollout.
REVOKE INSERT,UPDATE,DELETE ON public.samtal_calls,public.samtal_jobs,public.samtal_tasks FROM service_role;
COMMIT;