// Run with:  deno test --allow-env supabase/functions/_shared/connection_binding_test.ts
// The shared bind/revoke rules (connection-binding.ts) against the in-memory fake database. Provider calls are stubbed.
function assert(v: unknown, msg = "assertion failed"): asserts v { if (!v) throw new Error(msg); }
function assertEquals(a: unknown, b: unknown, msg = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${msg} expected ${y} but got ${x}`); }
import { asClient, FakeDb, type Row } from "./test-db.ts";
import {
  BIND_FAILED_EVENT, BIND_OK_EVENT, bindConnection, bindFailureAction, bindFailureText, bindUnipileAccount, disconnectConnection, orphanAction,
  revokeIfUnreferenced, stateInFlight, stateTag, unipileFinishStatus,
} from "./connection-binding.ts";
import { sha256Hex } from "./nylas.ts";

const STATE = "a".repeat(64);
const HASH = await sha256Hex(STATE);
const C1 = "c1", C2 = "c2", U1 = "u1";
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

/** A fake db with two companies, an owner of c1 and email_connections unique on company_id and grant_id. */
function bindDb(tables: Record<string, Row[]> = {}): FakeDb {
  return new FakeDb({
    tables: {
      companies: [{ id: C1, active: true }, { id: C2, active: true }],
      company_members: [{ company_id: C1, user_id: U1, role: "ägare" }],
      email_connections: [],
      oauth_states: [{ state_hash: HASH, company_id: C1, user_id: U1, used_at: null, expires_at: iso(20 * 60_000) }],
      ...tables,
    },
    unique: { email_connections: ["company_id", "grant_id"] },
  });
}
function recorder(ok = true) {
  const revoked: string[] = [];
  return { revoked, revoke: (id: string) => { revoked.push(id); return Promise.resolve(ok); } };
}
const events = (db: FakeDb, event: string) => db.rows("audit_log").filter((r) => r.event === event);
const nylasInput = (over: Partial<Parameters<typeof bindConnection>[1]> = {}) => ({
  providerName: "nylas" as const, companyId: C1, userId: U1, connectionId: "g-new", email: "info@foretag.se", mailProvider: "google",
  isNew: true, isLastAttempt: true, stateHash: HASH, ...over,
});
const addEvent = (accountId: string) => ({ account: { id: accountId }, state: STATE });
const unipileDeps = (rec: ReturnType<typeof recorder>, opts: { fail?: string } = {}) => ({
  getAccount: (id: string) => opts.fail ? Promise.reject(new Error(opts.fail)) : Promise.resolve({ email: `${id}@foretag.se`, provider: "google" }),
  revoke: rec.revoke,
});

/* ---------- Pure decisions ---------- */

Deno.test("bind failure: never deletes a reconnect or a known account; retries transient errors until the last attempt", () => {
  const add = "account.add" as const, re = "account.reconnect" as const;
  assertEquals(bindFailureAction({ type: add, errorCode: "23505", isLastAttempt: false, accountKnown: false }), "delete");
  assertEquals(bindFailureAction({ type: add, errorCode: "23505", isLastAttempt: false, accountKnown: true }), "ignore");
  assertEquals(bindFailureAction({ type: re, errorCode: "23505", isLastAttempt: true, accountKnown: false }), "ignore");
  assertEquals(bindFailureAction({ type: add, errorCode: "08006", isLastAttempt: false, accountKnown: false }), "retry");
  assertEquals(bindFailureAction({ type: add, errorCode: null, isLastAttempt: false, accountKnown: false }), "retry");
  assertEquals(bindFailureAction({ type: add, errorCode: "08006", isLastAttempt: true, accountKnown: false }), "delete");
  assertEquals(bindFailureAction({ type: add, errorCode: "08006", isLastAttempt: true, accountKnown: true }), "retry");
  assertEquals(bindFailureAction({ type: re, errorCode: "08006", isLastAttempt: false, accountKnown: false }), "retry");
  assertEquals(bindFailureAction({ type: re, errorCode: "08006", isLastAttempt: true, accountKnown: true }), "retry");
});

Deno.test("orphan: deleted only when the state is expired or its binding is over; never while in flight (1e)", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  const add = "account.add" as const, re = "account.reconnect" as const;
  const expired = { used_at: null, expires_at: at(-1000) };
  const usedLongAgo = { used_at: at(-10 * 60_000), expires_at: at(20 * 60_000) };
  const usedJustNow = { used_at: at(-5_000), expires_at: at(20 * 60_000) };
  const open = { used_at: null, expires_at: at(60_000) };
  const base = { type: add, accountKnown: false, bindDone: false, isLastAttempt: false, now };
  assertEquals(orphanAction({ ...base, stateRow: expired }), "delete");
  assertEquals(orphanAction({ ...base, stateRow: usedLongAgo }), "delete");
  // in flight: wait for the binding, and on the last attempt keep the account (the old code deleted here)
  assertEquals(orphanAction({ ...base, stateRow: usedJustNow }), "retry");
  assertEquals(orphanAction({ ...base, stateRow: usedJustNow, isLastAttempt: true }), "ignore");
  // the binding recorded its outcome and this account is not the bound one: a second account for the same link
  assertEquals(orphanAction({ ...base, stateRow: usedJustNow, bindDone: true }), "delete");
  // never: no row (other environment), reconnect, account already bound, state still claimable
  assertEquals(orphanAction({ ...base, stateRow: null, isLastAttempt: true }), "ignore");
  assertEquals(orphanAction({ ...base, type: re, stateRow: expired, isLastAttempt: true }), "ignore");
  assertEquals(orphanAction({ ...base, stateRow: usedLongAgo, accountKnown: true, isLastAttempt: true }), "ignore");
  assertEquals(orphanAction({ ...base, stateRow: open, isLastAttempt: true }), "ignore");
  assert(stateInFlight({ stateRow: usedJustNow, bindDone: false, now }));
  assert(!stateInFlight({ stateRow: usedJustNow, bindDone: true, now }));
  assert(!stateInFlight({ stateRow: usedLongAgo, bindDone: false, now }));
  assert(!stateInFlight({ stateRow: open, bindDone: false, now }));
});

Deno.test("failure texts for /epost-klar", () => {
  assertEquals(bindFailureText("bound_elsewhere"), "Mejllådan är redan kopplad till ett annat företag.");
  assertEquals(bindFailureText("unsupported_account"), "Det här kontot stöds inte.");
  assertEquals(bindFailureText("not_allowed"), "Bara ägare kan koppla e-post.");
  assertEquals(bindFailureText(undefined), "Kunde inte slutföra anslutningen. Försök igen.");
});

/* ---------- 1b revoke rule and 1c lookup errors (bindConnection, both providers) ---------- */

Deno.test("1b: a replaced connection is revoked only after the new row is saved, and the success event names the state", async () => {
  const db = bindDb({ email_connections: [{ company_id: C1, grant_id: "g-old", status: "active" }] });
  const rec = recorder();
  assertEquals(await bindConnection(asClient(db), nylasInput(), rec.revoke), { status: "saved" });
  assertEquals(db.rows("email_connections").map((r) => r.grant_id), ["g-new"]);
  assertEquals(rec.revoked, ["g-old"]);
  const upsertAt = db.calls.findIndex((c) => c.startsWith("email_connections.upsert"));
  const lastLookup = db.calls.map((c, i) => [c, i] as const).filter(([c]) => c.includes(".eq(grant_id,g-old)")).pop()![1];
  assert(upsertAt >= 0 && lastLookup > upsertAt, "old id checked before the save");
  assertEquals(events(db, BIND_OK_EVENT).map((e) => e.after), [{ provider: "google", state: stateTag(HASH) }]);
  assertEquals("last_event_at" in db.rows("email_connections")[0]!, false); // Nylas never stored it
});

Deno.test("1b: own grant on re-login + transient upsert error -> no revoke", async () => {
  const db = bindDb({ email_connections: [{ company_id: C1, grant_id: "g-same", status: "active" }] });
  db.fail("email_connections.upsert", { code: "08006", message: "connection failure" });
  const rec = recorder();
  const res = await bindConnection(asClient(db), nylasInput({ connectionId: "g-same" }), rec.revoke);
  assertEquals(res, { status: "failed", stage: "save", action: "retry", boundElsewhere: false });
  assertEquals(rec.revoked, []);
  assertEquals(db.rows("email_connections"), [{ company_id: C1, grant_id: "g-same", status: "active" }]);
  assertEquals(events(db, BIND_FAILED_EVENT).map((e) => e.after), [{ code: "save_failed", state: stateTag(HASH) }]);
});

Deno.test("1b: a grant that cannot be read is revoked only when no row references it; a failed lookup counts as referenced", async () => {
  const db = bindDb({ email_connections: [{ company_id: C1, grant_id: "g-own", status: "active" }, { company_id: C2, grant_id: "g-other", status: "active" }] });
  const rec = recorder();
  assertEquals(await revokeIfUnreferenced(asClient(db), "g-own", rec.revoke), "referenced"); // the old code revoked this one
  assertEquals(await revokeIfUnreferenced(asClient(db), "g-other", rec.revoke), "referenced");
  db.fail("email_connections.select(company_id)");
  assertEquals(await revokeIfUnreferenced(asClient(db), "g-free", rec.revoke), "lookup_failed");
  assertEquals(rec.revoked, []);
  assertEquals(await revokeIfUnreferenced(asClient(db), "g-free", rec.revoke), "revoked");
  assertEquals(rec.revoked, ["g-free"]);
  assertEquals(await revokeIfUnreferenced(asClient(db), "g-free2", recorder(false).revoke), "revoke_failed");
});

Deno.test("1b: a grant bound to another company is never revoked and is reported as bound elsewhere", async () => {
  const db = bindDb({ email_connections: [{ company_id: C2, grant_id: "g-new", status: "active" }] });
  const rec = recorder();
  const res = await bindConnection(asClient(db), nylasInput(), rec.revoke);
  assertEquals(res, { status: "failed", stage: "save", action: "ignore", boundElsewhere: true });
  assertEquals(rec.revoked, []);
  assertEquals(events(db, BIND_FAILED_EVENT).map((e) => (e.after as Row).code), ["bound_elsewhere"]);
});

Deno.test("1c: the lookup of the old connection fails -> nothing is saved; Nylas removes its new unreferenced grant, Unipile retries", async () => {
  const nylas = bindDb({ email_connections: [{ company_id: C1, grant_id: "g-old", status: "active" }] });
  nylas.fail("email_connections.select(grant_id).eq(company_id");
  const rec = recorder();
  const res = await bindConnection(asClient(nylas), nylasInput(), rec.revoke);
  assertEquals(res, { status: "failed", stage: "lookup", action: "delete", boundElsewhere: false });
  assert(!nylas.calls.some((c) => c.startsWith("email_connections.upsert")), "saved after a failed lookup");
  assertEquals(rec.revoked, ["g-new"]); // never the old, live one

  const uni = bindDb();
  uni.fail("email_connections.select(grant_id).eq(company_id");
  const rec2 = recorder();
  assertEquals(await bindUnipileAccount(asClient(uni), "account.add", addEvent("acc_1"), false, unipileDeps(rec2)), { retry: true });
  assertEquals(rec2.revoked, []);
  assertEquals(uni.rows("oauth_states")[0]!.used_at, null); // released for the retry
  assertEquals(events(uni, BIND_FAILED_EVENT), []); // not final yet
  assertEquals(await bindUnipileAccount(asClient(uni), "account.add", addEvent("acc_1"), false, unipileDeps(rec2)), {});
  assertEquals(uni.rows("email_connections").map((r) => r.grant_id), ["acc_1"]);
});

/* ---------- Unipile account events ---------- */

Deno.test("unipile: account.add binds once, stores the event time and records success", async () => {
  const db = bindDb();
  const rec = recorder();
  assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_1"), false, unipileDeps(rec)), {});
  const row = db.rows("email_connections")[0]!;
  assertEquals([row.grant_id, row.email, row.provider, row.status, row.connected_by], ["acc_1", "acc_1@foretag.se", "google", "active", U1]);
  assert(typeof row.last_event_at === "string");
  assert(db.rows("oauth_states")[0]!.used_at, "state not claimed");
  assertEquals(events(db, BIND_OK_EVENT).length, 1);
  assertEquals(rec.revoked, []);
});

Deno.test("1d: two account.add with one state -> loser deleted, winner kept", async () => {
  const db = bindDb();
  const rec = recorder();
  // Both deliveries see the unused state and race to claim it.
  const outcomes = await Promise.all(["acc_A", "acc_B"].map((id) => bindUnipileAccount(asClient(db), "account.add", addEvent(id), false, unipileDeps(rec))));
  const bound = db.rows("email_connections").map((r) => r.grant_id);
  assertEquals(bound.length, 1); // which delivery wins the claim depends on timing
  const winner = bound[0] as string, loser = winner === "acc_A" ? "acc_B" : "acc_A";
  assertEquals(outcomes[winner === "acc_A" ? 0 : 1], {});
  if (outcomes[loser === "acc_A" ? 0 : 1]!.retry) { // the loser saw the winner in flight: its retry deletes it once the winner recorded success
    assertEquals(rec.revoked, []);
    assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent(loser), false, unipileDeps(rec)), {});
  }
  assertEquals(rec.revoked, [loser]);
  assertEquals(events(db, BIND_OK_EVENT).length, 1);
});

Deno.test("1e: a duplicate delivery while the binding is still in flight never deletes, also on the last attempt", async () => {
  const db = bindDb({ oauth_states: [{ state_hash: HASH, company_id: C1, user_id: U1, used_at: iso(-3_000), expires_at: iso(20 * 60_000) }] });
  const rec = recorder();
  assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_1"), false, unipileDeps(rec)), { retry: true });
  assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_1"), true, unipileDeps(rec)), {});
  assertEquals(rec.revoked, []);
  // used long ago without the account being bound: an orphan
  db.rows("oauth_states")[0]!.used_at = iso(-10 * 60_000);
  assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_1"), true, unipileDeps(rec)), {});
  assertEquals(rec.revoked, ["acc_1"]);
});

Deno.test("1f: an inactive company or a user who is no longer owner cannot bind; a new account is removed", async () => {
  for (const tables of [{ companies: [{ id: C1, active: false }] } as Record<string, Row[]>, { company_members: [{ company_id: C1, user_id: U1, role: "medarbetare" }] }, { company_members: [] }]) {
    const db = bindDb(tables);
    const rec = recorder();
    assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_1"), false, unipileDeps(rec)), {});
    assertEquals(db.rows("email_connections"), []);
    assertEquals(rec.revoked, ["acc_1"]);
    assert(db.rows("oauth_states")[0]!.used_at, "state left usable");
    assertEquals(events(db, BIND_FAILED_EVENT).map((e) => (e.after as Row).code), ["not_allowed"]);
  }
  // a reconnect of the company's own account is never deleted
  const db = bindDb({ companies: [{ id: C1, active: false }], email_connections: [{ company_id: C1, grant_id: "acc_1", status: "expired" }] });
  const rec = recorder();
  await bindUnipileAccount(asClient(db), "account.reconnect", addEvent("acc_1"), false, unipileDeps(rec));
  assertEquals(rec.revoked, []);
  assertEquals(db.rows("email_connections")[0]!.status, "expired");
  // the lookup fails: retry, nothing claimed
  const flaky = bindDb();
  flaky.fail("companies.select(active)");
  assertEquals(await bindUnipileAccount(asClient(flaky), "account.add", addEvent("acc_1"), false, unipileDeps(recorder())), { retry: true });
  assertEquals(flaky.rows("oauth_states")[0]!.used_at, null);
});

Deno.test("unipile: an unsupported account is refused and removed; a transient error retries", async () => {
  const db = bindDb();
  const rec = recorder();
  assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_1"), false, unipileDeps(rec, { fail: "unipile_no_email" })), {});
  assertEquals(rec.revoked, ["acc_1"]);
  assertEquals(events(db, BIND_FAILED_EVENT).map((e) => (e.after as Row).code), ["unsupported_account"]);
  const flaky = bindDb();
  assertEquals(await bindUnipileAccount(asClient(flaky), "account.add", addEvent("acc_1"), false, unipileDeps(recorder(), { fail: "unipile_get_account_503" })), { retry: true });
  assertEquals(flaky.rows("oauth_states")[0]!.used_at, null);
});

Deno.test("unipile: a save error on the last attempt is final: failure recorded, state stays used, a new account is deleted", async () => {
  const db = bindDb();
  db.fail("email_connections.upsert", { code: "08006", message: "x" });
  const rec = recorder();
  assertEquals(await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_1"), true, unipileDeps(rec)), {});
  assertEquals(rec.revoked, ["acc_1"]);
  assert(db.rows("oauth_states")[0]!.used_at, "state released on the last attempt");
  assertEquals(events(db, BIND_FAILED_EVENT).length, 1);
});

/* ---------- 1g disconnect ---------- */

Deno.test("1g: disconnect changes the row only after the provider confirmed the revoke", async () => {
  const ok = bindDb({ email_connections: [{ company_id: C1, grant_id: "acc_1", status: "active" }] });
  const rec = recorder();
  assertEquals(await disconnectConnection(asClient(ok), C1, U1, rec.revoke), { ok: true });
  assertEquals(rec.revoked, ["acc_1"]);
  assertEquals(ok.rows("email_connections")[0]!.status, "revoked");
  assertEquals(events(ok, "E-post frånkopplad").length, 1);

  const failed = bindDb({ email_connections: [{ company_id: C1, grant_id: "acc_1", status: "active" }] });
  const res = await disconnectConnection(asClient(failed), C1, U1, recorder(false).revoke);
  assertEquals(res, { ok: false, status: 502, error: "Kunde inte koppla från hos leverantören. Försök igen." });
  assertEquals(failed.rows("email_connections")[0]!.status, "active");
  assertEquals(events(failed, "E-post frånkopplad").length, 0);

  const lookup = bindDb({ email_connections: [{ company_id: C1, grant_id: "acc_1", status: "active" }] });
  lookup.fail(".neq(company_id");
  const rec3 = recorder();
  assertEquals((await disconnectConnection(asClient(lookup), C1, U1, rec3.revoke)).ok, false);
  assertEquals(rec3.revoked, []);

  assertEquals(await disconnectConnection(asClient(bindDb()), C1, U1, recorder().revoke), { ok: true }); // nothing connected
});

/* ---------- 1h /epost-klar ---------- */

Deno.test("1h: finish reports this attempt's outcome, never the old mailbox after a failed switch", async () => {
  const old = { company_id: C1, grant_id: "acc_old", email: "gammal@foretag.se", provider: "google", status: "active" };
  const status = (db: FakeDb) => unipileFinishStatus(asClient(db), C1, U1, HASH);

  assertEquals(await status(bindDb({ email_connections: [old] })), { kind: "pending" }); // not claimed yet

  // claimed, no outcome yet: still pending, even though an old active connection exists
  const claimed = bindDb({ email_connections: [old], oauth_states: [{ state_hash: HASH, company_id: C1, user_id: U1, used_at: iso(-1000), expires_at: iso(20 * 60_000) }] });
  assertEquals(await status(claimed), { kind: "pending" });

  // the switch failed: the error, not "Klart! gammal@foretag.se"
  claimed.tables.audit_log = [{ company_id: C1, event: BIND_FAILED_EVENT, after: { code: "bound_elsewhere", state: stateTag(HASH) } }];
  assertEquals(await status(claimed), { kind: "error", status: 409, error: "Mejllådan är redan kopplad till ett annat företag." });

  // a failure event of another attempt does not count
  claimed.tables.audit_log = [{ company_id: C1, event: BIND_FAILED_EVENT, after: { code: "save_failed", state: "0".repeat(16) } }];
  assertEquals(await status(claimed), { kind: "pending" });

  // success of this attempt
  const db = bindDb({ oauth_states: [{ state_hash: HASH, company_id: C1, user_id: U1, used_at: null, expires_at: iso(20 * 60_000) }] });
  await bindUnipileAccount(asClient(db), "account.add", addEvent("acc_new"), false, unipileDeps(recorder()));
  assertEquals(await status(db), { kind: "connected", email: "acc_new@foretag.se", provider: "google" });

  // another user or company never sees it
  assertEquals((await unipileFinishStatus(asClient(db), C2, U1, HASH)).kind, "error");

  // expired without a claim, or claimed long ago without an outcome
  assertEquals(await status(bindDb({ oauth_states: [{ state_hash: HASH, company_id: C1, user_id: U1, used_at: null, expires_at: iso(-1000) }] })), { kind: "error", status: 400, error: "Anslutningen har gått ut. Försök igen." });
  assertEquals((await status(bindDb({ oauth_states: [{ state_hash: HASH, company_id: C1, user_id: U1, used_at: iso(-40 * 60_000), expires_at: iso(-10 * 60_000) }] }))).kind, "error");
});
