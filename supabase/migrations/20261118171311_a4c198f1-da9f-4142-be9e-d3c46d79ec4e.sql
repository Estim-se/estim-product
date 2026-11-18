REVOKE UPDATE ON public.companies FROM authenticated;
GRANT UPDATE(name,signature,reply_to_email,hourly_rate_ex_vat,travel_fee,settings) ON public.companies TO authenticated;
CREATE INDEX threads_customer_idx ON public.threads(company_id,customer_id);