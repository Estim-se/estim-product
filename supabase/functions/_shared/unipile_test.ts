// Run with:  deno test --allow-env supabase/functions/_shared/unipile_test.ts
// No network: only the pure parts of the Unipile client are tested.
function assert(v: unknown, msg = "assertion failed"): asserts v { if (!v) throw new Error(msg); }
function assertFalse(v: unknown) { assert(!v, "expected false"); }
function assertEquals(a: unknown, b: unknown) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`expected ${y} but got ${x}`); }
function assertThrows(fn: () => unknown, includes: string) {
  try { fn(); } catch (e) { assert(String((e as Error).message).includes(includes), `wrong error: ${(e as Error).message}`); return; }
  throw new Error("expected an error");
}
import {
  accountEventOf, authLinkBody, bounceEventOf, emailEventOf, isNonInboxFolder, isUnipileAccount, mapProvider, normalizeMessageId, parseAccount, parseEmail,
  parseEvent, shouldHandleEmailEvent, verifyUnipileSignature,
} from "./unipile.ts";
import { activeProvider, providerOf } from "./mail-provider.ts";
import { shouldSkip } from "./nylas.ts";

const secret = "DUMMY_unipile_secret";
const enc = new TextEncoder();
const STATE = "a".repeat(64);

async function sign(t: number, body: Uint8Array, key = secret): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array([...enc.encode(`${t}.`), ...body]);
  const hex = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", k, signed as BufferSource))).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${t},v0=${hex}`;
}

Deno.test("signature: accepts the signed timestamp and body, rejects tampering, wrong secret, old or missing timestamps", async () => {
  const now = 1_800_000_000, body = enc.encode('{"type":"email.new"}');
  const header = await sign(now, body);
  assert(await verifyUnipileSignature(body, header, secret, now));
  assert(await verifyUnipileSignature(body, header, secret, now + 299));
  assertFalse(await verifyUnipileSignature(body, header, secret, now + 301)); // replayed later
  assertFalse(await verifyUnipileSignature(enc.encode('{"type":"x"}'), header, secret, now));
  assertFalse(await verifyUnipileSignature(body, header, "other", now));
  assertFalse(await verifyUnipileSignature(body, header.replace(/^t=\d+/, `t=${now + 1}`), secret, now)); // timestamp is signed too
  assertFalse(await verifyUnipileSignature(body, "v0=abc", secret, now));
  assertFalse(await verifyUnipileSignature(body, null, secret, now));
  assertFalse(await verifyUnipileSignature(body, header, "", now));
  // several v0 values (secret rotation): one valid is enough
  assert(await verifyUnipileSignature(body, `${header},v0=${"0".repeat(64)}`, secret, now));
});

Deno.test("event envelope and pointers", () => {
  const e = parseEvent({ id: "evt_1", type: "email.new", account_id: "acc_123", account_provider: "google", payload: { folder_id: "INBOX", email: { id: "em_1", folders: ["INBOX"] } } });
  assertEquals(e.accountId, "acc_123");
  assertEquals(e.provider, "google");
  assertEquals(emailEventOf(e.payload), { emailId: "em_1", folders: ["INBOX"], folderId: "INBOX" });
  assertEquals(parseEvent({ type: "email.new", account_id: "not-an-account" }).accountId, null);
  assertThrows(() => parseEvent("nope"), "invalid_event");
  assertThrows(() => parseEvent({ account_id: "acc_1" }), "invalid_type");
  assertEquals(emailEventOf({}), null);
});

Deno.test("account events carry only our own well-formed state", () => {
  assertEquals(accountEventOf({ account: { id: "acc_9" }, state: STATE }), { accountId: "acc_9", state: STATE });
  assertEquals(accountEventOf({ account: { id: "acc_9" }, state: "short" }), { accountId: "acc_9", state: null });
  assertEquals(accountEventOf({ account: { id: "x" }, state: STATE }), null);
  assertEquals(accountEventOf({}), null);
});

