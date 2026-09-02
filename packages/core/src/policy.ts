import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Rail } from "./types.js";

export interface ContactCap {
  channel: string;
  windowDays: number;
  max: number;
}

export interface Policy {
  version: string;
  merchant: string;
  quietHours: { start: string; end: string; timezone: string };
  contactCaps: readonly ContactCap[];
  maxAttemptsPerCase: number;
  requireApprovalAbovePaise: number;
  allowedActions: Readonly<Record<string, readonly string[]>>;
}

/** Stable rule ids — every decision cites one, and the ledger stores it. */
export const RULES = {
  ACTION_NOT_ALLOWED_ON_RAIL: "R-102",
  RETRY_CAP: "R-201",
  QUIET_HOURS: "R-207",
  CONTACT_BUDGET: "R-208",
  AMOUNT_APPROVAL: "R-301",
  OPTED_OUT: "R-401",
  ALLOWED: "R-500",
} as const;

export type RuleId = (typeof RULES)[keyof typeof RULES];

export interface PolicyDecision {
  outcome: "allow" | "block" | "require_approval";
  ruleId: RuleId;
  reason: string;
  policyVersion: string;
}

/**
 * Hour-of-day in the policy's timezone. Quiet hours are a legal constraint in
 * the customer's jurisdiction, so evaluating them against server-local time
 * would be wrong everywhere the server is not in India.
 */
export function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

export function inQuietHours(at: Date, policy: Policy): boolean {
  const now = localMinutes(at, policy.quietHours.timezone);
  const start = toMinutes(policy.quietHours.start);
  const end = toMinutes(policy.quietHours.end);
  // Quiet hours normally wrap midnight (21:00 -> 09:00), so the window is the
  // union of two ranges rather than a simple between.
  return start > end ? now >= start || now < end : now >= start && now < end;
}

export function capFor(policy: Policy, channel: string): ContactCap | undefined {
  return policy.contactCaps.find((c) => c.channel === channel);
}

export function globalCap(policy: Policy): ContactCap | undefined {
  return policy.contactCaps.find((c) => c.channel === "*");
}

export function actionAllowedOnRail(policy: Policy, rail: Rail, actionId: string): boolean {
  return (policy.allowedActions[rail] ?? []).includes(actionId);
}

export function parsePolicy(source: string): Policy {
  const raw = parse(source) as {
    version: string;
    merchant: string;
    quiet_hours: { start: string; end: string; timezone: string };
    contact_caps: { channel: string; window_days: number; max: number }[];
    retry_caps: { max_attempts_per_case: number };
    amount_thresholds: { require_approval_above_paise: number };
    allowed_actions: Record<string, string[]>;
  };
  return {
    version: raw.version,
    merchant: raw.merchant,
    quietHours: raw.quiet_hours,
    contactCaps: raw.contact_caps.map((c) => ({
      channel: c.channel,
      windowDays: c.window_days,
      max: c.max,
    })),
    maxAttemptsPerCase: raw.retry_caps.max_attempts_per_case,
    requireApprovalAbovePaise: raw.amount_thresholds.require_approval_above_paise,
    allowedActions: raw.allowed_actions,
  };
}

export const loadPolicy = (path: string): Policy => parsePolicy(readFileSync(path, "utf8"));
