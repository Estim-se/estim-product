// Run with:  deno test --allow-env supabase/functions/_shared/mail_flood_test.ts
function assertEquals(a: unknown, b: unknown, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} expected ${y} but got ${x}`); }
import { aiBudgetLeft, aiDailyCap, floodDecision, floodGuardV2 } from "./mail-flood.ts";

const caps = { companyCap: 60, hardCap: 300, senderCap: 10, senderHardCap: 30 };

Deno.test("flood guard off: exactly today's company cap, whatever the sender count", () => {
  for (const companyCount of [0, 1, 59, 60, 61, 299, 300, 1000]) {
    for (const senderCount of [0, 9, 10, 29, 30, 500]) {
      const today = companyCount >= 60 ? "drop" : "normal"; // the old `count >= EMAIL_INBOUND_HOURLY_CAP` check
      assertEquals(floodDecision({ senderCount, companyCount, flag: false, caps }), today, `${companyCount}/${senderCount}`);
    }
  }
  // a failed company count was read as 0
  assertEquals(floodDecision({ senderCount: 0, companyCount: null, flag: false, caps }), "normal");
  // the AI budget is the plain AI_DAILY_CAP for every sender, and a failed AI count was read as 0
  for (const known of [true, false, undefined]) assertEquals(aiDailyCap({ known, flag: false, dailyCap: 150, unknownShare: 0.6 }), 150);
  assertEquals(aiBudgetLeft({ used: null, known: false, flag: false, dailyCap: 150 }), true);
  assertEquals(aiBudgetLeft({ used: 149, known: false, flag: false, dailyCap: 150, unknownShare: 0.6 }), true);
  assertEquals(aiBudgetLeft({ used: 150, known: true, flag: false, dailyCap: 150 }), false);
});

Deno.test("flood guard on: store without AI instead of dropping, drop only above the hard cap", () => {
  assertEquals(floodDecision({ senderCount: 0, companyCount: 0, flag: true, caps }), "normal");
  assertEquals(floodDecision({ senderCount: 9, companyCount: 59, flag: true, caps }), "normal");
  assertEquals(floodDecision({ senderCount: 10, companyCount: 0, flag: true, caps }), "store_no_ai"); // one sender floods
  assertEquals(floodDecision({ senderCount: 0, companyCount: 60, flag: true, caps }), "store_no_ai"); // company cap
  assertEquals(floodDecision({ senderCount: 0, companyCount: 299, flag: true, caps }), "store_no_ai");
  assertEquals(floodDecision({ senderCount: 0, companyCount: 300, flag: true, caps }), "drop"); // storage protection
  // one sender can never fill the company hard cap alone
  assertEquals(floodDecision({ senderCount: 29, companyCount: 29, flag: true, caps }), "store_no_ai");
  assertEquals(floodDecision({ senderCount: 30, companyCount: 30, flag: true, caps }), "drop");
  // a failed count is never read as 0
  assertEquals(floodDecision({ senderCount: 0, companyCount: null, flag: true, caps }), "retry");
  assertEquals(aiBudgetLeft({ used: null, known: true, flag: true, dailyCap: 150 }), false);
  assertEquals(aiBudgetLeft({ used: 89, known: false, flag: true, dailyCap: 150, unknownShare: 0.6 }), true);
  assertEquals(aiBudgetLeft({ used: 90, known: false, flag: true, dailyCap: 150, unknownShare: 0.6 }), false);
});

Deno.test("flood guard on: unknown senders get a share of the AI cap, known senders all of it", () => {
  assertEquals(aiDailyCap({ known: true, flag: true, dailyCap: 150, unknownShare: 0.6 }), 150);
  assertEquals(aiDailyCap({ known: false, flag: true, dailyCap: 150, unknownShare: 0.6 }), 90);
  assertEquals(aiDailyCap({ known: undefined, flag: true, dailyCap: 150, unknownShare: 0.6 }), 150);
  assertEquals(aiDailyCap({ known: false, flag: true, dailyCap: 150, unknownShare: 5 }), 150); // share is capped at 1
});

Deno.test("flood guard settings: flag off by default, empty secrets fall back to the defaults", () => {
  const names = ["EMAIL_FLOOD_GUARD_V2", "EMAIL_INBOUND_HOURLY_CAP", "EMAIL_INBOUND_HOURLY_HARD_CAP", "EMAIL_SENDER_HOURLY_CAP", "EMAIL_SENDER_HOURLY_HARD_CAP", "AI_DAILY_CAP", "AI_UNKNOWN_SENDER_SHARE"];
  const before = Object.fromEntries(names.map((n) => [n, Deno.env.get(n)]));
  try {
    for (const n of names) Deno.env.delete(n);
    assertEquals(floodGuardV2(), false);
    Deno.env.set("EMAIL_FLOOD_GUARD_V2", "yes"); assertEquals(floodGuardV2(), false);
    Deno.env.set("EMAIL_FLOOD_GUARD_V2", " TRUE "); assertEquals(floodGuardV2(), true);
    for (const n of names.slice(1)) Deno.env.set(n, "");
    assertEquals(floodDecision({ senderCount: 10, companyCount: 0, flag: true }), "store_no_ai");
    assertEquals(floodDecision({ senderCount: 0, companyCount: 300, flag: true }), "drop");
    assertEquals(floodDecision({ senderCount: 30, companyCount: 30, flag: true }), "drop");
    assertEquals(aiDailyCap({ known: false, flag: true }), 90);
  } finally {
    for (const n of names) { const v = before[n]; if (v === undefined) Deno.env.delete(n); else Deno.env.set(n, v); }
  }
});
