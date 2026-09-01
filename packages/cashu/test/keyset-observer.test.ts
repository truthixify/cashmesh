import { createNewMintKeys, serializeMintKeys } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import {
  CASHU_KEYSET_OBSERVATION_CONCURRENCY,
  CashuKeysetObservationError,
  CashuKeysetObserver,
  type CashuKeysetReadOptions,
  type CashuKeysetSnapshotEntryInputV1,
  CashuMintKeysetHttpClient,
  CashuMintKeysetHttpError,
  type CashuMintKeysetSource,
  MAX_CASHU_KEYSET_METADATA_ENTRIES,
  MAX_CASHU_KEYSET_REQUEST_TIMEOUT_MS,
  MAX_CASHU_KEYSET_RESPONSE_BYTES,
  MAX_CASHU_KEYSETS_PER_SNAPSHOT,
} from "../src";

const MINT_URL = "https://mint.cashmesh.example/operator";
const NOW = 1_788_200_000;

describe("CashuKeysetObserver", () => {
  it("observes a stable, unit-scoped NUT-01 and NUT-02 snapshot", async () => {
    const active = testKeyset(21, 125);
    const inactive = testKeyset(22, 750, {
      active: false,
      finalExpiry: NOW + 3_600,
    });
    const metadata = {
      keysets: [
        metadataResponse(inactive),
        { active: true, id: `02${"ab".repeat(32)}`, unit: "sat" },
        metadataResponse(active),
      ],
    };
    const source = new FixtureKeysetSource(
      [metadata, structuredClone(metadata)],
      [active, inactive],
    );
    const observer = new CashuKeysetObserver(source, { clock: sequenceClock(NOW - 2, NOW) });

    const snapshot = await observer.observe({ unit: "usdc" });

    expect(snapshot).toEqual({
      keysets: [active.entry, inactive.entry].sort((left, right) => (left.id < right.id ? -1 : 1)),
      mintUrl: MINT_URL,
      observedAt: NOW,
      schemaVersion: 1,
    });
    expect(source.metadataReads).toBe(2);
    expect(source.keyReads.sort()).toEqual([active.entry.id, inactive.entry.id].sort());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.keysets)).toBe(true);
    expect(Object.isFrozen(snapshot.keysets[0]?.keys)).toBe(true);
  });

  it("limits concurrent key reads", async () => {
    const fixtures = Array.from({ length: 9 }, (_, index) => testKeyset(30 + index, index));
    const metadata = { keysets: fixtures.map(metadataResponse) };
    const source = new FixtureKeysetSource([metadata, metadata], fixtures, 5);
    const observer = new CashuKeysetObserver(source, { clock: sequenceClock(NOW - 1, NOW) });

    await observer.observe({ unit: "usdc" });

    expect(source.maximumConcurrentKeyReads).toBe(CASHU_KEYSET_OBSERVATION_CONCURRENCY);
  });

  it("rejects keyset rotation during an observation", async () => {
    const fixture = testKeyset(41, 100);
    const initial = metadataResponse(fixture);
    const source = new FixtureKeysetSource(
      [{ keysets: [initial] }, { keysets: [{ ...initial, active: false }] }],
      [fixture],
    );
    const observer = new CashuKeysetObserver(source, { clock: sequenceClock(NOW - 1, NOW) });

    await expect(observer.observe({ unit: "usdc" })).rejects.toMatchObject({
      code: "keyset_metadata_changed",
    });
  });

  it.each([
    {
      name: "the requested identifier",
      mutate: (response: Record<string, unknown>) => ({ ...response, id: `00${"1".repeat(14)}` }),
    },
    {
      name: "the requested unit",
      mutate: (response: Record<string, unknown>) => ({ ...response, unit: "sat" }),
    },
    {
      name: "the active flag",
      mutate: (response: Record<string, unknown>) => ({ ...response, active: false }),
    },
    {
      name: "the input fee",
      mutate: (response: Record<string, unknown>) => ({ ...response, input_fee_ppk: 101 }),
    },
    {
      name: "the final expiry",
      mutate: (response: Record<string, unknown>) => ({
        ...response,
        final_expiry: NOW + 3_600,
      }),
    },
  ])("rejects a keys response that changes $name", async ({ mutate }) => {
    const fixture = testKeyset(42, 100);
    const metadata = { keysets: [metadataResponse(fixture)] };
    const response = mutate(keysResponseEntry(fixture));
    const source = new FixtureKeysetSource([metadata, metadata], [fixture]);
    source.keyResponses.set(fixture.entry.id, { keysets: [response] });
    const observer = new CashuKeysetObserver(source, { clock: sequenceClock(NOW - 1, NOW) });

    await expect(observer.observe({ unit: "usdc" })).rejects.toMatchObject({
      code: "keyset_response_mismatch",
    });
  });

  it("rejects invalid public keys after joining keyset metadata", async () => {
    const fixture = testKeyset(43, 0);
    const metadata = { keysets: [metadataResponse(fixture)] };
    const source = new FixtureKeysetSource([metadata, metadata], [fixture]);
    source.keyResponses.set(fixture.entry.id, {
      keysets: [{ ...keysResponseEntry(fixture), keys: { "1": `02${"00".repeat(32)}` } }],
    });
    const observer = new CashuKeysetObserver(source, { clock: sequenceClock(NOW - 1, NOW) });

    await expect(observer.observe({ unit: "usdc" })).rejects.toMatchObject({
      code: "invalid_keyset_response",
    });
  });

  it("bounds metadata before requesting individual keys", async () => {
    const tooMany = Array.from({ length: MAX_CASHU_KEYSET_METADATA_ENTRIES + 1 }, () => ({
      unit: "sat",
    }));
    const source = new FixtureKeysetSource([{ keysets: tooMany }], []);
    const observer = new CashuKeysetObserver(source, { clock: () => NOW });

    await expect(observer.observe({ unit: "usdc" })).rejects.toMatchObject({
      code: "keyset_limit_exceeded",
    });
    expect(source.keyReads).toEqual([]);
  });

  it("bounds selected keysets and reports a missing unit", async () => {
    const tooManyForUnit = Array.from(
      { length: MAX_CASHU_KEYSETS_PER_SNAPSHOT + 1 },
      (_, index) => ({
        active: true,
        id: `00${index.toString(16).padStart(14, "0")}`,
        unit: "usdc",
      }),
    );
    const limitedSource = new FixtureKeysetSource([{ keysets: tooManyForUnit }], []);
    const missingSource = new FixtureKeysetSource(
      [{ keysets: [{ active: true, id: `00${"1".repeat(14)}`, unit: "sat" }] }],
      [],
    );

    await expect(
      new CashuKeysetObserver(limitedSource, { clock: () => NOW }).observe({ unit: "usdc" }),
    ).rejects.toMatchObject({ code: "keyset_limit_exceeded" });
    await expect(
      new CashuKeysetObserver(missingSource, { clock: () => NOW }).observe({ unit: "usdc" }),
    ).rejects.toMatchObject({ code: "keyset_unit_not_found" });
  });

  it("rejects a keyset identifier reused across units", async () => {
    const fixture = testKeyset(45, 0);
    const response = metadataResponse(fixture);
    const source = new FixtureKeysetSource(
      [{ keysets: [response, { ...response, unit: "sat" }] }],
      [fixture],
    );

    await expect(
      new CashuKeysetObserver(source, { clock: () => NOW }).observe({ unit: "usdc" }),
    ).rejects.toMatchObject({ code: "invalid_keyset_response" });
    expect(source.keyReads).toEqual([]);
  });

  it("rejects malformed input, clocks, and source failures with stable errors", async () => {
    const fixture = testKeyset(44, 0);
    const metadata = { keysets: [metadataResponse(fixture)] };
    const source = new FixtureKeysetSource([metadata, metadata], [fixture]);
    const invalidClock = new CashuKeysetObserver(source, { clock: () => -1 });

    await expect(
      invalidClock.observe(null as unknown as { readonly unit: string }),
    ).rejects.toMatchObject({ code: "invalid_observation_input" });
    await expect(
      invalidClock.observe({ signal: {} as AbortSignal, unit: "usdc" }),
    ).rejects.toMatchObject({ code: "invalid_observation_input" });
    await expect(invalidClock.observe({ unit: "usdc" })).rejects.toMatchObject({
      code: "invalid_clock",
    });
    await expect(
      new CashuKeysetObserver(source, {
        clock: sequenceClock(NOW, NOW - 1),
      }).observe({ unit: "usdc" }),
    ).rejects.toMatchObject({ code: "invalid_clock" });
    expect(CashuKeysetObservationError.prototype).toBeInstanceOf(Error);

    source.failure = new Error("fixture source unavailable");
    await expect(
      new CashuKeysetObserver(source, { clock: () => NOW }).observe({ unit: "usdc" }),
    ).rejects.toMatchObject({ code: "source_unavailable" });
  });

  it("rejects a caller-aborted observation before reading the source", async () => {
    const source = new FixtureKeysetSource([], []);
    const controller = new AbortController();
    controller.abort();

    await expect(
      new CashuKeysetObserver(source, { clock: () => NOW }).observe({
        signal: controller.signal,
        unit: "usdc",
      }),
    ).rejects.toMatchObject({ code: "observation_aborted" });
    expect(source.metadataReads).toBe(0);
  });
});

