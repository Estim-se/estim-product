// Real PostgreSQL (PGlite) verification of the email identity & threading migration (20261126125238_e35cc9b6-8539-47aa-8540-9f4f0c62c2d1.sql)
// and non-regression of estim_receive for WhatsApp / SMS / Samtal (issues #62 and #71).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { normPhone, newReceive } from './helpers/samtal-inbox-db';

const root = resolve(__dirname, '../..');
const emailMigration = readFileSync(
  resolve(root, 'supabase/migrations/20261126125238_e35cc9b6-8539-47aa-8540-9f4f0c62c2d1.sql'),
  'utf8',
);

const BASE_SCHEMA = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE TABLE public.companies (id uuid PRIMARY KEY, active boolean NOT NULL DEFAULT true);
CREATE TABLE public.company_members (company_id uuid NOT NULL, user_id uuid NOT NULL UNIQUE, role text NOT NULL);
CREATE FUNCTION public.my_company() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT m.company_id FROM public.company_members m JOIN public.companies c ON c.id = m.company_id AND c.active WHERE m.user_id = auth.uid()
$$;
CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id),
  name text NOT NULL, email text, phone text, address text, place text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(company_id, id)
);
CREATE TABLE public.threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id),
  customer_id uuid NOT NULL, job text NOT NULL, place text,
  channel text NOT NULL CHECK(channel IN ('email','sms','wa','form','samtal')),
  status text NOT NULL DEFAULT 'svar' CHECK(status IN ('analys','svar','ai','skickad','oppnad','bokat','vunnen','stangd')),
  read boolean NOT NULL DEFAULT false, autopilot boolean NOT NULL DEFAULT false, whatsapp_auto_override boolean,
  last_message_at timestamptz NOT NULL DEFAULT now(), last_customer_wa_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, id), FOREIGN KEY(company_id, customer_id) REFERENCES public.customers(company_id, id)
);
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid NOT NULL,
  "from" text NOT NULL CHECK("from" IN ('kund','vv','ai','sys')), channel text, text text NOT NULL,
  provider_message_id text, in_reply_to text, email_subject text,
  sent_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivery_status text NOT NULL DEFAULT 'sent',
  FOREIGN KEY(company_id, thread_id) REFERENCES public.threads(company_id, id)
);
CREATE TABLE public.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid NOT NULL UNIQUE,
  text text NOT NULL DEFAULT '', channel text NOT NULL DEFAULT 'email', edited boolean NOT NULL DEFAULT false,
  warnings jsonb NOT NULL DEFAULT '[]', needs_review boolean NOT NULL DEFAULT true
);
CREATE TABLE public.ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid NOT NULL,
  interpret boolean NOT NULL DEFAULT true, state text NOT NULL DEFAULT 'queued',
  incoming_message_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid NOT NULL
);
CREATE TABLE public.samtal_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, thread_id uuid
);
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, user_id uuid,
  event text NOT NULL, "before" jsonb, "after" jsonb
);
CREATE TABLE public.company_document_deliveries (
  company_id uuid NOT NULL, thread_id uuid NOT NULL, message_id uuid NOT NULL
);
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
`;

const A = '0000000a-0000-4000-8000-000000000000';
const B = '0000000b-0000-4000-8000-000000000000';
const USER_A = 'a0000000-0000-4000-8000-000000000001';
const USER_B = 'b0000000-0000-4000-8000-000000000001';

let db: PGlite;

async function asRole<T>(role: 'service_role' | 'authenticated', user: string | null, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T | undefined;
  let err: unknown;
  await db.transaction(async tx => {
    await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user ?? '']);
    await tx.exec(`SET LOCAL ROLE ${role}`);
    try { result = await fn(tx); } catch (e) { err = e; }
    await tx.rollback();
  });
  if (err) throw err;
  return result as T;
}

async function expectSqlError(tx: Transaction, sql: string, params: unknown[], match: RegExp): Promise<void> {
  await tx.exec('SAVEPOINT expect_err');
  let caught: unknown;
  try {
    await tx.query(sql, params);
  } catch (e) {
    caught = e;
  } finally {
    await tx.exec('ROLLBACK TO SAVEPOINT expect_err');
    await tx.exec('RELEASE SAVEPOINT expect_err');
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(match);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(normPhone);
  await db.exec(newReceive);
  await db.exec(emailMigration);
  await db.exec(`
    INSERT INTO public.companies (id, active) VALUES ('${A}', true), ('${B}', true);
    INSERT INTO public.company_members (company_id, user_id, role) VALUES
      ('${A}', '${USER_A}', 'ägare'), ('${B}', '${USER_B}', 'ägare');
  `);
}, 60000);

describe('Email identity & threading SQL migration on real PostgreSQL (PGlite)', () => {
  it('issue #71 check: estim_receive still auto-joins open threads for WhatsApp and Samtal unchanged', async () => {
    await asRole('service_role', null, async tx => {
      for (const ch of ['wa', 'sms', 'samtal'] as const) {
        const first = await tx.query<{ r: { id: string } }>(
          `SELECT public.estim_receive($1, $2::jsonb) AS r`,
          [A, JSON.stringify({ channel: ch, customer_phone: '070-555 11 22', text: `Hej 1 (${ch})`, provider_message_id: `${ch}-1` })],
        );
        const second = await tx.query<{ r: { id: string } }>(
          `SELECT public.estim_receive($1, $2::jsonb) AS r`,
          [A, JSON.stringify({ channel: ch, customer_phone: '070-555 11 22', text: `Hej 2 (${ch})`, provider_message_id: `${ch}-2` })],
        );
        expect(second.rows[0]!.r.id).toBe(first.rows[0]!.r.id);
      }
    });
  });

  it('estim_receive_email: quarantine never modifies existing customers; authenticated role is denied', async () => {
    await expect(asRole('authenticated', USER_A, async tx => {
      await tx.query(`SELECT public.estim_receive_email($1, $2::jsonb)`, [A, JSON.stringify({ mode: 'new_thread', text: 'hej' })]);
    })).rejects.toThrow();

    await asRole('service_role', null, async tx => {
      const existing = await tx.query<{ id: string }>(
        `INSERT INTO public.customers (company_id, name, phone, email) VALUES ($1, 'Anna', '0701234567', NULL) RETURNING id`,
        [A],
      );
      const res = await tx.query<{ r: { id: string; job_id: string; duplicate: boolean } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({
          mode: 'quarantine', text: 'Falskt formulär', provider_message_id: 'q-1',
          rfc_message_id: 'q-rfc@example.com', in_reply_to: null,
          pending_sender: { name: 'Anna', email: 'attacker@example.com', phone: '0701234567', source: 'form' },
        })],
      );
      expect(res.rows[0]!.r.duplicate).toBe(false);

      // Existing WhatsApp customer Anna still has email = NULL (#62)
      const anna = await tx.query<{ email: string | null }>(`SELECT email FROM public.customers WHERE id = $1`, [existing.rows[0]!.id]);
      expect(anna.rows[0]!.email).toBeNull();

      // Quarantined thread has contact-less customer and pending_sender
      const q = await tx.query<{ email: string | null; phone: string | null; pending_sender: Record<string, unknown> }>(
        `SELECT c.email, c.phone, t.pending_sender FROM public.threads t JOIN public.customers c ON c.id = t.customer_id WHERE t.id = $1`,
        [res.rows[0]!.r.id],
      );
      expect(q.rows[0]!.email).toBeNull();
      expect(q.rows[0]!.phone).toBeNull();
      expect(q.rows[0]!.pending_sender).toEqual({ name: 'Anna', email: 'attacker@example.com', phone: '0701234567', source: 'form' });

      // Duplicate provider_message_id returns duplicate: true
      const dup = await tx.query<{ r: { duplicate: boolean } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({ mode: 'quarantine', text: 'Falskt formulär', provider_message_id: 'q-1' })],
      );
      expect(dup.rows[0]!.r.duplicate).toBe(true);
    });
  });

  it('estim_receive_email: join_thread, new_thread, and cross-company isolation', async () => {
    await asRole('service_role', null, async tx => {
      const first = await tx.query<{ r: { id: string } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({ mode: 'new_thread', customer_name: 'Bo', customer_email: 'bo@kund.se', text: 'Jobb 1', provider_message_id: 'm1', rfc_message_id: 'r1@kund.se' })],
      );
      const t1 = first.rows[0]!.r.id;

      // join_thread appends to t1 and sets interpret = false
      const joined = await tx.query<{ r: { id: string; job_id: string } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({ mode: 'join_thread', target_thread_id: t1, text: 'Svar på Jobb 1', provider_message_id: 'm2', rfc_message_id: 'r2@kund.se', in_reply_to: 'r1@kund.se' })],
      );
      expect(joined.rows[0]!.r.id).toBe(t1);
      const job = await tx.query<{ interpret: boolean }>(`SELECT interpret FROM public.ai_jobs WHERE id = $1`, [joined.rows[0]!.r.job_id]);
      expect(job.rows[0]!.interpret).toBe(false);

      // new_thread for same customer creates a distinct thread with suggested_merge_thread_id = t1
      const second = await tx.query<{ r: { id: string } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({ mode: 'new_thread', customer_name: 'Bo', customer_email: 'bo@kund.se', text: 'Jobb 2', provider_message_id: 'm3', suggested_merge_thread_id: t1 })],
      );
      expect(second.rows[0]!.r.id).not.toBe(t1);
      const sug = await tx.query<{ suggested_merge_thread_id: string | null }>(`SELECT suggested_merge_thread_id FROM public.threads WHERE id = $1`, [second.rows[0]!.r.id]);
      expect(sug.rows[0]!.suggested_merge_thread_id).toBe(t1);

      // Company B cannot join or suggest-merge Company A's thread t1
      const cross = await tx.query<{ r: { id: string } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [B, JSON.stringify({ mode: 'join_thread', target_thread_id: t1, customer_email: 'x@b.se', text: 'Cross', provider_message_id: 'mb1', suggested_merge_thread_id: t1 })],
      );
      expect(cross.rows[0]!.r.id).not.toBe(t1);
      const crossSug = await tx.query<{ suggested_merge_thread_id: string | null }>(`SELECT suggested_merge_thread_id FROM public.threads WHERE id = $1`, [cross.rows[0]!.r.id]);
      expect(crossSug.rows[0]!.suggested_merge_thread_id).toBeNull();
    });
  });

  it('estim_approve_email_sender: approves edited sender, links existing customer without overwriting, and blocks cross-company access', async () => {
    // Seed inside a transaction via service_role, then switch role to authenticated USER_A / USER_B
    let tid = '';
    let existingCust = '';
    await db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE service_role`);
      const c = await tx.query<{ id: string }>(
        `INSERT INTO public.customers (company_id, name, phone, email) VALUES ($1, 'Anna Befintlig', '070-111', NULL) RETURNING id`,
        [A],
      );
      existingCust = c.rows[0]!.id;
      const r = await tx.query<{ r: { id: string } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({
          mode: 'quarantine', text: 'Formulär', provider_message_id: 'ap-1',
          pending_sender: { name: 'Anna', email: 'anna@kund.se', phone: '070-999', source: 'form' },
        })],
      );
      tid = r.rows[0]!.r.id;

      // Cross-company user B is rejected
      await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER_B]);
      await tx.exec(`SET LOCAL ROLE authenticated`);
      await expectSqlError(tx, `SELECT public.estim_approve_email_sender($1)`, [tid], /Not allowed/);

      // Company A owner links to existing customer: fills empty email, keeps existing phone '070-111'
      await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER_A]);
      await tx.query(`SELECT public.estim_approve_email_sender($1, NULL, 'anna@kund.se', '070-999', $2)`, [tid, existingCust]);

      await tx.exec(`SET LOCAL ROLE service_role`);
      const updatedCust = await tx.query<{ email: string | null; phone: string | null }>(`SELECT email, phone FROM public.customers WHERE id = $1`, [existingCust]);
      expect(updatedCust.rows[0]).toEqual({ email: 'anna@kund.se', phone: '070-111' });
      const updatedThread = await tx.query<{ customer_id: string; pending_sender: unknown }>(`SELECT customer_id, pending_sender FROM public.threads WHERE id = $1`, [tid]);
      expect(updatedThread.rows[0]).toEqual({ customer_id: existingCust, pending_sender: null });
      const audit = await tx.query<{ event: string }>(`SELECT event FROM public.audit_log WHERE company_id = $1 AND event = 'Avsändare godkänd'`, [A]);
      expect(audit.rows.length).toBe(1);
      await tx.rollback();
    });
  });

  it('estim_merge_email_thread: merges messages, blocks quotes/AI busy, and clears merge suggestions', async () => {
    await db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE service_role`);
      const t1 = (await tx.query<{ r: { id: string } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({ mode: 'new_thread', customer_email: 'c@k.se', text: 'Msg 1', provider_message_id: 'mg-1' })],
      )).rows[0]!.r.id;
      const t2 = (await tx.query<{ r: { id: string } }>(
        `SELECT public.estim_receive_email($1, $2::jsonb) AS r`,
        [A, JSON.stringify({ mode: 'new_thread', customer_email: 'c@k.se', text: 'Msg 2', provider_message_id: 'mg-2', suggested_merge_thread_id: t1 })],
      )).rows[0]!.r.id;

      // While AI jobs are queued, merge refuses with 'AI busy'
      await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER_A]);
      await tx.exec(`SET LOCAL ROLE authenticated`);
      await expectSqlError(tx, `SELECT public.estim_merge_email_thread($1, $2)`, [t2, t1], /AI busy/);

      // Mark AI jobs done; add a quote to t2 -> refuses with 'Has quotes'
      await tx.exec(`SET LOCAL ROLE service_role`);
      await tx.query(`UPDATE public.ai_jobs SET state = 'done' WHERE thread_id IN ($1, $2)`, [t1, t2]);
      await tx.query(`INSERT INTO public.quotes (company_id, thread_id) VALUES ($1, $2)`, [A, t2]);
      await tx.exec(`SET LOCAL ROLE authenticated`);
      await expectSqlError(tx, `SELECT public.estim_merge_email_thread($1, $2)`, [t2, t1], /Has quotes/);

      // Remove quote -> merge succeeds, moves messages to t1, deletes t2, logs audit
      await tx.exec(`SET LOCAL ROLE service_role`);
      await tx.query(`DELETE FROM public.quotes WHERE thread_id = $1`, [t2]);
      await tx.exec(`SET LOCAL ROLE authenticated`);
      await tx.query(`SELECT public.estim_merge_email_thread($1, $2)`, [t2, t1]);

      await tx.exec(`SET LOCAL ROLE service_role`);
      const msgs = await tx.query<{ text: string }>(`SELECT text FROM public.messages WHERE thread_id = $1 ORDER BY provider_message_id`, [t1]);
      expect(msgs.rows.map(r => r.text)).toEqual(['Msg 1', 'Msg 2']);
      const gone = await tx.query(`SELECT id FROM public.threads WHERE id = $1`, [t2]);
      expect(gone.rows.length).toBe(0);
      const audit = await tx.query<{ event: string }>(`SELECT event FROM public.audit_log WHERE company_id = $1 AND event = 'Tråd sammanslagen'`, [A]);
      expect(audit.rows.length).toBe(1);
      await tx.rollback();
    });
  });
});
