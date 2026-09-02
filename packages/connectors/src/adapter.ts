import type { CapabilityToken } from "@rra/core";

/**
 * Every capability the engine can exercise against the outside world. Two
 * implementations, chosen by config; the engine cannot tell them apart.
 *
 * Note what is absent and stays absent: no chargeRetry, no updateRouting, no
 * free-form sendMessage. Those are enforced in actions/library.yaml as well,
 * but an interface that cannot express them cannot grow them by accident.
 */
export type CapabilityName =
  | "createPaymentLink"
  | "resumeCheckout"
  | "requestPaymentMethodUpdate"
  | "sendApprovedTemplate"
  | "createOpsEscalation"
  | "fetchPaymentStatus";

export interface CallResult {
  ok: boolean;
  /** Provider-side identifier, when one exists. */
  reference?: string;
  detail: Record<string, unknown>;
}

export interface PaymentStatus {
  found: boolean;
  captured: boolean;
  amountPaise?: number;
  reference?: string;
}

export interface AdapterCall {
  caseId: string;
  obligationId: string;
  customerId: string;
  params: Record<string, unknown>;
  idemKey: string;
}

export class UnsupportedCapabilityError extends Error {
  constructor(adapter: string, capability: string) {
    super(`${adapter} does not support ${capability}`);
    this.name = "UnsupportedCapabilityError";
  }
}

export interface PSPAdapter {
  readonly name: string;
  /** Which surface the ledger and UI label this adapter's actions with. */
  readonly surface: "live" | "simulated";
  /** Declared up front so an unsupported action is refused before execution. */
  capabilities(): ReadonlySet<CapabilityName>;

  createPaymentLink(call: AdapterCall, token: CapabilityToken): Promise<CallResult>;
  resumeCheckout(call: AdapterCall, token: CapabilityToken): Promise<CallResult>;
  requestPaymentMethodUpdate(call: AdapterCall, token: CapabilityToken): Promise<CallResult>;
  sendApprovedTemplate(call: AdapterCall, token: CapabilityToken): Promise<CallResult>;
  createOpsEscalation(call: AdapterCall, token: CapabilityToken): Promise<CallResult>;
  /** Reconciliation probe. Takes no token: it moves no money and reads only. */
  fetchPaymentStatus(idemKey: string): Promise<PaymentStatus>;
}

export const invoke = (
  adapter: PSPAdapter,
  capability: CapabilityName,
  call: AdapterCall,
  token: CapabilityToken,
): Promise<CallResult> => {
  if (!adapter.capabilities().has(capability)) {
    throw new UnsupportedCapabilityError(adapter.name, capability);
  }
  switch (capability) {
    case "createPaymentLink": return adapter.createPaymentLink(call, token);
    case "resumeCheckout": return adapter.resumeCheckout(call, token);
    case "requestPaymentMethodUpdate": return adapter.requestPaymentMethodUpdate(call, token);
    case "sendApprovedTemplate": return adapter.sendApprovedTemplate(call, token);
    case "createOpsEscalation": return adapter.createOpsEscalation(call, token);
    case "fetchPaymentStatus":
      throw new Error("fetchPaymentStatus is a reconciliation probe, not an executable action");
  }
};