Deno.test("auth links ask for mail permissions only, also when reconnecting", () => {
  const base = { state: STATE, redirectUri: "https://app.example/epost-klar", now: 0, minutes: 30 };
  const fresh = authLinkBody({ ...base, provider: "microsoft" });
  assertEquals(fresh.providers, "outlook");
  assertEquals(fresh.expires_on, "1970-01-01T00:30:00.000Z");
  assertEquals(authLinkBody(base).providers, ["google", "outlook"]); // never IMAP or other providers
  const again = authLinkBody({ ...base, provider: "google", reconnectAccountId: "acc_9" });
  assertEquals(again.account_id, "acc_9");
  assertEquals("providers" in again, false);
  for (const body of [fresh, again]) {
    const config = body.config as { google: { oauth_scope: string[] }; outlook: { oauth_scope: string[] } };
    const all = [...config.google.oauth_scope, ...config.outlook.oauth_scope].join(" ");
    assertFalse(/calendar|Calendars|gmail\.modify|contacts/i.test(all));
    assert(config.google.oauth_scope.includes("https://www.googleapis.com/auth/gmail.readonly"));
    assert(config.google.oauth_scope.includes("https://www.googleapis.com/auth/gmail.send"));
    // Microsoft: "Mail.Send alone is insufficient"
    assert(["Mail.Send", "Mail.ReadWrite", "offline_access"].every((s) => config.outlook.oauth_scope.includes(s)));
  }
});

Deno.test("accounts: provider mapping and the mailbox address come from Unipile", () => {
  assertEquals(mapProvider("google"), "google");
  assertEquals(mapProvider("outlook"), "microsoft");
  assertEquals(mapProvider("imap"), "imap");
  assertEquals(mapProvider("whatsapp"), null);
  assertEquals(parseAccount({ provider: "outlook", name: "Info@Foretag.se", status: "running" }), { email: "info@foretag.se", provider: "microsoft", status: "running" });
  // shape of a real Gmail account (2026-11-25): the address is in user_id
  assertEquals(parseAccount({ object: "Account", user_id: "Anna@Example.com", id: "acc_1", status: "running", provider: "google" }), { email: "anna@example.com", provider: "google", status: "running" });
  assertEquals(parseAccount({ provider: "google", user_id: "not-an-email", name: "anna@example.com" }).email, "anna@example.com");
  assertThrows(() => parseAccount({ provider: "linkedin", name: "x@y.se" }), "unipile_unsupported_account");
  assertThrows(() => parseAccount({ provider: "google", name: "Anna Andersson" }), "unipile_no_email");
});

Deno.test("email parsing maps v2 fields to the shared message shape", () => {
  const m = parseEmail({
    id: "em_1", thread_id: "th_1", subject: "Offert", date: "2026-11-24T10:00:00Z",
    from: [{ email: " kund@example.com ", display_name: "Kund" }], to: [{ email: "info@foretag.se" }], cc: "oops",
    body: "<p>Hej</p>", body_plain: "Hej", headers: [{ name: "List-Id", value: "z" }, { value: "no name" }],
    attachments: [
      { type: "file", id: "at_1", filename: "ritning.pdf", mimetype: "application/pdf", file_size: 1200, is_inline: false },
      { type: "img", id: "at_2", mimetype: "image/jpeg", is_inline: true },
      { type: "audio", id: "at_3", mimetype: "audio/ogg" },
    ],
  });
  assertEquals(m.from, [{ name: "Kund", email: "kund@example.com" }]);
  assertEquals(m.cc, []);
  assertEquals(m.date, Date.parse("2026-11-24T10:00:00Z") / 1000);
  assertEquals(m.body, "<p>Hej</p>");
  assertEquals(m.headers.length, 1);
  assertEquals(m.attachments, [
    { id: "at_1", filename: "ritning.pdf", content_type: "application/pdf", size: 1200, is_inline: false },
    { id: "at_2", filename: "bild.jpeg", content_type: "image/jpeg", size: 0, is_inline: true },
  ]);
  assertEquals(parseEmail({ id: "em_2", body: "", body_plain: "Bara text" }).body, "Bara text");
  // real Gmail attachment ids are long tokens and must be kept whole
  const longId = "ANGjdJ8" + "x".repeat(397);
  assertEquals(parseEmail({ id: "em_4", attachments: [{ type: "file", id: longId, filename: "test.pdf", mimetype: "application/pdf", file_size: 13264 }] }).attachments[0]?.id, longId);
  assertThrows(() => parseEmail({ id: "" }), "invalid_id");
});

