import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { ActionLibrary } from "./actions.js";
import type { Domain } from "./types.js";

export interface PlanStep {
  actionId: string;
  params: Record<string, unknown>;
}

export interface Plan {
  ruleId: string;
  domain: Domain;
  cause: string;
  steps: readonly PlanStep[];
  stopConditions: readonly string[];
  /** Tier 0 plans cite a rule; Tier 1 plans will cite claims instead. */
  chosenBy: "tier0_playbook";
}

export interface Playbook {
  domain: Domain;
  cause: string;
  ruleId: string;
  steps: readonly PlanStep[];
  stopConditions: readonly string[];
}

export class PlaybookTable {
  readonly version: number;
  readonly #byKey: ReadonlyMap<string, Playbook>;

  constructor(version: number, playbooks: readonly Playbook[]) {
    this.version = version;
    this.#byKey = new Map(playbooks.map((p) => [`${p.domain}::${p.cause}`, p]));
  }

  /**
   * Falls back from a domain-specific playbook to the cause's cross-domain
   * default. Without the fallback the table has to enumerate the full
   * domain x cause cross product, and every gap silently escalates a case the
   * taxonomy had already resolved — which inflates Tier 1 with cases the model
   * adds nothing to.
   *
   * Null still means no default plan exists at all, and the case escalates
   * rather than improvising.
   */
  planFor(domain: Domain, cause: string): Plan | null {
    const pb = this.#byKey.get(`${domain}::${cause}`) ?? this.#byKey.get(`*::${cause}`);
    if (!pb) return null;
    return {
      ruleId: pb.ruleId,
      domain: pb.domain,
      cause: pb.cause,
      steps: pb.steps,
      stopConditions: pb.stopConditions,
      chosenBy: "tier0_playbook",
    };
  }

  has(domain: Domain, cause: string): boolean {
    return this.#byKey.has(`${domain}::${cause}`) || this.#byKey.has(`*::${cause}`);
  }

  all(): readonly Playbook[] {
    return [...this.#byKey.values()];
  }
}

interface RawPlaybook {
  domain: Domain;
  cause: string;
  rule_id: string;
  steps: { action: string; params?: Record<string, unknown> }[];
  stop_conditions?: string[];
}

/**
 * Validating against the action library at parse time is the point: a playbook
 * naming an action that does not exist, or one the library forbids, must fail
 * at load rather than at the connector during the demo.
 */
export function parsePlaybooks(source: string, library: ActionLibrary): PlaybookTable {
  const raw = parse(source) as { version: number; playbooks: RawPlaybook[] };
  const seen = new Set<string>();

  const playbooks = raw.playbooks.map((p): Playbook => {
    const key = `${p.domain}::${p.cause}`;
    if (seen.has(key)) throw new Error(`duplicate playbook: ${key}`);
    seen.add(key);
    if (p.steps.length === 0) throw new Error(`playbook ${key} has no steps`);

    const steps = p.steps.map((s): PlanStep => {
      library.get(s.action); // throws on unknown or forbidden
      return { actionId: s.action, params: s.params ?? {} };
    });
    return {
      domain: p.domain,
      cause: p.cause,
      ruleId: p.rule_id,
      steps,
      stopConditions: p.stop_conditions ?? [],
    };
  });
  return new PlaybookTable(raw.version, playbooks);
}

export const loadPlaybooks = (path: string, library: ActionLibrary): PlaybookTable =>
  parsePlaybooks(readFileSync(path, "utf8"), library);
