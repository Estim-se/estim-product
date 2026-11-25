// estim Samtal: a real Postgres (PGlite) with the inbox tables and the inbox functions copied from the migrations,
// before (oldReceive, oldSplit) and after (docs/samtal/inkorg.sql) the channel 'samtal'. Shared by the inbox tests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');
const receiveMigration = read('supabase/migrations/20261123144202_95f9c10a-4081-463f-926e-0c9f0a700d36.sql');
const splitMigration = read('supabase/migrations/20261123143501_416880fc-8e2a-4ed0-b1b6-152e26cd8008.sql');
export const inkorg = read('docs/samtal/inkorg.sql');
const between = (text: string, start: string, end: string) => { const i = text.indexOf(start); const j = text.indexOf(end, i); return text.slice(i, j + end.length); };
export const oldReceive = between(receiveMigration, 'CREATE OR REPLACE FUNCTION public.estim_receive', 'END $function$;');
export const oldSplit = between(splitMigration, 'CREATE FUNCTION public.estim_split_thread', 'END;\n$function$;');
export const newReceive = between(inkorg, 'CREATE OR REPLACE FUNCTION public.estim_receive', 'END $function$;');
export const newSplit = between(inkorg, 'CREATE OR REPLACE FUNCTION public.estim_split_thread', 'END;\n$function$;');
export const normPhone = between(splitMigration, 'CREATE FUNCTION public.estim_norm_phone', '$function$;');

// The tables the two functions touch, with the columns and checks of the migrations.
export const SCHEMA = `
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE public.companies (id uuid PRIMARY KEY, active boolean NOT NULL DEFAULT true);
CREATE TABLE public.company_members (company_id uuid NOT NULL, user_id uuid NOT NULL UNIQUE, role text NOT NULL);
CREATE FUNCTION public.my_company() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT company_id FROM public.company_members WHERE user_id = auth.uid() $$;
CREATE TABLE public.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), name text NOT NULL, email text, phone text, address text, place text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(company_id,id));
CREATE TABLE public.threads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id), customer_id uuid NOT NULL, job text NOT NULL, place text,
  channel text NOT NULL CHECK(channel IN ('email','sms','wa','form')), status text NOT NULL DEFAULT 'svar' CHECK(status IN ('analys','svar','ai','skickad','oppnad','bokat','vunnen')),
  read boolean NOT NULL DEFAULT false, autopilot boolean NOT NULL DEFAULT false, whatsapp_auto_override boolean, last_message_at timestamptz NOT NULL DEFAULT now(), last_customer_wa_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,id), FOREIGN KEY(company_id,customer_id) REFERENCES public.customers(company_id,id));
CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid NOT NULL, "from" text NOT NULL CHECK("from" IN ('kund','vv','ai','sys')), channel text, text text NOT NULL,
  provider_message_id text, sent_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), delivery_status text NOT NULL DEFAULT 'sent', FOREIGN KEY(company_id,thread_id) REFERENCES public.threads(company_id,id));
CREATE TABLE public.drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid NOT NULL UNIQUE, text text NOT NULL DEFAULT '', channel text NOT NULL DEFAULT 'email', edited boolean NOT NULL DEFAULT false, warnings jsonb NOT NULL DEFAULT '[]', needs_review boolean NOT NULL DEFAULT true);
CREATE TABLE public.ai_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid NOT NULL, interpret boolean NOT NULL DEFAULT true, state text NOT NULL DEFAULT 'queued', incoming_message_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.audit_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, user_id uuid NOT NULL, event text NOT NULL, "after" jsonb);
CREATE TABLE public.company_document_deliveries (company_id uuid NOT NULL, thread_id uuid NOT NULL, message_id uuid NOT NULL);
`;
export const CID = '0000000a-0000-4000-8000-000000000000', USER = 'a0000000-0000-4000-8000-000000000001';

export async function database(withSamtal: boolean) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(normPhone);
  await db.exec(oldReceive);
  await db.exec(oldSplit);
  if (withSamtal) await db.exec(inkorg);
  await db.exec(`INSERT INTO public.companies (id) VALUES ('${CID}'); INSERT INTO public.company_members VALUES ('${CID}', '${USER}', 'ägare');
    INSERT INTO public.customers (company_id, name, phone, email) VALUES ('${CID}', 'Befintlig Kund', '070-123 45 67', 'befintlig@example.se');`);
  return db;
}
