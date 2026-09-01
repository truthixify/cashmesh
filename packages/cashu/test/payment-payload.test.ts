import { Amount, PaymentRequest, type Proof } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import {
  CashuPaymentPayloadError,
  inspectCashuPaymentPayloadV1,
  MAX_NUT18_PAYMENT_PAYLOAD_BYTES,
  MAX_NUT18_PAYMENT_PROOFS,
} from "../src";

const INVOICE_ID = "invoice-payment-001";
const MINT_URL = "https://mint.cashmesh.example";
const PROOF_SECRET = "proof-secret-must-not-escape";

describe("inspectCashuPaymentPayloadV1", () => {
  it("projects a canonical NUT-18 payload into a metadata-only envelope", () => {
    const envelope = inspectCashuPaymentPayloadV1(
      paymentPayload({
        memo: "private payer memo",
        mint: `${MINT_URL}/`,
        proofs: [proof(1_024), proof(210)],
      }),
    );

    expect(envelope).toEqual({
      grossAmount: 1_234,
      invoiceId: INVOICE_ID,
      mintUrl: MINT_URL,
      proofCount: 2,
      unit: "usdc",
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(PROOF_SECRET);
    expect(JSON.stringify(envelope)).not.toContain("private payer memo");
  });

  it("preserves exact JSON integer values through the pinned decoder", () => {
    const envelope = inspectCashuPaymentPayloadV1(
      paymentPayload({ proofs: [proof(BigInt(Number.MAX_SAFE_INTEGER))] }),
    );

    expect(envelope.grossAmount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("ignores undeclared payer metadata instead of retaining it", () => {
    const rawPayload = JSON.stringify({
      customerEmail: "payer@example.invalid",
      id: INVOICE_ID,
      mint: MINT_URL,
      proofs: [
        {
          C: proof().C,
          amount: 1_234,
          id: proof().id,
          internalMetadata: "must-not-survive",
          secret: PROOF_SECRET,
        },
      ],
      unit: "usdc",
    });

    const envelope = inspectCashuPaymentPayloadV1(rawPayload);

    expect(Object.keys(envelope).sort()).toEqual([
      "grossAmount",
      "invoiceId",
      "mintUrl",
      "proofCount",
      "unit",
    ]);
    expect(JSON.stringify(envelope)).not.toContain("payer@example.invalid");
    expect(JSON.stringify(envelope)).not.toContain("must-not-survive");
  });

  it.each([
    { name: "invalid JSON", payload: "not-json", code: "invalid_payload" },
    {
      name: "missing invoice identifier",
      payload: paymentPayload({ id: null }),
      code: "invalid_invoice_id",
    },
    {
      name: "invalid unit",
      payload: paymentPayload({ unit: " usdc" }),
      code: "invalid_unit",
    },
    {
      name: "unsafe mint",
      payload: paymentPayload({ mint: "https://user:secret@mint.example" }),
      code: "invalid_mint",
    },
    {
      name: "mint query",
      payload: paymentPayload({ mint: "https://mint.example?tenant=secret" }),
      code: "invalid_mint",
    },
    {
      name: "zero-value proof",
      payload: paymentPayload({ proofs: [proof(0)] }),
      code: "invalid_proof",
    },
    {
      name: "empty proof secret",
      payload: paymentPayload({ proofs: [{ ...proof(), secret: "" }] }),
      code: "invalid_proof",
    },
  ])("rejects $name", ({ code, payload }) => {
    expect(errorFrom(() => inspectCashuPaymentPayloadV1(payload))).toMatchObject({ code });
  });

  it("bounds proof count and exact aggregate amount", () => {
    expect(
      errorFrom(() =>
        inspectCashuPaymentPayloadV1(
          paymentPayload({
            proofs: Array.from({ length: MAX_NUT18_PAYMENT_PROOFS + 1 }, () => proof(1)),
          }),
        ),
      ),
    ).toMatchObject({ code: "proof_limit_exceeded" });
    expect(
      errorFrom(() =>
        inspectCashuPaymentPayloadV1(
          paymentPayload({ proofs: [proof(Number.MAX_SAFE_INTEGER), proof(1)] }),
        ),
      ),
    ).toMatchObject({ code: "amount_limit_exceeded" });
  });

  it("bounds raw UTF-8 payload bytes before decoding", () => {
    expect(
      errorFrom(() =>
        inspectCashuPaymentPayloadV1("x".repeat(MAX_NUT18_PAYMENT_PAYLOAD_BYTES + 1)),
      ),
    ).toMatchObject({ code: "payload_too_large" });
  });

  it("exposes a stable adapter error type", () => {
    expect(CashuPaymentPayloadError.prototype).toBeInstanceOf(Error);
  });
});

function paymentPayload(
  options: {
    readonly id?: string | null;
    readonly memo?: string;
    readonly mint?: string;
    readonly proofs?: Proof[];
    readonly unit?: string;
  } = {},
): string {
  const request = new PaymentRequest({
    ...(options.id !== null && { id: options.id ?? INVOICE_ID }),
    unit: options.unit ?? "usdc",
  });
  return request.encodePayload(options.mint ?? MINT_URL, options.proofs ?? [proof()], {
    ...(options.memo !== undefined && { memo: options.memo }),
  });
}

function proof(amount: number | bigint = 1_234): Proof {
  return {
    C: `02${"11".repeat(32)}`,
    amount: Amount.from(amount),
    id: "009a1f293253e41e",
    secret: PROOF_SECRET,
  };
}

function errorFrom(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}