Deno.test("sent, draft and spam folders never become requests, and own mail is skipped", () => {
  assert(isNonInboxFolder(["SENT"])); assert(isNonInboxFolder(["INBOX", "SPAM"])); assertFalse(isNonInboxFolder(["INBOX", "Label_5"]));
  // Gmail sends one email.new per label for the same mail (seen 2026-11-25): only the INBOX one is handled
  const labels = ["IMPORTANT", "CATEGORY_PERSONAL", "INBOX"];
  assertEquals(["INBOX", "IMPORTANT", "CATEGORY_PERSONAL"].map((folderId) => shouldHandleEmailEvent("google", { folders: labels, folderId })), [true, false, false]);
  assertFalse(shouldHandleEmailEvent("google", { folders: ["SENT"], folderId: "SENT" }));
  // other providers: opaque folder ids, every event is handled and the duplicate checks stop repeats
  assert(shouldHandleEmailEvent("microsoft", { folders: ["AAMkAD"], folderId: "AAMkAD" }));
  assert(shouldHandleEmailEvent(null, { folders: [], folderId: null }));
  const own = parseEmail({ id: "em_3", from: [{ email: "info@foretag.se" }], to: [{ email: "kund@example.com" }] });
  assertEquals(shouldSkip(own, "info@foretag.se"), "own_message");
});

Deno.test("bounces point at the Message-ID of our reply, ordinary mail does not", () => {
  assertEquals(normalizeMessageId("<CA+HPZ=ab@mail.gmail.com>"), "CA+HPZ=ab@mail.gmail.com");
  assertEquals(normalizeMessageId(" CA+HPZ=ab@mail.gmail.com "), "CA+HPZ=ab@mail.gmail.com");
  assertEquals(normalizeMessageId("not an id"), null);
  assertEquals(normalizeMessageId(42), null);
  // the email.new.bounce event as Unipile really sends it (2026-11-25): no email object, email_id is our Message-ID
  const event = {
    reason: "The email account that you tried to reach does not exist.", addresses: "finns-inte@example.com", type: "action_not_taken",
    code: 550, error_persistence: "permanent", email_id: "<CA+HPZ=ab@mail.gmail.com>", date: "Tue, 24 Nov 2026 16:08:07 -0800 (PST)",
  };
  assertEquals(bounceEventOf(event), "CA+HPZ=ab@mail.gmail.com");
  assertEquals(bounceEventOf({ ...event, error_persistence: "transient" }), null);
  assertEquals(bounceEventOf({ code: 550 }), null);
  // the bounce MAIL (also a "delayed" report, which looks the same) never marks anything and never becomes a request:
  // headers as in a real Gmail report (2026-11-25)
  const report = parseEmail({
    id: "em_b", from: [{ email: "mailer-daemon@googlemail.com" }], to: [{ email: "info@foretag.se" }],
    headers: [
      { name: "Subject", value: "Delivery Status Notification (Delay)" },
      { name: "Content-Type", value: 'multipart/report; boundary="x"; report-type=delivery-status' },
      { name: "Auto-Submitted", value: "auto-replied" },
      { name: "In-Reply-To", value: "<CA+HPZ=ab@mail.gmail.com>" },
    ],
  });
  assertEquals(shouldSkip(report, "info@foretag.se"), "automated_sender");
});

Deno.test("provider routing: connections keep their provider, new ones follow EMAIL_PROVIDER", () => {
  assert(isUnipileAccount("acc_AbC-1")); assertFalse(isUnipileAccount("3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90")); assertFalse(isUnipileAccount(null));
  assertEquals(providerOf("acc_1"), "unipile");
  assertEquals(providerOf("3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90"), "nylas");
  const before = Deno.env.get("EMAIL_PROVIDER");
  try {
    Deno.env.delete("EMAIL_PROVIDER"); assertEquals(activeProvider(), "nylas");
    Deno.env.set("EMAIL_PROVIDER", " Unipile "); assertEquals(activeProvider(), "unipile");
  } finally { if (before === undefined) Deno.env.delete("EMAIL_PROVIDER"); else Deno.env.set("EMAIL_PROVIDER", before); }
});
