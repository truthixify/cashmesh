import { describe, expect, it } from "vitest";

import {
  IdentifierError,
  idempotencyKey,
  invoiceId,
  journalEntryId,
  merchantId,
  operatorId,
  paymentId,
  settlementAssetId,
  unixTimestamp,
} from "../src";

describe("domain identifiers", () => {
  it("constructs typed identifiers from durable URL-safe values", () => {
    expect(idempotencyKey("checkout-attempt_0001")).toBe("checkout-attempt_0001");
    expect(invoiceId("inv:merchant-1:0001")).toBe("inv:merchant-1:0001");
    expect(journalEntryId("journal_0001")).toBe("journal_0001");
    expect(merchantId("merchant.example")).toBe("merchant.example");
    expect(operatorId("operator-a")).toBe("operator-a");
    expect(paymentId("payment_0001")).toBe("payment_0001");
    expect(settlementAssetId("stellar-testnet-usdc-circle")).toBe("stellar-testnet-usdc-circle");
  });

  it.each(["", "contains space", "#fragment", "a".repeat(129)])(
    "rejects invalid identifier %s",
    (value) => {
      expect(() => invoiceId(value)).toThrowError(IdentifierError);
      expect(errorFrom(() => invoiceId(value))).toMatchObject({ code: "invalid_identifier" });
    },
  );

  it("accepts non-negative, whole-second timestamps", () => {
    expect(unixTimestamp(0)).toBe(0);
    expect(unixTimestamp(1_787_000_000)).toBe(1_787_000_000);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid timestamp %s",
    (value) => {
      expect(() => unixTimestamp(value)).toThrowError(IdentifierError);
      expect(errorFrom(() => unixTimestamp(value))).toMatchObject({ code: "invalid_timestamp" });
    },
  );
});

function errorFrom(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}
