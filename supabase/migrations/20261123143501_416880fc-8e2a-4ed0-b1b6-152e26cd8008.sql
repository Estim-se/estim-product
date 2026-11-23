CREATE FUNCTION public.estim_norm_phone(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = public
AS $function$
WITH digits AS (
  SELECT regexp_replace(p, '[^0-9]', '', 'g') AS value
), normalized AS (
  SELECT CASE
    WHEN left(value, 2) = '00' THEN substring(value FROM 3)
    WHEN left(value, 1) = '0' THEN '46' || substring(value FROM 2)
    ELSE value
  END AS value
  FROM digits
)
SELECT CASE WHEN length(value) >= 8 THEN value ELSE NULL END FROM normalized;
$function$;

CREATE FUNCTION public.estim_set_won(tid uuid, won boolean)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  cid uuid := public.my_company();
  t public.threads;
  new_status text;
  latest_from text;
BEGIN
  SELECT * INTO t FROM public.threads
  WHERE id = tid AND company_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;

  IF won THEN
    IF t.status = 'vunnen' THEN RAISE EXCEPTION 'Already won'; END IF;
    IF t.status = 'analys' AND t.updated_at > now() - interval '90 seconds' THEN
      RAISE EXCEPTION 'AI busy';
    END IF;
    UPDATE public.threads SET status = 'vunnen' WHERE id = tid AND company_id = cid;
    INSERT INTO public.audit_log(company_id, user_id, event, "after")
    VALUES (cid, auth.uid(), 'Jobb markerat som vunnet', jsonb_build_object('thread_id', tid));
    RETURN 'vunnen';
  END IF;

  IF t.status <> 'vunnen' THEN RAISE EXCEPTION 'Not won'; END IF;
  SELECT m."from" INTO latest_from FROM public.messages m
  WHERE m.thread_id = tid AND m.company_id = cid
  ORDER BY m.sent_at DESC, m.created_at DESC, m.id DESC LIMIT 1;
  new_status := CASE WHEN latest_from = 'kund' THEN 'svar' ELSE 'skickad' END;
  UPDATE public.threads SET status = new_status WHERE id = tid AND company_id = cid;
  INSERT INTO public.audit_log(company_id, user_id, event, "after")
  VALUES (cid, auth.uid(), 'Jobb återställt', jsonb_build_object('thread_id', tid));
  RETURN new_status;
END;
$function$;
REVOKE ALL ON FUNCTION public.estim_set_won(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estim_set_won(uuid, boolean) TO authenticated;

CREATE FUNCTION public.estim_split_thread(tid uuid, mid uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  cid uuid := public.my_company();
  actor uuid := auth.uid();
  t public.threads;
  m public.messages;
  new_tid uuid;
  new_jid uuid;
  moved_ids uuid[];
  latest_customer uuid;
  latest_from text;
  new_status text;
BEGIN
  IF cid IS NULL OR actor IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO t FROM public.threads
  WHERE id = tid AND company_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF (t.status = 'analys' AND t.updated_at > now() - interval '90 seconds')
    OR EXISTS (SELECT 1 FROM public.ai_jobs j WHERE j.thread_id = tid AND j.company_id = cid AND j.state IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'AI busy';
  END IF;
  IF EXISTS (SELECT 1 FROM public.messages x WHERE x.thread_id = tid AND x.company_id = cid AND x.delivery_status = 'sending') THEN
    RAISE EXCEPTION 'Busy';
  END IF;
  SELECT * INTO m FROM public.messages
  WHERE id = mid AND thread_id = tid AND company_id = cid AND "from" = 'kund';
  IF NOT FOUND THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.messages x WHERE x.thread_id = tid AND x.company_id = cid
    AND (x.sent_at, x.created_at, x.id) < (m.sent_at, m.created_at, m.id)
  ) THEN RAISE EXCEPTION 'Nothing to split'; END IF;

  INSERT INTO public.threads(company_id, customer_id, place, channel, autopilot, whatsapp_auto_override, job, status, read)
  VALUES (cid, t.customer_id, t.place, t.channel, t.autopilot, t.whatsapp_auto_override, 'Nytt ärende', 'analys', false)
  RETURNING id INTO new_tid;

  SELECT array_agg(x.id) INTO moved_ids FROM public.messages x
  WHERE x.thread_id = tid AND x.company_id = cid
    AND (x.sent_at, x.created_at, x.id) >= (m.sent_at, m.created_at, m.id);
  UPDATE public.messages SET thread_id = new_tid
  WHERE company_id = cid AND thread_id = tid AND id = ANY(moved_ids);

  -- Reviewed all public thread references: deliveries and completed jobs follow their messages;
  -- quotes stay on the source thread, and drafts are reset separately.
  UPDATE public.company_document_deliveries SET thread_id = new_tid
  WHERE company_id = cid AND thread_id = tid AND message_id = ANY(moved_ids);
  UPDATE public.ai_jobs SET thread_id = new_tid
  WHERE company_id = cid AND thread_id = tid AND incoming_message_id = ANY(moved_ids);

  UPDATE public.threads SET
    last_message_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = new_tid),
    last_customer_wa_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = new_tid AND x."from" = 'kund' AND x.channel = 'wa')
  WHERE id = new_tid AND company_id = cid;
  INSERT INTO public.drafts(company_id, thread_id, channel, text, needs_review)
  VALUES (cid, new_tid, CASE WHEN t.channel = 'form' THEN 'email' ELSE t.channel END, '', true);
  SELECT x.id INTO latest_customer FROM public.messages x
  WHERE x.company_id = cid AND x.thread_id = new_tid AND x."from" = 'kund'
  ORDER BY x.sent_at DESC, x.created_at DESC, x.id DESC LIMIT 1;
  INSERT INTO public.ai_jobs(company_id, thread_id, interpret, incoming_message_id)
  VALUES (cid, new_tid, true, latest_customer) RETURNING id INTO new_jid;
  -- The existing insert trigger orders by creation time; restore the requested sent-time ordering
  -- on this newly created job without changing that trigger or its function.
  UPDATE public.ai_jobs SET incoming_message_id = latest_customer WHERE id = new_jid AND company_id = cid;

  SELECT x."from" INTO latest_from FROM public.messages x
  WHERE x.company_id = cid AND x.thread_id = tid
  ORDER BY x.sent_at DESC, x.created_at DESC, x.id DESC LIMIT 1;
  new_status := CASE WHEN t.status = 'vunnen' THEN 'vunnen' WHEN latest_from = 'kund' THEN 'svar' ELSE 'skickad' END;
  UPDATE public.threads SET
    last_message_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = tid),
    last_customer_wa_at = (SELECT max(x.sent_at) FROM public.messages x WHERE x.company_id = cid AND x.thread_id = tid AND x."from" = 'kund' AND x.channel = 'wa'),
    status = new_status
  WHERE id = tid AND company_id = cid;
  UPDATE public.drafts SET text = '', edited = false, warnings = '[]'::jsonb, needs_review = true
  WHERE company_id = cid AND thread_id = tid;

  INSERT INTO public.audit_log(company_id, user_id, event, "after") VALUES
    (cid, actor, 'Meddelanden flyttade till nytt ärende', jsonb_build_object('thread_id', tid, 'new_thread_id', new_tid)),
    (cid, actor, 'Utbrutet från tidigare ärende', jsonb_build_object('thread_id', new_tid, 'from_thread_id', tid));
  RETURN jsonb_build_object('id', new_tid, 'job_id', new_jid);
