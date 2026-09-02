import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Rail } from "./types.js";

/**
 * Loader for /actions/library.yaml. The library is a closed set: the optimizer
 * ranks entries from it and nothing else, and the policy engine will only mint
 * a capability token for an id that appears here.
 */

export type ActionKind = "capability" | "schedule";
export type ActionSurface = "live" | "simulated";

export interface ActionDef {
  id: string;
  kind: ActionKind;
  /** PSPAdapter method. Absent for schedule actions — they make no external call. */
  capability?: string;
  surface: ActionSurface;
  description: string;
  rails?: readonly Rail[];
  params: Record<string, unknown>;
  amountCapped: boolean;
  consumesContactBudget: boolean;
  quietHoursEnforced: boolean;
  requiresApproval: boolean;
  optimizerSelectable: boolean;
  actionCostPaise: number;
  pRecoverDefault: number | null;
  pRecoverByCause: Readonly<Record<string, number>>;
  stopConditions: readonly string[];
}

export interface ForbiddenActionDef {
  id: string;
  reason: string;
}

export class ForbiddenActionError extends Error {
  constructor(id: string, reason: string) {
    super(`action "${id}" is forbidden by the library: ${reason.trim()}`);
    this.name = "ForbiddenActionError";
  }
}

export class UnknownActionError extends Error {
  constructor(id: string) {
    super(`action "${id}" is not in the action library`);
    this.name = "UnknownActionError";
  }
}

export class ActionLibrary {
  readonly version: number;
  readonly #byId: ReadonlyMap<string, ActionDef>;
  readonly #forbidden: ReadonlyMap<string, ForbiddenActionDef>;

  constructor(version: number, actions: readonly ActionDef[], forbidden: readonly ForbiddenActionDef[]) {
    this.version = version;
    this.#byId = new Map(actions.map((a) => [a.id, a]));
    this.#forbidden = new Map(forbidden.map((f) => [f.id, f]));
  }

  /**
   * Resolve an id. A forbidden id fails here with its documented reason rather
   * than failing obscurely at the connector.
   */
  get(id: string): ActionDef {
    const forbidden = this.#forbidden.get(id);
    if (forbidden) throw new ForbiddenActionError(forbidden.id, forbidden.reason);
    const action = this.#byId.get(id);
    if (!action) throw new UnknownActionError(id);
    return action;
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** Sorted for prompt-prefix stability — an unsorted list invalidates the cache. */
  all(): readonly ActionDef[] {
    return [...this.#byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The optimizer's candidate set for a rail. */
  selectableForRail(rail: Rail): readonly ActionDef[] {
    return this.all().filter(
      (a) => a.optimizerSelectable && (a.rails === undefined || a.rails.includes(rail)),
    );
  }

  pRecover(id: string, cause: string): number {
    const a = this.get(id);
    return a.pRecoverByCause[cause] ?? a.pRecoverDefault ?? 0;
  }
}

interface RawAction {
  id: string;
  kind: ActionKind;
  capability?: string;
  surface?: ActionSurface;
  description?: string;
  rails?: Rail[];
  params?: Record<string, unknown>;
  amount_capped?: boolean;
  consumes_contact_budget?: boolean;
  quiet_hours_enforced?: boolean;
  requires_approval?: boolean;
  optimizer_selectable?: boolean;
  action_cost_paise?: number;
  p_recover?: { default?: number; by_cause?: Record<string, number> };
  stop_conditions?: string[];
}

export function parseActionLibrary(source: string): ActionLibrary {
  const raw = parse(source) as {
    version: number;
    defaults?: { requires_approval?: boolean; surface?: ActionSurface };
    actions: RawAction[];
    forbidden?: ForbiddenActionDef[];
  };

  const defaults = raw.defaults ?? {};
  const seen = new Set<string>();

  const actions = raw.actions.map((a): ActionDef => {
    if (seen.has(a.id)) throw new Error(`duplicate action id in library: ${a.id}`);
    seen.add(a.id);
    if (a.kind === "capability" && !a.capability) {
      throw new Error(`capability action "${a.id}" must name a PSPAdapter capability`);
    }
    if (a.kind === "schedule" && a.capability) {
      throw new Error(`schedule action "${a.id}" must not bind a capability — it makes no external call`);
    }
    return {
      id: a.id,
      kind: a.kind,
      ...(a.capability !== undefined ? { capability: a.capability } : {}),
      surface: a.surface ?? defaults.surface ?? "simulated",
      description: (a.description ?? "").trim(),
      ...(a.rails !== undefined ? { rails: a.rails } : {}),
      params: a.params ?? {},
      amountCapped: a.amount_capped ?? false,
      consumesContactBudget: a.consumes_contact_budget ?? false,
      quietHoursEnforced: a.quiet_hours_enforced ?? false,
      requiresApproval: a.requires_approval ?? defaults.requires_approval ?? false,
      optimizerSelectable: a.optimizer_selectable ?? true,
      actionCostPaise: a.action_cost_paise ?? 0,
      pRecoverDefault: a.p_recover?.default ?? null,
      pRecoverByCause: a.p_recover?.by_cause ?? {},
      stopConditions: a.stop_conditions ?? [],
    };
  });

  return new ActionLibrary(raw.version, actions, raw.forbidden ?? []);
}

export function loadActionLibrary(path: string): ActionLibrary {
  return parseActionLibrary(readFileSync(path, "utf8"));
}
