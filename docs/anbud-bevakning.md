# Anbudsbevakning (tender watch)

estim finds Swedish public tenders on TED (EU) that suit an electrical contractor and lists them under Anbud → **Hittade anbud**.

## How it is switched on

- **Flag:** server environment variable `ANBUD_BEVAKNING=1`. Without it the tab is hidden and the server functions refuse.
- **Isolation:**
  - It does not change the tender engine, WhatsApp, email or the inbox.
  - "Starta analys" opens the existing *Nytt anbud* dialog with the name filled in and a link to the procurement documents.
  - When the tender is uploaded, the hit is linked to it.
- **Tables:** only two new ones, `tender_watch_profiles` and `tender_watch_hits`, created by Lovable from the SQL below. Until they exist the tab says that the migration has to run first.

## How it works

**Source:** TED Search API v3, which is anonymous and needs no key. Notices may be reused freely when the source is stated.

**Query:** Swedish buyers, CPV 45000000 (all construction, including electrical installation) and 50711000 (maintenance of electrical installations). The first run covers eight weeks; after that it fetches from the day before the last fetch. It runs when the list is opened and the last fetch is more than 20 hours old, or when someone presses *Hämta nu*.

**Classification**, in `src/lib/tender-watch.ts`, uses the main CPV (the first code):

| Group | Rule |
|---|---|
| Elanbud | Main CPV 4531… or 50711…, or another main CPV with electrical installation stated |
| Bygg, el angiven | Building or renovation main CPV, with an electrical CPV among the codes |
| Bygg – ingår el, kontrollera | Building or renovation main CPV, without any electrical CPV |
| Not shown | Civil works (roads, ground, water: 4510/4511/4522–4525…) and everything else |

**Other rules:**
- Only calls for tenders are shown; award notices and prior information without a call are left out.
- **Duplicates:** a notice republished with the same document link, or with the same buyer and title, is one tender. The latest publication is kept.
- **Regions:** NUTS län codes, editable per company. The default is Stockholms län (SE110), Uppsala (SE121) and Södermanland (SE122).
- **Value:** shown but never used as a filter. For framework agreements it is marked as the ceiling value, and those tenders are marked *Ramavtal*.

**Limitation:** TED covers procurements above the EU threshold (about 60 % of Swedish advertised procurements). Smaller national procurements come later through an agreement with Mercell/Antirio.

## SQL for Lovable

```sql
-- Anbudsbevakning: per-company watch profile and the tenders found on TED.
CREATE TABLE public.tender_watch_profiles (
  company_id uuid PRIMARY KEY DEFAULT public.my_company() REFERENCES public.companies(id) ON DELETE CASCADE,
  regions text[] NOT NULL DEFAULT ARRAY['SE110','SE121','SE122']::text[],
  last_fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tender_watch_regions_valid CHECK (cardinality(regions) BETWEEN 1 AND 21 AND regions <@ ARRAY['SE110','SE121','SE122','SE123','SE124','SE125','SE211','SE212','SE213','SE214','SE221','SE224','SE231','SE232','SE311','SE312','SE313','SE321','SE322','SE331','SE332']::text[])
);
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
CREATE INDEX tender_watch_hits_company_published ON public.tender_watch_hits (company_id, published DESC);

GRANT SELECT, INSERT, UPDATE ON public.tender_watch_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tender_watch_hits TO authenticated;
GRANT ALL ON public.tender_watch_profiles, public.tender_watch_hits TO service_role;
ALTER TABLE public.tender_watch_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tender_watch_hits ENABLE ROW LEVEL SECURITY;
CREATE POLICY tender_watch_profiles_own ON public.tender_watch_profiles FOR ALL TO authenticated
  USING (company_id = public.my_company()) WITH CHECK (company_id = public.my_company());
CREATE POLICY tender_watch_hits_own ON public.tender_watch_hits FOR ALL TO authenticated
  USING (company_id = public.my_company()) WITH CHECK (company_id = public.my_company()
    AND (tender_id IS NULL OR EXISTS (SELECT 1 FROM public.tenders t WHERE t.id = tender_id AND t.company_id = public.my_company())));
```

## Prompt for Lovable

> Create a migration with exactly this SQL for the new, separate feature Anbudsbevakning (two new tables, `tender_watch_profiles` and `tender_watch_hits`, with company-scoped RLS through `public.my_company()`, as `company_documents` has).
>
> Do not change any existing table, policy, function or code, and do not change any application files. Only run the migration and regenerate the Supabase types.
>
> Do not set the environment variable `ANBUD_BEVAKNING`; the feature stays off until we switch it on.
>
> [paste the SQL block above]
