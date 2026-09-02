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

  async createPaymentLink(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    const latent = this.latentFor(call.customerId);
    const fundsAvailable = this.clock.now().getTime() >= latent.hasFundsAfterMs;
    const paid = fundsAvailable && !latent.cardExpired && this.#rand() < latent.respondsToLink;
    const reference = `sim_link_${call.idemKey.slice(0, 10)}`;
    this.#settled.set(call.idemKey, {
      found: true,
      captured: paid,
      amountPaise: Number(call.params["amount"] ?? 0),
      reference,
    });
    return { ok: true, reference, detail: { paid, fundsAvailable } };
  }

  async resumeCheckout(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    const resumed = this.#rand() < this.latentFor(call.customerId).respondsToLink;
    const reference = `sim_checkout_${call.idemKey.slice(0, 10)}`;
    this.#settled.set(call.idemKey, { found: true, captured: resumed, reference });
    return { ok: true, reference, detail: { resumed } };
  }

  async requestPaymentMethodUpdate(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    const latent = this.latentFor(call.customerId);
    // A revoked mandate is exactly the case where an update request is the only
    // path, so it succeeds more often than the generic link response rate.
    const updated = this.#rand() < (latent.mandateState === "revoked" ? 0.44 : latent.respondsToLink);
    const reference = `sim_update_${call.idemKey.slice(0, 10)}`;
    this.#settled.set(call.idemKey, { found: true, captured: false, reference });
    return { ok: true, reference, detail: { updated } };
  }

  async sendApprovedTemplate(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    const reference = `sim_msg_${call.idemKey.slice(0, 10)}`;
    this.#settled.set(call.idemKey, { found: true, captured: false, reference });
    return {
      ok: true,
      reference,
      detail: { delivered: true, channel: call.params["channel"], template: call.params["template_id"] },
    };
  }

  async createOpsEscalation(call: AdapterCall, _t: CapabilityToken): Promise<CallResult> {
    const reference = `sim_esc_${call.idemKey.slice(0, 10)}`;
    this.#settled.set(call.idemKey, { found: true, captured: false, reference });
    return { ok: true, reference, detail: { queue: call.params["queue"] } };
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
