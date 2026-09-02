/** Claim payload shapes and their JSON Schemas. */

export interface DiagnosisClaim {
  primaryCause: string;
  confidence: number;
  alternatives: { cause: string; confidence: number }[];
  ruleId: string | null;
  evidenceRefs: string[];
}

export interface ContextClaim {
  intent: "will_pay" | "will_update" | "dispute" | "opt_out" | "missing_po" | "unknown";
  optedOut: boolean;
  language: "en" | "hi" | "hinglish";
  priorContacts: number;
}

export interface IncidentClaim {
  attach: boolean;
  incidentId: string | null;
  suppress: boolean;
  rationale: string;
}

export interface EconomicsCandidate {
  actionId: string;
  pRecover: number;
  valueAtRiskPaise: number;
  actionCostPaise: number;
  expectedValuePaise: number;
}

export interface EconomicsClaim {
  candidates: EconomicsCandidate[];
}

export interface CommunicationClaim {
  templateId: string;
  language: "en" | "hi" | "hinglish";
  slots: Record<string, string>;
}

const num = (min: number, max: number) => ({ type: "number", minimum: min, maximum: max });

export const DIAGNOSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["primaryCause", "confidence", "alternatives", "ruleId", "evidenceRefs"],
  properties: {
    primaryCause: { type: "string" },
    confidence: num(0, 1),
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cause", "confidence"],
        properties: { cause: { type: "string" }, confidence: num(0, 1) },
      },
    },
    ruleId: { type: ["string", "null"] },
    // Citations are required, so a hypothesis with no evidence behind it fails
    // validation rather than reaching the reducer.
    evidenceRefs: { type: "array", items: { type: "string" }, minItems: 1 },
  },
} as const;

export const CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "optedOut", "language", "priorContacts"],
  properties: {
    // An enum, not free text: the reply interpreter cannot emit an action.
    intent: {
      type: "string",
      enum: ["will_pay", "will_update", "dispute", "opt_out", "missing_po", "unknown"],
    },
    optedOut: { type: "boolean" },
    language: { type: "string", enum: ["en", "hi", "hinglish"] },
    priorContacts: { type: "integer", minimum: 0 },
  },
} as const;

export const INCIDENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["attach", "incidentId", "suppress", "rationale"],
  properties: {
    attach: { type: "boolean" },
    incidentId: { type: ["string", "null"] },
    suppress: { type: "boolean" },
    rationale: { type: "string", maxLength: 600 },
  },
} as const;

export const COMMUNICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["templateId", "language", "slots"],
  properties: {
    // Template id and language only. No recipient, no link, no free-form body:
    // the schema itself is the injection defence.
    templateId: { type: "string" },
    language: { type: "string", enum: ["en", "hi", "hinglish"] },
    slots: { type: "object", additionalProperties: { type: "string" } },
  },
} as const;

export const STRATEGY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selectedCause", "confidence", "rationale", "rejected"],
  properties: {
    selectedCause: { type: "string" },
    confidence: num(0, 1),
    rationale: { type: "string", maxLength: 800 },
    rejected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cause", "why"],
        properties: { cause: { type: "string" }, why: { type: "string" } },
      },
    },
  },
} as const;

export const SCHEMA_VERSION = "1";
