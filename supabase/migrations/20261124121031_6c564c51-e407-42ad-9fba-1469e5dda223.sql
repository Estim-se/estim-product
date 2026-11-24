-- Anbudsbevakning: per-company watch profile and the tenders found on TED.
-- New, separate feature. Does not change any existing table, policy or function.

CREATE TABLE public.tender_watch_profiles (
  company_id uuid PRIMARY KEY DEFAULT public.my_company() REFERENCES public.companies(id) ON DELETE CASCADE,
  regions text[] NOT NULL DEFAULT ARRAY['SE110','SE121','SE122']::text[],
  last_fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tender_watch_regions_valid CHECK (
    cardinality(regions) BETWEEN 1 AND 21
    AND regions <@ ARRAY['SE110','SE121','SE122','SE123','SE124','SE125','SE211','SE212','SE213','SE214','SE221','SE224','SE231','SE232','SE311','SE312','SE313','SE321','SE322','SE331','SE332']::text[]
  )
);
GRANT SELECT, INSERT, UPDATE ON public.tender_watch_profiles TO authenticated;
GRANT ALL ON public.tender_watch_profiles TO service_role;

CREATE TABLE public.tender_watch_hits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL DEFAULT public.my_company() REFERENCES public.companies(id) ON DELETE CASCADE,
  publication_number text NOT NULL CHECK (publication_number ~ '^[0-9]{1,8}-[0-9]{4}$'),
  kind text NOT NULL CHECK (kind IN ('el','bygg_el','bygg_kontrollera')),
  title text NOT NULL CHECK (char_length(title) <= 500),
  buyer text NOT NULL CHECK (char_length(buyer) <= 300),
  city text,
  places text[] NOT NULL DEFAULT '{}',
  cpv text[] NOT NULL DEFAULT '{}',
  deadline date,
  value numeric,
  currency text,
  framework boolean NOT NULL DEFAULT false,
  published date NOT NULL,
  documents_url text CHECK (documents_url IS NULL OR documents_url LIKE 'https://%'),
  notice_url text NOT NULL CHECK (notice_url LIKE 'https://ted.europa.eu/%'),
  status text NOT NULL DEFAULT 'ny' CHECK (status IN ('ny','sedd','avvisad','analys')),
  tender_id uuid REFERENCES public.tenders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, publication_number)
);
GRANT SELECT, INSERT, UPDATE ON public.tender_watch_hits TO authenticated;
GRANT ALL ON public.tender_watch_hits TO service_role;

CREATE INDEX tender_watch_hits_company_published
  ON public.tender_watch_hits (company_id, published DESC);

ALTER TABLE public.tender_watch_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_watch_hits ENABLE ROW LEVEL SECURITY;

CREATE POLICY tender_watch_profiles_own ON public.tender_watch_profiles
  FOR ALL TO authenticated
  USING (company_id = public.my_company())
  WITH CHECK (company_id = public.my_company());

CREATE POLICY tender_watch_hits_own ON public.tender_watch_hits
  FOR ALL TO authenticated
  USING (company_id = public.my_company())
  WITH CHECK (
    company_id = public.my_company()
    AND (
      tender_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.tenders t
        WHERE t.id = tender_id AND t.company_id = public.my_company()
      )
    )
  );