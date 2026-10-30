/**
 * Electronic eligibility (X12 270/271 through a clearinghouse), behind an interface like
 * LlmProvider, so a clearinghouse integration can be added after the HIPAA deployment phase.
 * See docs/INTEGRATIONS.md.
 *
 * Unused by default: the only implementation is NotConfiguredEligibilityProvider, which refuses
 * every request. An eligibility request carries real member identifiers, so no implementation may
 * be wired in before a BAA with the clearinghouse is signed and the app runs in the HIPAA
 * environment. v1.0 holds synthetic data only.
 */
import type { z } from "zod";
import type { Day } from "../dates";
import type { BenefitsCheckSchema } from "../services/records";

/** What a 270 eligibility inquiry needs. Built only by server code, never logged. */
export type EligibilityRequest = {
  /** The clearinghouse's identifier for the payer (from payer enrollment), not Yoma's payor key. */
  payerId: string;
  /** The practice's NPI, from org settings. */
  providerNpi: string;
  memberId: string;
  subscriber: { firstName: string; lastName: string; dob: Day };
  serviceDate: Day;
};

/**
 * The parts of a 271 response Yoma would keep. 271s have no ABA-specific service type code, so
 * coverage and prior authorization come back generic (often "unknown" for ABA): a person still
 * confirms the ABA specifics.
 */
export type EligibilityResult = {
  active: boolean | null;
  planName: string | null;
  groupNumber: string | null;
  coverageStart: Day | null;
  coverageEnd: Day | null;
  /** Some payers report fully insured vs self-funded; most do not. */
  planFunding: "fully_insured" | "self_funded" | "unknown";
  /**
   * The clearinghouse's trace number. It becomes the check's reference number once the HIPAA phase
   * lifts v1.0's synthetic-identifier rule; until then it is not stored.
   */
  traceNumber: string | null;
};

export interface EligibilityProvider {
  readonly name: string;
  /** False until a clearinghouse is configured (after the BAA). */
  readonly configured: boolean;
  check(req: EligibilityRequest): Promise<EligibilityResult>;
}

export class EligibilityNotConfiguredError extends Error {
  constructor() {
    super(
      "Electronic eligibility is not configured. It requires a clearinghouse, payer enrollment, and a signed BAA (docs/INTEGRATIONS.md).",
    );
    this.name = "EligibilityNotConfiguredError";
  }
}

export class NotConfiguredEligibilityProvider implements EligibilityProvider {
  readonly name = "not_configured";
  readonly configured = false;
  async check(): Promise<EligibilityResult> {
    throw new EligibilityNotConfiguredError();
  }
}

let override: EligibilityProvider | null = null;
/** Tests inject a provider. */
export function setEligibilityProvider(p: EligibilityProvider | null) {
  override = p;
}

/** The configured provider. Always NotConfigured in v1.0. */
export function eligibilityProvider(): EligibilityProvider {
  return override ?? new NotConfiguredEligibilityProvider();
}

/**
 * How a 271 maps into a benefits check (method "electronic_eligibility"). ABA coverage and prior
 * authorization stay "unknown": the response cannot answer them for ABA, so the audit keeps
 * warning until a person records what the payor said.
 */
export function benefitsCheckFromEligibility(
  r: EligibilityResult,
  checkedOn: Day,
): z.input<typeof BenefitsCheckSchema> {
  return {
    checkedOn,
    method: "electronic_eligibility",
    referenceNumber: null,
    abaCovered: r.active === false ? "no" : "unknown",
    priorAuthRequired: "unknown",
    planFunding: r.planFunding,
    ageLimitYears: null,
    visitOrHourLimits: null,
    notes: [
      r.active === null ? "Coverage status not returned" : r.active ? "Coverage active" : "Coverage inactive",
      r.planName ? `plan ${r.planName}` : null,
      r.coverageStart || r.coverageEnd
        ? `coverage ${r.coverageStart ?? "?"} to ${r.coverageEnd ?? "?"}`
        : null,
    ]
      .filter(Boolean)
      .join("; ")
      .slice(0, 1000),
  };
}
