// Run with:  deno test --allow-env supabase/functions/_shared/inbound_pipeline_test.ts
// ingestMail against the in-memory fake database (test-db.ts) with a stubbed fetch. The golden lists are the exact call
// sequence of the code before any flag existed: with every flag off the pipeline must make the same calls.
function assert(v: unknown, msg = "assertion failed"): asserts v { if (!v) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown, msg = "") { const x = JSON.stringify(a, null, 1), y = JSON.stringify(b, null, 1); if (x !== y) throw new Error(`${msg}\nexpected ${y}\nbut got ${x}`); }
import { asClient, FakeDb, type Row } from "./test-db.ts";
import { ingestMail, type InboundMail, pipelineTiming } from "./inbound-pipeline.ts";
import { FLOOD_WARNING } from "./mail-flood.ts";
import { UNVERIFIED_WARNING } from "./sender-auth.ts";

pipelineTiming.pollMs = 0;

const COMPANY = "c1";
const NOW_S = Math.floor(Date.now() / 1000);
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://fake.supabase.co", INTERNAL_FUNCTION_KEY: "DUMMY_internal", ESTIM_AI_JOB_SECRET: "DUMMY_job",
  APP_URL: "https://app.example", NYLAS_API_KEY: "DUMMY_nylas",
};
const FLAGS = ["EMAIL_FLOOD_GUARD_V2", "EMAIL_SENDER_CHECK", "EMAIL_INBOUND_LEVEL", "AI_ENABLED", "NOTIFY_ENABLED", "AI_DAILY_CAP", "EMAIL_INBOUND_HOURLY_CAP",
  "EMAIL_INBOUND_HOURLY_HARD_CAP", "EMAIL_SENDER_HOURLY_CAP", "EMAIL_SENDER_HOURLY_HARD_CAP", "AI_UNKNOWN_SENDER_SHARE", "NOTIFY_HOURLY_CAP"];

