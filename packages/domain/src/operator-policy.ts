export const OPERATOR_TIERS = ["trusted", "convertible", "unlisted"] as const;
export type OperatorTier = (typeof OPERATOR_TIERS)[number];

export const SETTLEMENT_MODES = ["trusted_hold", "immediate_conversion"] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export interface OperatorPolicyInput {
  readonly tier: OperatorTier;
  readonly requestedMode?: SettlementMode;
}

export type PolicyDecision =
  | {
      readonly accepted: true;
      readonly mode: SettlementMode;
      readonly reason: "trusted_operator" | "conversion_required";
    }
  | {
      readonly accepted: false;
      readonly reason: "operator_not_accepted";
    };

export function evaluateOperatorPolicy(input: OperatorPolicyInput): PolicyDecision {
  if (input.tier === "unlisted") {
    return { accepted: false, reason: "operator_not_accepted" };
  }

  if (input.tier === "convertible") {
    return {
      accepted: true,
      mode: "immediate_conversion",
      reason: "conversion_required",
    };
  }

  return {
    accepted: true,
    mode: input.requestedMode ?? "trusted_hold",
    reason: "trusted_operator",
  };
}
