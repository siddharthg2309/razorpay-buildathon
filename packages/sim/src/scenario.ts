import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Domain, Rail } from "@rra/core";

export interface Injection {
  atHours: number;
  type: "gateway_degradation";
  segment: Record<string, string>;
  approvalDrop: number;
  durationMinutes: number;
}

export interface Scenario {
  seed: number;
  merchant: string;
  size: number;
  domains: Record<Domain, number>;
  rails: Record<Rail, number>;
  causes: Record<string, number>;
  valueDistribution: { mu: number; sigma: number };
  world: {
    naturalRecoveryRate: number;
    respondsToLink: number;
    fundsClearAfterHours: number;
    optOutRate: number;
    disputeRate: number;
    replyRate: number;
    replyIntents: Record<string, number>;
  };
  holdout: number;
  windowDays: number;
  naturalRecoveryWindowMs: number;
  injections: Injection[];
}

const sums = (d: Record<string, number>): number =>
  Object.values(d).reduce((a, b) => a + b, 0);

export function parseScenario(source: string): Scenario {
  const raw = parse(source) as Record<string, never>;
  const cohort = raw["cohort"] as unknown as {
    size: number;
    domains: Record<Domain, number>;
    rails: Record<Rail, number>;
    causes: Record<string, number>;
    value_distribution: { mu: number; sigma: number };
  };
  const world = raw["world"] as unknown as Record<string, number | Record<string, number>>;
  const measurement = raw["measurement"] as unknown as Record<string, number>;

  // A distribution that does not sum to 1 silently reweights the cohort, so it
  // fails at load instead.
  for (const [name, dist] of [
    ["domains", cohort.domains],
    ["rails", cohort.rails],
    ["causes", cohort.causes],
  ] as const) {
    const total = sums(dist as Record<string, number>);
    if (Math.abs(total - 1) > 1e-6) {
      throw new Error(`scenario ${name} distribution sums to ${total}, expected 1`);
    }
  }

  return {
    seed: raw["seed"] as unknown as number,
    merchant: raw["merchant"] as unknown as string,
    size: cohort.size,
    domains: cohort.domains,
    rails: cohort.rails,
    causes: cohort.causes,
    valueDistribution: cohort.value_distribution,
    world: {
      naturalRecoveryRate: world["natural_recovery_rate"] as number,
      respondsToLink: world["responds_to_link"] as number,
      fundsClearAfterHours: world["funds_clear_after_hours"] as number,
      optOutRate: world["opt_out_rate"] as number,
      disputeRate: world["dispute_rate"] as number,
      replyRate: (world["reply_rate"] as unknown as number) ?? 0,
      replyIntents: (world["reply_intents"] as unknown as Record<string, number>) ?? {},
    },
    holdout: raw["holdout"] as unknown as number,
    windowDays: measurement["window_days"]!,
    naturalRecoveryWindowMs: measurement["natural_recovery_window_minutes"]! * 60_000,
    injections: ((raw["injections"] ?? []) as unknown as Record<string, never>[]).map((i) => ({
      atHours: i["at_hours"] as unknown as number,
      type: "gateway_degradation" as const,
      segment: i["segment"] as unknown as Record<string, string>,
      approvalDrop: i["approval_drop"] as unknown as number,
      durationMinutes: i["duration_minutes"] as unknown as number,
    })),
  };
}

export const loadScenario = (path: string): Scenario => parseScenario(readFileSync(path, "utf8"));
