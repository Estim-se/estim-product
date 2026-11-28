// Run with:  deno test --allow-env supabase/functions/_shared/resend_test.ts
// Covers Resend system-mail client, loop protection in shouldSkip, draft/form-quarantine notifications,
// reconnect alerts for owners only, and optional ops alerts — plus flag-off isolation.

function assert(v: unknown, msg = "assertion failed"): asserts v {
  if (!v) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown, msg = "") {
  const x = JSON.stringify(a),
    y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y} but got ${x}`);
}
async function assertRejects(fn: () => Promise<unknown>, includes: string) {
  try {
    await fn();
  } catch (e) {
    assert(String((e as Error).message).includes(includes), `wrong error: ${(e as Error).message}`);
    return;
  }
  throw new Error("expected rejection");
}

import { asClient, FakeDb, type Row } from "./test-db.ts";
import { parseFromAddress, resendEnabled, sendResendEmail } from "./resend.ts";
import {
  _resetOpsAlertCache,
  notifyConnectionLost,
  notifyDraftReady,
  notifyOpsAlert,
} from "./notify.ts";
import { shouldSkip, type NylasMessage } from "./nylas.ts";

const RESEND_ENV_KEYS = [
  "APP_URL",
  "NOTIFY_ENABLED",
  "NOTIFY_HOURLY_CAP",
  "RESEND_NOTIFY_ENABLED",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "RECONNECT_NOTIFY_COOLDOWN_HOURS",
  "OPS_ALERT_EMAIL",
];

async function withEnvAndFetch(
  vars: Record<string, string>,
  handler: (url: string, init?: RequestInit) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const before = Object.fromEntries(RESEND_ENV_KEYS.map((k) => [k, Deno.env.get(k)]));
  const realFetch = globalThis.fetch;
  try {
    for (const k of RESEND_ENV_KEYS) Deno.env.delete(k);
    for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v);
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        handler(String(input instanceof Request ? input.url : input), init),
      )) as typeof fetch;
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const k of RESEND_ENV_KEYS) {
      const v = before[k];
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const RESEND_ON = {
  APP_URL: "https://app.estim.se",
  RESEND_NOTIFY_ENABLED: "true",
  RESEND_API_KEY: "re_dummy_key",
  RESEND_FROM: "estim <notiser@mail.estim.se>",
};

Deno.test("resend config: off by default and validates sender format strictly", async () => {
  assertEquals(parseFromAddress("notiser@mail.estim.se"), "notiser@mail.estim.se");
  assertEquals(parseFromAddress("estim <Notiser@Mail.Estim.se>"), "notiser@mail.estim.se");
  assertEquals(parseFromAddress("estim <a@b.se>\r\nBcc: x@y.se"), null);
  assertEquals(parseFromAddress("A <a@b.se>, B <c@d.se>"), null);
  assertEquals(parseFromAddress("estim <a@b.se>\x00"), null);
  assertEquals(parseFromAddress("bad"), null);

  await withEnvAndFetch(
    { RESEND_API_KEY: "re_dummy", RESEND_FROM: "notiser@mail.estim.se" },
    () => new Response("ok"),
    async () => {
      assertEquals(resendEnabled(), false, "flag must default to off");
      await assertRejects(
        () => sendResendEmail({ to: "a@b.se", subject: "x", html: "<p>x</p>" }),
        "resend_disabled",
      );
    },
  );
  await withEnvAndFetch(RESEND_ON, () => new Response("ok"), async () => {
    assertEquals(resendEnabled(), true);
  });
});

Deno.test("sendResendEmail: sets loop-prevention headers, idempotency key, and safe errors", async () => {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  await withEnvAndFetch(
    RESEND_ON,
    (url, init) => {
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ id: "email_1" });
    },
    async () => {
      const id = await sendResendEmail({
        to: "Agare@Elfirma.se",
        subject: "Hej\r\nvärlden",
        html: "<p>Hej</p>",
        text: "Hej",
        idempotencyKey: "draft:c1:j1:0",
      });
      assertEquals(id, "email_1");
      assertEquals(calls.length, 1);
      assertEquals(calls[0]!.url, "https://api.resend.com/emails");
      assertEquals(calls[0]!.headers["Authorization"], "Bearer re_dummy_key");
      assertEquals(calls[0]!.headers["Idempotency-Key"], "draft:c1:j1:0");
      assertEquals(calls[0]!.body.to, ["agare@elfirma.se"]);
      assertEquals(calls[0]!.body.subject, "Hej världen");
      assertEquals(calls[0]!.body.headers, {
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
        "X-Estim-System-Mail": "1",
      });
    },
  );

  await withEnvAndFetch(
    RESEND_ON,
    () => new Response("secret error text", { status: 429 }),
    async () => {
      await assertRejects(
        () => sendResendEmail({ to: "a@b.se", subject: "x", html: "<p>x</p>" }),
        "resend_429",
      );
    },
  );
});

Deno.test("shouldSkip: blocks incoming estim system mails by header or RESEND_FROM", async () => {
  const baseMsg = (over: Partial<NylasMessage> = {}): NylasMessage => ({
    id: "m1",
    thread_id: null,
    subject: "Nytt svarsutkast",
    from: [{ email: "kund@example.se", name: null }],
    to: [{ email: "info@elfirma.se", name: null }],
    cc: [],
    date: 0,
    body: "hej",
    snippet: "hej",
    headers: [],
    attachments: [],
    ...over,
  });

  await withEnvAndFetch(RESEND_ON, () => new Response("ok"), async () => {
    assertEquals(
      shouldSkip(
        baseMsg({ from: [{ email: "notiser@mail.estim.se", name: "estim" }] }),
        "info@elfirma.se",
        null,
      ),
      "estim_system_mail",
    );
    assertEquals(
      shouldSkip(
        baseMsg({ headers: [{ name: "X-Estim-System-Mail", value: "1" }] }),
        "info@elfirma.se",
        null,
      ),
      "estim_system_mail",
    );
    assertEquals(
      shouldSkip(
        baseMsg({ headers: [{ name: "Auto-Submitted", value: "auto-generated" }] }),
        "info@elfirma.se",
        null,
      ),
      "auto_submitted",
    );
    assertEquals(shouldSkip(baseMsg(), "info@elfirma.se", null), null);
  });
  // Flag off: inbound filtering is exactly as before Resend, even with RESEND_FROM set.
  await withEnvAndFetch({ RESEND_FROM: "estim <notiser@mail.estim.se>" }, () => new Response("ok"), async () => {
    assertEquals(
      shouldSkip(
        baseMsg({ from: [{ email: "notiser@mail.estim.se", name: "estim" }] }),
        "info@elfirma.se",
        null,
      ),
      null,
    );
    assertEquals(
      shouldSkip(
        baseMsg({ headers: [{ name: "X-Estim-System-Mail", value: "1" }] }),
        "info@elfirma.se",
        null,
      ),
      null,
    );
  });
});

function draftDb(extra: Record<string, Row[]> = {}): FakeDb {
  const db = new FakeDb({
    tables: {
      email_connections: [],
      drafts: [{ thread_id: "t1", company_id: "c1", text: "Hej kund!" }],
      companies: [{ id: "c1", name: "Kalles El <AB>" }],
      company_members: [
        { company_id: "c1", user_id: "u1", role: "ägare" },
        { company_id: "c1", user_id: "u2", role: "användare" },
      ],
      ...extra,
    },
  });
  db.users = { u1: "info@elfirma.se", u2: "lisa@elfirma.se" };
  return db;
}

Deno.test("notifyDraftReady (Resend): notifies sole proprietor even without email_connections and formats form quarantine", async () => {
  const sent: Record<string, unknown>[] = [];
  const db = draftDb();

  await withEnvAndFetch(
    RESEND_ON,
    (url, init) => {
      assertEquals(url, "https://api.resend.com/emails");
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: `re_${sent.length}` });
    },
    async () => {
      await notifyDraftReady(asClient(db), "c1", "t1", "j1", { kind: "form_quarantine" });
      // Duplicate job key must not send again.
      await notifyDraftReady(asClient(db), "c1", "t1", "j1", { kind: "form_quarantine" });
    },
  );

  assertEquals(sent.length, 2);
  assertEquals(
    sent.map((m) => (m.to as string[])[0]),
    ["info@elfirma.se", "lisa@elfirma.se"],
  );
  assertEquals(sent[0]!.subject, "Nytt formulärmejl att godkänna");
  const html = String(sent[0]!.html);
  assert(html.includes("Kalles El &lt;AB&gt;"), "company name must be HTML-escaped");
  assert(!html.includes("Hej kund!"), "must never include draft/customer text");
  assertEquals(
    [...new Set([...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]))],
    ["https://app.estim.se"],
    "button and fallback link go only to the app origin",
  );
  assert(html.includes('src="https://app.estim.se/email/logo.png"'), "branded layout shows the logo");
});

Deno.test("notifyConnectionLost: off by default, notifies owners only, respects cooldown", async () => {
  const db = new FakeDb({
    tables: {
      companies: [{ id: "c1", name: "Kalles El" }],
      company_members: [
        { company_id: "c1", user_id: "u1", role: "ägare" },
        { company_id: "c1", user_id: "u2", role: "användare" },
      ],
      audit_log: [],
    },
  });
  db.users = { u1: "agare@elfirma.se", u2: "anstalld@elfirma.se" };

  // Flag off: zero sends and zero DB queries.
  let sends = 0;
  await withEnvAndFetch(
    { APP_URL: "https://app.estim.se", RESEND_API_KEY: "re_x", RESEND_FROM: "notiser@mail.estim.se" },
    () => {
      sends++;
      return Response.json({ id: "re_1" });
    },
    () =>
      notifyConnectionLost(asClient(db), {
        companyId: "c1",
        email: "info@elfirma.se",
        grantId: "acc_1",
        newState: "expired",
      }),
  );
  assertEquals(sends, 0);
  assertEquals(db.calls.length, 0);

  // Flag on: notifies owner only, links to /kanaler, and second call within cooldown does not re-send.
  const sent: Record<string, unknown>[] = [];
  await withEnvAndFetch(
    RESEND_ON,
    (url, init) => {
      assertEquals(url, "https://api.resend.com/emails");
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "re_rc_1" });
    },
    async () => {
      await notifyConnectionLost(asClient(db), {
        companyId: "c1",
        email: "info@elfirma.se",
        grantId: "acc_1",
        newState: "expired",
      });
      // Postgres DEFAULT now() sets created_at on audit_log inserts; populate it on FakeDb's inserted row.
      const logged = db.rows("audit_log");
      assertEquals(logged.length, 1);
      logged[0]!.created_at = new Date().toISOString();
      await notifyConnectionLost(asClient(db), {
        companyId: "c1",
        email: "info@elfirma.se",
        grantId: "acc_1",
        newState: "revoked",
      });
      // Once outside the 24h cooldown window, a new alert is allowed again.
      logged[0]!.created_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
      await notifyConnectionLost(asClient(db), {
        companyId: "c1",
        email: "info@elfirma.se",
        grantId: "acc_1",
        newState: "expired",
      });
    },
  );

  assertEquals(sent.length, 2);
  assertEquals(sent[0]!.to, ["agare@elfirma.se"]);
  assertEquals(sent[0]!.subject, "E-postkopplingen i estim behöver förnyas");
  assertEquals(
    [...new Set([...String(sent[0]!.html).matchAll(/href="([^"]*)"/g)].map((match) => match[1]))],
    ["https://app.estim.se/kanaler"],
  );
  assert(String(sent[0]!.html).includes("info@elfirma.se"));
});

Deno.test("notifyOpsAlert: no-op without OPS_ALERT_EMAIL, sends and rate-limits when configured", async () => {
  _resetOpsAlertCache();
  let sends = 0;
  await withEnvAndFetch(
    RESEND_ON,
    () => {
      sends++;
      return Response.json({ id: "re_ops_1" });
    },
    () => notifyOpsAlert({ key: "k1", title: "Fel", detail: "Detalj" }),
  );
  assertEquals(sends, 0);

  const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  await withEnvAndFetch(
    { ...RESEND_ON, OPS_ALERT_EMAIL: "drift@estim.se" },
    (_url, init) => {
      sent.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ id: "re_ops_2" });
    },
    async () => {
      await notifyOpsAlert({ key: "unipile_giveup:email.new", title: "Webhook-fel", detail: "Retry slut" });
      await notifyOpsAlert({ key: "unipile_giveup:email.new", title: "Webhook-fel", detail: "Retry slut" });
    },
  );
  assertEquals(sent.length, 1);
  assertEquals(sent[0]!.body.to, ["drift@estim.se"]);
  assertEquals(sent[0]!.body.subject, "[estim drift] Webhook-fel");
  assert(
    /^ops:unipile_giveup:email\.new:\d+$/.test(sent[0]!.headers["Idempotency-Key"] ?? ""),
    "ops alert must pass a time-bucketed Idempotency-Key",
  );
});

Deno.test("notify: refuses non-http(s) APP_URL schemes", async () => {
  const db = draftDb();
  let sends = 0;
  await withEnvAndFetch(
    { ...RESEND_ON, APP_URL: "javascript:alert(1)" },
    () => {
      sends++;
      return Response.json({ id: "re_bad" });
    },
    async () => {
      await notifyDraftReady(asClient(db), "c1", "t1", "j_bad");
      await notifyConnectionLost(asClient(db), {
        companyId: "c1",
        email: "info@elfirma.se",
        grantId: "acc_1",
        newState: "expired",
      });
    },
  );
  assertEquals(sends, 0);
});
