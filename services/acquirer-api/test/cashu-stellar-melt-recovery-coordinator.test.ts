import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
  CASHU_STELLAR_TESTNET_USDC_ISSUER,
  CASHU_STELLAR_UNIT,
  CashuStellarMeltQuoteClientError,
  createCashuProofReferenceV1,
  createCashuProofStateSnapshotV1,
  createCashuStellarMeltQuoteRequestV1,
  createCashuStellarMeltQuoteV1,
} from "@cashmesh/cashu";
import {
  acceptInvoicePaymentV1,
  createInvoiceV1,
  invoiceId,
  journalEntryId,
  merchantId,
  minorUnits,
  operatorId,
  paymentId,
  settlementAssetAccount,
  settlementAssetId,
  unixTimestamp,
} from "@cashmesh/domain";
import { describe, expect, it } from "vitest";

import {
  type AcceptCashuInvoicePaymentInput,
  CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
  type CashuProofReservationLifecycleV1,
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuOperatorReference,
  cashuReservationLifecycleEventId,
  type RecordCashuOperatorPendingInput,
  type ReleaseCashuProofReservationInput,
  type RequireCashuOperatorAttentionInput,
} from "../src/cashu-proof-reservation-lifecycle-repository";
import {
  CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
  type CashuProofReservationV1,
} from "../src/cashu-proof-reservation-repository";
import {
  CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
  type CashuStellarMeltQuoteAttemptV1,
  cashuStellarMeltQuoteAttemptId,
} from "../src/cashu-stellar-melt-quote-repository";
import {
  CashuStellarMeltRecoveryCoordinator,
  type CashuStellarMeltRecoveryCoordinatorDependencies,
  CashuStellarMeltRecoveryCoordinatorError,
} from "../src/cashu-stellar-melt-recovery-coordinator";

const MINT_URL = "https://mint-a.cashmesh.example";
const OTHER_MINT_URL = "https://mint-b.cashmesh.example";
const NOW = 1_788_800_000;
const QUOTE_EXPIRY = NOW + 10;
const QUOTE_ID = "019e6d5a-2347-7000-89e2-35fe79f92c0e";
const PROOF_Y_A = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const PROOF_Y_B = "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5";
const DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const PAYMENT_ID = paymentId("payment-recovery-001");
const INVOICE_ID = invoiceId("invoice-recovery-001");
const OPERATOR_ID = operatorId("operator-a");
const EFFECT_ID = cashuOperatorEffectId("effect-recovery-001");
const REQUEST = stellarPaymentRequest();