/** Runs `fn` with the test secrets set, every flag unset unless given, and fetch stubbed; restores everything after. */
async function withEnv(vars: Record<string, string>, db: FakeDb, fn: () => Promise<void>, triage: Record<string, unknown> = TRIAGE_NEW): Promise<void> {
  const names = [...Object.keys(ENV), ...FLAGS, ...Object.keys(vars)];
  const before = Object.fromEntries(names.map((n) => [n, Deno.env.get(n)]));
  const realFetch = globalThis.fetch;
  try {
    for (const n of FLAGS) Deno.env.delete(n);
    for (const [k, v] of Object.entries({ ...ENV, ...vars })) Deno.env.set(k, v);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = new URL(url).pathname;
      db.note(`fetch ${path}`);
      if (path.endsWith("/triage-email")) return Response.json(triage);
      if (path.endsWith("/interpret-request")) { // the worker: fills the draft and finishes the job
        for (const j of db.rows("ai_jobs")) j.state = "done";
        for (const d of db.rows("drafts")) d.text = "Hej! Här är ett utkast.";
        return Response.json({ ok: true });
      }
      if (path.endsWith("/messages/send")) return Response.json({ data: { id: "sent_1" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const n of names) { const v = before[n]; if (v === undefined) Deno.env.delete(n); else Deno.env.set(n, v); }
  }
}

const TRIAGE_NEW = { category: "forfragan", is_form_mail: false, customer: { name: null, email: null, phone: null } };

/** A company with a connected Nylas mailbox, one owner, and estim_receive creating customer, thread, message, draft and job. */
function pipelineDb(extra: Record<string, Row[]> = {}): FakeDb {
  const db = new FakeDb({
    tables: {
      email_connections: [{ company_id: COMPANY, grant_id: "g-1111", email: "info@foretag.se", status: "active" }],
      companies: [{ id: COMPANY, name: "Firma AB" }],
      company_members: [{ company_id: COMPANY, user_id: "u1", role: "ägare" }],
      ...extra,
    },
  });
  db.users = { u1: "agare@foretag.se" };
  let n = 0;
  db.rpcs.estim_receive = (args) => {
    const payload = args.payload as Row;
    n++;
    const threadId = `t${n}`, jobId = `j${n}`;
    db.tables.threads = [...db.rows("threads"), { id: threadId, company_id: COMPANY, channel: "email", status: "ny" }];
    db.tables.messages = [...db.rows("messages"), { id: `msg${n}`, company_id: COMPANY, channel: "email", from: "kund", thread_id: threadId, provider_message_id: payload.provider_message_id, created_at: new Date().toISOString() }];
    db.tables.drafts = [...db.rows("drafts"), { thread_id: threadId, company_id: COMPANY, text: "", warnings: [] }];
    db.tables.ai_jobs = [...db.rows("ai_jobs"), { id: jobId, state: "queued" }];
    return { data: { id: threadId, job_id: jobId, duplicate: false }, error: null };
  };
  return db;
}

const mail = (over: Partial<InboundMail> = {}): InboundMail => ({
  companyId: COMPANY, messageKey: "m1", fromEmail: "kund@example.com", fromName: "Kund", subject: "Offert badrum", text: "Hej, vi vill renovera.",
  ts: NOW_S - 60, attachments: [{ name: "ritning.pdf", type: "application/pdf", size: 3, load: () => Promise.resolve(new Uint8Array([1, 2, 3])) }], ...over,
});

async function run(db: FakeDb, m: InboundMail = mail()): Promise<void> {
  const out = await ingestMail(asClient(db), m, "nylas");
  assert(!out.retry, "unexpected retry");
  if (out.after) await out.after();
}

// Golden lists: taken from the code at commit ab0aae6 (before round 2), all flags off. Approved changes since then
// are marked with their step.
const GOLDEN_NEW_SENDER = [
  "messages.select(id).eq(company_id,c1).eq(channel,email).eq(provider_message_id,m1).maybeSingle()",
  "messages.select(id,count).eq(company_id,c1).eq(from,kund).eq(channel,email).gte(created_at,<ts>)",
  "customers.select(id).eq(company_id,c1).ilike(email,kund@example.com).limit(5)",
  "ai_calls.select(id,count).eq(company_id,c1).gte(created_at,<ts>)",
  "fetch /functions/v1/triage-email",
  "storage.mail-attachments.upload(c1/inbox/ca0df2c95aa144c1d0ff2ff3/1-ritning.pdf,3,application/pdf)",
  "rpc.estim_receive({\"cid\":\"c1\",\"payload\":{\"channel\":\"email\",\"customer_email\":\"kund@example.com\",\"text\":\"Hej, vi vill renovera.\",\"provider_message_id\":\"m1\",\"customer_name\":\"Kund\",\"sent_at\":\"<ts>\",\"job\":\"Offert badrum\"}})",
  "messages.update({\"attachments\":[\"ritning.pdf\"],\"attachment_files\":[{\"name\":\"ritning.pdf\",\"type\":\"application/pdf\",\"size\":3,\"path\":\"c1/inbox/ca0df2c95aa144c1d0ff2ff3/1-ritning.pdf\"}],\"email_subject\":\"Offert badrum\"}).eq(company_id,c1).eq(channel,email).eq(provider_message_id,m1)",
  "ai_calls.select(id,count).eq(company_id,c1).gte(created_at,<ts>)",
  "fetch /functions/v1/interpret-request",
  "ai_jobs.select(state).eq(id,j1).maybeSingle()",
  "email_connections.select(grant_id,status,email).eq(company_id,c1).maybeSingle()", // step 2b: + email (own mailbox)
  "audit_log.select(id,count).eq(company_id,c1).eq(event,Notis skickad).contains(after,{\"key\":\"j1\"})",
  "audit_log.select(id,count).eq(company_id,c1).eq(event,Notis skickad).gte(created_at,<ts>)", // step 2b: NOTIFY_HOURLY_CAP
  "drafts.select(text).eq(thread_id,t1).eq(company_id,c1).maybeSingle()",
  "companies.select(name).eq(id,c1).maybeSingle()",
  "company_members.select(user_id).eq(company_id,c1)",
  "auth.getUserById(u1)",
  "audit_log.insert({\"company_id\":\"c1\",\"event\":\"Notis skickad\",\"after\":{\"thread_id\":\"t1\",\"key\":\"j1\"}})",
  "fetch /v3/grants/g-1111/messages/send",
];
const GOLDEN_KNOWN_SENDER = [
  "messages.select(id).eq(company_id,c1).eq(channel,email).eq(provider_message_id,m1).maybeSingle()",
  "messages.select(id,count).eq(company_id,c1).eq(from,kund).eq(channel,email).gte(created_at,<ts>)",
  "customers.select(id).eq(company_id,c1).ilike(email,kund@example.com).limit(5)",
  "threads.select(id).eq(company_id,c1).eq(channel,email).in(customer_id,[\"cu1\"]).not(status,in,(vunnen,stangd)).limit(1)",
  "storage.mail-attachments.upload(c1/inbox/ca0df2c95aa144c1d0ff2ff3/1-ritning.pdf,3,application/pdf)",
  "rpc.estim_receive({\"cid\":\"c1\",\"payload\":{\"channel\":\"email\",\"customer_email\":\"kund@example.com\",\"text\":\"Hej, vi vill renovera.\",\"provider_message_id\":\"m1\",\"customer_name\":\"Kund\",\"sent_at\":\"<ts>\",\"job\":\"Offert badrum\"}})",
  "messages.update({\"attachments\":[\"ritning.pdf\"],\"attachment_files\":[{\"name\":\"ritning.pdf\",\"type\":\"application/pdf\",\"size\":3,\"path\":\"c1/inbox/ca0df2c95aa144c1d0ff2ff3/1-ritning.pdf\"}],\"email_subject\":\"Offert badrum\"}).eq(company_id,c1).eq(channel,email).eq(provider_message_id,m1)",
  "ai_calls.select(id,count).eq(company_id,c1).gte(created_at,<ts>)",
  "fetch /functions/v1/interpret-request",
  "ai_jobs.select(state).eq(id,j1).maybeSingle()",
  "email_connections.select(grant_id,status,email).eq(company_id,c1).maybeSingle()", // step 2b: + email (own mailbox)
  "audit_log.select(id,count).eq(company_id,c1).eq(event,Notis skickad).contains(after,{\"key\":\"j1\"})",
  "audit_log.select(id,count).eq(company_id,c1).eq(event,Notis skickad).gte(created_at,<ts>)", // step 2b: NOTIFY_HOURLY_CAP
  "drafts.select(text).eq(thread_id,t1).eq(company_id,c1).maybeSingle()",
  "companies.select(name).eq(id,c1).maybeSingle()",
  "company_members.select(user_id).eq(company_id,c1)",
  "auth.getUserById(u1)",
  "audit_log.insert({\"company_id\":\"c1\",\"event\":\"Notis skickad\",\"after\":{\"thread_id\":\"t1\",\"key\":\"j1\"}})",
  "fetch /v3/grants/g-1111/messages/send",
];
const GOLDEN_FLOOD_DROP = [
  "messages.select(id).eq(company_id,c1).eq(channel,email).eq(provider_message_id,m1).maybeSingle()",
  "messages.select(id,count).eq(company_id,c1).eq(from,kund).eq(channel,email).gte(created_at,<ts>)",
];

Deno.test("golden, flags off: a new sender (triage, attachment, AI job, notification)", async () => {
  const db = pipelineDb();
  await withEnv({}, db, () => run(db));
  assertEquals(db.normalized(), GOLDEN_NEW_SENDER);
});

Deno.test("golden, flags off: a sender with an open thread (no triage)", async () => {
  const db = pipelineDb({
    customers: [{ id: "cu1", company_id: COMPANY, email: "Kund@Example.com" }],
    threads: [{ id: "t0", company_id: COMPANY, channel: "email", customer_id: "cu1", status: "ny" }],
  });
  await withEnv({}, db, () => run(db));
  assertEquals(db.normalized(), GOLDEN_KNOWN_SENDER);
});

Deno.test("golden, flags off: the company cap drops the mail", async () => {
  const old = new Date().toISOString();
  const db = pipelineDb({ messages: Array.from({ length: 60 }, (_, i) => ({ id: `old${i}`, company_id: COMPANY, channel: "email", from: "kund", created_at: old })) });
  await withEnv({}, db, () => run(db));
  assertEquals(db.normalized(), GOLDEN_FLOOD_DROP);
});

/* ---------- EMAIL_FLOOD_GUARD_V2 ---------- */

const recent = () => new Date().toISOString();
const knownSender = (mails: number): Record<string, Row[]> => ({
  customers: [{ id: "cu1", company_id: COMPANY, email: "kund@example.com" }],
  threads: [{ id: "t0", company_id: COMPANY, channel: "email", customer_id: "cu1", status: "ny" }],
  messages: Array.from({ length: mails }, (_, i) => ({ id: `old${i}`, company_id: COMPANY, channel: "email", from: "kund", thread_id: "t0", created_at: recent() })),
});
const fetched = (db: FakeDb, what: string) => db.calls.some((c) => c.startsWith("fetch ") && c.includes(what));

Deno.test("flood guard v2: above the company hard cap the mail is dropped", async () => {
  const db = pipelineDb({ messages: Array.from({ length: 300 }, (_, i) => ({ id: `o${i}`, company_id: COMPANY, channel: "email", from: "kund", created_at: recent() })) });
  await withEnv({ EMAIL_FLOOD_GUARD_V2: "true" }, db, () => run(db));
  assert(!db.calls.some((c) => c.startsWith("rpc.estim_receive")), "stored");
});

Deno.test("flood guard v2: a flooding sender is stored without AI and without triage", async () => {
  const db = pipelineDb(knownSender(10));
  await withEnv({ EMAIL_FLOOD_GUARD_V2: "true" }, db, () => run(db));
  assert(db.calls.some((c) => c.startsWith("rpc.estim_receive")), "not stored");
  assert(!fetched(db, "triage-email") && !fetched(db, "interpret-request"), "AI ran");
  assertEquals(db.rows("ai_jobs").map((j) => j.state), ["failed"]);
  assertEquals(db.rows("drafts").map((d) => d.warnings), [[FLOOD_WARNING]]);
  assert(!fetched(db, "/messages/send"), "notified");
});

Deno.test("flood guard v2: unknown senders get only their share of the AI cap, known senders all of it", async () => {
  const calls = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, company_id: COMPANY, created_at: recent() })); // cap 150, share 90
  const unknown = pipelineDb({ ai_calls: calls });
  await withEnv({ EMAIL_FLOOD_GUARD_V2: "true" }, unknown, () => run(unknown));
  assert(!fetched(unknown, "triage-email") && !fetched(unknown, "interpret-request"), "unknown sender got AI");
  assertEquals(unknown.rows("ai_jobs").map((j) => j.state), ["failed"]);

  const known = pipelineDb({ ...knownSender(1), ai_calls: calls });
  await withEnv({ EMAIL_FLOOD_GUARD_V2: "true" }, known, () => run(known));
  assert(fetched(known, "interpret-request"), "known sender got no AI");

  const off = pipelineDb({ ai_calls: calls }); // flag off: the whole cap for everyone
  await withEnv({}, off, () => run(off));
  assert(fetched(off, "triage-email") && fetched(off, "interpret-request"), "flag off changed the AI cap");
});