END;
$function$;
REVOKE ALL ON FUNCTION public.estim_split_thread(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estim_split_thread(uuid, uuid) TO authenticated;

CREATE FUNCTION public.estim_merge_customers(keep_id uuid, drop_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  cid uuid := public.my_company();
  keep_customer public.customers;
  drop_customer public.customers;
  locked_count integer;
BEGIN
  IF keep_id = drop_id OR cid IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
  PERFORM 1 FROM public.customers c
  WHERE c.company_id = cid AND c.id IN (keep_id, drop_id) ORDER BY c.id FOR UPDATE;
  GET DIAGNOSTICS locked_count = ROW_COUNT;
  IF locked_count <> 2 THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT * INTO keep_customer FROM public.customers WHERE id = keep_id AND company_id = cid;
  SELECT * INTO drop_customer FROM public.customers WHERE id = drop_id AND company_id = cid;
  IF (nullif(trim(keep_customer.phone), '') IS NOT NULL AND nullif(trim(drop_customer.phone), '') IS NOT NULL
      AND public.estim_norm_phone(keep_customer.phone) IS DISTINCT FROM public.estim_norm_phone(drop_customer.phone))
    OR (nullif(trim(keep_customer.email), '') IS NOT NULL AND nullif(trim(drop_customer.email), '') IS NOT NULL
      AND lower(keep_customer.email) IS DISTINCT FROM lower(drop_customer.email)) THEN
    RAISE EXCEPTION 'Conflict';
  END IF;

  -- threads is the only public table referencing customers in the inspected schema.
  UPDATE public.threads SET customer_id = keep_id WHERE company_id = cid AND customer_id = drop_id;
  DELETE FROM public.customers WHERE id = drop_id AND company_id = cid;
  UPDATE public.customers SET
    phone = CASE WHEN nullif(trim(phone), '') IS NULL THEN drop_customer.phone ELSE phone END,
    email = CASE WHEN nullif(trim(email), '') IS NULL THEN drop_customer.email ELSE email END,
    address = CASE WHEN nullif(trim(address), '') IS NULL THEN drop_customer.address ELSE address END,
    place = CASE WHEN nullif(trim(place), '') IS NULL THEN drop_customer.place ELSE place END,
    name = CASE WHEN name = 'Okänd kund' THEN drop_customer.name ELSE name END
  WHERE id = keep_id AND company_id = cid;
  INSERT INTO public.audit_log(company_id, user_id, event, "after")
  VALUES (cid, auth.uid(), 'Kunder sammanslagna', jsonb_build_object('customer_id', keep_id, 'merged_customer_id', drop_id));
  RETURN keep_id;
END;
$function$;
REVOKE ALL ON FUNCTION public.estim_merge_customers(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estim_merge_customers(uuid, uuid) TO authenticated;