describe("CashuStellarMeltRecoveryCoordinator", () => {
  it("accepts one confirmed paid melt from exact later spent proof evidence", async () => {
    const fixture = recoveryFixture({
      proofObservedAt: NOW + 2,
      proofStates: ["SPENT", "SPENT"],
      quoteObservedAt: NOW + 1,
      quoteState: "PAID",
    });

    const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

    expect(fixture.log).toEqual([
      "reservation.find",
      "lifecycle.find",
      "quote.find",
      "quote.check",
      "quote.persist",
      "proof.observe",
      "proof.persist",
      "lifecycle.accept",
    ]);
    expect(fixture.captured.acceptance).toMatchObject({
      effectId: EFFECT_ID,
      evidenceAt: NOW + 1,
      evidenceKind: "melt_paid",
      feeAmount: 0,
      paymentId: PAYMENT_ID,
      proofStateObservedAt: NOW + 2,
      recordedAt: NOW + 3,
    });
    expect(fixture.captured.acceptance?.eventId).toMatch(
      /^stellar-melt-recovery-accepted:[0-9a-f]{64}$/,
    );
    expect(fixture.captured.acceptance?.journalEntryId).toMatch(
      /^stellar-melt-payment:[0-9a-f]{64}$/,
    );
    expect(result).toMatchObject({
      accounting: { invoice: { state: "paid" } },
      lifecycle: { state: "consumed" },
      paymentId: PAYMENT_ID,
      replayed: false,
      schemaVersion: 1,
      state: "accepted",
    });
    expect(JSON.stringify(result)).not.toMatch(/web\+stellar|proof_y|destination/i);
  });

  it("releases only an expired unpaid quote with exact later unspent proof evidence", async () => {
    const fixture = recoveryFixture({
      clock: () => NOW + 13,
      proofObservedAt: NOW + 12,
      proofStates: ["UNSPENT", "UNSPENT"],
      quoteObservedAt: NOW + 11,
      quoteState: "UNPAID",
    });

    const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

    expect(fixture.captured.release).toMatchObject({
      effectId: EFFECT_ID,
      evidenceAt: NOW + 11,
      evidenceKind: "melt_unpaid_after_expiry",
      kind: "after_failure",
      proofStateObservedAt: NOW + 12,
      recordedAt: NOW + 13,
    });
    expect(result).toMatchObject({
      lifecycle: { state: "released" },
      replayed: false,
      state: "released",
    });
    expect(fixture.log).not.toContain("lifecycle.accept");
  });

  it("persists a pending observation without accepting or releasing", async () => {
    const fixture = recoveryFixture({
      proofObservedAt: NOW + 2,
      proofStates: ["PENDING", "PENDING"],
      quoteObservedAt: NOW + 1,
      quoteState: "PENDING",
    });

    const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

    expect(fixture.captured.pending).toMatchObject({
      evidenceAt: NOW + 1,
      paymentId: PAYMENT_ID,
      recordedAt: NOW + 3,
    });
    expect(result).toMatchObject({
      lifecycle: { state: "pending" },
      proofStateObservedAt: NOW + 2,
      quoteObservedAt: NOW + 1,
      state: "pending",
    });
    expect(fixture.log).not.toContain("lifecycle.accept");
    expect(fixture.log).not.toContain("lifecycle.release");
  });

  it("keeps a pre-expiry unpaid and unspent effect recoverable without inventing failure", async () => {
    const fixture = recoveryFixture({
      proofObservedAt: NOW + 2,
      proofStates: ["UNSPENT", "UNSPENT"],
      quoteObservedAt: NOW + 1,
      quoteState: "UNPAID",
    });

    const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({ lifecycle: { state: "dispatch_started" }, state: "pending" });
    expect(fixture.log).not.toContain("lifecycle.pending");
    expect(fixture.log).not.toContain("lifecycle.release");
  });

  it.each([
    { proofStates: ["PENDING", "PENDING"] as const, quoteState: "PAID" as const },
    { proofStates: ["SPENT", "UNSPENT"] as const, quoteState: "PAID" as const },
    { proofStates: ["SPENT", "SPENT"] as const, quoteState: "PENDING" as const },
  ])("retains inconsistent $quoteState evidence for attention", async (options) => {
    const fixture = recoveryFixture({
      proofObservedAt: NOW + 2,
      proofStates: options.proofStates,
      quoteObservedAt: NOW + 1,
      quoteState: options.quoteState,
    });

    const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      attentionReason: "operator_state_unknown",
      lifecycle: { state: "needs_attention" },
      state: "needs_attention",
    });
    expect(fixture.log).toContain("lifecycle.attention");
    expect(fixture.log).not.toContain("lifecycle.accept");
    expect(fixture.log).not.toContain("lifecycle.release");
  });

  it("records an invalid quote observation as invalid operator response", async () => {
    const fixture = recoveryFixture({
      quoteError: new CashuStellarMeltQuoteClientError(
        "quote_response_mismatch",
        "sanitized fixture mismatch",
      ),
    });

    const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

    expect(result).toMatchObject({
      attentionReason: "operator_response_invalid",
      state: "needs_attention",
    });
    expect(fixture.log).toEqual([
      "reservation.find",
      "lifecycle.find",
      "quote.find",
      "quote.check",
      "lifecycle.attention",
    ]);
  });

  it.each(["proof", "quote"] as const)(
    "does not act when durable %s persistence acknowledges different evidence",
    async (kind) => {
      const fixture = recoveryFixture({
        proofObservedAt: NOW + 2,
        proofStates: ["SPENT", "SPENT"],
        quoteObservedAt: NOW + 1,
        quoteState: "PAID",
      });
      if (kind === "quote") {
        fixture.dependencies.quoteRepository.observe = async () => ({
          attempt: quoteAttempt(quote({ observedAt: NOW + 1, state: "PENDING" })),
          replayed: true,
        });
      } else {
        fixture.dependencies.proofStateRepository.persistObservation = async () => ({
          replayed: true,
          snapshot: proofSnapshot(["UNSPENT", "UNSPENT"], NOW + 2),
        });
      }

      const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

      expect(result).toMatchObject({
        attentionReason: "operator_state_unknown",
        state: "needs_attention",
      });
      expect(fixture.log).not.toContain("lifecycle.accept");
      expect(fixture.log).not.toContain("lifecycle.release");
    },
  );

  it.each(["attention", "pending"] as const)(
    "converges on an equivalent concurrent %s event with a different completion time",
    async (kind) => {
      const fixture = recoveryFixture({
        proofObservedAt: NOW + 2,
        proofStates: kind === "pending" ? ["PENDING", "PENDING"] : ["SPENT", "UNSPENT"],
        quoteObservedAt: NOW + 1,
        quoteState: kind === "pending" ? "PENDING" : "PAID",
      });
      if (kind === "pending") {
        fixture.dependencies.lifecycleRepository.recordPending = async (input) => {
          fixture.setLifecycle(
            pendingLifecycle(fixture.getLifecycle(), {
              ...input,
              recordedAt: unixTimestamp(input.recordedAt + 1),
            }),
          );
          throw new Error("concurrent pending fixture");
        };
      } else {
        fixture.dependencies.lifecycleRepository.requireAttention = async (input) => {
          fixture.setLifecycle(
            attentionLifecycle(fixture.getLifecycle(), {
              ...input,
              recordedAt: unixTimestamp(input.recordedAt + 1),
            }),
          );
          throw new Error("concurrent attention fixture");
        };
      }

      const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

      expect(result.state).toBe(kind === "pending" ? "pending" : "needs_attention");
      expect(result.lifecycle.events).toHaveLength(2);
      expect(result.lifecycle.events.at(-1)?.recordedAt).toBe(NOW + 4);
    },
  );

  it.each(["attention", "pending"] as const)(
    "does not treat an old matching %s event as the current concurrent result",
    async (kind) => {
      const fixture = recoveryFixture({
        proofObservedAt: NOW + 2,
        proofStates: kind === "pending" ? ["PENDING", "PENDING"] : ["SPENT", "UNSPENT"],
        quoteObservedAt: NOW + 1,
        quoteState: kind === "pending" ? "PENDING" : "PAID",
      });
      if (kind === "pending") {
        fixture.dependencies.lifecycleRepository.recordPending = async (input) => {
          const matching = pendingLifecycle(fixture.getLifecycle(), {
            ...input,
            recordedAt: unixTimestamp(input.recordedAt + 1),
          });
          fixture.setLifecycle(
            pendingLifecycle(matching, {
              ...input,
              eventId: cashuReservationLifecycleEventId("newer-pending-event"),
              evidenceAt: unixTimestamp(input.evidenceAt + 1),
              recordedAt: unixTimestamp(input.recordedAt + 2),
            }),
          );
          throw new Error("historical pending fixture");
        };
      } else {
        fixture.dependencies.lifecycleRepository.requireAttention = async (input) => {
          const matching = attentionLifecycle(fixture.getLifecycle(), {
            ...input,
            recordedAt: unixTimestamp(input.recordedAt + 1),
          });
          fixture.setLifecycle(
            attentionLifecycle(matching, {
              ...input,
              eventId: cashuReservationLifecycleEventId("newer-attention-event"),
              evidenceAt: unixTimestamp(input.evidenceAt + 1),
              recordedAt: unixTimestamp(input.recordedAt + 2),
            }),
          );
          throw new Error("historical attention fixture");
        };
      }

      await expect(fixture.coordinator.recover({ paymentId: PAYMENT_ID })).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      expect(fixture.getLifecycle().events).toHaveLength(3);
    },
  );

  it.each(["consumed", "released"] as const)(
    "returns an existing %s terminal result without another operator observation",
    async (state) => {
      const fixture = recoveryFixture({ existingLifecycle: terminalLifecycle(state) });

      const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

      expect(result.state).toBe(state === "consumed" ? "accepted" : "released");
      expect(result).toMatchObject({ replayed: true });
      expect(fixture.log).toEqual(
        state === "consumed"
          ? ["reservation.find", "lifecycle.find", "lifecycle.accounting.find"]
          : ["reservation.find", "lifecycle.find"],
      );
    },
  );

  it.each(["proof", "quote"] as const)(
    "converges on a concurrent terminal release while persisting %s evidence",
    async (kind) => {
      const fixture = recoveryFixture({
        proofObservedAt: NOW + 2,
        proofStates: ["SPENT", "SPENT"],
        quoteObservedAt: NOW + 1,
        quoteState: "PAID",
      });
      if (kind === "quote") {
        fixture.dependencies.quoteRepository.observe = async () => {
          fixture.setLifecycle(terminalLifecycle("released"));
          throw new Error("concurrent terminal fixture");
        };
      } else {
        fixture.dependencies.proofStateRepository.persistObservation = async () => {
          fixture.setLifecycle(terminalLifecycle("released"));
          throw new Error("concurrent terminal fixture");
        };
      }

      const result = await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

      expect(result).toMatchObject({ replayed: true, state: "released" });
      expect(fixture.log).not.toContain("lifecycle.accept");
      expect(fixture.log).not.toContain("lifecycle.attention");
    },
  );

  it("routes both observations through the mint bound to the reservation", async () => {
    const fixture = recoveryFixture({
      proofObservedAt: NOW + 2,
      proofStates: ["PENDING", "PENDING"],
      quoteObservedAt: NOW + 1,
      quoteState: "PENDING",
      withUnrelatedObservers: true,
    });

    await fixture.coordinator.recover({ paymentId: PAYMENT_ID });

    expect(fixture.log).not.toContain("unrelated.quote");
    expect(fixture.log).not.toContain("unrelated.proof");
  });

  it("supports preflight cancellation without reading durable state", async () => {
    const fixture = recoveryFixture({
      clock: () => {
        throw new Error("clock must not be read");
      },
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.coordinator.recover({ paymentId: PAYMENT_ID, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "request_aborted" });
    expect(fixture.log).toEqual([]);
  });

  it("rejects an absent effect, invalid request, and duplicate operator configuration", async () => {
    const fixture = recoveryFixture({ existingLifecycle: reservedLifecycle() });

    await expect(fixture.coordinator.recover({ paymentId: PAYMENT_ID })).rejects.toMatchObject({
      code: "effect_not_recoverable",
    });
    await expect(
      fixture.coordinator.recover({ paymentId: "bad payment id" }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(
      () =>
        new CashuStellarMeltRecoveryCoordinator({
          ...fixture.dependencies,
          quoteCheckers: [
            fixture.dependencies.quoteCheckers[0] as NonNullable<
              (typeof fixture.dependencies.quoteCheckers)[number]
            >,
            fixture.dependencies.quoteCheckers[0] as NonNullable<
              (typeof fixture.dependencies.quoteCheckers)[number]
            >,
          ],
        }),
    ).toThrow(CashuStellarMeltRecoveryCoordinatorError);
  });
});

interface RecoveryFixtureOptions {
  readonly clock?: () => number;
  readonly existingLifecycle?: CashuProofReservationLifecycleV1;
  readonly proofError?: Error;
  readonly proofObservedAt?: number;
  readonly proofStates?: readonly ("PENDING" | "SPENT" | "UNSPENT")[];
  readonly quoteError?: Error;
  readonly quoteObservedAt?: number;
  readonly quoteState?: "PAID" | "PENDING" | "UNPAID";
  readonly withUnrelatedObservers?: boolean;
}

interface RecoveryFixture {
  readonly captured: {
    acceptance?: AcceptCashuInvoicePaymentInput;
    attention?: RequireCashuOperatorAttentionInput;
    pending?: RecordCashuOperatorPendingInput;
    release?: ReleaseCashuProofReservationInput;
  };
  readonly coordinator: CashuStellarMeltRecoveryCoordinator;
  readonly dependencies: CashuStellarMeltRecoveryCoordinatorDependencies;
  readonly getLifecycle: () => CashuProofReservationLifecycleV1;
  readonly log: string[];
  readonly setLifecycle: (lifecycle: CashuProofReservationLifecycleV1) => void;
}

function recoveryFixture(options: RecoveryFixtureOptions = {}): RecoveryFixture {
  const log: string[] = [];
  const captured: RecoveryFixture["captured"] = {};
  const reservation = reservationFixture();
  let lifecycle = options.existingLifecycle ?? startedLifecycle();
  let attempt = quoteAttempt();
  const quoteChecker = {
    mintUrl: MINT_URL,
    async check() {
      log.push("quote.check");
      if (options.quoteError !== undefined) {
        throw options.quoteError;
      }
      return quote({
        observedAt: options.quoteObservedAt ?? NOW + 1,
        state: options.quoteState ?? "PAID",
      });
    },
  };
  const proofObserver = {
    mintUrl: MINT_URL,
    async observe() {
      log.push("proof.observe");
      if (options.proofError !== undefined) {
        throw options.proofError;
      }
      return proofSnapshot(
        options.proofStates ?? ["SPENT", "SPENT"],
        options.proofObservedAt ?? NOW + 2,
      );
    },
  };
  const dependencies: CashuStellarMeltRecoveryCoordinatorDependencies = {
    lifecycleRepository: {
      async acceptPayment(input) {
        log.push("lifecycle.accept");
        captured.acceptance = input;
        const accounting = acceptedAccounting(input);
        lifecycle = consumedLifecycle(lifecycle, input);
        return { accounting, lifecycle, replayed: false };
      },
      async findAcceptedPaymentByPaymentId() {
        log.push("lifecycle.accounting.find");
        return acceptedAccounting({
          effectId: EFFECT_ID,
          eventId: cashuReservationLifecycleEventId("terminal-event"),
          evidenceAt: unixTimestamp(NOW + 1),
          evidenceKind: "melt_paid",
          feeAmount: minorUnits(0),
          journalEntryId: journalEntryId("terminal-journal"),
          paymentId: PAYMENT_ID,
          proofStateObservedAt: unixTimestamp(NOW + 2),
          recordedAt: unixTimestamp(NOW + 3),
        });
      },
      async findByPaymentId() {
        log.push("lifecycle.find");
        return lifecycle;
      },
      async recordPending(input) {
        log.push("lifecycle.pending");
        captured.pending = input;
        lifecycle = pendingLifecycle(lifecycle, input);
        return { lifecycle, replayed: false };
      },
      async release(input) {
        log.push("lifecycle.release");
        captured.release = input;
        lifecycle = releasedLifecycle(lifecycle, input);
        return { lifecycle, replayed: false };
      },
      async requireAttention(input) {
        log.push("lifecycle.attention");
        captured.attention = input;
        lifecycle = attentionLifecycle(lifecycle, input);
        return { lifecycle, replayed: false };
      },
    },
    proofStateObservers: [
      ...(options.withUnrelatedObservers
        ? [
            {
              mintUrl: OTHER_MINT_URL,
              async observe() {
                log.push("unrelated.proof");
                throw new Error("Wrong proof observer selected.");
              },
            },
          ]
        : []),
      proofObserver,
    ],
    proofStateRepository: {
      async persistObservation(input) {
        log.push("proof.persist");
        return { replayed: false, snapshot: input.snapshot };
      },
    },
    quoteCheckers: [
      ...(options.withUnrelatedObservers
        ? [
            {
              mintUrl: OTHER_MINT_URL,
              async check() {
                log.push("unrelated.quote");
                throw new Error("Wrong quote checker selected.");
              },
            },
          ]
        : []),
      quoteChecker,
    ],
    quoteRepository: {
      async findByPaymentId() {
        log.push("quote.find");
        return attempt;
      },
      async observe(input) {
        log.push("quote.persist");
        attempt = quoteAttempt(input.quote);
        return { attempt, replayed: false };
      },
    },
    reservationRepository: {
      async findByPaymentId() {
        log.push("reservation.find");
        return reservation;
      },
    },
  };
  return {
    captured,
    coordinator: new CashuStellarMeltRecoveryCoordinator(dependencies, {
      clock: options.clock ?? (() => NOW + 3),
    }),
    dependencies,
    getLifecycle() {
      return lifecycle;
    },
    log,
    setLifecycle(nextLifecycle) {
      lifecycle = nextLifecycle;
    },
  };
}

function reservationFixture(): CashuProofReservationV1 {
  return Object.freeze({
    grossAmount: minorUnits(2),
    invoiceId: INVOICE_ID,
    keysetObservedAt: unixTimestamp(NOW - 10),
    mintUrl: MINT_URL,
    operatorId: OPERATOR_ID,
    paymentId: PAYMENT_ID,
    proofReferences: Object.freeze(
      [PROOF_Y_A, PROOF_Y_B].map((y) =>
        createCashuProofReferenceV1({ amount: 1, keysetId: "000f715baf5d4c2e", y }),
      ),
    ),
    reservedAt: unixTimestamp(NOW - 5),
    schemaVersion: CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
    unit: CASHU_STELLAR_UNIT,
  });
}

function quoteAttempt(
  latestQuote = quote(),
): Extract<CashuStellarMeltQuoteAttemptV1, { readonly state: "quoted" }> {
  const initial = quote();
  return Object.freeze({
    attemptId: cashuStellarMeltQuoteAttemptId("attempt-recovery-001"),
    invoiceId: INVOICE_ID,
    latestQuote,
    mintUrl: MINT_URL,
    observations: Object.freeze(
      latestQuote.observedAt === initial.observedAt ? [initial] : [initial, latestQuote],
    ),
    operatorId: OPERATOR_ID,
    paymentId: PAYMENT_ID,
    request: createCashuStellarMeltQuoteRequestV1({ amount: 2, request: REQUEST }),
    schemaVersion: CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
    startedAt: unixTimestamp(NOW - 4),
    state: "quoted",
  });
}

function quote(
  overrides: { readonly observedAt?: number; readonly state?: "PAID" | "PENDING" | "UNPAID" } = {},
) {
  return createCashuStellarMeltQuoteV1({
    amount: 2,
    expiry: QUOTE_EXPIRY,
    feeReserve: 0,
    method: CASHU_STELLAR_METHOD,
    mintUrl: MINT_URL,
    observedAt: overrides.observedAt ?? NOW - 2,
    quoteId: QUOTE_ID,
    request: REQUEST,
    state: overrides.state ?? "UNPAID",
    unit: CASHU_STELLAR_UNIT,
  });
}

function proofSnapshot(states: readonly ("PENDING" | "SPENT" | "UNSPENT")[], observedAt: number) {
  return createCashuProofStateSnapshotV1({
    mintUrl: MINT_URL,
    observedAt,
    states: [PROOF_Y_A, PROOF_Y_B].map((y, position) => ({
      state: states[position] ?? "UNSPENT",
      y,
    })),
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

function startedLifecycle(): CashuProofReservationLifecycleV1 {
  return Object.freeze({
    effect: Object.freeze({
      dispatchFingerprint: cashuOperatorDispatchFingerprint("a".repeat(64)),
      effectId: EFFECT_ID,
      kind: "melt",
      operatorReference: cashuOperatorReference(QUOTE_ID),
      operatorReferenceExpiresAt: unixTimestamp(QUOTE_EXPIRY),
      schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
      startedAt: unixTimestamp(NOW - 1),
    }),
    events: Object.freeze([
      Object.freeze({
        eventId: cashuReservationLifecycleEventId("event-dispatch-started"),
        recordedAt: unixTimestamp(NOW - 1),
        sequence: 0,
        state: "dispatch_started" as const,
      }),
    ]),
    paymentId: PAYMENT_ID,
    schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
    state: "dispatch_started",
  });
}

function terminalLifecycle(state: "consumed" | "released"): CashuProofReservationLifecycleV1 {
  const lifecycle = startedLifecycle();
  return Object.freeze({
    ...lifecycle,
    events: Object.freeze([
      ...lifecycle.events,
      Object.freeze(
        state === "consumed"
          ? {
              eventId: cashuReservationLifecycleEventId("event-consumed"),
              evidenceAt: unixTimestamp(NOW + 1),
              evidenceKind: "melt_paid" as const,
              journalEntryId: journalEntryId("terminal-journal"),
              proofStateObservedAt: unixTimestamp(NOW + 2),
              recordedAt: unixTimestamp(NOW + 3),
              sequence: 1,
              state,
            }
          : {
              eventId: cashuReservationLifecycleEventId("event-released"),
              evidenceAt: unixTimestamp(NOW + 11),
              evidenceKind: "melt_unpaid_after_expiry" as const,
              proofStateObservedAt: unixTimestamp(NOW + 12),
              recordedAt: unixTimestamp(NOW + 13),
              sequence: 1,
              state,
            },
      ),
    ]),
    state,
  });
}

function pendingLifecycle(
  lifecycle: CashuProofReservationLifecycleV1,
  input: RecordCashuOperatorPendingInput,
): CashuProofReservationLifecycleV1 {
  return Object.freeze({
    ...lifecycle,
    events: Object.freeze([
      ...lifecycle.events,
      Object.freeze({
        eventId: input.eventId,
        evidenceAt: input.evidenceAt,
        evidenceKind: "operator_pending" as const,
        recordedAt: input.recordedAt,
        sequence: lifecycle.events.length,
        state: "pending" as const,
      }),
    ]),
    state: "pending",
  });
}

function attentionLifecycle(
  lifecycle: CashuProofReservationLifecycleV1,
  input: RequireCashuOperatorAttentionInput,
): CashuProofReservationLifecycleV1 {
  return Object.freeze({
    ...lifecycle,
    events: Object.freeze([
      ...lifecycle.events,
      Object.freeze({
        eventId: input.eventId,
        evidenceAt: input.evidenceAt,
        evidenceKind: input.reason,
        recordedAt: input.recordedAt,
        sequence: lifecycle.events.length,
        state: "needs_attention" as const,
      }),
    ]),
    state: "needs_attention",
  });
}

function consumedLifecycle(
  lifecycle: CashuProofReservationLifecycleV1,
  input: AcceptCashuInvoicePaymentInput,
): CashuProofReservationLifecycleV1 {
  return Object.freeze({
    ...lifecycle,
    events: Object.freeze([
      ...lifecycle.events,
      Object.freeze({
        eventId: input.eventId,
        evidenceAt: input.evidenceAt,
        evidenceKind: "melt_paid" as const,
        journalEntryId: input.journalEntryId,
        proofStateObservedAt: input.proofStateObservedAt,
        recordedAt: input.recordedAt,
        sequence: lifecycle.events.length,
        state: "consumed" as const,
      }),
    ]),
    state: "consumed",
  });
}

function releasedLifecycle(
  lifecycle: CashuProofReservationLifecycleV1,
  input: ReleaseCashuProofReservationInput,
): CashuProofReservationLifecycleV1 {
  if (input.kind !== "after_failure") {
    throw new Error("Expected an after-failure release.");
  }
  return Object.freeze({
    ...lifecycle,
    events: Object.freeze([
      ...lifecycle.events,
      Object.freeze({
        eventId: input.eventId,
        evidenceAt: input.evidenceAt,
        evidenceKind: input.evidenceKind,
        proofStateObservedAt: input.proofStateObservedAt,
        recordedAt: input.recordedAt,
        sequence: lifecycle.events.length,
        state: "released" as const,
      }),
    ]),
    state: "released",
  });
}

function acceptedAccounting(input: AcceptCashuInvoicePaymentInput) {
  const invoice = createInvoiceV1({
    amount: minorUnits(2),
    createdAt: unixTimestamp(NOW - 20),
    expiresAt: unixTimestamp(NOW + 100),
    id: INVOICE_ID,
    merchantId: merchantId("merchant-001"),
  });
  return acceptInvoicePaymentV1(invoice, {
    acceptedAt: input.proofStateObservedAt,
    assetAccount: settlementAssetAccount(settlementAssetId("stellar-testnet-usdc-circle")),
    effectiveAt: input.recordedAt,
    feeAmount: input.feeAmount,
    journalEntryId: input.journalEntryId,
    operatorId: OPERATOR_ID,
    paymentId: PAYMENT_ID,
    settlementMode: "immediate_conversion",
  });
}

function stellarPaymentRequest(): string {
  const parameters = new URLSearchParams({
    amount: "0.02",
    asset_code: CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
    asset_issuer: CASHU_STELLAR_TESTNET_USDC_ISSUER,
    destination: DESTINATION,
    network_passphrase: CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  });
  return `web+stellar:pay?${parameters.toString()}`;
}
