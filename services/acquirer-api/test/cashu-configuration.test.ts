import {
  createInvoiceV1,
  invoiceId,
  merchantId,
  minorUnits,
  unixTimestamp,
} from "@cashmesh/domain";
import { describe, expect, it } from "vitest";

import {
  CashuConfigurationError,
  cashuPaymentRequestIssuerFromEnvironment,
  cashuStellarSettlementDestinationFromEnvironment,
} from "../src/cashu-configuration";

const SETTLEMENT_DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";

const INVOICE = createInvoiceV1({
  amount: minorUnits(1_234),
  createdAt: unixTimestamp(1_788_000_000),
  expiresAt: unixTimestamp(1_788_000_300),
  id: invoiceId("invoice-configuration-001"),
  merchantId: merchantId("merchant-001"),
});

describe("Cashu payment request configuration", () => {
  it("uses an explicit non-routable multi-operator profile outside production", () => {
    const request = cashuPaymentRequestIssuerFromEnvironment({}).issue({
      invoice: INVOICE,
      issuedAt: INVOICE.createdAt,
    });

    expect(request.transportUrl).toBe("https://pay.cashmesh.example/v1/cashu/payments");
    expect(request.operators).toMatchObject([
      { operatorId: "operator-local-a", tier: "trusted" },
      { operatorId: "operator-local-b", tier: "convertible" },
    ]);
  });

  it("loads and validates a production-owned operator profile", () => {
    const issuer = cashuPaymentRequestIssuerFromEnvironment({
      CASHMESH_CASHU_OPERATOR_ROUTES: JSON.stringify([
        {
          mintUrl: "https://mint.example",
          operatorId: "operator-production-a",
          requestedMode: "immediate_conversion",
          tier: "trusted",
        },
      ]),
      CASHMESH_CASHU_TRANSPORT_URL: "https://pay.example/v1/cashu/payments",
      NODE_ENV: "production",
    });

    expect(issuer.issue({ invoice: INVOICE, issuedAt: INVOICE.createdAt })).toMatchObject({
      operators: [
        {
          mode: "immediate_conversion",
          operatorId: "operator-production-a",
          tier: "trusted",
        },
      ],
      transportUrl: "https://pay.example/v1/cashu/payments",
    });
  });

  it("requires both production configuration values", () => {
    expect(
      errorFrom(() => cashuPaymentRequestIssuerFromEnvironment({ NODE_ENV: "production" })),
    ).toBeInstanceOf(CashuConfigurationError);
    expect(
      errorFrom(() =>
        cashuPaymentRequestIssuerFromEnvironment({
          CASHMESH_CASHU_OPERATOR_ROUTES: "[]",
          NODE_ENV: "production",
        }),
      ),
    ).toBeInstanceOf(CashuConfigurationError);
  });

  it("loads a server-owned Stellar settlement destination", () => {
    expect(String(cashuStellarSettlementDestinationFromEnvironment({}))).toBe(
      SETTLEMENT_DESTINATION,
    );
    expect(
      String(
        cashuStellarSettlementDestinationFromEnvironment({
          CASHMESH_STELLAR_SETTLEMENT_DESTINATION: SETTLEMENT_DESTINATION,
          NODE_ENV: "production",
        }),
      ),
    ).toBe(SETTLEMENT_DESTINATION);
  });

  it("requires a valid production Stellar settlement destination without reflecting it", () => {
    expect(
      errorFrom(() => cashuStellarSettlementDestinationFromEnvironment({ NODE_ENV: "production" })),
    ).toBeInstanceOf(CashuConfigurationError);
    const error = errorFrom(() =>
      cashuStellarSettlementDestinationFromEnvironment({
        CASHMESH_STELLAR_SETTLEMENT_DESTINATION: "secret-invalid-destination",
        NODE_ENV: "production",
      }),
    );
    expect(error).toBeInstanceOf(CashuConfigurationError);
    expect(String(error)).not.toContain("secret-invalid-destination");
  });

  it.each([
    "not-json",
    "{}",
    "[]",
    JSON.stringify([{ mintUrl: "http://mint.example", operatorId: "operator-a", tier: "trusted" }]),
    JSON.stringify([
      {
        mintUrl: "https://mint.example",
        operatorId: "operator-a",
        secret: "must-not-be-accepted",
        tier: "trusted",
      },
    ]),
    JSON.stringify([
      { mintUrl: "https://mint.example", operatorId: "operator-a", tier: "unlisted" },
    ]),
  ])("rejects an invalid operator profile without reflecting its input", (routes) => {
    const error = errorFrom(() =>
      cashuPaymentRequestIssuerFromEnvironment({
        CASHMESH_CASHU_OPERATOR_ROUTES: routes,
        CASHMESH_CASHU_TRANSPORT_URL: "https://pay.example/v1/cashu/payments",
      }),
    );

    expect(error).toBeInstanceOf(CashuConfigurationError);
    expect(String(error)).not.toContain("must-not-be-accepted");
    expect(error).toMatchObject({ code: "invalid_cashu_configuration" });
  });
});

function errorFrom(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}
