// Flood guard decisions for received mail (pure, unit tested in mail_flood_test.ts).
// EMAIL_FLOOD_GUARD_V2 (default off) changes the guard so a flood never loses real mail:
//  - per sender: above EMAIL_SENDER_HOURLY_CAP (10) customer mails in an hour, the mail is stored without AI, and at
//    EMAIL_SENDER_HOURLY_HARD_CAP (30) it is dropped, so one sender can never fill the company hard cap alone;
//  - per company: above EMAIL_INBOUND_HOURLY_CAP (60) the mail is stored without AI instead of dropped; only above
//    EMAIL_INBOUND_HOURLY_HARD_CAP (300) it is dropped, to protect storage;
//  - unknown senders (no open thread) may use at most AI_UNKNOWN_SENDER_SHARE (0.6) of AI_DAILY_CAP, so existing
//    customers keep AI even when strangers flood the inbox.
//  - a failed count is never read as 0: the company count retries the mail, the AI count means "no AI".
// With the flag off every function returns exactly what the pipeline did before.

import { optNumber } from "./nylas.ts";

export type FloodAction = "drop" | "store_no_ai" | "normal" | "retry";
export interface FloodCaps { companyCap: number; hardCap: number; senderCap: number; senderHardCap: number }

export const FLOOD_WARNING = "Många mejl på kort tid: AI hoppades över. Svara manuellt.";

export function floodGuardV2(): boolean {
  return Deno.env.get("EMAIL_FLOOD_GUARD_V2")?.trim().toLowerCase() === "true";
}

export function floodCaps(): FloodCaps {
  return {
    companyCap: optNumber("EMAIL_INBOUND_HOURLY_CAP", 60),
    hardCap: optNumber("EMAIL_INBOUND_HOURLY_HARD_CAP", 300),
    senderCap: optNumber("EMAIL_SENDER_HOURLY_CAP", 10),
    senderHardCap: optNumber("EMAIL_SENDER_HOURLY_HARD_CAP", 30),
  };
}

/**
 * Counts are the customer mails already received in the last hour (this sender / the whole company).
 * `companyCount` null = the count failed: with the flag a retry, without it 0 as before.
 */
export function floodDecision(args: { senderCount: number; companyCount: number | null; flag: boolean; caps?: FloodCaps }): FloodAction {
  const caps = args.caps ?? floodCaps();
  if (!args.flag) return (args.companyCount ?? 0) >= caps.companyCap ? "drop" : "normal"; // today's behaviour
  if (args.companyCount === null) return "retry";
  if (args.companyCount >= caps.hardCap || args.senderCount >= caps.senderHardCap) return "drop";
  if (args.senderCount >= caps.senderCap || args.companyCount >= caps.companyCap) return "store_no_ai";
  return "normal";
}

/** The daily AI budget for this mail. `known` = the sender has an open thread (undefined: not known yet). */
export function aiDailyCap(args: { known: boolean | undefined; flag: boolean; dailyCap?: number; unknownShare?: number }): number {
  const dailyCap = args.dailyCap ?? optNumber("AI_DAILY_CAP", 150);
  if (!args.flag || args.known !== false) return dailyCap;
  const share = Math.min(1, args.unknownShare ?? optNumber("AI_UNKNOWN_SENDER_SHARE", 0.6));
  return Math.floor(dailyCap * share);
}

/** Whether this mail may use AI. `used` = AI calls in the last 24 h, null when the count failed (with the flag: no AI). */
export function aiBudgetLeft(args: { used: number | null; known: boolean | undefined; flag: boolean; dailyCap?: number; unknownShare?: number }): boolean {
  if (args.used === null && args.flag) return false;
  return (args.used ?? 0) < aiDailyCap(args);
}
