import type { CapabilityToken, Clock } from "@rra/core";
import type {
  AdapterCall,
  CallResult,
  CapabilityName,
  PaymentStatus,
  PSPAdapter,
} from "./adapter.js";

/**
 * Latent state the engine never sees. This is what makes the simulation an
 * asset rather than a mock: because the simulator knows who would have paid
 * anyway, it can compute true incremental recovery and validate the holdout
 * estimator against it.
 */
export interface LatentCustomer {
  hasFundsAfterMs: number;
  cardExpired: boolean;
  mandateState: "active" | "paused" | "revoked";
  respondsToLink: number;
  /** The natural-recovery flag: would have paid with no intervention at all. */
  willPayRegardless: boolean;
}

export const DEFAULT_LATENT: LatentCustomer = {
  hasFundsAfterMs: 0,
  cardExpired: false,
  mandateState: "active",
  respondsToLink: 0.35,
  willPayRegardless: false,
};

/** Seeded, so a replayed batch samples identically. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL: CapabilityName[] = [
  "createPaymentLink",
  "resumeCheckout",
  "requestPaymentMethodUpdate",
  "sendApprovedTemplate",
  "createOpsEscalation",
  "fetchPaymentStatus",
];

export class SimulatedPSP implements PSPAdapter {
  readonly name = "SimulatedPSP";
  readonly surface = "simulated" as const;

  /** Records what each idem_key did, so reconciliation can answer truthfully. */
  readonly #settled = new Map<string, PaymentStatus>();
  #rand: () => number;

  constructor(
    private readonly clock: Clock,
    private readonly latent: Map<string, LatentCustomer> = new Map(),
    seed = 20260902,
  ) {
    this.#rand = mulberry32(seed);
  }

  capabilities(): ReadonlySet<CapabilityName> {
    return new Set(ALL);
  }

  latentFor(customerId: string): LatentCustomer {
    return this.latent.get(customerId) ?? DEFAULT_LATENT;
  }

  /**
   * The simulator's own conversion model.
   *
   * These rates are authored here and are deliberately NOT the p_recover priors
   * in actions/library.yaml. The library holds what the agent *believes*; this
   * holds what the world actually does. If they were the same table the
   * optimizer would be scoring against its own answer key, and the recovery
   * number would be circular — so the gap between them is the optimizer's
   * regret, and it is meant to exist.
   */
  #convert(call: AdapterCall, capability: string): boolean {
    const latent = this.latentFor(call.customerId);
    const fundsAvailable = this.clock.now().getTime() >= latent.hasFundsAfterMs;
    const draw = this.#rand();

    switch (capability) {
      case "createPaymentLink":
        // A link cannot work without funds, and not on a dead instrument.
        if (!fundsAvailable || latent.cardExpired || latent.mandateState === "revoked") return false;
        return draw < latent.respondsToLink;

      case "requestPaymentMethodUpdate":
        // The one action that addresses a dead instrument at its root, so it
        // converts best exactly where a link cannot work at all.
        if (latent.cardExpired || latent.mandateState === "revoked") return draw < 0.42;
        return draw < 0.12;

      case "sendApprovedTemplate":
        // A nudge only helps someone who could already have paid.
        if (!fundsAvailable || latent.cardExpired || latent.mandateState === "revoked") return false;
        return draw < 0.16;

      case "resumeCheckout":
        return fundsAvailable && draw < 0.24;

      case "createOpsEscalation":
        // A human works the case, and is effective across causes.
        return draw < 0.27;

      default:
        return false;
    }
  }

  #record(call: AdapterCall, capability: string, prefix: string): CallResult {
    const paid = this.#convert(call, capability);
    const reference = `${prefix}_${call.idemKey.slice(0, 10)}`;
    this.#settled.set(call.idemKey, {
      found: true,
      captured: paid,
      amountPaise: Number(call.params["amount"] ?? 0),
      reference,
    });
    const latent = this.latentFor(call.customerId);
    return {
      ok: true,
      reference,
      detail: {
        paid,
        fundsAvailable: this.clock.now().getTime() >= latent.hasFundsAfterMs,
        capability,
      },
    };
  }

  async createPaymentLink(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    return this.#record(call, "createPaymentLink", "sim_link");
  }

  async resumeCheckout(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    return this.#record(call, "resumeCheckout", "sim_checkout");
  }

  async requestPaymentMethodUpdate(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    return this.#record(call, "requestPaymentMethodUpdate", "sim_update");
  }

  async sendApprovedTemplate(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    const res = this.#record(call, "sendApprovedTemplate", "sim_msg");
    return {
      ...res,
      detail: { ...res.detail, delivered: true, channel: call.params["channel"], template: call.params["template_id"] },
    };
  }

  async createOpsEscalation(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    const res = this.#record(call, "createOpsEscalation", "sim_esc");
    return { ...res, detail: { ...res.detail, queue: call.params["queue"] } };
  }

  /**
   * The reconciliation answer. A key the simulator has seen returns its real
   * outcome — which is what stops a crashed executor from re-issuing the call.
   */
  async fetchPaymentStatus(idemKey: string): Promise<PaymentStatus> {
    return this.#settled.get(idemKey) ?? { found: false, captured: false };
  }

  /** Test seam: pretend a call landed at the provider before the crash. */
  seedSettled(idemKey: string, status: PaymentStatus): void {
    this.#settled.set(idemKey, status);
  }
}
