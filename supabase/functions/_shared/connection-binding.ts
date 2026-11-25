// Binding a mailbox connection (Nylas grant or Unipile account) to a company, and the one revoke rule, shared by
// nylas-connect (Nylas finish, disconnect) and nylas-webhook (Unipile account.add / account.reconnect).
// Unit tested in connection_binding_test.ts with the fake database from test-db.ts.
//
// Revoke rule (every path): a connection id that is still referenced by ANY email_connections row is never revoked or
// deleted; a failed lookup counts as referenced. The old id of a replaced connection is revoked only after the new row
// is saved (it is then no longer referenced). Disconnect removes its own reference, so only other companies count there.
//
// Outcome for /epost-klar: bindConnection writes the audit event "E-post ansluten" or "E-post anslutning misslyckades"
// with { state: <first 16 hex of the state hash> }, so finish reports the result of THIS attempt, never an older
// connection. Never logs addresses, ids or provider bodies: short codes only.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";
import { type ProviderName, revokeConnection } from "./mail-provider.ts";
import { sha256Hex } from "./nylas.ts";
import * as unipile from "./unipile.ts";

export type AccountEventType = "account.add" | "account.reconnect";
export type BindFailureAction = "delete" | "retry" | "ignore";

export const BIND_OK_EVENT = "E-post ansluten";
export const BIND_FAILED_EVENT = "E-post anslutning misslyckades";
/** Short failure codes stored on the failure event; /epost-klar turns them into a Swedish text. */
export type BindFailureCode = "bound_elsewhere" | "save_failed" | "unsupported_account" | "not_allowed";

const UNIQUE_VIOLATION = "23505";
/** A state used this recently may belong to a binding that is still running (or retrying) for the same event. */
export const STATE_IN_FLIGHT_MS = 2 * 60_000;

/** The value stored in audit_log.after.state: enough to find this attempt, not enough to use the state. */
export const stateTag = (stateHash: string): string => stateHash.slice(0, 16);

/* ---------- Pure decisions ---------- */

/**
 * What to do when saving the connection failed (or the lookup before it). `accountKnown` = the id is referenced by an
 * email_connections row (or that could not be checked). Never deletes a reconnect (the company's live account) or a
 * known id.
 *  - unique violation (the id is bound elsewhere): delete a new, unknown id; otherwise leave it.
 *  - any other error: retry (the caller releases the state first); only a new, unknown id on the last attempt is
 *    deleted, so an unbound account does not keep reading the mailbox and being billed.
 */
export function bindFailureAction(args: { type: AccountEventType; errorCode: string | null | undefined; isLastAttempt: boolean; accountKnown: boolean }): BindFailureAction {
  const deletable = args.type === "account.add" && !args.accountKnown;
  if (args.errorCode === UNIQUE_VIOLATION) return deletable ? "delete" : "ignore";
  return deletable && args.isLastAttempt ? "delete" : "retry";
}

type StateRow = { used_at: string | null; expires_at: string };

/**
 * The state was claimed less than STATE_IN_FLIGHT_MS ago and that binding has not recorded an outcome yet: a binding
 * for it may still be saving, so no account may be deleted because of it.
 */
export function stateInFlight(args: { stateRow: StateRow; bindDone: boolean; now?: number }): boolean {
  const usedAt = args.stateRow.used_at ? Date.parse(args.stateRow.used_at) : NaN;
  return !Number.isNaN(usedAt) && (args.now ?? Date.now()) - usedAt < STATE_IN_FLIGHT_MS && !args.bindDone;
}

/**
 * What to do with an account whose state could not be claimed. `stateRow` = our oauth_states row (null: no row at all,
 * it may belong to another environment, so never touch it). `bindDone` = the binding that claimed the state has
 * recorded its outcome event. A new account (account.add) that is not referenced and whose state is expired or used
 * is an orphan and is deleted: Unipile created it, it reads the whole mailbox and is billed.
 * While the state is in flight nothing is deleted: retry (the binding may finish meanwhile, then a second account
 * created with the same state is deleted), and on the last attempt keep it ("ignore", logged by the caller).
 */
