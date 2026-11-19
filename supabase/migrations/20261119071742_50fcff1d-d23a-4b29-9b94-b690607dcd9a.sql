-- Log of every AI call, for debugging and for the test suite.
-- Only edge functions (service role) write here. No client access.
create table if not exists public.ai_calls (
  id uuid primary key default gen_random_uuid(),
  company_id uuid,
  request_id text,
  step text not null check (step in ('extract-prices','interpret-request','write-reply','triage-email')),
  model text,
  prompt_version text not null,
  input jsonb,
  output jsonb,
  error text,
  duration_ms integer,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now()
);
grant all on public.ai_calls to service_role;
revoke all on public.ai_calls from anon, authenticated;
create index if not exists ai_calls_company_idx on public.ai_calls (company_id, created_at desc);
create index if not exists ai_calls_request_idx on public.ai_calls (request_id);
alter table public.ai_calls enable row level security;

-- Latest AI interpretation per thread, read by write-reply under the user's RLS.
alter table public.threads add column if not exists interpretation jsonb;