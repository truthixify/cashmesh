export const OPERATOR_TIERS = ["trusted", "convertible", "unlisted"] as const;
export type OperatorTier = (typeof OPERATOR_TIERS)[number];

export const SETTLEMENT_MODES = ["trusted_hold", "immediate_conversion"] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export interface OperatorPolicyInput {
  readonly tier: OperatorTier;
  readonly requestedMode?: SettlementMode;
}

export type OperatorPolicyErrorCode = "invalid_operator_tier" | "invalid_settlement_mode";

export class OperatorPolicyError extends Error {
  override readonly name = "OperatorPolicyError";

  constructor(
    readonly code: OperatorPolicyErrorCode,
    message: string,
  ) {
    super(message);
  }
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
  if (!OPERATOR_TIERS.includes(input.tier)) {
    throw new OperatorPolicyError("invalid_operator_tier", "Operator tier is invalid.");
  }
  if (input.requestedMode !== undefined && !SETTLEMENT_MODES.includes(input.requestedMode)) {
    throw new OperatorPolicyError(
      "invalid_settlement_mode",
      "Requested settlement mode is invalid.",
    );
  }
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
