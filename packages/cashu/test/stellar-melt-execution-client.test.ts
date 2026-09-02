import { createHash } from "node:crypto";

import { hashToCurve, pointToHex } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import * as publicApi from "../src";
import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
  CASHU_STELLAR_TESTNET_USDC_ISSUER,
  CASHU_STELLAR_UNIT,
  type CashuBearerProofBundleV1,
  CashuStellarMeltExecutionClient,
  CashuStellarMeltExecutionClientError,
  type CashuStellarMeltQuoteV1,
  createCashuStellarMeltQuoteV1,
  MAX_CASHU_STELLAR_MELT_EXECUTION_RESPONSE_BYTES,
  MAX_CASHU_STELLAR_MELT_EXECUTION_TIMEOUT_MS,
  restoreCashuBearerProofBundleV1,
} from "../src";

const MINT_URL = "https://mint.cashmesh.example/operator";
const OTHER_MINT_URL = "https://other.cashmesh.example";
const NOW = 1_788_400_000;
const EXPIRY = NOW + 600;
const AMOUNT = 12;
const INPUT_FEE = 1;
const QUOTE_ID = "01890f3c-7b62-7a4f-bc7d-1a2b3c4d5e6f";
const OTHER_QUOTE_ID = "01890f3c-7b63-7f41-8d2e-2b3c4d5e6f70";
const DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const KEYSET_ID = "000f715baf5d4c2e";
const SIGNATURE = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const REQUEST = paymentRequest();

