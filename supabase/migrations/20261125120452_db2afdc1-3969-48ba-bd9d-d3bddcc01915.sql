-- estim Samtal: indexes for the foreign keys that samtal.sql left without one (reported by the Supabase linter).
-- Runs after samtal.sql. Only new indexes on the new samtal_ tables.
--
-- Why they are needed: when a parent row is deleted or its key changes, Postgres must find the referencing rows.
-- Without an index on the referencing columns it scans the whole samtal table, and that grows with every call.
-- This happens in existing flows: estim_merge_customers deletes the merged customer (scans samtal_calls),
-- removing an employee deletes their company_members row (scans samtal_numbers and samtal_tasks), and deleting a
-- request or a number scans samtal_calls. Looking up the call behind a request (thread_id) also uses its index.
-- One index on samtal_jobs (company_id, call_id) covers both of its foreign keys (company_id alone, and company_id + call_id).
CREATE INDEX samtal_numbers_member_idx ON public.samtal_numbers (company_id, user_id);
CREATE INDEX samtal_calls_number_idx ON public.samtal_calls (company_id, number_id);
CREATE INDEX samtal_calls_thread_idx ON public.samtal_calls (company_id, thread_id);
CREATE INDEX samtal_calls_customer_idx ON public.samtal_calls (company_id, customer_id);
CREATE INDEX samtal_jobs_call_idx ON public.samtal_jobs (company_id, call_id);
CREATE INDEX samtal_tasks_member_idx ON public.samtal_tasks (company_id, user_id);