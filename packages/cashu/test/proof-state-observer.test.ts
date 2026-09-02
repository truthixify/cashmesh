import { describe, expect, it } from "vitest";

import {
  CashuMintProofStateHttpClient,
  CashuMintProofStateHttpError,
  type CashuMintProofStateSource,
  type CashuProofReferenceV1,
  CashuProofStateObservationError,
  CashuProofStateObserver,
  type CashuProofStateReadOptions,
  CashuProofStateSnapshotError,
  type CashuProofY,
  cashuProofY,
  createCashuProofReferenceV1,
  createCashuProofStateSnapshotV1,
  MAX_CASHU_PROOF_STATE_REQUEST_TIMEOUT_MS,
  MAX_CASHU_PROOF_STATE_RESPONSE_BYTES,
  MAX_CASHU_PROOF_STATES_PER_SNAPSHOT,
} from "../src";

const MINT_URL = "https://mint.cashmesh.example/operator";
const NOW = 1_788_300_000;
const KEYSET_ID = "000f715baf5d4c2e";
const PROOF_Y_A = cashuProofY("0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05");
const PROOF_Y_B = cashuProofY("02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5");
const PROOF_Y_C = cashuProofY("02b79a5775181e7973cab6c33eea75d943d9974acefd4d2a267f0f76ef567915ff");

