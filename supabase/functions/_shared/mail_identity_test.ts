// Run with:  deno test --allow-env supabase/functions/_shared/mail_identity_test.ts
function assertEquals(a: unknown, b: unknown, msg = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y} but got ${x}`);
}
import {
  type CandidateMessage, decideQuarantine, decideThreadMatch, extractMessageIds, extractReplyCandidates,
  FORM_MAIL_WARNING, inboundLevel, MAX_REFERENCE_IDS, NO_REPLY_LEAD_WARNING, parseThreadHeaders, withDraftWarning,
} from "./mail-identity.ts";
import { UNVERIFIED_WARNING } from "./sender-auth.ts";
import { parseMessage } from "./nylas.ts";
import { parseEmail } from "./unipile.ts";

Deno.test("inboundLevel: defaults to 0, accepts only 1/2/3", () => {
  const before = Deno.env.get("EMAIL_INBOUND_LEVEL");
  try {
    Deno.env.delete("EMAIL_INBOUND_LEVEL"); assertEquals(inboundLevel(), 0);
    for (const bad of ["", "0", "4", "-1", "true", "abc", "1.5"]) {
      Deno.env.set("EMAIL_INBOUND_LEVEL", bad);
      assertEquals(inboundLevel(), 0, bad);
    }
    Deno.env.set("EMAIL_INBOUND_LEVEL", "1"); assertEquals(inboundLevel(), 1);
    Deno.env.set("EMAIL_INBOUND_LEVEL", " 2 "); assertEquals(inboundLevel(), 2);
    Deno.env.set("EMAIL_INBOUND_LEVEL", "3"); assertEquals(inboundLevel(), 3);
  } finally {
    if (before === undefined) Deno.env.delete("EMAIL_INBOUND_LEVEL"); else Deno.env.set("EMAIL_INBOUND_LEVEL", before);
  }
});

Deno.test("extractMessageIds & parseThreadHeaders: RFC 5322 comments, brackets, dedup, cap, priority order", () => {
  assertEquals(extractMessageIds(" <abc@host.se>  (comment <fake@evil.se>) <def@host.se> <abc@host.se> "), ["abc@host.se", "def@host.se"]);
  assertEquals(extractMessageIds("bare-id@host.se"), ["bare-id@host.se"]);
  assertEquals(extractMessageIds("not-an-id"), []);
  assertEquals(extractMessageIds(null), []);

  // Cap at MAX_REFERENCE_IDS
  const many = Array.from({ length: 30 }, (_, i) => `<m${i}@host.se>`).join(" ");
  assertEquals(extractMessageIds(many).length, MAX_REFERENCE_IDS);

  // In-Reply-To first, then References from newest (last) to oldest, deduplicated
  const th = parseThreadHeaders([
    { name: "Message-ID", value: "<curr@kund.se>" },
    { name: "In-Reply-To", value: "<parent@foretag.se>" },
    { name: "References", value: "<root@kund.se> <mid@foretag.se> <parent@foretag.se>" },
  ]);
  assertEquals(th.messageId, "curr@kund.se");
  assertEquals(extractReplyCandidates(th), ["parent@foretag.se", "mid@foretag.se", "root@kund.se"]);
});

Deno.test("long References header is preserved up to 8 KB in both Nylas and Unipile parsers", () => {
  const refs = Array.from({ length: 60 }, (_, i) => `<msg-${i}-${"x".repeat(40)}@host.example>`).join(" ");
  if (refs.length <= 2000 || refs.length > 8192) throw new Error(`unexpected length ${refs.length}`);
  const headers = [{ name: "References", value: refs }];
  for (const parsed of [parseMessage({ id: "m1", headers }).headers, parseEmail({ id: "em1", headers }).headers]) {
    assertEquals(parsed[0]!.value.length, refs.length);
  }
});

Deno.test("decideQuarantine (D18): off at level 0; quarantines form mail and unverified senders at level 1+", () => {
  const base = { fromEmail: "kund@example.com", fromName: "Anna", isFormMail: true, noReply: false, senderCheck: "pass" as const, extracted: { name: "Kalle", email: "kalle@kund.se", phone: "0701234567" } };
  assertEquals(decideQuarantine({ ...base, level: 0 }).quarantine, false);

  const form = decideQuarantine({ ...base, level: 1 });
  assertEquals(form, {
    quarantine: true,
    reason: "form_mail",
    suggestion: { name: "Kalle", email: "kalle@kund.se", phone: "0701234567", source: "form" },
    warning: FORM_MAIL_WARNING,
  });

  // Unverified sender always quarantines, even if not a form mail
  const unverified = decideQuarantine({ level: 1, isFormMail: false, noReply: false, senderCheck: "fail", fromEmail: "Kund@Example.com", fromName: "Anna" });
  assertEquals(unverified, {
    quarantine: true,
    reason: "unverified_sender",
    suggestion: { name: "Anna", email: "kund@example.com", phone: null, source: "unverified" },
    warning: UNVERIFIED_WARNING,
  });

  // no-reply without extracted email: not quarantined at level 1-2 (skipped as before), quarantined at level 3
  const nr = { isFormMail: false, noReply: true, senderCheck: "pass" as const, fromEmail: "no-reply@site.se", fromName: null, extracted: { name: "Bo", email: null, phone: "070999" } };
  assertEquals(decideQuarantine({ ...nr, level: 1 }).quarantine, false);
  assertEquals(decideQuarantine({ ...nr, level: 2 }).quarantine, false);
  assertEquals(decideQuarantine({ ...nr, level: 3 }), {
    quarantine: true,
    reason: "no_reply_lead",
    suggestion: { name: "Bo", email: null, phone: "070999", source: "no_reply" },
    warning: NO_REPLY_LEAD_WARNING,
  });

  // Normal mail never quarantined
  assertEquals(decideQuarantine({ level: 3, isFormMail: false, noReply: false, senderCheck: "pass", fromEmail: "kund@example.com", fromName: "Anna" }).quarantine, false);
});

Deno.test("decideThreadMatch (D17): our Message-ID joins; customer Message-ID needs matching From and non-fail; otherwise new thread + merge hint", () => {
  const ourReply: CandidateMessage = { threadId: "t1", from: "vv", rfcMessageId: null, providerMessageId: "sent-1@foretag.se", threadStatus: "svar", customerEmail: "kund@example.com" };
  const custMsg: CandidateMessage = { threadId: "t2", from: "kund", rfcMessageId: "cust-1@example.com", providerMessageId: "prov-2", threadStatus: "ny", customerEmail: "kund@example.com" };
  const closedThread: CandidateMessage = { threadId: "t3", from: "vv", rfcMessageId: "closed@foretag.se", providerMessageId: null, threadStatus: "vunnen", customerEmail: "kund@example.com" };

  // 1. Our sent Message-ID joins even from a different alias
  assertEquals(decideThreadMatch({
    replyIds: ["sent-1@foretag.se"], candidates: [ourReply], fromEmail: "alias@example.com", senderCheck: "pass", openThreadByFrom: null,
  }), { kind: "join", threadId: "t1", matchedBy: "our_message_id" });

  // 2. Customer's own Message-ID joins when From matches (case-insensitive) and senderCheck !== "fail"
  assertEquals(decideThreadMatch({
    replyIds: ["cust-1@example.com"], candidates: [custMsg], fromEmail: "KUND@Example.COM", senderCheck: "unknown", openThreadByFrom: "t2",
  }), { kind: "join", threadId: "t2", matchedBy: "customer_message_id" });

  // 3. Customer's own Message-ID does NOT join when From differs (CC'd recipient) or when senderCheck === "fail"
  assertEquals(decideThreadMatch({
    replyIds: ["cust-1@example.com"], candidates: [custMsg], fromEmail: "cc-person@other.se", senderCheck: "pass", openThreadByFrom: null,
  }), { kind: "new_thread", suggestedMergeThreadId: null });
  assertEquals(decideThreadMatch({
    replyIds: ["cust-1@example.com"], candidates: [custMsg], fromEmail: "kund@example.com", senderCheck: "fail", openThreadByFrom: "t2",
  }), { kind: "new_thread", suggestedMergeThreadId: "t2" });

  // 4. Closed/won thread is never auto-joined
  assertEquals(decideThreadMatch({
    replyIds: ["closed@foretag.se"], candidates: [closedThread], fromEmail: "kund@example.com", senderCheck: "pass", openThreadByFrom: null,
  }), { kind: "new_thread", suggestedMergeThreadId: null });

  // 5. Known sender with no Message-ID match gets a new thread + 1-click merge suggestion
  assertEquals(decideThreadMatch({
    replyIds: [], candidates: [], fromEmail: "kund@example.com", senderCheck: "pass", openThreadByFrom: "t1",
  }), { kind: "new_thread", suggestedMergeThreadId: "t1" });
});

Deno.test("withDraftWarning appends once and preserves existing string warnings", () => {
  assertEquals(withDraftWarning(["A"], FORM_MAIL_WARNING), ["A", FORM_MAIL_WARNING]);
  assertEquals(withDraftWarning(["A", FORM_MAIL_WARNING], FORM_MAIL_WARNING), ["A", FORM_MAIL_WARNING]);
  assertEquals(withDraftWarning(null, FORM_MAIL_WARNING), [FORM_MAIL_WARNING]);
});
