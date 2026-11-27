-- estim Samtal staged migration 9/13 from docs/samtal/a9-lookup-indexes.sql (approved for Bygg Demo AB test, 2026-11-27).
-- DOCUMENTATION-ONLY. Shared-table index dependency requiring separate approval; no live application.
-- Install after a9-matching.sql defines immutable normalization helpers. Existing shared rows/columns are unchanged.
CREATE INDEX samtal_a9_customer_phone_idx ON public.customers(company_id,public.samtal_a9_phone(phone));
CREATE INDEX samtal_a9_customer_name_idx ON public.customers(company_id,public.samtal_a9_text(name));
CREATE INDEX samtal_a9_customer_address_idx ON public.customers(company_id,public.samtal_a9_text(address));
CREATE INDEX samtal_a9_customer_threads_idx ON public.threads(company_id,customer_id,last_message_at DESC,id);
CREATE INDEX samtal_a9_thread_quotes_idx ON public.quotes(company_id,thread_id,version DESC);
CREATE INDEX samtal_a9_thread_messages_idx ON public.messages(company_id,thread_id,sent_at DESC,id DESC);
