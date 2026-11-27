-- Inbox realtime (flag VITE_INBOX_REALTIME, off by default; PR "Realtime: Push workspace changes without polling delay").
-- NOT APPLIED. Reviewed here first; then ask Lovable to create a migration with exactly this SQL.
-- Adds the company-scoped inbox tables to Supabase's realtime publication. Realtime checks each subscriber's RLS
-- (my_company()) before delivering a change, and the app only uses an event as a signal to re-read the workspace.
-- No table, column, policy or function changes. ai_jobs is left out: only service_role can read it.
-- Until this is applied the flag has no effect beyond normal polling: the app slows polling only after the channel
-- reports SUBSCRIBED.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['threads','messages','drafts','customers','quotes','moments','audit_log','companies'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
