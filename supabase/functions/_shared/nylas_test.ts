// Run with:  deno test --allow-env supabase/functions/_shared/nylas_test.ts
// Tiny assert helpers so the test needs no network or extra packages.
function assert(v: unknown, msg = "assertion failed"): asserts v { if (!v) throw new Error(msg); }
function assertFalse(v: unknown) { assert(!v, "expected false"); }
function assertEquals(a: unknown, b: unknown) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`expected ${y} but got ${x}`); }
async function assertRejects(fn: () => Promise<unknown>, _cls: unknown, includes: string) {
  try { await fn(); } catch (e) { assert(String((e as Error).message).includes(includes), `wrong error: ${(e as Error).message}`); return; }
  throw new Error("expected rejection");
}
import {
  errCode, extractNylasRfcMessageId, gunzip, htmlToText, isNoReplySender, mailText, parseMessage, parseNotification, pointer, readBounded, shouldSkip, stripQuoted, verifyNylasSignature,
  type NylasMessage,
} from "./nylas.ts";

const secret = "DUMMY_webhook_secret";
const enc = new TextEncoder();

async function hmacHex(bytes: Uint8Array, key = secret): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes as BufferSource))).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const msg = (over: Partial<NylasMessage> = {}): NylasMessage => ({
  id: "m1", thread_id: "t1", subject: "Hej", from: [{ name: null, email: "kund@example.com" }], to: [{ name: null, email: "info@foretag.se" }],
  cc: [], date: 1, snippet: null, body: null, headers: [], attachments: [], ...over,
});

Deno.test("signature: accepts a correct signature, rejects tampering, bad hex, wrong secret, missing header", async () => {
  const body = enc.encode('{"type":"message.created"}');
  const sig = await hmacHex(body);
  assert(await verifyNylasSignature(body, sig, secret));
  assertFalse(await verifyNylasSignature(enc.encode('{"type":"x"}'), sig, secret));
  assertFalse(await verifyNylasSignature(body, "zz", secret));
  assertFalse(await verifyNylasSignature(body, sig, "other"));
  assertFalse(await verifyNylasSignature(body, null, secret));
});

Deno.test("signature covers the gzip bytes, not the decompressed JSON", async () => {
  const body = enc.encode('{"type":"message.created"}');
  const compressed = await gzip(body);
  assert(await verifyNylasSignature(compressed, await hmacHex(compressed), secret));
  assertFalse(await verifyNylasSignature(compressed, await hmacHex(body), secret));
  assertEquals(new TextDecoder().decode(await gunzip(compressed)), '{"type":"message.created"}');
});

Deno.test("gunzip refuses decompression bombs", async () => {
  const bomb = await gzip(new Uint8Array(3_000_000));
  await assertRejects(() => gunzip(bomb, 1_000_000), Error, "payload_too_large");
});

Deno.test("notification parsing is strict about shape but tolerant about extras", () => {
  const n = parseNotification({ type: "message.created", data: { object: { grant_id: "g", id: "m" } }, extra: 1 });
  assertEquals(n.type, "message.created");
  assertEquals(pointer(n.object), { grantId: "g", id: "m" });
  assertEquals(pointer({ grant_id: "g" }), null);
  assertEquals(pointer({ grant_id: "x".repeat(301), id: "m" }), null);
  try { parseNotification("nope"); assert(false); } catch (e) { assertEquals((e as Error).message, "invalid_notification"); }
});

Deno.test("message parsing keeps only expected fields and limits sizes", () => {
  const m = parseMessage({ id: "a", from: [{ email: "x@y.se", name: "X" }], to: "oops", headers: [{ name: "List-Id", value: "z" }, { value: "no name" }], body: "b" });
  assertEquals(m.from[0]?.email, "x@y.se");
  assertEquals(m.to, []);
  assertEquals(m.headers.length, 1);
  try { parseMessage({ id: "" }); assert(false); } catch (e) { assertEquals((e as Error).message, "invalid_id"); }
});

Deno.test("html becomes plain text without tags or scripts", () => {
  assertEquals(htmlToText("<p>Hej&nbsp;<b>Anna</b></p><script>alert(1)</script><p>Tack</p>"), "Hej Anna\nTack");
});

Deno.test("quoted history is removed", () => {
  assertEquals(stripQuoted("Ja, tisdag funkar.\n\nOn Mon, 1 Jan 2026 Anna <a@b.se> wrote:\n> Kan ni komma?"), "Ja, tisdag funkar.");
  assertEquals(stripQuoted("Tack!\nPå mån 1 jan 2026 skrev Anna:\nHej"), "Tack!");
});