export function orphanAction(args: { type: AccountEventType; stateRow: StateRow | null; accountKnown: boolean; bindDone: boolean; isLastAttempt: boolean; now?: number }): BindFailureAction {
  if (!args.stateRow || args.type !== "account.add" || args.accountKnown) return "ignore";
  const now = args.now ?? Date.now();
  const used = Boolean(args.stateRow.used_at);
  const expired = !(Date.parse(args.stateRow.expires_at) > now);
  if (!used && !expired) return "ignore"; // still claimable: not an orphan
  if (stateInFlight({ stateRow: args.stateRow, bindDone: args.bindDone, now })) return args.isLastAttempt ? "ignore" : "retry";
  return "delete";
}

/* ---------- Database helpers ---------- */

/** Whether any email_connections row references the id (optionally ignoring one company). */
async function referenceState(db: SupabaseClient, connectionId: string, opts: { exceptCompany?: string | undefined }): Promise<"referenced" | "free" | "unknown"> {
  let q = db.from("email_connections").select("company_id").eq("grant_id", connectionId);
  if (opts.exceptCompany) q = q.neq("company_id", opts.exceptCompany);
  const res = await q.limit(1).maybeSingle();
  return res.error ? "unknown" : res.data ? "referenced" : "free";
}

/** Whether any email_connections row references the id (optionally ignoring one company). A failed lookup counts as referenced. */
export async function isReferenced(db: SupabaseClient, connectionId: string, opts: { exceptCompany?: string | undefined } = {}): Promise<boolean> {
  return (await referenceState(db, connectionId, opts)) !== "free";
}

export type Revoke = (connectionId: string) => Promise<boolean>;
export type RevokeResult = "revoked" | "referenced" | "lookup_failed" | "revoke_failed";

/**
 * The one revoke path: revokes/deletes the id at its provider only when no email_connections row references it
 * (with `exceptCompany`: no row of another company, used by disconnect, which removes its own reference).
 */
export async function revokeIfUnreferenced(db: SupabaseClient, connectionId: string, revoke: Revoke = revokeConnection, opts: { exceptCompany?: string | undefined } = {}): Promise<RevokeResult> {
  const ref = await referenceState(db, connectionId, opts);
  if (ref !== "free") { console.info("[mail] connection kept:", ref === "unknown" ? "lookup_failed" : "referenced"); return ref === "unknown" ? "lookup_failed" : "referenced"; }
  if (await revoke(connectionId)) return "revoked";
  console.error("[mail] revoke failed");
  return "revoke_failed";
}

/** Writes the outcome event /epost-klar looks for. */
export async function recordBindOutcome(db: SupabaseClient, args: { companyId: string; userId: string; stateHash?: string | undefined; ok: true; provider: string } | { companyId: string; userId: string; stateHash?: string | undefined; ok: false; code: BindFailureCode }): Promise<void> {
  const state = args.stateHash ? { state: stateTag(args.stateHash) } : {};
  const res = await db.from("audit_log").insert(args.ok
    ? { company_id: args.companyId, user_id: args.userId, event: BIND_OK_EVENT, after: { provider: args.provider, ...state } }
    : { company_id: args.companyId, user_id: args.userId, event: BIND_FAILED_EVENT, after: { code: args.code, ...state } });
  if (res.error) console.error("[mail] could not record bind outcome:", res.error.code ?? "unknown");
}

/** Whether the binding for this state has recorded its outcome (success or failure). A failed lookup counts as not done. */
export async function bindOutcomeRecorded(db: SupabaseClient, companyId: string, stateHash: string): Promise<boolean> {
  const res = await db.from("audit_log").select("id").eq("company_id", companyId).in("event", [BIND_OK_EVENT, BIND_FAILED_EVENT])
    .contains("after", { state: stateTag(stateHash) }).limit(1).maybeSingle();
  return !res.error && Boolean(res.data);
}

/** The company is still active and the user still an owner of it (checked again when the webhook binds, up to 30 min later). null = lookup failed. */
export async function ownerStillAllowed(db: SupabaseClient, companyId: string, userId: string): Promise<boolean | null> {
  const [company, member] = await Promise.all([
    db.from("companies").select("active").eq("id", companyId).maybeSingle(),
    db.from("company_members").select("role").eq("company_id", companyId).eq("user_id", userId).maybeSingle(),
  ]);
  if (company.error || member.error) return null;
  return company.data?.active === true && member.data?.role === "ägare";
}