describe("createCashuProofStateSnapshotV1", () => {
  it("canonicalizes and deeply freezes a versioned NUT-07 snapshot", () => {
    const snapshot = createCashuProofStateSnapshotV1({
      mintUrl: `${MINT_URL}/`,
      observedAt: NOW,
      states: [
        { state: "SPENT", y: PROOF_Y_C },
        { state: "UNSPENT", y: PROOF_Y_A },
        { state: "PENDING", y: PROOF_Y_B },
      ],
    });

    expect(snapshot).toEqual({
      mintUrl: MINT_URL,
      observedAt: NOW,
      schemaVersion: 1,
      states: [
        { state: "UNSPENT", y: PROOF_Y_A },
        { state: "PENDING", y: PROOF_Y_B },
        { state: "SPENT", y: PROOF_Y_C },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.states)).toBe(true);
    expect(Object.isFrozen(snapshot.states[0])).toBe(true);
  });

  it.each([
    {
      input: { mintUrl: MINT_URL, observedAt: NOW, states: [] },
      name: "an empty proof set",
    },
    {
      input: {
        mintUrl: MINT_URL,
        observedAt: NOW,
        states: [
          { state: "UNSPENT", y: PROOF_Y_A },
          { state: "SPENT", y: PROOF_Y_A },
        ],
      },
      name: "a duplicate proof",
    },
    {
      input: {
        mintUrl: MINT_URL,
        observedAt: NOW,
        states: [{ state: "UNKNOWN", y: PROOF_Y_A }],
      },
      name: "an unknown state",
    },
    {
      input: {
        mintUrl: MINT_URL,
        observedAt: NOW,
        states: [{ state: "UNSPENT", y: `02${"ff".repeat(32)}` }],
      },
      name: "an invalid curve point",
    },
    {
      input: { mintUrl: "http://mint.example", observedAt: NOW, states: [] },
      name: "an unsafe mint URL",
    },
    {
      input: { mintUrl: MINT_URL, observedAt: -1, states: [] },
      name: "an invalid clock",
    },
  ])("rejects $name", ({ input }) => {
    expect(() => createCashuProofStateSnapshotV1(input)).toThrow(CashuProofStateSnapshotError);
  });

  it("rejects sparse and oversized state arrays", () => {
    expect(() =>
      createCashuProofStateSnapshotV1({
        mintUrl: MINT_URL,
        observedAt: NOW,
        states: new Array(1) as Array<{ readonly state: string; readonly y: string }>,
      }),
    ).toThrow(CashuProofStateSnapshotError);
    expect(() =>
      createCashuProofStateSnapshotV1({
        mintUrl: MINT_URL,
        observedAt: NOW,
        states: Array.from({ length: MAX_CASHU_PROOF_STATES_PER_SNAPSHOT + 1 }, () => ({
          state: "UNSPENT",
          y: PROOF_Y_A,
        })),
      }),
    ).toThrow(CashuProofStateSnapshotError);
  });
});

describe("CashuProofStateObserver", () => {
  it("observes an exact ordered NUT-07 response and drops witnesses", async () => {
    const source = new FixtureProofStateSource({
      states: [
        { Y: PROOF_Y_A, state: "UNSPENT", witness: null },
        { Y: PROOF_Y_B, state: "PENDING" },
        { Y: PROOF_Y_C, state: "SPENT", witness: "sensitive-spending-witness" },
      ],
    });
    const observer = new CashuProofStateObserver(source, {
      clock: sequenceClock(NOW - 1, NOW),
    });

    const snapshot = await observer.observe({
      proofReferences: [
        proofReference(PROOF_Y_C),
        proofReference(PROOF_Y_A),
        proofReference(PROOF_Y_B),
      ],
    });

    expect(source.requests).toEqual([[PROOF_Y_A, PROOF_Y_B, PROOF_Y_C]]);
    expect(snapshot).toEqual({
      mintUrl: MINT_URL,
      observedAt: NOW,
      schemaVersion: 1,
      states: [
        { state: "UNSPENT", y: PROOF_Y_A },
        { state: "PENDING", y: PROOF_Y_B },
        { state: "SPENT", y: PROOF_Y_C },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-spending-witness");
  });

  it.each([
    {
      code: "state_response_mismatch",
      name: "missing state",
      response: { states: [{ Y: PROOF_Y_A, state: "UNSPENT", witness: null }] },
    },
    {
      code: "state_response_mismatch",
      name: "reordered state",
      response: {
        states: [
          { Y: PROOF_Y_B, state: "PENDING", witness: null },
          { Y: PROOF_Y_A, state: "UNSPENT", witness: null },
        ],
      },
    },
    {
      code: "invalid_state_response",
      name: "unknown state",
      response: {
        states: [
          { Y: PROOF_Y_A, state: "UNKNOWN", witness: null },
          { Y: PROOF_Y_B, state: "PENDING", witness: null },
        ],
      },
    },
    {
      code: "invalid_state_response",
      name: "structured witness",
      response: {
        states: [
          { Y: PROOF_Y_A, state: "UNSPENT", witness: {} },
          { Y: PROOF_Y_B, state: "PENDING", witness: null },
        ],
      },
    },
    {
      code: "state_response_mismatch",
      name: "sparse state entries",
      response: { states: new Array(2) },
    },
  ])("rejects a response with $name", async ({ code, response }) => {
    const observer = new CashuProofStateObserver(new FixtureProofStateSource(response), {
      clock: sequenceClock(NOW - 1, NOW),
    });

    await expect(
      observer.observe({
        proofReferences: [proofReference(PROOF_Y_A), proofReference(PROOF_Y_B)],
      }),
    ).rejects.toMatchObject({ code });
  });

  it("rejects invalid and oversized observation inputs before reading the source", async () => {
    const source = new FixtureProofStateSource({ states: [] });
    const observer = new CashuProofStateObserver(source, { clock: () => NOW });
    const duplicate = proofReference(PROOF_Y_A);

    await expect(observer.observe({ proofReferences: [] })).rejects.toMatchObject({
      code: "invalid_observation_input",
    });
    await expect(
      observer.observe({ proofReferences: [duplicate, duplicate] }),
    ).rejects.toMatchObject({
      code: "invalid_observation_input",
    });
    await expect(
      observer.observe({
        proofReferences: Array.from(
          { length: MAX_CASHU_PROOF_STATES_PER_SNAPSHOT + 1 },
          () => duplicate,
        ),
      }),
    ).rejects.toMatchObject({ code: "proof_limit_exceeded" });
    await expect(
      observer.observe({ proofReferences: [duplicate], signal: {} as AbortSignal }),
    ).rejects.toMatchObject({ code: "invalid_observation_input" });
    await expect(
      observer.observe({
        proofReferences: new Array(1) as CashuProofReferenceV1[],
      }),
    ).rejects.toMatchObject({ code: "invalid_observation_input" });
    expect(source.requests).toEqual([]);
  });

  it("maps abort, clock, and source failures without leaking their details", async () => {
    const source = new FixtureProofStateSource({ states: [] });
    const controller = new AbortController();
    controller.abort();

    await expect(
      new CashuProofStateObserver(source, { clock: () => NOW }).observe({
        proofReferences: [proofReference(PROOF_Y_A)],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "observation_aborted" });
    await expect(
      new CashuProofStateObserver(source, { clock: () => -1 }).observe({
        proofReferences: [proofReference(PROOF_Y_A)],
      }),
    ).rejects.toMatchObject({ code: "invalid_clock" });

    source.response = {
      states: [{ Y: PROOF_Y_A, state: "UNSPENT", witness: null }],
    };
    await expect(
      new CashuProofStateObserver(source, {
        clock: sequenceClock(NOW, NOW - 1),
      }).observe({ proofReferences: [proofReference(PROOF_Y_A)] }),
    ).rejects.toMatchObject({ code: "invalid_clock" });

    source.failure = new Error("sensitive fixture failure");
    const error = await errorFromAsync(() =>
      new CashuProofStateObserver(source, { clock: () => NOW }).observe({
        proofReferences: [proofReference(PROOF_Y_A)],
      }),
    );
    expect(error).toMatchObject({ code: "source_unavailable" });
    expect(String(error)).not.toContain("sensitive fixture failure");
    expect(CashuProofStateObservationError.prototype).toBeInstanceOf(Error);
  });
});

describe("CashuMintProofStateHttpClient", () => {
  it("uses the exact credential-free NUT-07 POST contract", async () => {
    const calls: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const fetchFixture: typeof fetch = async (input, init) => {
      calls.push({ ...(init !== undefined && { init }), url: String(input) });
      return jsonResponse({ states: [] });
    };
    const client = new CashuMintProofStateHttpClient(`${MINT_URL}/`, { fetch: fetchFixture });

    await client.checkProofStates([PROOF_Y_B, PROOF_Y_A]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${MINT_URL}/v1/checkstate`);
    expect(calls[0]?.init).toMatchObject({
      body: JSON.stringify({ Ys: [PROOF_Y_B, PROOF_Y_A] }),
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(calls[0]?.init?.body)).not.toMatch(/secret|signature|dleq|witness/i);
  });

  it("composes with the observer without exposing bearer proof fields", async () => {
    const client = new CashuMintProofStateHttpClient(MINT_URL, {
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { readonly Ys: readonly string[] };
        return jsonResponse({
          states: request.Ys.map((Y) => ({ Y, state: "UNSPENT", witness: "discard-me" })),
        });
      },
    });
    const observer = new CashuProofStateObserver(client, {
      clock: sequenceClock(NOW - 1, NOW),
    });

    const snapshot = await observer.observe({
      proofReferences: [proofReference(PROOF_Y_B), proofReference(PROOF_Y_A)],
    });

    expect(snapshot.states).toEqual([
      { state: "UNSPENT", y: PROOF_Y_A },
      { state: "UNSPENT", y: PROOF_Y_B },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("discard-me");
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
      code: "response_too_large",
      fetch: async () => new Response("{}", { headers: { "content-length": "17" }, status: 200 }),
      options: { maxResponseBytes: 16 },
    },
    {
      code: "response_too_large",
      fetch: async () => new Response("x".repeat(17), { status: 200 }),
      options: { maxResponseBytes: 16 },
    },
    {
      code: "network_error",
      fetch: async () => {
        throw new Error("sensitive network failure");
      },
      options: {},
    },
  ])("maps bounded HTTP failure to $code", async ({ code, fetch: fetchFixture, options }) => {
    const client = new CashuMintProofStateHttpClient(MINT_URL, {
      fetch: fetchFixture as typeof fetch,
      ...options,
    });

    await expect(client.checkProofStates([PROOF_Y_A])).rejects.toMatchObject({ code });
  });

  it("times out stalled requests and response bodies", async () => {
    const requestClient = new CashuMintProofStateHttpClient(MINT_URL, {
      fetch: async () => new Promise<Response>(() => undefined),
      requestTimeoutMs: 10,
    });
    const bodyClient = new CashuMintProofStateHttpClient(MINT_URL, {
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      requestTimeoutMs: 10,
    });

    await expect(requestClient.checkProofStates([PROOF_Y_A])).rejects.toMatchObject({
      code: "request_timeout",
    });
    await expect(bodyClient.checkProofStates([PROOF_Y_A])).rejects.toMatchObject({
      code: "request_timeout",
    });
  });

  it("rejects redirects, invalid configuration, malformed requests, and cancellation", async () => {
    const redirected = jsonResponse({ states: [] });
    Object.defineProperties(redirected, {
      redirected: { value: true },
      url: { value: "https://other.example/v1/checkstate" },
    });
    const redirectedClient = new CashuMintProofStateHttpClient(MINT_URL, {
      fetch: async () => redirected,
    });
    await expect(redirectedClient.checkProofStates([PROOF_Y_A])).rejects.toMatchObject({
      code: "invalid_response",
    });

    expect(() => new CashuMintProofStateHttpClient("http://mint.example")).toThrow(
      CashuMintProofStateHttpError,
    );
    expect(
      () =>
        new CashuMintProofStateHttpClient(MINT_URL, {
          requestTimeoutMs: MAX_CASHU_PROOF_STATE_REQUEST_TIMEOUT_MS + 1,
        }),
    ).toThrow(CashuMintProofStateHttpError);
    expect(
      () =>
        new CashuMintProofStateHttpClient(MINT_URL, {
          maxResponseBytes: MAX_CASHU_PROOF_STATE_RESPONSE_BYTES + 1,
        }),
    ).toThrow(CashuMintProofStateHttpError);

    let requestCount = 0;
    const client = new CashuMintProofStateHttpClient(MINT_URL, {
      fetch: async () => {
        requestCount += 1;
        return jsonResponse({ states: [] });
      },
    });
    await expect(client.checkProofStates([])).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.checkProofStates([PROOF_Y_A, PROOF_Y_A])).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      client.checkProofStates([`02${"ff".repeat(32)}` as CashuProofY]),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.checkProofStates([PROOF_Y_A], { signal: {} as AbortSignal }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(client.checkProofStates(new Array(1) as string[])).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      client.checkProofStates(
        Array.from({ length: MAX_CASHU_PROOF_STATES_PER_SNAPSHOT + 1 }, () => PROOF_Y_A),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.checkProofStates([PROOF_Y_A], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "request_aborted" });
    expect(requestCount).toBe(0);

    const inFlightController = new AbortController();
    const inFlightClient = new CashuMintProofStateHttpClient(MINT_URL, {
      fetch: async () => new Promise<Response>(() => undefined),
    });
    const inFlightRequest = inFlightClient.checkProofStates([PROOF_Y_A], {
      signal: inFlightController.signal,
    });
    inFlightController.abort();
    await expect(inFlightRequest).rejects.toMatchObject({ code: "request_aborted" });
    expect(CashuMintProofStateHttpError.prototype).toBeInstanceOf(Error);
  });
});

class FixtureProofStateSource implements CashuMintProofStateSource {
  readonly mintUrl = MINT_URL;
  readonly requests: string[][] = [];
  failure: Error | undefined;

  constructor(public response: unknown) {}

  async checkProofStates(
    proofYs: readonly string[],
    options: CashuProofStateReadOptions = {},
  ): Promise<unknown> {
    this.requests.push([...proofYs]);
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.response;
  }
}

function proofReference(y: CashuProofY): CashuProofReferenceV1 {
  return createCashuProofReferenceV1({ amount: 1, keysetId: KEYSET_ID, y });
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
