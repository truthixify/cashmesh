import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
  CASHU_STELLAR_TESTNET_USDC_ISSUER,
  CASHU_STELLAR_UNIT,
  CashuStellarMeltQuoteClient,
  CashuStellarMeltQuoteClientError,
  CashuStellarMeltQuoteError,
  type CreateCashuStellarMeltQuoteInputV1,
  cashuStellarMeltRequestDestination,
  cashuStellarSettlementDestination,
  createCashuStellarMeltQuoteRequestV1,
  createCashuStellarMeltQuoteV1,
  MAX_CASHU_STELLAR_MELT_AMOUNT,
  MAX_CASHU_STELLAR_MELT_QUOTE_REQUEST_TIMEOUT_MS,
  MAX_CASHU_STELLAR_MELT_QUOTE_RESPONSE_BYTES,
  MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS,
  MAX_CASHU_STELLAR_MELT_REQUEST_LENGTH,
} from "../src";

const MINT_URL = "https://mint.cashmesh.example/operator";
const NOW = 1_788_300_000;
const EXPIRY = NOW + 600;
const AMOUNT = 1_234;
const QUOTE_ID = "01890f3c-7b62-7a4f-bc7d-1a2b3c4d5e6f";
const OTHER_QUOTE_ID = "01890f3c-7b63-7f41-8d2e-2b3c4d5e6f70";
const DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const MUXED_DESTINATION = "MA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAAAAAAAAAPCICBKU";
const REQUEST = paymentRequest();
const PINNED_CDK_QUOTE_RESPONSE = readFileSync(
  new URL("../fixtures/nut05/stellar-melt-quote-unpaid.json", import.meta.url),
  "utf8",
);