/** The Swedish text /epost-klar shows for a recorded failure code. */
export function bindFailureText(code: unknown): string {
  if (code === "bound_elsewhere") return "Mejllådan är redan kopplad till ett annat företag.";
  if (code === "unsupported_account") return "Det här kontot stöds inte.";
  if (code === "not_allowed") return "Bara ägare kan koppla e-post.";
  return "Kunde inte slutföra anslutningen. Försök igen.";
}

/* ---------- Binding ---------- */

export interface BindInput {
  providerName: ProviderName;
  companyId: string; userId: string;
  connectionId: string;            // Nylas grant id or Unipile account id
  email: string; mailProvider: string; // from the provider with our key, never from the browser or the event
  isNew: boolean;                  // account.add (Unipile) or a Nylas code exchange; false for account.reconnect
  isLastAttempt: boolean;          // Nylas finish has no retries, so always true there
  stateHash?: string | undefined;
  lastEventAt?: string | undefined;  // Unipile stores the event time; Nylas never did
}
export type BindResult =
  | { status: "saved" }
  | { status: "failed"; stage: "lookup" | "save"; action: BindFailureAction; boundElsewhere: boolean };

/**
 * Saves the connection as the company's mailbox. On failure decides (bindFailureAction) and performs a delete of the
 * new id; the caller handles "retry" (Unipile: release the state and retry; Nylas: an error answer). After a save the
 * replaced id is revoked if nothing references it any more. Writes the outcome event when the outcome is final.
 */
export async function bindConnection(db: SupabaseClient, input: BindInput, revoke: Revoke = revokeConnection): Promise<BindResult> {
  const { companyId, userId, connectionId, stateHash } = input;
  const type: AccountEventType = input.isNew ? "account.add" : "account.reconnect";

  const fail = async (stage: "lookup" | "save", errorCode: string | null | undefined): Promise<BindResult> => {
    const action = bindFailureAction({ type, errorCode, isLastAttempt: input.isLastAttempt, accountKnown: await isReferenced(db, connectionId) });
    const boundElsewhere = await isReferenced(db, connectionId, { exceptCompany: companyId });
    console.error(`[${input.providerName}] could not save connection:`, stage, errorCode ?? "unknown", action);
    if (action === "delete") await revokeIfUnreferenced(db, connectionId, revoke);
    if (action !== "retry" || input.isLastAttempt) {
      await recordBindOutcome(db, { companyId, userId, stateHash, ok: false, code: boundElsewhere ? "bound_elsewhere" : "save_failed" });
    }
    return { status: "failed", stage, action, boundElsewhere };
  };

  const existing = await db.from("email_connections").select("grant_id").eq("company_id", companyId).maybeSingle();
  if (existing.error) return await fail("lookup", existing.error.code);

  const saved = await db.from("email_connections").upsert({
    company_id: companyId, grant_id: connectionId, email: input.email, provider: input.mailProvider, status: "active",
    watch_address: input.email, connected_by: userId, ...(input.lastEventAt ? { last_event_at: input.lastEventAt } : {}),
  }, { onConflict: "company_id" });
  if (saved.error) return await fail("save", saved.error.code);

  const oldId = existing.data?.grant_id as string | undefined;
  if (oldId && oldId !== connectionId) await revokeIfUnreferenced(db, oldId, revoke);
  await recordBindOutcome(db, { companyId, userId, stateHash, ok: true, provider: input.mailProvider });
  return { status: "saved" };
}

/* ---------- Unipile: account.add / account.reconnect (called by nylas-webhook) ---------- */

export interface UnipileBindDeps {
  getAccount: (accountId: string) => Promise<{ email: string; provider: string }>;
  revoke: Revoke;
}
const defaultUnipileDeps: UnipileBindDeps = { getAccount: (id) => unipile.getAccount(id), revoke: revokeConnection };
export interface BindOutcome { retry?: boolean }

/**
 * Binds a newly linked (or re-linked) Unipile account to the company that started the link, through our single-use
 * state. The provider and address come from Unipile with our key, never from the event or the browser.
 */
