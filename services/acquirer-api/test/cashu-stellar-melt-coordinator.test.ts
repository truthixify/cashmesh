import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_UNIT,
  type CashuBearerProofBundleV1,
  CashuStellarMeltExecutionClientError,
  type CashuStellarMeltExecutionResultV1,
  type CashuStellarMeltQuoteV1,
  createCashuKeysetSnapshotV1,
  createCashuProofReferenceV1,
  createCashuStellarMeltQuoteV1,
} from "@cashmesh/cashu";
import { invoiceId, operatorId, paymentId, unixTimestamp } from "@cashmesh/domain";
import { describe, expect, it } from "vitest";
import {
  CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
  type CashuProofReservationLifecycleV1,
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuOperatorReference,
  cashuReservationLifecycleEventId,
  type RequireCashuOperatorAttentionInput,
  type StartCashuOperatorEffectInput,
} from "../src/cashu-proof-reservation-lifecycle-repository";
import {
  CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
  type CashuProofReservationV1,
} from "../src/cashu-proof-reservation-repository";
import {
  CashuStellarMeltCoordinator,
  type CashuStellarMeltCoordinatorDependencies,
  CashuStellarMeltCoordinatorError,
} from "../src/cashu-stellar-melt-coordinator";
import {
  CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
  type CashuStellarMeltQuoteAttemptV1,
  cashuStellarMeltQuoteAttemptId,
} from "../src/cashu-stellar-melt-quote-repository";

const MINT_URL = "https://mint-a.cashmesh.example";
const OTHER_MINT_URL = "https://mint-b.cashmesh.example";
const NOW = 1_788_500_000;
const KEYSET_OBSERVED_AT = NOW - 20;
const RESERVED_AT = NOW - 10;
const QUOTE_OBSERVED_AT = NOW - 2;
const QUOTE_EXPIRY = NOW + 600;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_Y_A = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const PROOF_Y_B = "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5";
const QUOTE_ID = "01890f3c-7b62-7a4f-bc7d-1a2b3c4d5e6f";
const DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const REQUEST = stellarPaymentRequest();
const PAYMENT_ID = paymentId("payment-coordinator-001");
const INVOICE_ID = invoiceId("invoice-coordinator-001");
const OPERATOR_ID = operatorId("operator-a");