Deno.test("flood guard v2: one sender at the per-sender hard cap is dropped", async () => {
  const db = pipelineDb(knownSender(30));
  await withEnv({ EMAIL_FLOOD_GUARD_V2: "true" }, db, () => run(db));
  assert(!db.calls.some((c) => c.startsWith("rpc.estim_receive")), "stored");
});

Deno.test("failed counts: with the flag a retry or no AI; without it read as 0 exactly as before", async () => {
  const companyCount = ".select(id,count).eq(company_id,c1).eq(from,kund)";
  const on = pipelineDb();
  on.fail(companyCount);
  await withEnv({ EMAIL_FLOOD_GUARD_V2: "true" }, on, async () => assertEquals(await ingestMail(asClient(on), mail(), "nylas"), { retry: true }));

  const off = pipelineDb();
  off.fail(companyCount);
  await withEnv({}, off, () => run(off));
  assertEquals(off.normalized(), GOLDEN_NEW_SENDER);

  const noAi = pipelineDb(knownSender(1));
  noAi.fail("ai_calls.select", undefined, 5);
  await withEnv({ EMAIL_FLOOD_GUARD_V2: "true" }, noAi, () => run(noAi));
  assert(noAi.calls.some((c) => c.startsWith("rpc.estim_receive")), "not stored");
  assert(!fetched(noAi, "interpret-request"), "AI ran without a budget count");
  assertEquals(noAi.rows("ai_jobs").map((j) => j.state), ["failed"]);

  const offAi = pipelineDb();
  offAi.fail("ai_calls.select", undefined, 5);
  await withEnv({}, offAi, () => run(offAi));
  assertEquals(offAi.normalized(), GOLDEN_NEW_SENDER);
});

/* ---------- EMAIL_SENDER_CHECK ---------- */

Deno.test("sender check fail: audit row, warning on the draft, no notification", async () => {
  const db = pipelineDb();
  await withEnv({ EMAIL_SENDER_CHECK: "true" }, db, () => run(db, mail({ senderCheck: "fail" })));
  const audit = db.rows("audit_log").filter((r) => r.event === "Overifierad avsändare");
  assertEquals(audit.map((r) => r.after), [{ thread_id: "t1", provider_message_id: "m1" }]);
  assertEquals(db.rows("drafts")[0]!.warnings, [UNVERIFIED_WARNING]);
  assertEquals(db.rows("drafts")[0]!.needs_review, true);
  assert(!fetched(db, "/messages/send") && !db.rows("audit_log").some((r) => r.event === "Notis skickad"), "notified");
});

Deno.test("sender check pass or unknown: same calls as the golden list", async () => {
  for (const senderCheck of ["pass", "unknown"] as const) {
    const db = pipelineDb();
    await withEnv({ EMAIL_SENDER_CHECK: "true" }, db, () => run(db, mail({ senderCheck })));
    assertEquals(db.normalized(), GOLDEN_NEW_SENDER, senderCheck);
  }
});