export async function bindUnipileAccount(db: SupabaseClient, type: AccountEventType, payload: Record<string, unknown>, isLastAttempt: boolean, deps: UnipileBindDeps = defaultUnipileDeps): Promise<BindOutcome> {
  const ref = unipile.accountEventOf(payload);
  if (!ref) return {};
  if (!ref.state) { console.info("[unipile] account event without our state"); return {}; } // linked elsewhere: not ours to touch
  const stateHash = await sha256Hex(ref.state);
  const nowIso = new Date().toISOString();

  const pending = await db.from("oauth_states").select("company_id,user_id").eq("state_hash", stateHash).is("used_at", null).gt("expires_at", nowIso).maybeSingle();
  if (pending.error) return { retry: true };
  if (!pending.data) return await handleUnclaimable(db, type, stateHash, ref.accountId, isLastAttempt, deps);
  const { company_id: companyId, user_id: userId } = pending.data as { company_id: string; user_id: string };
  const refuse = async (code: BindFailureCode): Promise<BindOutcome> => {
    await claimState(db, stateHash); // used: the link cannot bind anything later
    if (type === "account.add") await revokeIfUnreferenced(db, ref.accountId, deps.revoke);
    await recordBindOutcome(db, { companyId, userId, stateHash, ok: false, code });
    console.info("[unipile] account refused:", code);
    return {};
  };

  // Up to 30 minutes may have passed since start: the company and the owner must still be allowed.
  const allowed = await ownerStillAllowed(db, companyId, userId);
  if (allowed === null) return { retry: true };
  if (!allowed) return await refuse("not_allowed");

  let account: { email: string; provider: string };
  try { account = await deps.getAccount(ref.accountId); }
  catch (e) {
    const code = e instanceof Error ? e.message : "";
    if (code === "unipile_unsupported_account" || code === "unipile_no_email") return await refuse("unsupported_account");
    return { retry: true };
  }

  // Single use: only the first event for this state may bind. A second event (a duplicate delivery, or a second
  // account created with the same link) is handled as unclaimable, so a second account is not left behind.
  const claimedAt = await claimState(db, stateHash);
  if (!claimedAt) return await handleUnclaimable(db, type, stateHash, ref.accountId, isLastAttempt, deps);

  const result = await bindConnection(db, {
    providerName: "unipile", companyId, userId, connectionId: ref.accountId, email: account.email, mailProvider: account.provider,
    isNew: type === "account.add", isLastAttempt, stateHash, lastEventAt: nowIso,
  }, deps.revoke);
  if (result.status === "failed" && result.action === "retry" && !isLastAttempt) { await unclaimState(db, stateHash, claimedAt); return { retry: true }; }
  return {};
}

/** The state is unknown, used or expired: remove an orphaned new account, otherwise only log. */
async function handleUnclaimable(db: SupabaseClient, type: AccountEventType, stateHash: string, accountId: string, isLastAttempt: boolean, deps: UnipileBindDeps): Promise<BindOutcome> {
  const row = await db.from("oauth_states").select("company_id,used_at,expires_at").eq("state_hash", stateHash).maybeSingle();
  if (row.error) return { retry: true };
  if (!row.data) { console.info("[unipile] unknown state"); return {}; } // may belong to another environment
  const stateRow = row.data as { company_id: string; used_at: string | null; expires_at: string };
  const bindDone = stateRow.used_at ? await bindOutcomeRecorded(db, stateRow.company_id, stateHash) : false;
  const accountKnown = await isReferenced(db, accountId);
  const action = orphanAction({ type, stateRow, accountKnown, bindDone, isLastAttempt });
  if (action === "retry") return { retry: true };
  if (action === "delete") {
    if (await revokeIfUnreferenced(db, accountId, deps.revoke) === "revoked") console.info("[unipile] orphan account removed");
    return {};
  }
  if (type === "account.add" && !accountKnown && stateInFlight({ stateRow, bindDone })) console.info("[unipile] orphan kept: state in flight");
  else console.info("[unipile] used or expired state");
  return {};
}

/** Claims the state; returns the used_at timestamp that was set, or null when it could not be claimed. */
async function claimState(db: SupabaseClient, stateHash: string): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const claimed = await db.from("oauth_states").update({ used_at: nowIso }).eq("state_hash", stateHash).is("used_at", null).gt("expires_at", nowIso).select("state_hash").maybeSingle();
  return !claimed.error && claimed.data ? nowIso : null;
}

