import { describe, expect, it } from "vitest";

import {
  evaluateOperatorPolicy,
  OperatorPolicyError,
  type OperatorTier,
  type SettlementMode,
} from "../src/operator-policy";

describe("evaluateOperatorPolicy", () => {
  it("holds proofs from a trusted operator by default", () => {
    expect(evaluateOperatorPolicy({ tier: "trusted" })).toEqual({
      accepted: true,
      mode: "trusted_hold",
      reason: "trusted_operator",
    });
  });

  it("allows immediate conversion for a trusted operator", () => {
    expect(
      evaluateOperatorPolicy({ tier: "trusted", requestedMode: "immediate_conversion" }),
    ).toEqual({
      accepted: true,
      mode: "immediate_conversion",
      reason: "trusted_operator",
    });
  });

  it("forces immediate conversion for a convertible-only operator", () => {
    expect(evaluateOperatorPolicy({ tier: "convertible", requestedMode: "trusted_hold" })).toEqual({
      accepted: true,
      mode: "immediate_conversion",
      reason: "conversion_required",
    });
  });

  it("rejects an unlisted operator", () => {
    expect(evaluateOperatorPolicy({ tier: "unlisted" })).toEqual({
      accepted: false,
      reason: "operator_not_accepted",
    });
  });

  it("rejects invalid runtime policy values even when types are bypassed", () => {
    expect(() => evaluateOperatorPolicy({ tier: "preferred" as OperatorTier })).toThrowError(
      OperatorPolicyError,
    );
    expect(() =>
      evaluateOperatorPolicy({
        requestedMode: "deferred" as SettlementMode,
        tier: "trusted",
      }),
    ).toThrowError(OperatorPolicyError);
  });
});
