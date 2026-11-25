// estim Samtal: the inbox accepts the channel 'samtal' (docs/samtal/inkorg.sql). Proves that the change is exactly the
// intended lines, and that WhatsApp, e-mail, SMS and form requests (receive and split) give exactly the same rows
// before and after it, in a real Postgres (PGlite) with the current functions copied from the migrations.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n');
const receiveMigration = read('supabase/migrations/20261123144202_95f9c10a-4081-463f-926e-0c9f0a700d36.sql');
const splitMigration = read('supabase/migrations/20261123143501_416880fc-8e2a-4ed0-b1b6-152e26cd8008.sql');
const inkorg = read('docs/samtal/inkorg.sql');
const between = (text: string, start: string, end: string) => { const i = text.indexOf(start); const j = text.indexOf(end, i); return text.slice(i, j + end.length); };
const oldReceive = between(receiveMigration, 'CREATE OR REPLACE FUNCTION public.estim_receive', 'END $function$;');
const oldSplit = between(splitMigration, 'CREATE FUNCTION public.estim_split_thread', 'END;\n$function$;');
const newReceive = between(inkorg, 'CREATE OR REPLACE FUNCTION public.estim_receive', 'END $function$;');
const newSplit = between(inkorg, 'CREATE OR REPLACE FUNCTION public.estim_split_thread', 'END;\n$function$;');
const normPhone = between(splitMigration, 'CREATE FUNCTION public.estim_norm_phone', '$function$;');

// The tables the two functions touch, with the columns and checks of the migrations.
const SCHEMA = `
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
const CID = '0000000a-0000-4000-8000-000000000000', USER = 'a0000000-0000-4000-8000-000000000001';

async function database(withSamtal: boolean) {
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
const receive = async (db: PGlite, payload: object, actor: string | null = null) =>
  (await db.query<{ r: Record<string, unknown> }>(`SELECT public.estim_receive($1, $2, $3) AS r`, [CID, payload, actor])).rows[0]!.r;

// The same requests for every existing channel: new and existing customers, a duplicate, a follow-up, a user-made request.
async function scenario(db: PGlite) {
  const results: unknown[] = [];
  const at = (m: number) => new Date(Date.UTC(2026, 10, 25, 8, m)).toISOString();
  results.push(await receive(db, { channel: 'wa', customer_phone: '+46701234567', text: 'Hej, jag vill byta elcentral', provider_message_id: 'wa-1', sent_at: at(1) }));
  results.push(await receive(db, { channel: 'wa', customer_phone: '+46701234567', text: 'Hej, jag vill byta elcentral', provider_message_id: 'wa-1', sent_at: at(1) }));
  results.push(await receive(db, { channel: 'wa', customer_phone: '+46701234567', text: 'Det är i Solna', provider_message_id: 'wa-2', sent_at: at(2) }));
  results.push(await receive(db, { channel: 'wa', customer_phone: '+46709999999', customer_name: 'Ny Kund', text: 'Laddbox?', provider_message_id: 'wa-3', sent_at: at(3) }));
  results.push(await receive(db, { channel: 'email', customer_email: 'befintlig@example.se', text: 'Offert på uttag', provider_message_id: 'mail-1', sent_at: at(4) }));
  results.push(await receive(db, { channel: 'email', customer_email: 'ny@example.se', customer_name: 'Mejl Kund', text: 'Felsökning', provider_message_id: 'mail-2', sent_at: at(5) }));
  results.push(await receive(db, { channel: 'sms', customer_phone: '0701234567', text: 'Ring mig', provider_message_id: 'sms-1', sent_at: at(6) }));
  results.push(await receive(db, { channel: 'form', customer_name: 'Form Kund', customer_email: 'form@example.se', text: 'Badrum', address: 'Gatan 1', place: 'Solna', job: 'Badrum', sent_at: at(7) }, USER));
  await expect(receive(db, { channel: 'fax', customer_phone: '+46701234567', text: 'x' })).rejects.toThrow(/Invalid message/);
  // Split the WhatsApp thread at its second customer message (as a signed-in user).
  const wa = (await db.query<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM public.messages WHERE provider_message_id = 'wa-2'`)).rows[0]!;
  await db.exec(`UPDATE public.threads SET updated_at = now() - interval '1 hour'; UPDATE public.ai_jobs SET state = 'done'`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [USER]);
  results.push(Object.keys(await db.query<{ r: object }>(`SELECT public.estim_split_thread($1, $2) AS r`, [wa.thread_id, wa.id]).then(r => r.rows[0]!.r)).sort());
  return results.map(r => r && typeof r === 'object' && !Array.isArray(r) ? { ...r, id: 'id' in r ? 'uuid' : undefined, job_id: 'job_id' in r ? 'uuid' : undefined } : r);
}
// Every row the functions wrote, described without generated ids or clock times.
async function snapshot(db: PGlite) {
  const rows = async <T = unknown>(q: string) => (await db.query<T>(q)).rows;
  return {
    customers: await rows(`SELECT name, phone, email, address, place FROM public.customers ORDER BY name`),
    threads: await rows<Record<string, unknown>>(`SELECT c.name, t.job, t.place, t.channel, t.status, t.read, t.autopilot, t.last_customer_wa_at IS NOT NULL AS wa_window FROM public.threads t JOIN public.customers c ON c.id = t.customer_id ORDER BY c.name, t.channel, t.job`),
    messages: await rows(`SELECT c.name, t.job, m."from", m.channel, m.text, m.provider_message_id FROM public.messages m JOIN public.threads t ON t.id = m.thread_id JOIN public.customers c ON c.id = t.customer_id ORDER BY m.text`),
    drafts: await rows(`SELECT c.name, t.job, d.channel, d.text, d.needs_review, d.edited FROM public.drafts d JOIN public.threads t ON t.id = d.thread_id JOIN public.customers c ON c.id = t.customer_id ORDER BY c.name, t.job`),
    jobs: await rows(`SELECT c.name, t.job, j.interpret, j.state FROM public.ai_jobs j JOIN public.threads t ON t.id = j.thread_id JOIN public.customers c ON c.id = t.customer_id ORDER BY c.name, t.job, j.interpret`),
    audit: await rows<Record<string, unknown>>(`SELECT event FROM public.audit_log ORDER BY event`),
  };
}

