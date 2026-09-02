export type CaseId = string;
export type ObligationId = string;
export type MerchantId = string;
export type CustomerId = string;
export type IncidentId = string;

export const RAILS = [
  "card",
  "upi_collect",
  "upi_autopay",
  "enach",
  "netbanking",
  "wallet",
  "smart_collect",
] as const;
export type Rail = (typeof RAILS)[number];

export const DOMAINS = [
  "subscription_renewal",
  "payment_failure",
  "checkout_abandonment",
  "overdue_invoice",
] as const;
export type Domain = (typeof DOMAINS)[number];

/**
 * Evidence kinds are the invalidation currency. A role declares which kinds it
 * depends on; when a revision changes evidence of kind K, exactly the roles
 * declaring K are rerun. Adding a kind here without wiring it into a role's
 * dependsOn means changes of that kind rerun nothing.
 */
export const EVIDENCE_KINDS = [
  "payment_attempt",
  "decline_code",
  "mandate_state",
  "customer_profile",
  "customer_reply",
  "contact_history",
  "obligation_state",
  "incident_membership",
  "segment_metrics",
  "policy_snapshot",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type Tier = 0 | 1 | 2;

export interface Evidence {
  id: string;
  caseId: CaseId;
  kind: EvidenceKind;
  payload: Record<string, unknown>;
  source: string;
  observedAt: Date;
}

export interface Obligation {
  id: ObligationId;
  merchantId: MerchantId;
  customerId: CustomerId;
  type: Domain;
  amountPaise: number;
  currency: "INR";
  dueAt: Date;
  externalRef: string;
}

export interface LedgerEntry {
  caseId: CaseId;
  ts: Date;
  actor: string;
  eventType: string;
  payload: Record<string, unknown>;
  policyVersion?: string;
}