/** Gives the state back after a transient failure, so a retry can bind. Only our own claim is undone. */
async function unclaimState(db: SupabaseClient, stateHash: string, claimedAt: string): Promise<void> {
  const res = await db.from("oauth_states").update({ used_at: null }).eq("state_hash", stateHash).eq("used_at", claimedAt);
  if (res.error) console.error("[unipile] could not release state:", res.error.code ?? "unknown");
}

/* ---------- nylas-connect: finish (Unipile) and disconnect ---------- */

/** Extra time after the state expires for a binding that claimed it just before (the webhook retries for 25 s). */
const FINISH_GRACE_MS = STATE_IN_FLIGHT_MS;

export type FinishStatus =
  | { kind: "connected"; email: string; provider: string }
  | { kind: "pending" }
  | { kind: "error"; status: number; error: string };

/**
 * How far a Unipile link has come, for the user and company that started it. Success only when THIS state's success
 * event exists, so a failed switch never shows the old mailbox as connected.
 */
export async function unipileFinishStatus(db: SupabaseClient, companyId: string, userId: string, stateHash: string, now = Date.now()): Promise<FinishStatus> {
  const row = await db.from("oauth_states").select("used_at,expires_at").eq("state_hash", stateHash).eq("user_id", userId).eq("company_id", companyId).maybeSingle();
  if (row.error) return { kind: "error", status: 500, error: "Något gick fel. Försök igen." };
  if (!row.data) return { kind: "error", status: 400, error: "Anslutningen är ogiltig. Försök igen." };
  const expiresAt = Date.parse(row.data.expires_at as string);
  if (!row.data.used_at) return expiresAt > now ? { kind: "pending" } : { kind: "error", status: 400, error: "Anslutningen har gått ut. Försök igen." };

  const events = await db.from("audit_log").select("event,after").eq("company_id", companyId).in("event", [BIND_OK_EVENT, BIND_FAILED_EVENT])
    .contains("after", { state: stateTag(stateHash) }).limit(5);
  if (events.error) return { kind: "error", status: 500, error: "Något gick fel. Försök igen." };
  const list = (events.data ?? []) as { event: string; after: Record<string, unknown> | null }[];
  if (list.some((e) => e.event === BIND_OK_EVENT)) {
    const conn = await db.from("email_connections").select("email,provider,status").eq("company_id", companyId).maybeSingle();
    if (conn.error) return { kind: "error", status: 500, error: "Något gick fel. Försök igen." };
    if (!conn.data || conn.data.status !== "active") return { kind: "error", status: 409, error: bindFailureText(null) };
    return { kind: "connected", email: conn.data.email as string, provider: conn.data.provider as string };
  }
  const failed = list.find((e) => e.event === BIND_FAILED_EVENT);
  if (failed) return { kind: "error", status: 409, error: bindFailureText(failed.after?.code) };
  // Claimed, no outcome yet: the webhook is still saving or retrying.
  return expiresAt + FINISH_GRACE_MS > now ? { kind: "pending" } : { kind: "error", status: 409, error: bindFailureText(null) };
}

export type DisconnectResult = { ok: true } | { ok: false; status: 502; error: string };

/**
 * Disconnects the company's mailbox. The provider must confirm the revoke (2xx or 404), otherwise nothing changes and
 * the owner is asked to try again. An id another company still references is not revoked (only our row is dropped).
 */
export async function disconnectConnection(db: SupabaseClient, companyId: string, userId: string, revoke: Revoke = revokeConnection): Promise<DisconnectResult> {
  const conn = await db.from("email_connections").select("grant_id").eq("company_id", companyId).maybeSingle();
  if (!conn.data) return { ok: true };
  const result = await revokeIfUnreferenced(db, conn.data.grant_id as string, revoke, { exceptCompany: companyId });
  if (result === "lookup_failed" || result === "revoke_failed") {
    console.error("[mail] disconnect failed:", result);
    return { ok: false, status: 502, error: "Kunde inte koppla från hos leverantören. Försök igen." };
  }
  await db.from("email_connections").update({ status: "revoked" }).eq("company_id", companyId);
  await db.from("audit_log").insert({ company_id: companyId, user_id: userId, event: "E-post frånkopplad" });
  return { ok: true };
}
