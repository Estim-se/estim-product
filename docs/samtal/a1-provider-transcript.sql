-- estim Samtal A1 – provider-delivered transcript (CANDIDATE, NOT APPLIED).
-- Applies on top of docs/samtal/priority-1-coordinated-v2.sql, in the same transaction or right after it.
-- Documentation only: never run against a connected database without separate approval.
--
-- One new service-role-only function. No table, column, policy, grant or existing function changes.
-- Registration mirrors samtal_ingest_recover (receiving number -> company, tenant lock, replay denials, backpressure,
-- duplicate key provider + provider_call_id), but reserves no audio. The transcript is stored only when:
--   * its provenance names the same provider and provider call id as the payload,
--   * the call is not deleted, private, erased, past its deadline, or in a retired tenant,
--   * the call has no transcript yet and its job is still at 'transkribera' and not running.
-- The job then moves to 'tolka', so speech to text is skipped. Company and employee always come from the number.

CREATE FUNCTION public.samtal_ingest_transcript(payload jsonb, p_transcript jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE n samtal_numbers;c samtal_calls;j samtal_jobs;s samtal_settings;l samtal_runtime_limits;digest text;
BEGIN
  IF payload IS NULL OR length(payload::text)>16000 OR payload->>'provider' IS NULL OR payload->>'provider_call_id' IS NULL
    OR p_transcript IS NULL OR jsonb_typeof(p_transcript)<>'object' OR octet_length(p_transcript::text)>1000000
    OR jsonb_typeof(p_transcript->'segments')<>'array' OR jsonb_array_length(p_transcript->'segments')=0
    OR p_transcript#>>'{provenance,kind}' IS DISTINCT FROM 'provider'
    OR p_transcript#>>'{provenance,provider}' IS DISTINCT FROM payload->>'provider'
    OR p_transcript#>>'{provenance,provider_call_id}' IS DISTINCT FROM payload->>'provider_call_id' THEN
    RETURN jsonb_build_object('status','rejected');
  END IF;
  SELECT * INTO n FROM samtal_numbers WHERE phone_e164=payload->>'to_phone' AND active;IF n.id IS NULL THEN RETURN jsonb_build_object('status','rejected');END IF;
  IF NOT samtal_v2_try_tenant(n.company_id) THEN RETURN jsonb_build_object('status','retry');END IF;
  IF NOT EXISTS(SELECT 1 FROM companies WHERE id=n.company_id AND active) OR EXISTS(SELECT 1 FROM samtal_tenant_state WHERE company_id=n.company_id AND retired_at IS NOT NULL) THEN RETURN jsonb_build_object('status','rejected');END IF;
  digest:=encode(sha256(convert_to((payload->>'provider')||chr(31)||(payload->>'provider_call_id'),'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM samtal_replay_denials WHERE event_digest=digest AND(expires_at IS NULL OR expires_at>clock_timestamp())) THEN RETURN jsonb_build_object('status','rejected');END IF;
  SELECT * INTO c FROM samtal_calls WHERE provider=payload->>'provider' AND provider_call_id=payload->>'provider_call_id' AND company_id=n.company_id FOR UPDATE;
  IF c.id IS NULL AND EXISTS(SELECT 1 FROM samtal_calls WHERE provider=payload->>'provider' AND provider_call_id=payload->>'provider_call_id') THEN RETURN jsonb_build_object('status','rejected');END IF;
  IF c.id IS NOT NULL AND(c.number_id IS DISTINCT FROM n.id OR c.content_deleted_at IS NOT NULL OR c.delete_after<=clock_timestamp() OR c.status='privat') THEN RETURN jsonb_build_object('status','rejected');END IF;
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
  SELECT * INTO j FROM samtal_jobs WHERE call_id=c.id AND company_id=c.company_id FOR UPDATE;
  IF c.transcript IS NOT NULL OR j.id IS NULL OR j.step<>'transkribera' OR j.state NOT IN('queued','paused') THEN
    RETURN jsonb_build_object('status','duplicate','call_id',c.id,'company_id',c.company_id);
  END IF;
  UPDATE samtal_calls SET transcript=p_transcript,error_code=NULL WHERE id=c.id;
  UPDATE samtal_jobs SET step='tolka' WHERE id=j.id;
  PERFORM samtal_v2_deadline(c.delete_after);
  RETURN jsonb_build_object('status','attached','call_id',c.id,'company_id',c.company_id,
    'auto_process',coalesce((SELECT auto_process FROM samtal_settings WHERE company_id=c.company_id),false));
END $$;
REVOKE ALL ON FUNCTION public.samtal_ingest_transcript(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.samtal_ingest_transcript(jsonb,jsonb) TO service_role;

-- The V2 claim admits only calls with a recording. Same function, one condition widened: a call is also claimable when
-- it carries a stored provider transcript (only samtal_ingest_transcript writes one, with matching provenance).
-- Everything else in the claim (fair tenant admission, limits, review hold, deletion checks) is unchanged.
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
      AND s.content_deleted_at IS NULL AND s.status<>'privat' AND s.delete_after>clock_timestamp() AND(s.audio_path IS NOT NULL OR s.transcript#>>'{provenance,kind}'='provider')
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
