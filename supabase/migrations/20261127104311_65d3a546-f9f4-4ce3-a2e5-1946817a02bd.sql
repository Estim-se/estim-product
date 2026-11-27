ALTER FUNCTION public.samtal_a9_text(text) SET search_path = pg_catalog;
ALTER FUNCTION public.samtal_a9_phone(text) SET search_path = pg_catalog;
CREATE INDEX samtal_a9_customer_phone_idx ON public.customers(company_id,public.samtal_a9_phone(phone));
CREATE INDEX samtal_a9_customer_name_idx ON public.customers(company_id,public.samtal_a9_text(name));
CREATE INDEX samtal_a9_customer_address_idx ON public.customers(company_id,public.samtal_a9_text(address));
CREATE INDEX samtal_a9_customer_threads_idx ON public.threads(company_id,customer_id,last_message_at DESC,id);
CREATE INDEX samtal_a9_thread_quotes_idx ON public.quotes(company_id,thread_id,version DESC);
CREATE INDEX samtal_a9_thread_messages_idx ON public.messages(company_id,thread_id,sent_at DESC,id DESC);