describe("CashuStellarMeltCoordinator", () => {
  it("derives historical fees and authorizes one pending melt after effect persistence", async () => {
    const fixture = coordinatorFixture();

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(fixture.log).toEqual([
      "reservation.find",
      "lifecycle.find",
      "quote.find",
      "keyset.find",
      "custody.open",
      "executor.execute",
      "lifecycle.start",
      "executor.network",
      "quote.observe",
      "lifecycle.pending",
    ]);
    expect(fixture.captured.inputFee).toBe(1);
    expect(fixture.captured.keysetLookup).toEqual({
      mintUrl: MINT_URL,
      observedAtOrAfter: KEYSET_OBSERVED_AT,
      observedAtOrBefore: KEYSET_OBSERVED_AT,
      operatorId: OPERATOR_ID,
      unit: "usdc",
    });
    expect(fixture.captured.startEffect).toMatchObject({
      dispatchFingerprint: "a".repeat(64),
      kind: "melt",
      operatorReference: QUOTE_ID,
      operatorReferenceExpiresAt: QUOTE_EXPIRY,
      paymentId: PAYMENT_ID,
      startedAt: NOW + 1,
    });
    expect(fixture.captured.startEffect?.effectId).toMatch(/^stellar-melt:[0-9a-f]{64}$/);
    expect(fixture.captured.startEffect?.eventId).toMatch(/^stellar-melt-start:[0-9a-f]{64}$/);
    expect(result).toMatchObject({
      lifecycle: { state: "pending" },
      observedAt: NOW + 2,
      paymentId: PAYMENT_ID,
      schemaVersion: 1,
      state: "operator_pending",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/test-only-secret|signature|web\+stellar/i);
  });

  it("returns recovery immediately when an effect already exists", async () => {
    const fixture = coordinatorFixture({ existingLifecycle: startedLifecycle(startInput()) });

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      lifecycle: { state: "dispatch_started" },
      state: "recovery_required",
    });
    expect(fixture.log).toEqual(["reservation.find", "lifecycle.find"]);
  });

  it("routes execution through the mint bound to the reservation", async () => {
    const fixture = coordinatorFixture();
    const configuredExecutor = fixture.dependencies.executors[0];
    if (configuredExecutor === undefined) {
      throw new Error("Fixture executor is missing.");
    }
    let unrelatedCalls = 0;
    const coordinator = new CashuStellarMeltCoordinator(
      {
        ...fixture.dependencies,
        executors: [
          {
            mintUrl: OTHER_MINT_URL,
            async execute() {
              unrelatedCalls += 1;
              throw new Error("Wrong operator selected.");
            },
          },
          configuredExecutor,
        ],
      },
      { clock: sequenceClock(NOW, NOW + 1, NOW + 3) },
    );

    const result = await coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result.state).toBe("operator_pending");
    expect(unrelatedCalls).toBe(0);
  });

  it("turns a concurrent exact start replay into recovery without a second network call", async () => {
    const fixture = coordinatorFixture({ startReplay: true });

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      lifecycle: { state: "dispatch_started" },
      state: "recovery_required",
    });
    expect(fixture.log).toContain("lifecycle.start");
    expect(fixture.log).not.toContain("executor.network");
    expect(fixture.log).not.toContain("quote.observe");
  });

  it.each([
    ["UNPAID", "operator_unpaid"],
    ["PAID", "operator_paid_observed"],
  ] as const)("persists %s without claiming proof consumption", async (operatorState, state) => {
    const fixture = coordinatorFixture({ executionState: operatorState });

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      lifecycle: { state: "dispatch_started" },
      observedAt: NOW + 2,
      state,
    });
    expect(fixture.log).toContain("quote.observe");
    expect(fixture.log).not.toContain("lifecycle.pending");
    expect(fixture.log).not.toContain("lifecycle.attention");
  });

  it.each([
    ["network_error", "transport_ambiguous"],
    ["request_timeout", "transport_ambiguous"],
    ["invalid_response", "operator_response_invalid"],
    ["response_too_large", "operator_response_invalid"],
    ["quote_expired", "operator_state_unknown"],
  ] as const)("records %s after authorization as %s", async (code, reason) => {
    const fixture = coordinatorFixture({
      executionError: new CashuStellarMeltExecutionClientError(code, "sanitized fixture failure"),
    });

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      attentionReason: reason,
      lifecycle: { state: "needs_attention" },
      state: "needs_attention",
    });
    expect(fixture.captured.attention).toMatchObject({ reason });
    expect(fixture.log).toContain("executor.network");
    expect(fixture.log).toContain("lifecycle.attention");
    expect(fixture.log).not.toContain("quote.observe");
  });

  it("records an authority/response mismatch as invalid operator response", async () => {
    const fixture = coordinatorFixture({ mismatchExecutionDispatch: true });

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      attentionReason: "operator_response_invalid",
      state: "needs_attention",
    });
    expect(fixture.log).not.toContain("quote.observe");
  });

  it("records a missing runtime result after authorization as unknown operator state", async () => {
    const fixture = coordinatorFixture({ missingExecutionResult: true });

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      attentionReason: "operator_state_unknown",
      lifecycle: { state: "needs_attention" },
      state: "needs_attention",
    });
    expect(fixture.log).toContain("executor.network");
    expect(fixture.log).toContain("lifecycle.attention");
    expect(fixture.log).not.toContain("quote.observe");
  });

  it.each([NOW, NOW + 4])(
    "records an operator observation at %s outside the effect clock window",
    async (executionObservedAt) => {
      const fixture = coordinatorFixture({ executionObservedAt });

      const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

      expect(result).toMatchObject({
        attentionReason: "operator_state_unknown",
        lifecycle: { state: "needs_attention" },
        state: "needs_attention",
      });
      expect(fixture.log).not.toContain("quote.observe");
      expect(fixture.log).toContain("lifecycle.attention");
    },
  );

  it("records outcome-persistence failure as unknown operator state", async () => {
    const fixture = coordinatorFixture({
      quoteObserveError: new Error("test-only storage detail"),
    });

    const result = await fixture.coordinator.dispatch({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      attentionReason: "operator_state_unknown",
      state: "needs_attention",
    });
    expect(fixture.log).toEqual(expect.arrayContaining(["quote.observe", "lifecycle.attention"]));
  });

  it("does not contact an operator when durable effect persistence fails", async () => {
    const fixture = coordinatorFixture({ startError: new Error("test-only start failure") });

    await expect(fixture.coordinator.dispatch({ paymentId: PAYMENT_ID })).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(fixture.log).toContain("lifecycle.start");
    expect(fixture.log).not.toContain("executor.network");
    expect(fixture.log).not.toContain("lifecycle.attention");
  });

  it.each([
    {
      code: "reservation_not_found",
      name: "a missing reservation",
      options: { missingReservation: true },
    },
    {
      code: "quote_not_dispatchable",
      name: "a missing quote",
      options: { missingQuote: true },
    },
    {
      code: "quote_not_dispatchable",
      name: "a nonzero fee reserve",
      options: { quote: quote({ feeReserve: 1 }) },
    },
    {
      code: "quote_not_dispatchable",
      name: "a pending quote",
      options: { quote: quote({ state: "PENDING" }) },
    },
    {
      code: "keyset_evidence_missing",
      name: "missing keyset evidence",
      options: { missingSnapshot: true },
    },
    {
      code: "evidence_invalid",
      name: "an expired proof keyset",
      options: { snapshotFinalExpiry: NOW },
    },
    {
      code: "evidence_invalid",
      name: "a changed historical input fee",
      options: { snapshotInputFeePpk: 0 },
    },
    {
      code: "evidence_invalid",
      name: "duplicate persisted proof references",
      options: {
        reservation: reservationFixture({
          proofYs: [PROOF_Y_A, PROOF_Y_A],
        }),
      },
    },
    {
      code: "evidence_invalid",
      name: "noncanonical persisted proof order",
      options: {
        reservation: reservationFixture({
          proofYs: [PROOF_Y_B, PROOF_Y_A],
        }),
      },
    },
    {
      code: "operator_not_configured",
      name: "an unconfigured operator",
      options: { executorMintUrl: OTHER_MINT_URL },
    },
    {
      code: "custody_not_found",
      name: "missing bearer custody",
      options: { missingCustody: true },
    },
  ])("rejects $name before effect persistence", async ({ code, options }) => {
    const fixture = coordinatorFixture(options);

    await expect(fixture.coordinator.dispatch({ paymentId: PAYMENT_ID })).rejects.toMatchObject({
      code,
    });
    expect(fixture.log).not.toContain("lifecycle.start");
    expect(fixture.log).not.toContain("executor.network");
  });

  it("supports preflight cancellation without reading durable state", async () => {
    const fixture = coordinatorFixture({
      clock: () => {
        throw new Error("clock must not be read");
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.coordinator.dispatch({ paymentId: PAYMENT_ID, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "request_aborted" });
    expect(fixture.log).toEqual([]);
  });

  it("rejects invalid configuration and requests", async () => {
    const fixture = coordinatorFixture();

    await expect(
      fixture.coordinator.dispatch({ paymentId: "bad payment id" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      fixture.coordinator.dispatch({
        paymentId: PAYMENT_ID,
        signal: {} as AbortSignal,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fixture.log).toEqual([]);

    expect(
      () =>
        new CashuStellarMeltCoordinator({
          ...fixture.dependencies,
          executors: [],
        }),
    ).toThrow(CashuStellarMeltCoordinatorError);
    expect(() => {
      const configuredExecutor = fixture.dependencies.executors[0];
      if (configuredExecutor === undefined) {
        throw new Error("Fixture executor is missing.");
      }
      return new CashuStellarMeltCoordinator({
        ...fixture.dependencies,
        executors: [configuredExecutor, configuredExecutor],
      });
    }).toThrow(CashuStellarMeltCoordinatorError);
    expect(CashuStellarMeltCoordinatorError.prototype).toBeInstanceOf(Error);
  });
});

interface CoordinatorFixtureOptions {
  readonly clock?: () => number;
  readonly executionError?: Error;
  readonly executionObservedAt?: number;
  readonly executionState?: "PAID" | "PENDING" | "UNPAID";
  readonly executorMintUrl?: string;
  readonly existingLifecycle?: CashuProofReservationLifecycleV1;
  readonly mismatchExecutionDispatch?: boolean;
  readonly missingCustody?: boolean;
  readonly missingExecutionResult?: boolean;
  readonly missingQuote?: boolean;
  readonly missingReservation?: boolean;
  readonly missingSnapshot?: boolean;
  readonly quote?: CashuStellarMeltQuoteV1;
  readonly quoteObserveError?: Error;
  readonly reservation?: CashuProofReservationV1;
  readonly snapshotFinalExpiry?: number;
  readonly snapshotInputFeePpk?: number;
  readonly startError?: Error;
  readonly startReplay?: boolean;
}

interface CoordinatorFixture {
  readonly captured: {
    attention?: RequireCashuOperatorAttentionInput;
    inputFee?: number;
    keysetLookup?: unknown;
    startEffect?: StartCashuOperatorEffectInput;
  };
  readonly coordinator: CashuStellarMeltCoordinator;
  readonly dependencies: CashuStellarMeltCoordinatorDependencies;
  readonly log: string[];
}

function coordinatorFixture(options: CoordinatorFixtureOptions = {}): CoordinatorFixture {
  const log: string[] = [];
  const captured: CoordinatorFixture["captured"] = {};
  const reservation = options.reservation ?? reservationFixture();
  const selectedQuote = options.quote ?? quote();
  const attempt = quoteAttempt(selectedQuote);
  let lifecycle = options.existingLifecycle ?? reservedLifecycle();
  const executor = {
    mintUrl: options.executorMintUrl ?? MINT_URL,
    execute: async (input): Promise<CashuStellarMeltExecutionResultV1> => {
      log.push("executor.execute");
      captured.inputFee = input.inputFee;
      const dispatch = dispatchFixture(input.quote);
      const authorized = await input.authorize(dispatch);
      if (!authorized) {
        throw new CashuStellarMeltExecutionClientError(
          "dispatch_not_authorized",
          "Fixture dispatch was not authorized.",
        );
      }
      log.push("executor.network");
      if (options.executionError !== undefined) {
        throw options.executionError;
      }
      if (options.missingExecutionResult) {
        return undefined as unknown as CashuStellarMeltExecutionResultV1;
      }
      const resultDispatch = options.mismatchExecutionDispatch
        ? Object.freeze({ ...dispatch, dispatchFingerprint: "b".repeat(64) })
        : dispatch;
      return Object.freeze({
        dispatch: resultDispatch,
        quote: quote({
          observedAt: options.executionObservedAt ?? NOW + 2,
          state: options.executionState ?? "PENDING",
        }),
      }) as CashuStellarMeltExecutionResultV1;
    },
  } satisfies CashuStellarMeltCoordinatorDependencies["executors"][number];

  const dependencies: CashuStellarMeltCoordinatorDependencies = {
    custodyRepository: {
      async withDecryptedBundle(_paymentId, use) {
        log.push("custody.open");
        if (options.missingCustody) {
          return undefined;
        }
        return await use(bearerBundle());
      },
    },
    executors: [executor],
    keysetRepository: {
      async findLatestFreshSnapshot(input) {
        log.push("keyset.find");
        captured.keysetLookup = input;
        return options.missingSnapshot
          ? undefined
          : keysetSnapshot({
              ...(options.snapshotFinalExpiry !== undefined && {
                finalExpiry: options.snapshotFinalExpiry,
              }),
              ...(options.snapshotInputFeePpk !== undefined && {
                inputFeePpk: options.snapshotInputFeePpk,
              }),
            });
      },
    },
    lifecycleRepository: {
      async findByPaymentId() {
        log.push("lifecycle.find");
        return lifecycle;
      },
      async recordPending(input) {
        log.push("lifecycle.pending");
        lifecycle = pendingLifecycle(lifecycle, input);
        return { lifecycle, replayed: false };
      },
      async requireAttention(input) {
        log.push("lifecycle.attention");
        captured.attention = input;
        lifecycle = attentionLifecycle(lifecycle, input);
        return { lifecycle, replayed: false };
      },
      async startEffect(input) {
        log.push("lifecycle.start");
        captured.startEffect = input;
        if (options.startError !== undefined) {
          throw options.startError;
        }
        lifecycle = startedLifecycle(input);
        return { lifecycle, replayed: options.startReplay ?? false };
      },
    },
    quoteRepository: {
      async findByPaymentId() {
        log.push("quote.find");
        return options.missingQuote ? undefined : attempt;
      },
      async observe(input) {
        log.push("quote.observe");
        if (options.quoteObserveError !== undefined) {
          throw options.quoteObserveError;
        }
        return {
          attempt: quoteAttempt(input.quote, [selectedQuote, input.quote]),
          replayed: false,
        };
      },
    },
    reservationRepository: {
      async findByPaymentId() {
        log.push("reservation.find");
        return options.missingReservation ? undefined : reservation;
      },
    },
  };
  const coordinator = new CashuStellarMeltCoordinator(dependencies, {
    clock: options.clock ?? sequenceClock(NOW, NOW + 1, NOW + 3, NOW + 4),
  });
  return { captured, coordinator, dependencies, log };
}

function reservationFixture(
  options: { readonly proofYs?: readonly string[] } = {},
): CashuProofReservationV1 {
  const proofYs = options.proofYs ?? [PROOF_Y_A, PROOF_Y_B];
  return Object.freeze({
    grossAmount: proofYs.length,
    invoiceId: INVOICE_ID,
    keysetObservedAt: unixTimestamp(KEYSET_OBSERVED_AT),
    mintUrl: MINT_URL,
    operatorId: OPERATOR_ID,
    paymentId: PAYMENT_ID,
    proofReferences: Object.freeze(
      proofYs.map((y) =>
        createCashuProofReferenceV1({
          amount: 1,
          keysetId: KEYSET_ID,
          y,
        }),
      ),
    ),
    reservedAt: unixTimestamp(RESERVED_AT),
    schemaVersion: CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
    unit: CASHU_STELLAR_UNIT,
  });
}

function keysetSnapshot(options: { readonly finalExpiry?: number; readonly inputFeePpk?: number }) {
  return createCashuKeysetSnapshotV1({
    keysets: [
      {
        active: false,
        ...(options.finalExpiry !== undefined && { finalExpiry: options.finalExpiry }),
        id: KEYSET_ID,
        inputFeePpk: options.inputFeePpk ?? 500,
        keys: { "1": KEYSET_PUBLIC_KEY },
        unit: CASHU_STELLAR_UNIT,
      },
    ],
    mintUrl: MINT_URL,
    observedAt: KEYSET_OBSERVED_AT,
  });
}

function quote(overrides: Readonly<Record<string, unknown>> = {}): CashuStellarMeltQuoteV1 {
  return createCashuStellarMeltQuoteV1({
    amount: 1,
    expiry: QUOTE_EXPIRY,
    feeReserve: 0,
    method: CASHU_STELLAR_METHOD,
    mintUrl: MINT_URL,
    observedAt: QUOTE_OBSERVED_AT,
    quoteId: QUOTE_ID,
    request: REQUEST,
    state: "UNPAID",
    unit: CASHU_STELLAR_UNIT,
    ...overrides,
  } as Parameters<typeof createCashuStellarMeltQuoteV1>[0]);
}

function quoteAttempt(
  latestQuote: CashuStellarMeltQuoteV1,
  observations: readonly CashuStellarMeltQuoteV1[] = [latestQuote],
): CashuStellarMeltQuoteAttemptV1 {
  return Object.freeze({
    attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-coordinator-001"),
    invoiceId: INVOICE_ID,
    latestQuote,
    mintUrl: MINT_URL,
    observations: Object.freeze([...observations]),
    operatorId: OPERATOR_ID,
    paymentId: PAYMENT_ID,
    request: Object.freeze({
      amount: latestQuote.amount,
      method: CASHU_STELLAR_METHOD,
      request: latestQuote.request,
      unit: CASHU_STELLAR_UNIT,
    }),
    schemaVersion: CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
    startedAt: unixTimestamp(RESERVED_AT + 1),
    state: "quoted",
  });
}

function reservedLifecycle(): CashuProofReservationLifecycleV1 {
  return Object.freeze({
    events: Object.freeze([]),
    paymentId: PAYMENT_ID,
    schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
    state: "reserved",
  });
}

function startInput(): StartCashuOperatorEffectInput {
  return {
    dispatchFingerprint: cashuOperatorDispatchFingerprint("a".repeat(64)),
    effectId: cashuOperatorEffectId("stellar-melt:fixture"),
    eventId: cashuReservationLifecycleEventId("stellar-melt-start:fixture"),
    kind: "melt",
    operatorReference: cashuOperatorReference(QUOTE_ID),
    operatorReferenceExpiresAt: unixTimestamp(QUOTE_EXPIRY),
    paymentId: PAYMENT_ID,
    startedAt: unixTimestamp(NOW + 1),
  };
}

function startedLifecycle(input: StartCashuOperatorEffectInput): CashuProofReservationLifecycleV1 {
  if (input.kind !== "melt") {
    throw new Error("Fixture expects a melt effect.");
  }
  return Object.freeze({
    effect: Object.freeze({
      dispatchFingerprint: input.dispatchFingerprint,
      effectId: input.effectId,
      kind: "melt",
      operatorReference: input.operatorReference,
      operatorReferenceExpiresAt: input.operatorReferenceExpiresAt,
      schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
      startedAt: input.startedAt,
    }),
    events: Object.freeze([
      Object.freeze({
        eventId: input.eventId,
        recordedAt: input.startedAt,
        sequence: 0,
        state: "dispatch_started" as const,
      }),
    ]),
    paymentId: input.paymentId,
    schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
    state: "dispatch_started",
  });
}

function pendingLifecycle(
  current: CashuProofReservationLifecycleV1,
  input: Parameters<
    CashuStellarMeltCoordinatorDependencies["lifecycleRepository"]["recordPending"]
  >[0],
): CashuProofReservationLifecycleV1 {
  return Object.freeze({
    ...current,
    events: Object.freeze([
      ...current.events,
      Object.freeze({
        eventId: input.eventId,
        evidenceAt: input.evidenceAt,
        evidenceKind: "operator_pending" as const,
        recordedAt: input.recordedAt,
        sequence: current.events.length,
        state: "pending" as const,
      }),
    ]),
    state: "pending",
  });
}

function attentionLifecycle(
  current: CashuProofReservationLifecycleV1,
  input: RequireCashuOperatorAttentionInput,
): CashuProofReservationLifecycleV1 {
  return Object.freeze({
    ...current,
    events: Object.freeze([
      ...current.events,
      Object.freeze({
        eventId: input.eventId,
        evidenceAt: input.evidenceAt,
        evidenceKind: input.reason,
        recordedAt: input.recordedAt,
        sequence: current.events.length,
        state: "needs_attention" as const,
      }),
    ]),
    state: "needs_attention",
  });
}

function dispatchFixture(quoteSnapshot: CashuStellarMeltQuoteV1) {
  return Object.freeze({
    dispatchFingerprint: "a".repeat(
      64,
    ) as CashuStellarMeltExecutionResultV1["dispatch"]["dispatchFingerprint"],
    expiresAt: quoteSnapshot.expiry,
    method: CASHU_STELLAR_METHOD,
    mintUrl: quoteSnapshot.mintUrl,
    quoteId: quoteSnapshot.quoteId,
    schemaVersion: 1 as const,
  });
}

function bearerBundle(): CashuBearerProofBundleV1 {
  return Object.freeze({
    redacted: true,
    secret: "test-only-secret",
  }) as unknown as CashuBearerProofBundleV1;
}

function stellarPaymentRequest(): string {
  const parameters = new URLSearchParams();
  parameters.set("destination", DESTINATION);
  parameters.set("amount", "0.01");
  parameters.set("asset_code", "USDC");
  parameters.set("asset_issuer", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
  parameters.set("memo", "Y29vcmRpbmF0b3I=");
  parameters.set("memo_type", "MEMO_HASH");
  parameters.set("network_passphrase", "Test SDF Network ; September 2015");
  return `web+stellar:pay?${parameters.toString()}`;
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
