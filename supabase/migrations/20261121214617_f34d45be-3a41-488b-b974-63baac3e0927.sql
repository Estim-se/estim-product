CREATE TABLE public.tender_calculation_settings (company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE, hourly_rate numeric NOT NULL DEFAULT 0, material_markup numeric NOT NULL DEFAULT 0, list_discount numeric NOT NULL DEFAULT 0, establishment numeric NOT NULL DEFAULT 0, contingency numeric NOT NULL DEFAULT 0, post_types jsonb NOT NULL DEFAULT '[]', example_values boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tender_calculation_settings TO authenticated; GRANT ALL ON public.tender_calculation_settings TO service_role;
ALTER TABLE public.tender_calculation_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_calculation_settings ON public.tender_calculation_settings FOR ALL TO authenticated USING(company_id=public.my_company()) WITH CHECK(company_id=public.my_company());
ALTER TABLE public.tender_quantities ADD CONSTRAINT tender_quantities_run_unique UNIQUE(tender_id,analysis_run);
CREATE TABLE public.tender_calculation_matches (tender_id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE, analysis_run uuid NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(tender_id,analysis_run) REFERENCES public.tender_quantities(tender_id,analysis_run) ON DELETE CASCADE);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.tender_calculation_matches TO authenticated; GRANT ALL ON public.tender_calculation_matches TO service_role;
ALTER TABLE public.tender_calculation_matches ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_calculation_matches ON public.tender_calculation_matches FOR ALL TO authenticated USING(company_id=public.my_company()) WITH CHECK(company_id=public.my_company());
CREATE FUNCTION public.estim_validate_tender_calculation() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ DECLARE p jsonb; BEGIN
IF TG_OP='UPDATE' AND NEW.company_id<>OLD.company_id THEN RAISE EXCEPTION 'Immutable company'; END IF;
IF TG_TABLE_NAME='tender_calculation_settings' THEN
IF NEW.hourly_rate<0 OR NEW.hourly_rate>100000 OR NEW.material_markup<0 OR NEW.material_markup>1000 OR NEW.list_discount<0 OR NEW.list_discount>100 OR NEW.establishment<0 OR NEW.contingency<0 OR NEW.establishment+NEW.contingency>=100 OR jsonb_typeof(NEW.post_types)<>'array' OR jsonb_array_length(NEW.post_types)>200 OR pg_column_size(NEW.post_types)>131072 THEN RAISE EXCEPTION 'Invalid settings'; END IF;
FOR p IN SELECT * FROM jsonb_array_elements(NEW.post_types) LOOP
IF length(trim(coalesce(p->>'name','')))<1 OR length(p->>'name')>240 OR (p->>'id')::uuid IS NULL OR coalesce((p->>'hours')::numeric,-1)<0 OR (p->>'hours')::numeric>10000 OR coalesce((p->>'list_price')::numeric,-1)<0 OR (p->>'list_price')::numeric>100000000 THEN RAISE EXCEPTION 'Invalid post type'; END IF;
END LOOP;
IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(NEW.post_types) x)<>jsonb_array_length(NEW.post_types) THEN RAISE EXCEPTION 'Duplicate post type'; END IF;
ELSE
IF TG_OP='UPDATE' AND NEW.tender_id<>OLD.tender_id THEN RAISE EXCEPTION 'Immutable tender'; END IF;
IF NOT EXISTS(SELECT 1 FROM public.tender_quantities q WHERE q.tender_id=NEW.tender_id AND q.company_id=NEW.company_id AND q.analysis_run=NEW.analysis_run AND q.status='analysed') OR jsonb_typeof(NEW.result)<>'object' OR pg_column_size(NEW.result)>131072 THEN RAISE EXCEPTION 'Invalid matches'; END IF;
END IF;
NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER validate_tender_calculation_settings BEFORE INSERT OR UPDATE ON public.tender_calculation_settings FOR EACH ROW EXECUTE FUNCTION public.estim_validate_tender_calculation();
CREATE TRIGGER validate_tender_calculation_matches BEFORE INSERT OR UPDATE ON public.tender_calculation_matches FOR EACH ROW EXECUTE FUNCTION public.estim_validate_tender_calculation();
INSERT INTO public.tender_calculation_settings(company_id,hourly_rate,material_markup,list_discount,establishment,contingency,example_values,post_types) VALUES('f9df621c-a4f6-4fd1-acff-a89a67d4aa9e',650,15,30,5,5,true,'[
{"id":"00000000-0000-4000-8000-000000000001","name":"Dubbelt vägguttag","hours":0.8,"list_price":150},
{"id":"00000000-0000-4000-8000-000000000002","name":"Takuttag","hours":0.6,"list_price":60},
{"id":"00000000-0000-4000-8000-000000000003","name":"Spotlight IP44","hours":0.5,"list_price":350},
{"id":"00000000-0000-4000-8000-000000000004","name":"Dubbelt uttag IP44","hours":0.9,"list_price":250},
{"id":"00000000-0000-4000-8000-000000000005","name":"Lägenhetscentral","hours":4,"list_price":2500},
{"id":"00000000-0000-4000-8000-000000000006","name":"Anslutning spis","hours":1,"list_price":100},
{"id":"00000000-0000-4000-8000-000000000007","name":"Uttag diskmaskin","hours":0.8,"list_price":120},
{"id":"00000000-0000-4000-8000-000000000008","name":"Uttag kyl/frys","hours":0.8,"list_price":120},
{"id":"00000000-0000-4000-8000-000000000009","name":"Anslutning golvvärme","hours":1,"list_price":80},
{"id":"00000000-0000-4000-8000-000000000010","name":"Datauttag","hours":0.7,"list_price":200},
{"id":"00000000-0000-4000-8000-000000000011","name":"LED-armatur trapphus","hours":1,"list_price":900},
{"id":"00000000-0000-4000-8000-000000000012","name":"LED-armatur källare","hours":0.8,"list_price":600},
{"id":"00000000-0000-4000-8000-000000000013","name":"Fastighetscentral","hours":24,"list_price":25000},
{"id":"00000000-0000-4000-8000-000000000014","name":"Rivning per lägenhet","hours":6,"list_price":0}]');