describe("Cashu Stellar melt quote model", () => {
  it("creates a frozen current-profile request and versioned quote", () => {
    const request = createCashuStellarMeltQuoteRequestV1({ amount: AMOUNT, request: REQUEST });
    const quote = createCashuStellarMeltQuoteV1({
      amount: AMOUNT,
      expiry: EXPIRY,
      method: CASHU_STELLAR_METHOD,
      mintUrl: `${MINT_URL}/`,
      observedAt: NOW,
      quoteId: QUOTE_ID,
      request: REQUEST,
      state: "UNPAID",
      unit: CASHU_STELLAR_UNIT,
    });

    expect(request).toEqual({
      amount: AMOUNT,
      method: "stellar",
      request: REQUEST,
      unit: "usdc",
    });
    expect(quote).toEqual({
      amount: AMOUNT,
      expiry: EXPIRY,
      feeReserve: 0,
      method: "stellar",
      mintUrl: MINT_URL,
      observedAt: NOW,
      quoteId: QUOTE_ID,
      request: REQUEST,
      schemaVersion: 1,
      state: "UNPAID",
      unit: "usdc",
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(quote)).toBe(true);
  });

  it("accepts exact-cent Stellar decimal spellings without floating point", () => {
    for (const amount of ["12.34", "12.3400000", "012.3400"]) {
      expect(
        createCashuStellarMeltQuoteRequestV1({
          amount: AMOUNT,
          request: paymentRequest({ amount }),
        }).amount,
      ).toBe(AMOUNT);
    }
  });

  it("accepts checksum-valid muxed destinations", () => {
    const request = createCashuStellarMeltQuoteRequestV1({
      amount: AMOUNT,
      request: paymentRequest({ destination: MUXED_DESTINATION }),
    });

    expect(request.request).toContain(MUXED_DESTINATION);
    expect(cashuStellarMeltRequestDestination(request)).toBe(MUXED_DESTINATION);
    expect(cashuStellarSettlementDestination(MUXED_DESTINATION)).toBe(MUXED_DESTINATION);
    expect(() => cashuStellarSettlementDestination("GABC")).toThrow(CashuStellarMeltQuoteError);
  });

  it.each([
    { amount: 0, name: "a zero amount", request: REQUEST },
    { amount: MAX_CASHU_STELLAR_MELT_AMOUNT + 1, name: "an oversized amount", request: REQUEST },
    { amount: AMOUNT, name: "an empty request", request: "" },
    {
      amount: AMOUNT,
      name: "an oversized request",
      request: `web+stellar:pay?${"x".repeat(MAX_CASHU_STELLAR_MELT_REQUEST_LENGTH)}`,
    },
    {
      amount: AMOUNT,
      name: "a wrong URI scheme",
      request: REQUEST.replace("web+stellar", "https"),
    },
    { amount: AMOUNT, name: "a URI fragment", request: `${REQUEST}#fragment` },
    { amount: AMOUNT, name: "a duplicate parameter", request: `${REQUEST}&amount=12.34` },
    { amount: AMOUNT, name: "an unknown parameter", request: `${REQUEST}&callback=x` },
    { amount: AMOUNT, name: "a missing destination", request: paymentRequest({ destination: "" }) },
    {
      amount: AMOUNT,
      name: "an invalid destination",
      request: paymentRequest({ destination: "GABC" }),
    },
    {
      amount: AMOUNT,
      name: "an invalid destination checksum",
      request: paymentRequest({ destination: `${DESTINATION.slice(0, -1)}A` }),
    },
    { amount: AMOUNT, name: "a mismatched amount", request: paymentRequest({ amount: "12.35" }) },
    { amount: AMOUNT, name: "a sub-cent amount", request: paymentRequest({ amount: "12.341" }) },
    { amount: AMOUNT, name: "an exponent amount", request: paymentRequest({ amount: "1.234e1" }) },
    { amount: AMOUNT, name: "a wrong asset code", request: paymentRequest({ assetCode: "XLM" }) },
    {
      amount: AMOUNT,
      name: "a wrong issuer",
      request: paymentRequest({ assetIssuer: DESTINATION }),
    },
    {
      amount: AMOUNT,
      name: "a wrong network",
      request: paymentRequest({
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    },
    {
      amount: AMOUNT,
      name: "an incomplete memo",
      request: paymentRequest({ memo: "correlation", memoType: null }),
    },
    {
      amount: AMOUNT,
      name: "an unknown memo type",
      request: paymentRequest({ memo: "correlation", memoType: "MEMO_NUMBER" }),
    },
  ])("rejects $name", ({ amount, request }) => {
    expect(() => createCashuStellarMeltQuoteRequestV1({ amount, request })).toThrow(
      CashuStellarMeltQuoteError,
    );
  });

  it.each([
    { name: "a non-v7 quote ID", override: { quoteId: "550e8400-e29b-41d4-a716-446655440000" } },
    { name: "a wrong method", override: { method: "bolt11" } },
    { name: "a wrong unit", override: { unit: "sat" } },
    { name: "an unknown state", override: { state: "UNKNOWN" } },
    { name: "a negative fee", override: { feeReserve: -1 } },
    { name: "an overflowing total", override: { feeReserve: Number.MAX_SAFE_INTEGER } },
    { name: "a negative expiry", override: { expiry: -1 } },
    { name: "a negative observation time", override: { observedAt: -1 } },
    { name: "an unsupported schema", override: { schemaVersion: 2 } },
  ])("rejects a quote with $name", ({ override }) => {
    expect(() => createCashuStellarMeltQuoteV1(quoteInput(override))).toThrow(
      CashuStellarMeltQuoteError,
    );
  });
});

describe("CashuStellarMeltQuoteClient", () => {
  it("accepts the shared response fixture decoded by pinned CDK types", async () => {
    const client = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: sequenceClock(NOW - 1, NOW),
      fetch: async () =>
        new Response(PINNED_CDK_QUOTE_RESPONSE, {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });

    await expect(client.create({ amount: AMOUNT, request: REQUEST })).resolves.toEqual(
      expectedQuote(),
    );
  });

  it("uses the exact credential-free custom NUT-05 create contract", async () => {
    const calls: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const client = new CashuStellarMeltQuoteClient(`${MINT_URL}/`, {
      clock: sequenceClock(NOW - 1, NOW),
      fetch: async (input, init) => {
        calls.push({ ...(init !== undefined && { init }), url: String(input) });
        return jsonResponse({
          ...quoteResponse(),
          change: [],
          operator_detail: "discard-me",
          payment_preimage: "discard-me-too",
        });
      },
    });

    const quote = await client.create({ amount: AMOUNT, request: REQUEST });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${MINT_URL}/v1/melt/quote/stellar`);
    expect(calls[0]?.init).toMatchObject({
      body: JSON.stringify({ amount: AMOUNT, request: REQUEST, unit: "usdc" }),
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(quote).toEqual(expectedQuote());
    expect(JSON.stringify(quote)).not.toMatch(/discard-me|payment_preimage|operator_detail/);
  });

  it("checks the exact UUIDv7 route and allows pending recovery to unpaid", async () => {
    const calls: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const client = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: sequenceClock(NOW - 1, NOW, NOW + 1, NOW + 2),
      fetch: async (input, init) => {
        calls.push({ ...(init !== undefined && { init }), url: String(input) });
        return jsonResponse(quoteResponse({ state: calls.length === 1 ? "PENDING" : "UNPAID" }));
      },
    });
    const initial = expectedQuote({ observedAt: NOW - 2 });

    const pending = await client.check(initial);
    const unpaid = await client.check(pending);

    expect(pending.state).toBe("PENDING");
    expect(unpaid.state).toBe("UNPAID");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(`${MINT_URL}/v1/melt/quote/stellar/${QUOTE_ID}`);
      expect(call.init).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(call.init?.body).toBeUndefined();
    }
  });

  it.each([
    { name: "quote ID", override: { quote: OTHER_QUOTE_ID } },
    { name: "fee reserve", override: { fee_reserve: 1 } },
    { name: "expiry", override: { expiry: EXPIRY + 1 } },
    {
      name: "request and amount",
      override: { amount: 1_235, request: paymentRequest({ amount: "12.35" }) },
    },
  ])("rejects a check that changes the immutable $name", async ({ override }) => {
    const client = fixtureClient(quoteResponse(override));

    await expect(client.check(expectedQuote({ observedAt: NOW - 2 }))).rejects.toMatchObject({
      code: "quote_response_mismatch",
    });
  });

  it.each([
    { name: "an omitted method", override: { method: undefined } },
    { name: "a wrong method", override: { method: "bolt11" } },
    { name: "a wrong unit", override: { unit: "sat" } },
    { name: "a non-v7 ID", override: { quote: "550e8400-e29b-41d4-a716-446655440000" } },
    { name: "an unknown state", override: { state: "UNKNOWN" } },
    { name: "an unsafe amount", override: { amount: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "a null fee", override: { fee_reserve: null } },
    { name: "structured change", override: { change: {} } },
    { name: "nonempty change", override: { change: [{ amount: 1 }] } },
  ])("rejects a response with $name", async ({ override }) => {
    const client = fixtureClient(quoteResponse(override));

    await expect(client.create({ amount: AMOUNT, request: REQUEST })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("requires a newly created quote to be future and unpaid", async () => {
    await expect(
      fixtureClient(quoteResponse({ state: "PENDING" })).create({
        amount: AMOUNT,
        request: REQUEST,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      fixtureClient(quoteResponse({ expiry: NOW })).create({
        amount: AMOUNT,
        request: REQUEST,
      }),
    ).rejects.toMatchObject({ code: "quote_expired" });
    await expect(
      fixtureClient(
        quoteResponse({ expiry: NOW - 1 + MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS + 1 }),
      ).create({
        amount: AMOUNT,
        request: REQUEST,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("treats paid as terminal across later checks", async () => {
    const client = fixtureClient(quoteResponse({ state: "PENDING" }));

    await expect(
      client.check(expectedQuote({ observedAt: NOW - 2, state: "PAID" })),
    ).rejects.toMatchObject({ code: "quote_response_mismatch" });
  });

  it("rejects invalid inputs before contacting the mint", async () => {
    let requestCount = 0;
    const client = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });

    await expect(client.create({ amount: 0, request: REQUEST })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      client.create({ amount: AMOUNT, request: REQUEST, signal: {} as AbortSignal }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.check(expectedQuote({ mintUrl: "https://other.example", observedAt: NOW - 1 })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.check(expectedQuote({ observedAt: NOW - 1 }), { signal: {} as AbortSignal }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(requestCount).toBe(0);
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
  ])("maps a bounded HTTP failure to $code", async ({ code, fetch: fetchFixture, options }) => {
    const client = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: sequenceClock(NOW - 1, NOW),
      fetch: fetchFixture as typeof fetch,
      ...options,
    });

    await expect(client.create({ amount: AMOUNT, request: REQUEST })).rejects.toMatchObject({
      code,
    });
  });

  it("does not retry a failed quote creation and sanitizes the network error", async () => {
    let requestCount = 0;
    const client = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => {
        requestCount += 1;
        throw new Error("sensitive transport detail");
      },
    });

    const error = await errorFromAsync(() => client.create({ amount: AMOUNT, request: REQUEST }));

    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).not.toContain("sensitive transport detail");
    expect(requestCount).toBe(1);
  });

  it("times out stalled requests and response bodies", async () => {
    const requestClient = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => new Promise<Response>(() => undefined),
      requestTimeoutMs: 10,
    });
    const bodyClient = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      requestTimeoutMs: 10,
    });

    await expect(requestClient.create({ amount: AMOUNT, request: REQUEST })).rejects.toMatchObject({
      code: "request_timeout",
    });
    await expect(bodyClient.create({ amount: AMOUNT, request: REQUEST })).rejects.toMatchObject({
      code: "request_timeout",
    });
  });

  it("rejects redirects and response endpoint substitution", async () => {
    for (const properties of [
      { redirected: true, url: "https://other.example/v1/melt/quote/stellar" },
      { redirected: false, url: "https://other.example/v1/melt/quote/stellar" },
    ]) {
      const response = jsonResponse(quoteResponse());
      Object.defineProperties(response, {
        redirected: { value: properties.redirected },
        url: { value: properties.url },
      });
      const client = new CashuStellarMeltQuoteClient(MINT_URL, {
        clock: sequenceClock(NOW - 1, NOW),
        fetch: async () => response,
      });

      await expect(client.create({ amount: AMOUNT, request: REQUEST })).rejects.toMatchObject({
        code: "invalid_response",
      });
    }
  });

  it("supports preflight and in-flight cancellation", async () => {
    let requestCount = 0;
    const preflightController = new AbortController();
    preflightController.abort();
    const preflightClient = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => {
        requestCount += 1;
        return jsonResponse(quoteResponse());
      },
    });
    await expect(
      preflightClient.create({
        amount: AMOUNT,
        request: REQUEST,
        signal: preflightController.signal,
      }),
    ).rejects.toMatchObject({ code: "request_aborted" });
    expect(requestCount).toBe(0);

    const inFlightController = new AbortController();
    const inFlightClient = new CashuStellarMeltQuoteClient(MINT_URL, {
      clock: () => NOW,
      fetch: async () => new Promise<Response>(() => undefined),
    });
    const request = inFlightClient.create({
      amount: AMOUNT,
      request: REQUEST,
      signal: inFlightController.signal,
    });
    inFlightController.abort();
    await expect(request).rejects.toMatchObject({ code: "request_aborted" });
  });

  it("rejects invalid and backwards clocks", async () => {
    await expect(
      new CashuStellarMeltQuoteClient(MINT_URL, {
        clock: () => -1,
        fetch: async () => jsonResponse(quoteResponse()),
      }).create({ amount: AMOUNT, request: REQUEST }),
    ).rejects.toMatchObject({ code: "invalid_clock" });
    await expect(
      new CashuStellarMeltQuoteClient(MINT_URL, {
        clock: sequenceClock(NOW, NOW - 1),
        fetch: async () => jsonResponse(quoteResponse()),
      }).create({ amount: AMOUNT, request: REQUEST }),
    ).rejects.toMatchObject({ code: "invalid_clock" });
    await expect(
      fixtureClient(quoteResponse()).check(expectedQuote({ observedAt: NOW + 1 })),
    ).rejects.toMatchObject({ code: "invalid_clock" });
  });

  it("rejects invalid client configuration", () => {
    expect(() => new CashuStellarMeltQuoteClient("http://mint.example")).toThrow(
      CashuStellarMeltQuoteClientError,
    );
    expect(
      () =>
        new CashuStellarMeltQuoteClient(MINT_URL, {
          requestTimeoutMs: MAX_CASHU_STELLAR_MELT_QUOTE_REQUEST_TIMEOUT_MS + 1,
        }),
    ).toThrow(CashuStellarMeltQuoteClientError);
    expect(
      () =>
        new CashuStellarMeltQuoteClient(MINT_URL, {
          maxResponseBytes: MAX_CASHU_STELLAR_MELT_QUOTE_RESPONSE_BYTES + 1,
        }),
    ).toThrow(CashuStellarMeltQuoteClientError);
    expect(
      () => new CashuStellarMeltQuoteClient(MINT_URL, { clock: 1 as unknown as () => number }),
    ).toThrow(CashuStellarMeltQuoteClientError);
    expect(CashuStellarMeltQuoteClientError.prototype).toBeInstanceOf(Error);
  });
});

function paymentRequest(
  overrides: {
    readonly amount?: string;
    readonly assetCode?: string;
    readonly assetIssuer?: string;
    readonly destination?: string;
    readonly memo?: string | null;
    readonly memoType?: string | null;
    readonly networkPassphrase?: string;
  } = {},
): string {
  const parameters = new URLSearchParams();
  parameters.set("destination", overrides.destination ?? DESTINATION);
  parameters.set("amount", overrides.amount ?? "12.34");
  parameters.set("asset_code", overrides.assetCode ?? CASHU_STELLAR_TESTNET_USDC_ASSET_CODE);
  parameters.set("asset_issuer", overrides.assetIssuer ?? CASHU_STELLAR_TESTNET_USDC_ISSUER);
  if (overrides.memo !== null) {
    parameters.set("memo", overrides.memo ?? "Y29ycmVsYXRpb24=");
  }
  if (overrides.memoType !== null) {
    parameters.set("memo_type", overrides.memoType ?? "MEMO_HASH");
  }
  parameters.set(
    "network_passphrase",
    overrides.networkPassphrase ?? CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  );
  return `web+stellar:pay?${parameters.toString()}`;
}

function quoteInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    amount: AMOUNT,
    expiry: EXPIRY,
    feeReserve: 0,
    method: CASHU_STELLAR_METHOD,
    mintUrl: MINT_URL,
    observedAt: NOW,
    quoteId: QUOTE_ID,
    request: REQUEST,
    state: "UNPAID",
    unit: CASHU_STELLAR_UNIT,
    ...overrides,
  } as Parameters<typeof createCashuStellarMeltQuoteV1>[0];
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

function expectedQuote(overrides: Partial<CreateCashuStellarMeltQuoteInputV1> = {}) {
  return createCashuStellarMeltQuoteV1({
    ...quoteInput(),
    observedAt: NOW,
    ...overrides,
  });
}

function fixtureClient(response: unknown): CashuStellarMeltQuoteClient {
  return new CashuStellarMeltQuoteClient(MINT_URL, {
    clock: sequenceClock(NOW - 1, NOW),
    fetch: async () => jsonResponse(response),
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
