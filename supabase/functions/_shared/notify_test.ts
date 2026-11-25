// Run with:  deno test --allow-env supabase/functions/_shared/notify_test.ts
// notifyDraftReady and the bounded attachment downloads, against the fake database and a stubbed fetch.
function assert(v: unknown, msg = "assertion failed"): asserts v { if (!v) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} expected ${y} but got ${x}`); }
async function assertRejects(fn: () => Promise<unknown>, includes: string) {
  try { await fn(); } catch (e) { assert(String((e as Error).message).includes(includes), `wrong error: ${(e as Error).message}`); return; }
  throw new Error("expected rejection");
}
import { asClient, FakeDb, type Row } from "./test-db.ts";
import { notifyDraftReady } from "./notify.ts";
import { downloadAttachment as nylasDownload, MAX_ATTACHMENT_BYTES, readBounded } from "./nylas.ts";
import { downloadAttachment as unipileDownload } from "./unipile.ts";

const ENV = { APP_URL: "https://app.example", NYLAS_API_KEY: "DUMMY_nylas", UNIPILE_API_KEY: "DUMMY_unipile" };

async function withFetch(handler: (url: string, init?: RequestInit) => Response, fn: () => Promise<void>, vars: Record<string, string> = {}): Promise<void> {
  const all = { ...ENV, ...vars };
  const names = [...Object.keys(all), "NOTIFY_HOURLY_CAP", "NOTIFY_ENABLED"];
  const before = Object.fromEntries(names.map((n) => [n, Deno.env.get(n)]));
  const realFetch = globalThis.fetch;
  try {
    Deno.env.delete("NOTIFY_HOURLY_CAP"); Deno.env.delete("NOTIFY_ENABLED");
    for (const [k, v] of Object.entries(all)) Deno.env.set(k, v);
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(input instanceof Request ? input.url : input), init))) as typeof fetch;
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const n of names) { const v = before[n]; if (v === undefined) Deno.env.delete(n); else Deno.env.set(n, v); }
  }
}

/* ---------- 2b notifications ---------- */

function notifyDb(extra: Record<string, Row[]> = {}): FakeDb {
  const db = new FakeDb({
    tables: {
      email_connections: [{ company_id: "c1", grant_id: "g-1", email: "Info@Foretag.se", status: "active" }],
      drafts: [{ thread_id: "t1", company_id: "c1", text: "Utkast" }],
      companies: [{ id: "c1", name: "Firma" }],
      company_members: [{ company_id: "c1", user_id: "u1" }, { company_id: "c1", user_id: "u2" }],
      ...extra,
    },
  });
  db.users = { u1: "info@foretag.se", u2: "agare@foretag.se" }; // u1 signs in with the connected mailbox itself
  return db;
}
const sentTo = (bodies: string[]) => bodies.map((b) => (JSON.parse(b) as { to: { email: string }[] }).to[0]!.email);

Deno.test("notify: never to the company's own connected mailbox", async () => {
  const db = notifyDb();
  const bodies: string[] = [];
  await withFetch((url, init) => { bodies.push(String(init?.body)); assert(url.includes("/messages/send")); return Response.json({ data: { id: "s1" } }); },
    () => notifyDraftReady(asClient(db), "c1", "t1", "j1"));
  assertEquals(sentTo(bodies), ["agare@foretag.se"]);
});

Deno.test("notify: stops at NOTIFY_HOURLY_CAP notifications per company and hour", async () => {
  const now = new Date().toISOString(), old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const sent = (n: number, at: string): Row[] => Array.from({ length: n }, (_, i) => ({ company_id: "c1", event: "Notis skickad", after: { key: `k${i}` }, created_at: at }));
  const cases: [Row[], Record<string, string>, number][] = [
    [sent(19, now), {}, 1], [sent(20, now), {}, 0], [sent(50, old), {}, 1], [sent(3, now), { NOTIFY_HOURLY_CAP: "3" }, 0], [sent(3, now), { NOTIFY_HOURLY_CAP: "" }, 1],
  ];
  for (const [rows, vars, expect] of cases) {
    const db = notifyDb({ audit_log: rows });
    let sends = 0;
    await withFetch(() => { sends++; return Response.json({ data: { id: "s1" } }); }, () => notifyDraftReady(asClient(db), "c1", "t1", "j1"), vars);
    assertEquals(sends, expect, `${rows.length} ${JSON.stringify(vars)}`);
  }
  const failing = notifyDb();
  failing.fail(".gte(created_at");
  let sends = 0;
  await withFetch(() => { sends++; return Response.json({ data: { id: "s1" } }); }, () => notifyDraftReady(asClient(failing), "c1", "t1", "j1"));
  assertEquals(sends, 0);
});

/* ---------- 2a bounded downloads ---------- */

/** A body streamed in 1 MB chunks that counts how much was actually pulled. */
function streamed(totalBytes: number, headers: Record<string, string> = {}) {
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (pulled >= totalBytes) { c.close(); return; } const n = Math.min(chunk.length, totalBytes - pulled); pulled += n; c.enqueue(chunk.slice(0, n)); },
  });
  return { response: new Response(body, { headers }), pulled: () => pulled };
}

Deno.test("readBounded: responses too; a stream larger than the limit and a lying content-length are cut", async () => {
  assertEquals((await readBounded(new Response("abc"), 3))?.length, 3);
  assertEquals(await readBounded(new Response("abcd"), 3), null);
  assertEquals(await readBounded(new Response("abc", { headers: { "content-length": "99" } }), 10), null);
  const big = streamed(50 * 1024 * 1024);
  assertEquals(await readBounded(big.response, MAX_ATTACHMENT_BYTES), null);
  assert(big.pulled() <= MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024, `read ${big.pulled()} bytes`);
  const liar = streamed(30 * 1024 * 1024, { "content-length": "100" });
  assertEquals(await readBounded(liar.response, MAX_ATTACHMENT_BYTES), null);
  assert(liar.pulled() <= MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024, `read ${liar.pulled()} bytes`);
});

Deno.test("attachments: both providers keep at most 10 MB, raw or as base64 JSON", async () => {
  const ok = new Uint8Array(1000).fill(7);
  await withFetch(() => new Response(ok), async () => {
    assertEquals((await nylasDownload("g", "m", "a")).length, 1000);
    assertEquals((await unipileDownload("acc_1", "m", "a")).length, 1000);
  });
  await withFetch(() => streamed(MAX_ATTACHMENT_BYTES + 1).response, async () => {
    await assertRejects(() => nylasDownload("g", "m", "a"), "attachment_too_large");
    await assertRejects(() => unipileDownload("acc_1", "m", "a"), "attachment_too_large");
  });
  await withFetch(() => streamed(40 * 1024 * 1024, { "content-length": "10" }).response, async () => {
    await assertRejects(() => nylasDownload("g", "m", "a"), "attachment_too_large");
  });
  // base64 JSON: small is decoded; a decoded size above 10 MB, or a JSON above 14 MB, is refused
  const b64 = (bytes: number) => "A".repeat(Math.ceil(bytes / 3) * 4); // "AAAA" decodes to 3 zero bytes
  await withFetch(() => Response.json({ content: btoa("hej") }), async () => assertEquals((await unipileDownload("acc_1", "m", "a")).length, 3));
  await withFetch(() => Response.json({ content: b64(MAX_ATTACHMENT_BYTES + 3) }), () => assertRejects(() => unipileDownload("acc_1", "m", "a"), "attachment_too_large"));
  await withFetch(() => Response.json({ content: b64(12 * 1024 * 1024) }), () => assertRejects(() => unipileDownload("acc_1", "m", "a"), "attachment_too_large"));
  await withFetch(() => Response.json({ nope: 1 }), () => assertRejects(() => unipileDownload("acc_1", "m", "a"), "unipile_attachment_format"));
  await withFetch(() => new Response("x", { status: 404 }), () => assertRejects(() => unipileDownload("acc_1", "m", "a"), "unipile_attachment_404"));
});