describe('estim Samtal in the inbox: the change is exactly the intended lines', () => {
  const changed = (a: string, b: string) => { const x = a.split('\n'), y = b.split('\n'); expect(y).toHaveLength(x.length); return x.flatMap((l, i) => l === y[i] ? [] : [[l.trim(), y[i]!.trim()]]); };
  it('estim_receive: only the channel list and the draft channel of a call', () => {
    expect(changed(oldReceive, newReceive)).toEqual([
      [expect.stringContaining(`IF ch NOT IN ('wa','email','sms','form') OR`), expect.stringContaining(`IF ch NOT IN ('wa','email','sms','form','samtal') OR`)],
      [expect.stringContaining(`CASE WHEN ch='form' THEN 'email' ELSE ch END`), expect.stringContaining(`CASE WHEN ch='form' THEN 'email' WHEN ch='samtal' THEN 'sms' ELSE ch END`)],
    ]);
  });
  it('estim_split_thread: only CREATE OR REPLACE and the draft channel of a call', () => {
    expect(changed(oldSplit, newSplit)).toEqual([
      ['CREATE FUNCTION public.estim_split_thread(tid uuid, mid uuid)', 'CREATE OR REPLACE FUNCTION public.estim_split_thread(tid uuid, mid uuid)'],
      [`VALUES (cid, new_tid, CASE WHEN t.channel = 'form' THEN 'email' ELSE t.channel END, '', true);`, `VALUES (cid, new_tid, CASE WHEN t.channel = 'form' THEN 'email' WHEN t.channel = 'samtal' THEN 'sms' ELSE t.channel END, '', true);`],
    ]);
  });
});

describe('estim Samtal in the inbox: WhatsApp, e-mail, SMS and form work exactly as before', () => {
  it('the same requests give the same results and the same rows before and after the change', async () => {
    const before = await database(false), after = await database(true);
    expect(await scenario(after)).toEqual(await scenario(before));
    const [a, b] = [await snapshot(before), await snapshot(after)];
    expect(b).toEqual(a);
    // The scenario covered every channel, a duplicate, a follow-up and a split.
    expect(a.threads.map(t => t['channel'])).toEqual(expect.arrayContaining(['wa', 'email', 'sms', 'form']));
    expect(a.audit.map(e => e['event'])).toContain('Utbrutet från tidigare ärende');
  }, 30000);
});

describe('estim Samtal in the inbox: a call becomes a request with an SMS draft', () => {
  it('channel samtal is accepted; the thread and message keep it, the reply draft is an SMS awaiting review, and the AI job is queued', async () => {
    const db = await database(true);
    const r = await receive(db, { channel: 'samtal', customer_phone: '+46701234567', text: 'Samtal: kunden vill byta elcentral i Solna', provider_message_id: 'call-1' });
    expect(r).toMatchObject({ duplicate: false });
    expect((await db.query(`SELECT channel, status FROM public.threads WHERE id = $1`, [r['id']])).rows).toEqual([{ channel: 'samtal', status: 'analys' }]);
    expect((await db.query(`SELECT channel, "from" FROM public.messages WHERE thread_id = $1`, [r['id']])).rows).toEqual([{ channel: 'samtal', from: 'kund' }]);
    expect((await db.query(`SELECT channel, needs_review FROM public.drafts WHERE thread_id = $1`, [r['id']])).rows).toEqual([{ channel: 'sms', needs_review: true }]);
    expect((await db.query(`SELECT state FROM public.ai_jobs WHERE thread_id = $1`, [r['id']])).rows).toEqual([{ state: 'queued' }]);
    // The existing customer is found by phone, as for other channels; the same call is stored once.
    expect((await db.query(`SELECT c.name FROM public.threads t JOIN public.customers c ON c.id = t.customer_id WHERE t.id = $1`, [r['id']])).rows).toEqual([{ name: 'Befintlig Kund' }]);
    expect(await receive(db, { channel: 'samtal', customer_phone: '+46701234567', text: 'igen', provider_message_id: 'call-1' })).toEqual({ duplicate: true });
  });
  it('a split call thread also gets an SMS draft', async () => {
    const db = await database(true);
    await receive(db, { channel: 'samtal', customer_phone: '+46701234567', text: 'Första samtalet', provider_message_id: 'call-1', sent_at: '2026-11-25T08:00:00Z' });
    await receive(db, { channel: 'samtal', customer_phone: '+46701234567', text: 'Andra samtalet', provider_message_id: 'call-2', sent_at: '2026-11-25T09:00:00Z' });
    const m = (await db.query<{ id: string; thread_id: string }>(`SELECT id, thread_id FROM public.messages WHERE provider_message_id = 'call-2'`)).rows[0]!;
    await db.exec(`UPDATE public.threads SET updated_at = now() - interval '1 hour'; UPDATE public.ai_jobs SET state = 'done'`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [USER]);
    const split = (await db.query<{ r: { id: string } }>(`SELECT public.estim_split_thread($1, $2) AS r`, [m.thread_id, m.id])).rows[0]!.r;
    expect((await db.query(`SELECT channel FROM public.drafts WHERE thread_id = $1`, [split.id])).rows).toEqual([{ channel: 'sms' }]);
  });
});
