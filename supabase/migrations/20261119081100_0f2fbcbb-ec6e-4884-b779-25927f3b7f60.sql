ALTER TABLE public.moments ADD COLUMN IF NOT EXISTS source jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS rate_source jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE POLICY price_files_read ON storage.objects FOR SELECT TO authenticated
 USING (bucket_id='price-files' AND (storage.foldername(name))[1] = public.my_company()::text);
CREATE POLICY price_files_upload ON storage.objects FOR INSERT TO authenticated
 WITH CHECK (bucket_id='price-files' AND (storage.foldername(name))[1] = public.my_company()::text);

-- Saves an approved price list atomically; runs as the caller so RLS still applies.
CREATE OR REPLACE FUNCTION public.estim_import_prices(payload jsonb)
 RETURNS integer LANGUAGE plpgsql SET search_path TO 'public'
AS $$ DECLARE cid uuid=public.my_company(); m jsonb; n_new int=0; n_upd int=0; rate numeric; BEGIN
IF cid IS NULL THEN RAISE EXCEPTION 'Not allowed'; END IF;
PERFORM 1 FROM public.companies WHERE id=cid FOR UPDATE;
IF jsonb_typeof(payload->'moments') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'moments')>500 THEN RAISE EXCEPTION 'Invalid moments'; END IF;
IF payload ? 'hourly_rate' AND payload->'hourly_rate' <> 'null'::jsonb THEN
 rate=(payload->'hourly_rate'->>'value')::numeric;
 IF rate IS NULL OR rate<=0 OR rate>100000 THEN RAISE EXCEPTION 'Invalid rate'; END IF;
 UPDATE public.companies SET hourly_rate_ex_vat=rate, rate_source=coalesce(payload->'hourly_rate'->'source','[]'::jsonb) WHERE id=cid;
END IF;
FOR m IN SELECT * FROM jsonb_array_elements(payload->'moments') LOOP
 IF length(trim(coalesce(m->>'name','')))<1 OR length(trim(coalesce(m->>'unit','')))<1 OR coalesce((m->>'hours_per_unit')::numeric,-1)<0 OR coalesce((m->>'material_per_unit_ex_vat')::numeric,-1)<0 THEN RAISE EXCEPTION 'Invalid moment'; END IF;
 IF m->>'id' IS NOT NULL THEN
  UPDATE public.moments SET name=trim(m->>'name'),unit=m->>'unit',hours_per_unit=(m->>'hours_per_unit')::numeric,material_per_unit_ex_vat=(m->>'material_per_unit_ex_vat')::numeric,role=coalesce(m->>'role',role),rot_eligible=coalesce((m->>'rot_eligible')::boolean,rot_eligible),source=coalesce(m->'source','[]'::jsonb)
   WHERE id=(m->>'id')::uuid AND company_id=cid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown moment'; END IF; n_upd=n_upd+1;
 ELSE
  INSERT INTO public.moments(company_id,name,unit,hours_per_unit,material_per_unit_ex_vat,role,rot_eligible,active,source)
   VALUES(cid,trim(m->>'name'),m->>'unit',(m->>'hours_per_unit')::numeric,(m->>'material_per_unit_ex_vat')::numeric,coalesce(m->>'role','elektriker'),coalesce((m->>'rot_eligible')::boolean,true),true,coalesce(m->'source','[]'::jsonb));
  n_new=n_new+1;
 END IF;
END LOOP;
INSERT INTO public.audit_log(company_id,user_id,event,"after") VALUES(cid,auth.uid(),'Priser importerade',jsonb_build_object('new_moments',n_new,'updated_moments',n_upd,'hourly_rate',rate,'files',coalesce(payload->'files','[]'::jsonb)));
RETURN n_new+n_upd; END $$;
REVOKE ALL ON FUNCTION public.estim_import_prices(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estim_import_prices(jsonb) TO authenticated;