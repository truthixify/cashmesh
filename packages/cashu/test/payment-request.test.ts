import { readFileSync } from "node:fs";
import {
  createInvoiceV1,
  invoiceId,
  merchantId,
  minorUnits,
  type OpenInvoiceV1,
  type OperatorId,
  type OperatorTier,
  operatorId,
  type SettlementMode,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";
import { PaymentRequest } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import {
  CashuPaymentRequestError,
  type CreateCashuPaymentRequestInput,
  createCashuPaymentRequestV1,
  MAX_NUT18_OPERATORS,
  type Nut18MintPolicy,
} from "../src";

const CREATED_AT = unixTimestamp(1_787_000_000);
const EXPIRES_AT = unixTimestamp(1_787_000_300);
const ISSUED_AT = unixTimestamp(1_787_000_010);

describe("createCashuPaymentRequestV1", () => {
  it("builds a deterministic strict NUT-18 request and policy snapshot", () => {
    const first = buildRequest();
    const second = buildRequest();
    const decoded = PaymentRequest.fromEncodedRequest(first.encodedRequest);

    expect(first).toMatchObject({
      amount: 1_234,
      encoding: "creqA",
      expiresAt: EXPIRES_AT,
      invoiceId: "invoice-001",
      issuedAt: ISSUED_AT,
      mintPolicy: "strict",
      operators: [
        {
          mintUrl: "https://mint-a.cashmesh.example",
          mode: "trusted_hold",
          operatorId: "operator-a",
          reason: "trusted_operator",
          tier: "trusted",
        },
        {
          mintUrl: "https://mint-b.cashmesh.example",
          mode: "immediate_conversion",
          operatorId: "operator-b",
          reason: "conversion_required",
          tier: "convertible",
        },
      ],
      schemaVersion: 1,
      unit: "usdc",
    });
    expect(first.encodedRequest).toBe(second.encodedRequest);
    expect(first.encodedRequest.startsWith("creqA")).toBe(true);
    expect(decoded.id).toBe("invoice-001");
    expect(decoded.amount?.toBigInt()).toBe(1_234n);
    expect(decoded.unit).toBe("usdc");
    expect(decoded.singleUse).toBe(true);
    expect(decoded.mints).toEqual([
      "https://mint-a.cashmesh.example",
      "https://mint-b.cashmesh.example",
    ]);
    expect(decoded.isMintListStrict).toBe(true);
    expect(decoded.mintsPreferred).toBeUndefined();
    expect(decoded.supportedMethods).toHaveLength(1);
    expect(decoded.supportedMethods?.[0]?.method).toBe("stellar");
    expect(decoded.supportedMethods?.[0]?.fee).toBeUndefined();
    expect(decoded.transport).toEqual([
      {
        target: "https://pay.cashmesh.example/v1/cashu/payments",
        type: "post",
      },
    ]);
  });

  it("matches the cross-implementation compatibility fixture", () => {
    const invoice = createInvoiceV1({
      amount: minorUnits(1_234),
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      id: invoiceId("invoice-interop-001"),
      merchantId: merchantId("merchant-interop-001"),
    });
    const request = createCashuPaymentRequestV1({
      invoice,
      issuedAt: ISSUED_AT,
      operators: [
        operatorRoute("operator-b", "https://mint-b.cashmesh.example", "convertible"),
        operatorRoute("operator-a", "https://mint-a.cashmesh.example", "trusted"),
      ],
      transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
    });
    const fixture = readFileSync(
      new URL("../fixtures/nut18/strict-stellar.creq", import.meta.url),
      "utf8",
    ).trim();

    expect(request.encodedRequest).toBe(fixture);
  });

  it("emits only the required protocol fields and keeps expiry out of NUT-18", () => {
    const decoded = PaymentRequest.fromEncodedRequest(buildRequest().encodedRequest);

    expect(Object.keys(decoded.toRawRequest()).sort()).toEqual([
      "a",
      "i",
      "m",
      "s",
      "sm",
      "t",
      "u",
    ]);
    expect(decoded.description).toBeUndefined();
    expect(decoded.nut10).toBeUndefined();
  });

  it("records an explicit immediate-conversion choice for a trusted operator", () => {
    const result = buildRequest({
      operators: [
        operatorRoute("operator-a", "https://mint-a.example", "trusted", "immediate_conversion"),
      ],
    });

    expect(result.operators[0]).toMatchObject({
      mode: "immediate_conversion",
      reason: "trusted_operator",
      tier: "trusted",
    });
  });

  it("returns deeply immutable policy records", () => {
    const result = buildRequest();

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.operators)).toBe(true);
    expect(Object.isFrozen(result.operators[0])).toBe(true);
  });

  it("refuses advisory mint semantics until unlisted conversion is supported", () => {
    expect(errorFrom(() => buildRequest({ mintPolicy: "advisory" }))).toMatchObject({
      code: "advisory_policy_unsupported",
    });
    expect(
      errorFrom(() => buildRequest({ mintPolicy: "unknown" as Nut18MintPolicy })),
    ).toMatchObject({ code: "invalid_mint_policy" });
    expect(
      errorFrom(() => buildRequest({ mintPolicy: null as unknown as Nut18MintPolicy })),
    ).toMatchObject({ code: "invalid_mint_policy" });
  });

  it("rejects an empty, oversized, or unlisted operator set", () => {
    expect(errorFrom(() => buildRequest({ operators: [] }))).toMatchObject({
      code: "empty_operator_set",
    });
    expect(
      errorFrom(() =>
        buildRequest({
          operators: Array.from({ length: MAX_NUT18_OPERATORS + 1 }, (_, index) =>
            operatorRoute(`operator-${index}`, `https://mint-${index}.example`, "trusted"),
          ),
        }),
      ),
    ).toMatchObject({ code: "operator_limit_exceeded" });
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [operatorRoute("operator-unlisted", "https://mint.example", "unlisted")],
        }),
      ),
    ).toMatchObject({ code: "operator_not_accepted" });
  });

  it("rejects duplicate operator identities and normalized mint URLs", () => {
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [
            operatorRoute("operator-a", "https://mint-a.example", "trusted"),
            operatorRoute("operator-a", "https://mint-b.example", "trusted"),
          ],
        }),
      ),
    ).toMatchObject({ code: "duplicate_operator" });
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [
            operatorRoute("operator-a", "https://mint.example", "trusted"),
            operatorRoute("operator-b", "https://mint.example/", "convertible"),
          ],
        }),
      ),
    ).toMatchObject({ code: "duplicate_mint" });
  });

  it("rejects malformed runtime operator policy", () => {
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [
            operatorRoute("operator-a", "https://mint.example", "preferred" as OperatorTier),
          ],
        }),
      ),
    ).toMatchObject({ code: "invalid_operator_policy" });
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [
            operatorRoute(
              "operator-a",
              "https://mint.example",
              "trusted",
              "deferred" as SettlementMode,
            ),
          ],
        }),
      ),
    ).toMatchObject({ code: "invalid_operator_policy" });
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [
            {
              mintUrl: "https://mint.example",
              operatorId: "bad operator" as OperatorId,
              tier: "trusted",
            },
          ],
        }),
      ),
    ).toMatchObject({ code: "invalid_operator_policy" });
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [null] as unknown as Parameters<
            typeof createCashuPaymentRequestV1
          >[0]["operators"],
        }),
      ),
    ).toMatchObject({ code: "invalid_operator_policy" });
    expect(
      errorFrom(() =>
        buildRequest({
          operators: null as unknown as Parameters<
            typeof createCashuPaymentRequestV1
          >[0]["operators"],
        }),
      ),
    ).toMatchObject({ code: "invalid_operator_set" });
  });

  it.each([
    "http://pay.cashmesh.example/v1/cashu/payments",
    "https://user:secret@pay.cashmesh.example/v1/cashu/payments",
    "https://pay.cashmesh.example/v1/cashu/payments?token=secret",
    "https://pay.cashmesh.example/v1/cashu/payments#fragment",
    " https://pay.cashmesh.example/v1/cashu/payments",
    "not-a-url",
  ])("rejects unsafe transport endpoint %s", (transportUrl) => {
    expect(errorFrom(() => buildRequest({ transportUrl }))).toMatchObject({
      code: "invalid_endpoint",
    });
  });

  it("rejects unsafe mint endpoints", () => {
    expect(
      errorFrom(() =>
        buildRequest({
          operators: [operatorRoute("operator-a", "http://mint.example", "trusted")],
        }),
      ),
    ).toMatchObject({ code: "invalid_endpoint" });
  });

  it("rejects requests before creation and at or after expiry", () => {
    expect(
      errorFrom(() => buildRequest({ issuedAt: unixTimestamp(CREATED_AT - 1) })),
    ).toMatchObject({ code: "request_before_invoice" });
    expect(errorFrom(() => buildRequest({ issuedAt: EXPIRES_AT }))).toMatchObject({
      code: "invoice_expired",
    });
    expect(errorFrom(() => buildRequest({ issuedAt: -1 as UnixTimestamp }))).toMatchObject({
      code: "invalid_issued_at",
    });
  });

  it("rejects terminal, unsupported, and malformed invoices", () => {
    const terminalInvoice = { ...openInvoice(), state: "paid" } as unknown as OpenInvoiceV1;
    const unsupportedInvoice = {
      ...openInvoice(),
      schemaVersion: 2,
    } as unknown as OpenInvoiceV1;
    const malformedInvoice = { ...openInvoice(), amount: 0 } as unknown as OpenInvoiceV1;

    expect(errorFrom(() => buildRequest({ invoice: terminalInvoice }))).toMatchObject({
      code: "invalid_invoice",
    });
    expect(errorFrom(() => buildRequest({ invoice: unsupportedInvoice }))).toMatchObject({
      code: "invalid_invoice",
    });
    expect(errorFrom(() => buildRequest({ invoice: malformedInvoice }))).toMatchObject({
      code: "invalid_invoice",
    });
    expect(
      errorFrom(() => buildRequest({ invoice: null as unknown as OpenInvoiceV1 })),
    ).toMatchObject({ code: "invalid_invoice" });
  });

  it("rejects malformed request objects and endpoint runtime values", () => {
    expect(
      errorFrom(() =>
        createCashuPaymentRequestV1(null as unknown as CreateCashuPaymentRequestInput),
      ),
    ).toMatchObject({ code: "invalid_request" });
    expect(
      errorFrom(() => buildRequest({ transportUrl: null as unknown as string })),
    ).toMatchObject({ code: "invalid_endpoint" });
  });

  it("bounds the final encoded request size", () => {
    const longPath = "a".repeat(450);
    const operators = Array.from({ length: MAX_NUT18_OPERATORS }, (_, index) =>
      operatorRoute(`operator-${index}`, `https://mint-${index}.example/${longPath}`, "trusted"),
    );

    expect(errorFrom(() => buildRequest({ operators }))).toMatchObject({
      code: "request_too_large",
    });
  });

  it("exposes a stable adapter error type", () => {
    expect(CashuPaymentRequestError.prototype).toBeInstanceOf(Error);
  });
});

function buildRequest(overrides: Partial<Parameters<typeof createCashuPaymentRequestV1>[0]> = {}) {
  return createCashuPaymentRequestV1({
    invoice: openInvoice(),
    issuedAt: ISSUED_AT,
    operators: [
      operatorRoute("operator-b", "https://mint-b.cashmesh.example", "convertible"),
      operatorRoute("operator-a", "https://mint-a.cashmesh.example/", "trusted"),
    ],
    transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
    ...overrides,
  });
}

function openInvoice(): OpenInvoiceV1 {
  return createInvoiceV1({
    amount: minorUnits(1_234),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    id: invoiceId("invoice-001"),
    merchantId: merchantId("merchant-001"),
  });
}

function operatorRoute(
  id: string,
  mintUrl: string,
  tier: OperatorTier,
  requestedMode?: SettlementMode,
) {
  return {
    mintUrl,
    operatorId: operatorId(id),
    ...(requestedMode !== undefined && { requestedMode }),
    tier,
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