Deno.test("what gets ignored before the AI sees it", () => {
  const own = "info@foretag.se";
  assertEquals(shouldSkip(msg(), own, own), null);
  assertEquals(shouldSkip(msg({ from: [{ name: null, email: "Info@Foretag.se" }] }), own), "own_message");
  assertEquals(shouldSkip(msg({ from: [{ name: null, email: "mailer-daemon@x.se" }] }), own), "automated_sender");
  // a no-reply sender is NOT skipped here: website forms use such addresses and triage decides
  assertEquals(shouldSkip(msg({ from: [{ name: null, email: "no-reply@bank.se" }] }), own), null);
  assert(isNoReplySender("no-reply@bank.se")); assert(isNoReplySender("wordpress@site.se")); assertFalse(isNoReplySender("anna@site.se"));
  assertEquals(shouldSkip(msg({ headers: [{ name: "List-Unsubscribe", value: "<mailto:x@y.se>" }] }), own), "mailing_list");
  assertEquals(shouldSkip(msg({ headers: [{ name: "Precedence", value: "bulk" }] }), own), "bulk");
  assertEquals(shouldSkip(msg({ headers: [{ name: "Auto-Submitted", value: "auto-replied" }] }), own), "auto_submitted");
  assertEquals(shouldSkip(msg({ headers: [{ name: "Auto-Submitted", value: "no" }] }), own), null);
  assertEquals(shouldSkip(msg({ to: [{ name: null, email: "anna@foretag.se" }] }), own, "offert@foretag.se"), "not_addressed_to_watch_address");
  assertEquals(shouldSkip(msg({ from: [] }), own), "no_sender");
});

Deno.test("errCode never returns message text", () => {
  assertEquals(errCode(new Error("dispatch_500")), "dispatch_500");
  assertEquals(errCode(new Error("secret@customer.se failed")), "Error");
  assertEquals(errCode("x"), "unknown");
});

Deno.test("readBounded: refuses a large content-length at once and stops reading a stream past the limit", async () => {
  const small = new Uint8Array(10).fill(1);
  assertEquals((await readBounded(new Request("http://x", { method: "POST", body: small }), 100))?.length, 10);
  // declared too large: refused without reading
  let pulled = 0;
  const lazy = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(10)); } }, { highWaterMark: 0 });
  const declared = new Request("http://x", { method: "POST", body: lazy, headers: { "content-length": "5000" } });
  assertEquals(await readBounded(declared, 100), null);
  assertEquals(pulled, 0);
  // no or lying content-length: the stream is cancelled as soon as the limit is passed
  let cancelled = false, chunks = 0;
  const endless = () => new ReadableStream<Uint8Array>({ pull(c) { chunks++; c.enqueue(new Uint8Array(64)); }, cancel() { cancelled = true; } });
  assertEquals(await readBounded(new Request("http://x", { method: "POST", body: endless() }), 1000), null);
  assert(cancelled, "stream not cancelled");
  assert(chunks <= 20, `read too much: ${chunks} chunks`);
  cancelled = false; chunks = 0;
  const lying = new Request("http://x", { method: "POST", body: endless(), headers: { "content-length": "10" } });
  assertEquals(await readBounded(lying, 1000), null);
  assert(cancelled, "stream not cancelled");
  // exactly at the limit is accepted; an empty body is empty
  assertEquals((await readBounded(new Request("http://x", { method: "POST", body: new Uint8Array(100) }), 100))?.length, 100);
  assertEquals((await readBounded(new Request("http://x", { method: "POST" }), 100))?.length, 0);
});

Deno.test("mail text: quoted history is cut, but a mail that is only a forward is kept whole (step 6)", () => {
  assertEquals(mailText("<p>Hej!</p><p>Från: Anna</p><p>gammalt</p>", 8000), "Hej!");
  const forward = "Från: Anna Andersson\nSkickat: igår\nÄmne: Offert\n\nVi vill renovera badrummet.";
  assertEquals(stripQuoted(forward), ""); // the old code dropped this mail as empty
  assertEquals(mailText(forward, 8000), forward);
  assertEquals(mailText("> bara citat", 8000), "> bara citat");
  assertEquals(mailText("", 8000), "");
  assertEquals(mailText("x".repeat(9000), 8000).length, 8000);
});

Deno.test("extractNylasRfcMessageId reads direct fields or Message-ID header and rejects invalid values", () => {
  assertEquals(extractNylasRfcMessageId({ message_id: "<abc123@mail.foretag.se>" }), "abc123@mail.foretag.se");
  assertEquals(extractNylasRfcMessageId({ headers: [{ name: "Subject", value: "Re: Hej" }, { name: "Message-ID", value: "<hdr-1@foretag.se>" }] }), "hdr-1@foretag.se");
  assertEquals(extractNylasRfcMessageId({ id: "opaque-nylas-id" }), null);
  assertEquals(extractNylasRfcMessageId(null), null);
});