describe("CashuMintKeysetHttpClient", () => {
  it("provides a complete snapshot to the observer through HTTP fixtures", async () => {
    const fixture = testKeyset(51, 250);
    const calls: string[] = [];
    const fetchFixture: typeof fetch = async (input) => {
      const endpoint = String(input);
      calls.push(endpoint);
      if (endpoint === `${MINT_URL}/v1/keysets`) {
        return jsonResponse({ keysets: [metadataResponse(fixture)] });
      }
      if (endpoint === `${MINT_URL}/v1/keys/${fixture.entry.id}`) {
        return jsonResponse({ keysets: [keysResponseEntry(fixture)] });
      }
      throw new Error("Unexpected fixture endpoint.");
    };
    const client = new CashuMintKeysetHttpClient(MINT_URL, { fetch: fetchFixture });
    const observer = new CashuKeysetObserver(client, { clock: sequenceClock(NOW - 1, NOW) });

    const snapshot = await observer.observe({ unit: "usdc" });

    expect(snapshot.keysets).toEqual([fixture.entry]);
    expect(calls).toEqual([
      `${MINT_URL}/v1/keysets`,
      `${MINT_URL}/v1/keys/${fixture.entry.id}`,
      `${MINT_URL}/v1/keysets`,
    ]);
  });

  it("uses exact HTTPS endpoints and a credential-free, non-redirecting GET policy", async () => {
    const calls: Array<{ readonly init?: RequestInit; readonly url: string }> = [];
    const fetchFixture: typeof fetch = async (input, init) => {
      calls.push({ ...(init !== undefined && { init }), url: String(input) });
      return jsonResponse({ keysets: [] });
    };
    const client = new CashuMintKeysetHttpClient(`${MINT_URL}/`, { fetch: fetchFixture });
    const keysetId = `00${"a".repeat(14)}`;

    await client.getKeysets();
    await client.getKeys(keysetId);

    expect(calls.map((call) => call.url)).toEqual([
      `${MINT_URL}/v1/keysets`,
      `${MINT_URL}/v1/keys/${keysetId}`,
    ]);
    expect(calls[0]?.init).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json" },
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
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
        throw new Error("fixture network failure");
      },
      options: {},
    },
  ])("maps bounded HTTP failure to $code", async ({ code, fetch: fetchFixture, options }) => {
    const client = new CashuMintKeysetHttpClient(MINT_URL, {
      fetch: fetchFixture as typeof fetch,
      ...options,
    });

    await expect(client.getKeysets()).rejects.toMatchObject({ code });
  });

  it("times out a request that does not complete", async () => {
    const fetchFixture: typeof fetch = async () => new Promise<Response>(() => undefined);
    const client = new CashuMintKeysetHttpClient(MINT_URL, {
      fetch: fetchFixture,
      requestTimeoutMs: 10,
    });

    await expect(client.getKeysets()).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("times out while a successful response body is stalled", async () => {
    const fetchFixture: typeof fetch = async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    const client = new CashuMintKeysetHttpClient(MINT_URL, {
      fetch: fetchFixture,
      requestTimeoutMs: 10,
    });

    await expect(client.getKeysets()).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("rejects invalid configuration, keyset paths, and caller cancellation", async () => {
    expect(() => new CashuMintKeysetHttpClient("http://mint.example")).toThrow(
      CashuMintKeysetHttpError,
    );
    expect(
      () =>
        new CashuMintKeysetHttpClient(MINT_URL, {
          requestTimeoutMs: MAX_CASHU_KEYSET_REQUEST_TIMEOUT_MS + 1,
        }),
    ).toThrow(CashuMintKeysetHttpError);
    expect(
      () =>
        new CashuMintKeysetHttpClient(MINT_URL, {
          maxResponseBytes: MAX_CASHU_KEYSET_RESPONSE_BYTES + 1,
        }),
    ).toThrow(CashuMintKeysetHttpError);

    const client = new CashuMintKeysetHttpClient(MINT_URL, {
      fetch: async () => jsonResponse({ keysets: [] }),
    });
    await expect(client.getKeys("../info")).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client.getKeysets({ signal: controller.signal })).rejects.toMatchObject({
      code: "request_aborted",
    });
    await expect(client.getKeysets({ signal: {} as AbortSignal })).rejects.toMatchObject({
      code: "invalid_configuration",
    });
    expect(CashuMintKeysetHttpError.prototype).toBeInstanceOf(Error);
  });
});

interface TestKeyset {
  readonly entry: CashuKeysetSnapshotEntryInputV1;
}

class FixtureKeysetSource implements CashuMintKeysetSource {
  readonly keyReads: string[] = [];
  readonly keyResponses = new Map<string, unknown>();
  readonly mintUrl = MINT_URL;
  failure?: Error;
  maximumConcurrentKeyReads = 0;
  metadataReads = 0;

  private concurrentKeyReads = 0;

  constructor(
    private readonly metadataResponses: readonly unknown[],
    fixtures: readonly TestKeyset[],
    private readonly delayMs = 0,
  ) {
    for (const fixture of fixtures) {
      this.keyResponses.set(fixture.entry.id, { keysets: [keysResponseEntry(fixture)] });
    }
  }

  async getKeysets(options: CashuKeysetReadOptions = {}): Promise<unknown> {
    this.throwIfUnavailable(options);
    const response = this.metadataResponses[this.metadataReads];
    this.metadataReads += 1;
    if (response === undefined) {
      throw new Error("Missing fixture metadata response.");
    }
    return response;
  }

  async getKeys(keysetId: string, options: CashuKeysetReadOptions = {}): Promise<unknown> {
    this.throwIfUnavailable(options);
    this.keyReads.push(keysetId);
    this.concurrentKeyReads += 1;
    this.maximumConcurrentKeyReads = Math.max(
      this.maximumConcurrentKeyReads,
      this.concurrentKeyReads,
    );
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      const response = this.keyResponses.get(keysetId);
      if (response === undefined) {
        throw new Error("Missing fixture key response.");
      }
      return response;
    } finally {
      this.concurrentKeyReads -= 1;
    }
  }

  private throwIfUnavailable(options: CashuKeysetReadOptions): void {
    if (options.signal?.aborted) {
      throw options.signal.reason;
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }
}

function testKeyset(
  seedByte: number,
  inputFeePpk: number,
  options: { readonly active?: boolean; readonly finalExpiry?: number } = {},
): TestKeyset {
  const pair = createNewMintKeys(8, new Uint8Array(32).fill(seedByte), {
    ...(options.finalExpiry !== undefined && { expiry: options.finalExpiry }),
    input_fee_ppk: inputFeePpk,
    unit: "usdc",
    versionByte: 1,
  });
  return {
    entry: {
      active: options.active ?? true,
      ...(options.finalExpiry !== undefined && { finalExpiry: options.finalExpiry }),
      id: pair.keysetId,
      inputFeePpk,
      keys: serializeMintKeys(pair.pubKeys),
      unit: "usdc",
    },
  };
}

function metadataResponse(fixture: TestKeyset): Record<string, unknown> {
  return {
    active: fixture.entry.active,
    ...(fixture.entry.finalExpiry !== undefined && { final_expiry: fixture.entry.finalExpiry }),
    id: fixture.entry.id,
    input_fee_ppk: fixture.entry.inputFeePpk,
    unit: fixture.entry.unit,
  };
}

function keysResponseEntry(fixture: TestKeyset): Record<string, unknown> {
  return {
    ...metadataResponse(fixture),
    keys: Object.fromEntries(
      Object.entries(fixture.entry.keys).map(([amount, key]) => [amount, key.toUpperCase()]),
    ),
  };
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value ?? values.at(-1) ?? NOW;
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