describe("CashuStellarMeltExecutionClient", () => {
  it("authorizes the canonical dispatch before one exact credential-free NUT-05 request", async () => {
    const order: string[] = [];
    const calls: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const fixture = bearerBundle();
    const client = new CashuStellarMeltExecutionClient(`${MINT_URL}/`, {
      clock: sequenceClock(NOW, NOW, NOW + 1),
      fetch: async (input, init) => {
        order.push("fetch");
        calls.push({ ...(init !== undefined && { init }), url: String(input) });
        return jsonResponse({
          ...quoteResponse({ state: "PENDING" }),
          change: [],
          operator_detail: "discard-me",
          payment_preimage: "discard-me-too",
        });
      },
    });

    const result = await client.execute({
      authorize: (dispatch) => {
        order.push("authorize");
        expect(Object.isFrozen(dispatch)).toBe(true);
        expect(JSON.stringify(dispatch)).not.toMatch(
          /test-only-secret|signature|payment_preimage/i,
        );
        return true;
      },
      bearerProofs: fixture.bundle,
      inputFee: INPUT_FEE,
      quote: quote(),
    });

    expect(order).toEqual(["authorize", "fetch"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${MINT_URL}/v1/melt/stellar`);
    expect(calls[0]?.init).toMatchObject({
      body: JSON.stringify({ quote: QUOTE_ID, inputs: fixture.inputs, prefer_async: true }),
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);

    const requestBody = String(calls[0]?.init?.body);
    const fingerprintMaterial = JSON.stringify({
      body: requestBody,
      domain: "cashmesh.cashu.stellar-melt-dispatch.v1",
      method: "POST",
      url: `${MINT_URL}/v1/melt/stellar`,
    });
    const expectedFingerprint = createHash("sha256").update(fingerprintMaterial).digest("hex");
    expect(result).toEqual({
      dispatch: {
        dispatchFingerprint: expectedFingerprint,
        expiresAt: EXPIRY,
        method: "stellar",
        mintUrl: MINT_URL,
        quoteId: QUOTE_ID,
        schemaVersion: 1,
      },
      quote: quote({ observedAt: NOW + 1, state: "PENDING" }),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.quote)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /test-only-secret|discard-me|operator_detail|payment_preimage|signature/i,
    );
  });

  it("keeps the bearer melt projection out of the package API", () => {
    expect(publicApi).not.toHaveProperty("withCashuBearerMeltInputsV1");
    expect(publicApi).not.toHaveProperty("CashuBearerMeltInputV1");
  });

  it.each(["UNPAID", "PAID"] as const)(
    "returns a sanitized common %s response without treating it as proof evidence",
    async (state) => {
      const client = executionClient({
        response: quoteResponse({ payment_preimage: "discard-me", state }),
      });

      const result = await client.execute({
        authorize: () => true,
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      });

      expect(result.quote.state).toBe(state);
      expect(JSON.stringify(result)).not.toContain("discard-me");
    },
  );

  it("does not contact the mint when durable dispatch authorization is refused or fails", async () => {
    let requestCount = 0;
    const client = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });
    const fixture = bearerBundle();

    await expect(
      client.execute({
        authorize: () => false,
        bearerProofs: fixture.bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code: "dispatch_not_authorized" });

    const storageFailure = new Error("test-only persistence failure");
    await expect(
      client.execute({
        authorize: () => Promise.reject(storageFailure),
        bearerProofs: fixture.bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      }),
    ).rejects.toBe(storageFailure);
    expect(requestCount).toBe(0);
  });

  it("requires exact quote plus NUT-02 input-fee coverage", async () => {
    let authorizationCount = 0;
    let requestCount = 0;
    const client = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });

    await expect(
      client.execute({
        authorize: () => {
          authorizationCount += 1;
          return true;
        },
        bearerProofs: bearerBundle({ amounts: [8, 4] }).bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code: "input_amount_mismatch" });
    await expect(
      client.execute({
        authorize: () => {
          authorizationCount += 1;
          return true;
        },
        bearerProofs: bearerBundle().bundle,
        inputFee: 0,
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code: "input_amount_mismatch" });
    expect(authorizationCount).toBe(0);
    expect(requestCount).toBe(0);
  });

  it("fails closed on fee reserves until recoverable change outputs are persisted", async () => {
    let authorizationCount = 0;
    const client = executionClient();

    await expect(
      client.execute({
        authorize: () => {
          authorizationCount += 1;
          return true;
        },
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote({ feeReserve: 1 }),
      }),
    ).rejects.toMatchObject({ code: "unsupported_fee_reserve" });
    expect(authorizationCount).toBe(0);
  });

  it("rejects mismatched, destroyed, stale, and malformed inputs before authorization", async () => {
    let authorizationCount = 0;
    let requestCount = 0;
    const authorize = () => {
      authorizationCount += 1;
      return true;
    };
    const client = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });
    const destroyed = bearerBundle().bundle;
    destroyed.destroy();

    const cases: Array<{
      readonly code: string;
      readonly input: {
        readonly bearerProofs: CashuBearerProofBundleV1;
        readonly inputFee: number;
        readonly quote: CashuStellarMeltQuoteV1;
      };
    }> = [
      {
        code: "invalid_request",
        input: {
          bearerProofs: bearerBundle({ mintUrl: OTHER_MINT_URL }).bundle,
          inputFee: INPUT_FEE,
          quote: quote(),
        },
      },
      {
        code: "invalid_request",
        input: {
          bearerProofs: bearerBundle({ unit: "sat" }).bundle,
          inputFee: INPUT_FEE,
          quote: quote(),
        },
      },
      {
        code: "invalid_request",
        input: { bearerProofs: destroyed, inputFee: INPUT_FEE, quote: quote() },
      },
      {
        code: "invalid_request",
        input: { bearerProofs: bearerBundle().bundle, inputFee: -1, quote: quote() },
      },
      {
        code: "invalid_request",
        input: {
          bearerProofs: bearerBundle().bundle,
          inputFee: INPUT_FEE,
          quote: quote({ state: "PENDING" }),
        },
      },
      {
        code: "quote_expired",
        input: {
          bearerProofs: bearerBundle().bundle,
          inputFee: INPUT_FEE,
          quote: quote({ expiry: NOW }),
        },
      },
      {
        code: "invalid_clock",
        input: {
          bearerProofs: bearerBundle().bundle,
          inputFee: INPUT_FEE,
          quote: quote({ observedAt: NOW + 1 }),
        },
      },
    ];

    for (const fixture of cases) {
      await expect(client.execute({ authorize, ...fixture.input })).rejects.toMatchObject({
        code: fixture.code,
      });
    }
    expect(authorizationCount).toBe(0);
    expect(requestCount).toBe(0);
  });

  it("rechecks cancellation and expiry after authorization but before network dispatch", async () => {
    let requestCount = 0;
    const abortController = new AbortController();
    const abortClient = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });
    await expect(
      abortClient.execute({
        authorize: () => {
          abortController.abort();
          return true;
        },
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
        signal: abortController.signal,
      }),
    ).rejects.toMatchObject({ code: "request_aborted" });

    const expiryClient = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: sequenceClock(NOW, EXPIRY),
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });
    await expect(
      expiryClient.execute({
        authorize: () => true,
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code: "quote_expired" });
    expect(requestCount).toBe(0);
  });

  it.each([
    {
      code: "quote_response_mismatch",
      response: quoteResponse({ quote: OTHER_QUOTE_ID }),
    },
    { code: "invalid_response", response: quoteResponse({ change: [{ C_: SIGNATURE }] }) },
    { code: "invalid_response", response: quoteResponse({ state: "UNKNOWN" }) },
    { code: "invalid_response", response: { ...quoteResponse(), unit: undefined } },
  ])("rejects a bound execution response with $code", async ({ code, response }) => {
    const client = executionClient({ response });

    await expect(
      client.execute({
        authorize: () => true,
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    {
      code: "unexpected_status",
      fetch: async () => new Response("unavailable", { status: 503 }),
      options: {},
    },
    {
      code: "invalid_response",
      fetch: async () => new Response("not-json", { status: 200 }),
      options: {},
    },
    {
      code: "invalid_response",
      fetch: async () => new Response(new Uint8Array([0xff]), { status: 200 }),
      options: {},
    },
    {
      code: "response_too_large",
      fetch: async () => new Response("{}", { headers: { "content-length": "17" }, status: 200 }),
      options: { maxResponseBytes: 16 },
    },
    {
      code: "response_too_large",
      fetch: async () => new Response("x".repeat(17), { status: 200 }),
      options: { maxResponseBytes: 16 },
    },
  ])(
    "maps a bounded execution failure to $code",
    async ({ code, fetch: fixtureFetch, options }) => {
      const client = new CashuStellarMeltExecutionClient(MINT_URL, {
        clock: sequenceClock(NOW, NOW),
        fetch: fixtureFetch as typeof fetch,
        ...options,
      });

      await expect(
        client.execute({
          authorize: () => true,
          bearerProofs: bearerBundle().bundle,
          inputFee: INPUT_FEE,
          quote: quote(),
        }),
      ).rejects.toMatchObject({ code });
    },
  );

  it("does not retry and sanitizes transport failures", async () => {
    let requestCount = 0;
    const client = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: sequenceClock(NOW, NOW),
      fetch: async () => {
        requestCount += 1;
        throw new Error("test-only sensitive transport detail");
      },
    });

    const error = await errorFromAsync(() =>
      client.execute({
        authorize: () => true,
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      }),
    );

    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).not.toContain("sensitive transport detail");
    expect(requestCount).toBe(1);
  });

  it("times out stalled requests and response bodies", async () => {
    const requestClient = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: sequenceClock(NOW, NOW),
      fetch: async () => new Promise<Response>(() => undefined),
      requestTimeoutMs: 10,
    });
    const bodyClient = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: sequenceClock(NOW, NOW),
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      requestTimeoutMs: 10,
    });

    for (const client of [requestClient, bodyClient]) {
      await expect(
        client.execute({
          authorize: () => true,
          bearerProofs: bearerBundle().bundle,
          inputFee: INPUT_FEE,
          quote: quote(),
        }),
      ).rejects.toMatchObject({ code: "request_timeout" });
    }
  });

  it("rejects redirects and response endpoint substitution", async () => {
    for (const properties of [
      { redirected: true, url: `${OTHER_MINT_URL}/v1/melt/stellar` },
      { redirected: false, url: `${OTHER_MINT_URL}/v1/melt/stellar` },
    ]) {
      const response = jsonResponse(quoteResponse());
      Object.defineProperties(response, {
        redirected: { value: properties.redirected },
        url: { value: properties.url },
      });
      const client = new CashuStellarMeltExecutionClient(MINT_URL, {
        clock: sequenceClock(NOW, NOW),
        fetch: async () => response,
      });

      await expect(
        client.execute({
          authorize: () => true,
          bearerProofs: bearerBundle().bundle,
          inputFee: INPUT_FEE,
          quote: quote(),
        }),
      ).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("supports preflight and in-flight cancellation", async () => {
    let authorizationCount = 0;
    let requestCount = 0;
    const preflightController = new AbortController();
    preflightController.abort();
    const preflightClient = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: () => {
        throw new Error("clock should not be read");
      },
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });
    await expect(
      preflightClient.execute({
        authorize: () => {
          authorizationCount += 1;
          return true;
        },
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
        signal: preflightController.signal,
      }),
    ).rejects.toMatchObject({ code: "request_aborted" });
    expect(authorizationCount).toBe(0);
    expect(requestCount).toBe(0);

    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const inFlightController = new AbortController();
    const inFlightClient = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: sequenceClock(NOW, NOW),
      fetch: async () => {
        requestCount += 1;
        requestStarted?.();
        return new Promise<Response>(() => undefined);
      },
    });
    const pending = inFlightClient.execute({
      authorize: () => true,
      bearerProofs: bearerBundle().bundle,
      inputFee: INPUT_FEE,
      quote: quote(),
      signal: inFlightController.signal,
    });
    await started;
    inFlightController.abort();
    await expect(pending).rejects.toMatchObject({ code: "request_aborted" });
    expect(requestCount).toBe(1);
  });

  it("rejects backwards clocks and invalid client configuration", async () => {
    await expect(
      new CashuStellarMeltExecutionClient(MINT_URL, {
        clock: sequenceClock(NOW, NOW - 1),
        fetch: async () => jsonResponse(quoteResponse()),
      }).execute({
        authorize: () => true,
        bearerProofs: bearerBundle().bundle,
        inputFee: INPUT_FEE,
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code: "invalid_clock" });

    expect(() => new CashuStellarMeltExecutionClient("http://mint.example")).toThrow(
      CashuStellarMeltExecutionClientError,
    );
    expect(
      () =>
        new CashuStellarMeltExecutionClient(MINT_URL, {
          requestTimeoutMs: MAX_CASHU_STELLAR_MELT_EXECUTION_TIMEOUT_MS + 1,
        }),
    ).toThrow(CashuStellarMeltExecutionClientError);
    expect(
      () =>
        new CashuStellarMeltExecutionClient(MINT_URL, {
          maxResponseBytes: MAX_CASHU_STELLAR_MELT_EXECUTION_RESPONSE_BYTES + 1,
        }),
    ).toThrow(CashuStellarMeltExecutionClientError);
    expect(
      () =>
        new CashuStellarMeltExecutionClient(MINT_URL, {
          clock: 1 as unknown as () => number,
        }),
    ).toThrow(CashuStellarMeltExecutionClientError);
    expect(CashuStellarMeltExecutionClientError.prototype).toBeInstanceOf(Error);
  });
});

interface BearerBundleFixture {
  readonly bundle: CashuBearerProofBundleV1;
  readonly inputs: readonly Readonly<{
    readonly C: string;
    readonly amount: number;
    readonly id: string;
    readonly secret: string;
  }>[];
}

function bearerBundle(
  options: {
    readonly amounts?: readonly number[];
    readonly mintUrl?: string;
    readonly unit?: string;
  } = {},
): BearerBundleFixture {
  const proofs = (options.amounts ?? [8, 4, 1])
    .map((amount, index) => {
      const secret = `test-only-secret-${amount}-${index}`;
      return {
        amount,
        keysetId: KEYSET_ID,
        secret,
        signature: SIGNATURE,
        y: proofY(secret),
      };
    })
    .sort((left, right) => left.y.localeCompare(right.y));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      invoiceId: "invoice-melt-execution-001",
      mintUrl: options.mintUrl ?? MINT_URL,
      proofs,
      schemaVersion: 1,
      unit: options.unit ?? CASHU_STELLAR_UNIT,
    }),
  );
  return {
    bundle: restoreCashuBearerProofBundleV1(plaintext),
    inputs: proofs.map((proof) => ({
      C: proof.signature,
      amount: proof.amount,
      id: proof.keysetId,
      secret: proof.secret,
    })),
  };
}

function proofY(secret: string): string {
  return pointToHex({
    kind: "secp",
    pt: hashToCurve(new TextEncoder().encode(secret)),
  });
}

function paymentRequest(): string {
  const parameters = new URLSearchParams();
  parameters.set("destination", DESTINATION);
  parameters.set("amount", "0.12");
  parameters.set("asset_code", CASHU_STELLAR_TESTNET_USDC_ASSET_CODE);
  parameters.set("asset_issuer", CASHU_STELLAR_TESTNET_USDC_ISSUER);
  parameters.set("memo", "Y29ycmVsYXRpb24=");
  parameters.set("memo_type", "MEMO_HASH");
  parameters.set("network_passphrase", CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE);
  return `web+stellar:pay?${parameters.toString()}`;
}

function quote(overrides: Readonly<Record<string, unknown>> = {}): CashuStellarMeltQuoteV1 {
  return createCashuStellarMeltQuoteV1({
    amount: AMOUNT,
    expiry: EXPIRY,
    feeReserve: 0,
    method: CASHU_STELLAR_METHOD,
    mintUrl: MINT_URL,
    observedAt: NOW - 10,
    quoteId: QUOTE_ID,
    request: REQUEST,
    state: "UNPAID",
    unit: CASHU_STELLAR_UNIT,
    ...overrides,
  } as Parameters<typeof createCashuStellarMeltQuoteV1>[0]);
}

function quoteResponse(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    amount: AMOUNT,
    expiry: EXPIRY,
    fee_reserve: 0,
    method: CASHU_STELLAR_METHOD,
    quote: QUOTE_ID,
    request: REQUEST,
    state: "UNPAID",
    unit: CASHU_STELLAR_UNIT,
    ...overrides,
  };
}

function executionClient(options: { readonly response?: unknown } = {}) {
  return new CashuStellarMeltExecutionClient(MINT_URL, {
    clock: sequenceClock(NOW, NOW, NOW + 1),
    fetch: async () => jsonResponse(options.response ?? quoteResponse()),
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) {
      throw new Error("Fixture clock exhausted.");
    }
    return value;
  };
}

async function errorFromAsync(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to reject.");
}
