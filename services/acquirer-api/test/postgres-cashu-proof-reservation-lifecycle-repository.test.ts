import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
  CASHU_STELLAR_TESTNET_USDC_ISSUER,
  CASHU_STELLAR_UNIT,
  CashuPaymentRequestIssuer,
  type CashuProofStateValue,
  createCashuKeysetSnapshotV1,
  createCashuProofReferenceV1,
  createCashuProofStateSnapshotV1,
  createCashuStellarMeltQuoteV1,
} from "@cashmesh/cashu";
import {
  createInvoiceV1,
  idempotencyKey,
  invoiceId,
  merchantId,
  minorUnits,
  operatorId,
  paymentId,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool } from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CashuProofReservationLifecycleRepositoryError,
  type ConsumeCashuProofReservationInput,
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuOperatorReference,
  cashuReservationLifecycleEventId,
  type ReleaseCashuProofReservationInput,
  type StartCashuOperatorEffectInput,
} from "../src/cashu-proof-reservation-lifecycle-repository";
import type { ReserveCashuProofsInput } from "../src/cashu-proof-reservation-repository";
import type { PersistCashuProofStateObservation } from "../src/cashu-proof-state-repository";
import { cashuStellarMeltQuoteAttemptId } from "../src/cashu-stellar-melt-quote-repository";
import type { CreateOpenInvoiceRecord } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresCashuProofReservationLifecycleRepository } from "../src/postgres-cashu-proof-reservation-lifecycle-repository";
import { PostgresCashuProofReservationRepository } from "../src/postgres-cashu-proof-reservation-repository";
import { PostgresCashuProofStateRepository } from "../src/postgres-cashu-proof-state-repository";
import { PostgresCashuStellarMeltQuoteRepository } from "../src/postgres-cashu-stellar-melt-quote-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const MINT_A = "https://mint-a.cashmesh.example";
const CREATED_AT = 1_788_000_000;
const EXPIRES_AT = CREATED_AT + 300;
const RESERVED_AT = CREATED_AT + 1;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_Y_A = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const PROOF_Y_B = "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5";
const PROOF_Y_C = "02b79a5775181e7973cab6c33eea75d943d9974acefd4d2a267f0f76ef567915ff";
const MELT_QUOTE_ID = "019e6d5a-2347-7000-89e2-35fe79f92c0e";
const OTHER_MELT_QUOTE_ID = "019e6d5a-2348-7000-89e2-35fe79f92c0f";
const STELLAR_DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const MELT_REQUEST = stellarPaymentRequest(2);
const repositories: Array<{ close(): Promise<void> }> = [];
const CASHU_PAYMENT_REQUEST_ISSUER = new CashuPaymentRequestIssuer({
  operators: [
    {
      mintUrl: MINT_A,
      operatorId: operatorId("operator-a"),
      tier: "trusted",
    },
  ],
  transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
});

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL Cashu reservation lifecycle", () => {
  beforeAll(async () => {
    const repository = await PostgresCashuProofReservationLifecycleRepository.connect({
      connectionString: requireDatabaseUrl(),
    });
    await repository.close();
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(`
        TRUNCATE
          cashu_stellar_melt_quote_observations,
          cashu_stellar_melt_quote_outcomes,
          cashu_stellar_melt_quote_attempts,
          cashu_bearer_proof_custody,
          cashu_proof_custody_nonce_uses,
          cashu_proof_reservation_events,
          cashu_active_invoice_payment_claims,
          cashu_operator_effects,
          cashu_active_proof_claims,
          cashu_proof_state_observation_entries,
          cashu_proof_state_observations,
          cashu_reserved_proofs,
          cashu_proof_reservations,
          cashu_keyset_observation_entries,
          cashu_keyset_observations,
          cashu_keysets,
          invoice_cashu_request_operators,
          invoice_cashu_requests,
          invoice_creation_requests,
          merchant_invoices
      `);
    } finally {
      await pool.end();
    }
  });

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map(async (repository) => repository.close()));
  });

  it("reconstructs reserved and dispatch-started state across restart with exact replay", async () => {
    await seedReservation();
    const firstRepository = await connectLifecycleRepository();
    const reserved = await firstRepository.findByPaymentId(paymentId("payment-001"));
    const started = await firstRepository.startEffect(startSwap());
    await closeRepository(firstRepository);

    const restartedRepository = await connectLifecycleRepository();
    const found = await restartedRepository.findByPaymentId(paymentId("payment-001"));
    const replay = await restartedRepository.startEffect(startSwap());

    expect(reserved).toMatchObject({ events: [], state: "reserved" });
    expect(started.replayed).toBe(false);
    expect(found).toEqual(started.lifecycle);
    expect(replay).toEqual({ lifecycle: started.lifecycle, replayed: true });
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found?.events)).toBe(true);
    expect(JSON.stringify(found)).not.toMatch(/secret|signature|dleq|witness/i);
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 1 });
  });

  it("converges concurrent exact dispatch intents on one effect", async () => {
    await seedReservation();
    const firstRepository = await connectLifecycleRepository();
    const secondRepository = await connectLifecycleRepository();

    const [first, second] = await Promise.all([
      firstRepository.startEffect(startSwap()),
      secondRepository.startEffect(startSwap()),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.lifecycle).toEqual(second.lifecycle);
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 1 });
  });

  it("binds melt dispatch to one operator quote and rejects malformed effect shapes", async () => {
    await seedReservation();
    await seedMeltQuote();
    const repository = await connectLifecycleRepository();
    const melt = await repository.startEffect(startMelt());

    expect(melt.lifecycle.effect).toMatchObject({
      dispatchFingerprint: createFingerprint("effect-001"),
      effectId: "effect-001",
      kind: "melt",
      operatorReference: "019e6d5a-2347-7000-89e2-35fe79f92c0e",
      operatorReferenceExpiresAt: RESERVED_AT + 10,
    });
    await expect(repository.startEffect(startSwap())).rejects.toMatchObject({
      code: "effect_conflict",
    });

    await seedReservation({
      invoiceId: "invoice-002",
      paymentId: "payment-002",
      proofReferences: [proofReference(PROOF_Y_C)],
    });
    const malformed = {
      ...startSwap({ effectId: "effect-002", eventId: "event-002", paymentId: "payment-002" }),
      operatorReference: cashuOperatorReference("unexpected-reference"),
    } as StartCashuOperatorEffectInput;
    await expect(repository.startEffect(malformed)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("requires exact persisted quote evidence for every new melt effect", async () => {
    await seedReservation();
    const repository = await connectLifecycleRepository();

    await expect(repository.startEffect(startMelt())).rejects.toMatchObject({
      code: "quote_evidence_missing",
    });

    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const insertDirectMelt = (operatorReference: string) =>
        pool.query(
          `
            INSERT INTO cashu_operator_effects (
              effect_id,
              effect_fingerprint,
              dispatch_fingerprint,
              payment_id,
              invoice_id,
              operator_id,
              mint_url,
              effect_kind,
              operator_reference,
              operator_reference_expires_at,
              schema_version,
              started_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'melt', $8, $9, 1, $10)
          `,
          [
            "effect-direct",
            createFingerprint("effect-direct"),
            createFingerprint("dispatch-direct"),
            "payment-001",
            "invoice-001",
            "operator-a",
            MINT_A,
            operatorReference,
            RESERVED_AT + 10,
            RESERVED_AT + 1,
          ],
        );

      const missingQuote = await errorFromAsync(() => insertDirectMelt(MELT_QUOTE_ID));
      expect(missingQuote).toMatchObject({ code: "23514" });

      await seedMeltQuote();
      const wrongQuote = await errorFromAsync(() => insertDirectMelt(OTHER_MELT_QUOTE_ID));
      expect(wrongQuote).toMatchObject({ code: "23514" });
    } finally {
      await pool.end();
    }

    await expect(
      repository.startEffect(startMelt({ operatorReference: OTHER_MELT_QUOTE_ID })),
    ).rejects.toMatchObject({ code: "quote_evidence_mismatch" });
    await expect(
      repository.startEffect(startMelt({ operatorReferenceExpiresAt: RESERVED_AT + 11 })),
    ).rejects.toMatchObject({ code: "quote_evidence_mismatch" });
    await expectLifecycleCounts({ activeInvoices: 0, activeProofs: 2, effects: 0, events: 0 });
  });

  it("dispatches from current UNPAID evidence and replays after later quote states", async () => {
    await seedReservation();
    const quoteRepository = await seedMeltQuote();
    const lifecycleRepository = await connectLifecycleRepository();
    await quoteRepository.observe({
      attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: meltQuote({ observedAt: RESERVED_AT + 2, state: "PENDING" }),
    });

    await expect(
      lifecycleRepository.startEffect(startMelt({ startedAt: RESERVED_AT + 3 })),
    ).rejects.toMatchObject({ code: "quote_evidence_mismatch" });

    await quoteRepository.observe({
      attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: meltQuote({ observedAt: RESERVED_AT + 3, state: "UNPAID" }),
    });
    const input = startMelt({ startedAt: RESERVED_AT + 4 });
    const started = await lifecycleRepository.startEffect(input);
    await quoteRepository.observe({
      attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: meltQuote({ observedAt: RESERVED_AT + 5, state: "PAID" }),
    });

    const replay = await lifecycleRepository.startEffect(input);
    const recovered = await lifecycleRepository.findByPaymentId(paymentId("payment-001"));

    expect(started.replayed).toBe(false);
    expect(replay).toEqual({ lifecycle: started.lifecycle, replayed: true });
    expect(recovered).toEqual(started.lifecycle);
  });

  it("records pending and ambiguous evidence without releasing active claims", async () => {
    await seedReservation();
    await seedMeltQuote();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startMelt());
    await repository.recordPending({
      effectId: cashuOperatorEffectId("effect-001"),
      eventId: cashuReservationLifecycleEventId("event-pending"),
      evidenceAt: unixTimestamp(RESERVED_AT + 2),
      paymentId: paymentId("payment-001"),
      recordedAt: unixTimestamp(RESERVED_AT + 2),
    });
    const attention = await repository.requireAttention({
      effectId: cashuOperatorEffectId("effect-001"),
      eventId: cashuReservationLifecycleEventId("event-attention"),
      evidenceAt: unixTimestamp(RESERVED_AT + 3),
      paymentId: paymentId("payment-001"),
      reason: "transport_ambiguous",
      recordedAt: unixTimestamp(RESERVED_AT + 3),
    });

    expect(attention.lifecycle.state).toBe("needs_attention");
    expect(attention.lifecycle.events.map((event) => event.state)).toEqual([
      "dispatch_started",
      "pending",
      "needs_attention",
    ]);
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 3 });
  });

  it("does not model a NUT-03 swap as an operator-pending effect", async () => {
    await seedReservation();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startSwap());

    await expect(
      repository.recordPending({
        effectId: cashuOperatorEffectId("effect-001"),
        eventId: cashuReservationLifecycleEventId("event-pending"),
        evidenceAt: unixTimestamp(RESERVED_AT + 2),
        paymentId: paymentId("payment-001"),
        recordedAt: unixTimestamp(RESERVED_AT + 2),
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 1 });
  });

  it("does not release a melt before its quote has expired", async () => {
    await seedReservation();
    await seedMeltQuote();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startMelt());
    await persistProofState("UNSPENT", "UNSPENT", RESERVED_AT + 12);

    await expect(
      repository.release(
        releaseAfterFailure({
          evidenceAt: RESERVED_AT + 9,
          evidenceKind: "melt_unpaid_after_expiry",
          proofStateObservedAt: RESERVED_AT + 12,
          recordedAt: RESERVED_AT + 13,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    const released = await repository.release(
      releaseAfterFailure({
        evidenceAt: RESERVED_AT + 10,
        evidenceKind: "melt_unpaid_after_expiry",
        proofStateObservedAt: RESERVED_AT + 12,
        recordedAt: RESERVED_AT + 13,
      }),
    );

    expect(released.lifecycle.state).toBe("released");
  });

  it("consumes only after matching success and later exact all-SPENT evidence", async () => {
    await seedReservation();
    const lifecycleRepository = await connectLifecycleRepository();
    await lifecycleRepository.startEffect(startSwap());
    await persistProofState("SPENT", "SPENT", RESERVED_AT + 4);

    const consumed = await lifecycleRepository.consume(
      consumeInput({
        evidenceAt: RESERVED_AT + 3,
        proofStateObservedAt: RESERVED_AT + 4,
        recordedAt: RESERVED_AT + 5,
      }),
    );
    const replay = await lifecycleRepository.consume(
      consumeInput({
        evidenceAt: RESERVED_AT + 3,
        proofStateObservedAt: RESERVED_AT + 4,
        recordedAt: RESERVED_AT + 5,
      }),
    );

    expect(consumed.lifecycle.state).toBe("consumed");
    expect(replay).toEqual({ lifecycle: consumed.lifecycle, replayed: true });
    expect(consumed.lifecycle.events.at(-1)).toMatchObject({
      evidenceKind: "swap_succeeded",
      proofStateObservedAt: RESERVED_AT + 4,
      state: "consumed",
    });
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 2 });
    await expect(
      lifecycleRepository.requireAttention({
        effectId: cashuOperatorEffectId("effect-001"),
        eventId: cashuReservationLifecycleEventId("event-too-late"),
        evidenceAt: unixTimestamp(RESERVED_AT + 6),
        paymentId: paymentId("payment-001"),
        reason: "operator_state_unknown",
        recordedAt: unixTimestamp(RESERVED_AT + 6),
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("rejects missing, mixed, stale, or effect-mismatched consumption evidence", async () => {
    await seedReservation();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startSwap());

    await expect(repository.consume(consumeInput())).rejects.toMatchObject({
      code: "proof_state_evidence_missing",
    });
    await persistProofState("SPENT", "PENDING", RESERVED_AT + 4);
    await expect(repository.consume(consumeInput())).rejects.toMatchObject({
      code: "proof_state_evidence_missing",
    });
    await expect(
      repository.consume(consumeInput({ evidenceKind: "melt_paid" })),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await persistProofState("SPENT", "SPENT", RESERVED_AT + 5);
    await expect(
      repository.consume(
        consumeInput({
          evidenceAt: RESERVED_AT + 6,
          proofStateObservedAt: RESERVED_AT + 5,
          recordedAt: RESERVED_AT + 6,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 1 });
  });

  it("releases before dispatch and permits the same proofs to be claimed by a new payment", async () => {
    const reservationRepository = await seedReservation();
    const lifecycleRepository = await connectLifecycleRepository();
    const released = await lifecycleRepository.release({
      eventId: cashuReservationLifecycleEventId("event-release"),
      kind: "pre_dispatch",
      paymentId: paymentId("payment-001"),
      recordedAt: unixTimestamp(RESERVED_AT + 1),
    });

    expect(released.lifecycle.state).toBe("released");
    await expect(reservationRepository.reserve(reservationInput())).rejects.toMatchObject({
      code: "reservation_released",
    });
    await seedInvoice("invoice-002", "checkout-002");
    const reused = await reservationRepository.reserve(
      reservationInput({ invoiceId: "invoice-002", paymentId: "payment-002" }),
    );

    expect(reused.replayed).toBe(false);
    await expectLifecycleCounts({
      activeInvoices: 0,
      activeProofs: 2,
      effects: 0,
      events: 1,
      reservations: 2,
    });
  });

  it("releases after dispatch only with matching terminal failure and later all-UNSPENT evidence", async () => {
    const reservationRepository = await seedReservation();
    const lifecycleRepository = await connectLifecycleRepository();
    await lifecycleRepository.startEffect(startSwap());
    await persistProofState("UNSPENT", "UNSPENT", RESERVED_AT + 4);

    const released = await lifecycleRepository.release(
      releaseAfterFailure({
        evidenceAt: RESERVED_AT + 3,
        proofStateObservedAt: RESERVED_AT + 4,
        recordedAt: RESERVED_AT + 5,
      }),
    );
    const replay = await lifecycleRepository.release(
      releaseAfterFailure({
        evidenceAt: RESERVED_AT + 3,
        proofStateObservedAt: RESERVED_AT + 4,
        recordedAt: RESERVED_AT + 5,
      }),
    );

    expect(released.lifecycle.state).toBe("released");
    expect(replay).toEqual({ lifecycle: released.lifecycle, replayed: true });
    await seedInvoice("invoice-002", "checkout-002");
    await expect(
      reservationRepository.reserve(
        reservationInput({ invoiceId: "invoice-002", paymentId: "payment-002" }),
      ),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("never treats ambiguity, a mixed snapshot, or the wrong effect outcome as release evidence", async () => {
    await seedReservation();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startSwap());
    await persistProofState("UNSPENT", "PENDING", RESERVED_AT + 4);

    await expect(repository.release(releaseAfterFailure())).rejects.toMatchObject({
      code: "proof_state_evidence_missing",
    });
    await expect(
      repository.release(releaseAfterFailure({ evidenceKind: "melt_unpaid_after_expiry" })),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      repository.release({
        ...releaseAfterFailure(),
        evidenceKind: "transport_ambiguous",
      } as unknown as ReleaseCashuProofReservationInput),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 1 });
  });

  it("allows only one concurrent operator effect to own an invoice", async () => {
    await seedInvoice();
    await seedKeyset();
    const reservationRepository = await connectReservationRepository();
    await reservationRepository.reserve(
      reservationInput({ paymentId: "payment-a", proofReferences: [proofReference(PROOF_Y_A)] }),
    );
    await reservationRepository.reserve(
      reservationInput({ paymentId: "payment-b", proofReferences: [proofReference(PROOF_Y_B)] }),
    );
    const firstRepository = await connectLifecycleRepository();
    const secondRepository = await connectLifecycleRepository();

    const outcomes = await Promise.allSettled([
      firstRepository.startEffect(
        startSwap({ effectId: "effect-a", eventId: "event-a", paymentId: "payment-a" }),
      ),
      secondRepository.startEffect(
        startSwap({ effectId: "effect-b", eventId: "event-b", paymentId: "payment-b" }),
      ),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: "invoice_claimed" }),
      status: "rejected",
    });
    await expectLifecycleCounts({
      activeInvoices: 1,
      activeProofs: 2,
      effects: 1,
      events: 1,
      reservations: 2,
    });
  });

  it("does not bind one dispatch fingerprint to multiple payments", async () => {
    await seedReservation();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startSwap());
    await seedReservation({
      invoiceId: "invoice-002",
      paymentId: "payment-002",
      proofReferences: [proofReference(PROOF_Y_C)],
    });

    await expect(
      repository.startEffect(
        startSwap({
          dispatchFingerprint: createFingerprint("effect-001"),
          effectId: "effect-002",
          eventId: "event-002",
          paymentId: "payment-002",
        }),
      ),
    ).rejects.toMatchObject({ code: "effect_conflict" });
    await expectLifecycleCounts({
      activeInvoices: 1,
      activeProofs: 3,
      effects: 1,
      events: 1,
      reservations: 2,
    });
  });

  it("makes event identifiers immutable and exact-replay only", async () => {
    await seedReservation();
    await seedMeltQuote();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startMelt());
    const input = {
      effectId: cashuOperatorEffectId("effect-001"),
      eventId: cashuReservationLifecycleEventId("event-pending"),
      evidenceAt: unixTimestamp(RESERVED_AT + 2),
      paymentId: paymentId("payment-001"),
      recordedAt: unixTimestamp(RESERVED_AT + 2),
    };

    const first = await repository.recordPending(input);
    const replay = await repository.recordPending(input);
    const conflict = await errorFromAsync(() =>
      repository.requireAttention({
        ...input,
        reason: "operator_state_unknown",
      }),
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(conflict).toBeInstanceOf(CashuProofReservationLifecycleRepositoryError);
    expect(conflict).toMatchObject({ code: "event_conflict" });
    await expectLifecycleCounts({ activeInvoices: 1, activeProofs: 2, effects: 1, events: 2 });
  });

  it("enforces lifecycle history and active claims below the repository", async () => {
    await seedReservation();
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("BEGIN");
      await pool.query(
        `
          INSERT INTO cashu_operator_effects (
            effect_id,
            effect_fingerprint,
            dispatch_fingerprint,
            payment_id,
            invoice_id,
            operator_id,
            mint_url,
            effect_kind,
            operator_reference,
            operator_reference_expires_at,
            schema_version,
            started_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
          "raw-effect",
          "a".repeat(64),
          "b".repeat(64),
          "payment-001",
          "invoice-001",
          "operator-a",
          MINT_A,
          "swap",
          null,
          null,
          1,
          RESERVED_AT + 1,
        ],
      );
      const missingEvent = await errorFromAsync(() => pool.query("COMMIT"));
      expect(missingEvent).toMatchObject({ code: "23514" });
      await pool.query("ROLLBACK");

      await pool.query("BEGIN");
      await pool.query("DELETE FROM cashu_active_proof_claims WHERE payment_id = $1", [
        "payment-001",
      ]);
      const unsafeRelease = await errorFromAsync(() => pool.query("COMMIT"));
      expect(unsafeRelease).toMatchObject({ code: "23514" });
      await pool.query("ROLLBACK");
    } finally {
      await pool.end();
    }
    await expectLifecycleCounts({ activeInvoices: 0, activeProofs: 2, effects: 0, events: 0 });
  });

  it("rejects mutation and fails closed on corrupted lifecycle fingerprints", async () => {
    await seedReservation();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startSwap());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const mutation = await errorFromAsync(() =>
        pool.query("UPDATE cashu_operator_effects SET started_at = started_at + 1"),
      );
      expect(mutation).toMatchObject({ code: "55000" });

      await pool.query(
        "ALTER TABLE cashu_proof_reservation_events DISABLE TRIGGER cashu_proof_reservation_events_append_only",
      );
      try {
        await pool.query("UPDATE cashu_proof_reservation_events SET event_fingerprint = $1", [
          "f".repeat(64),
        ]);
      } finally {
        await pool.query(
          "ALTER TABLE cashu_proof_reservation_events ENABLE TRIGGER cashu_proof_reservation_events_append_only",
        );
      }
    } finally {
      await pool.end();
    }

    await expect(repository.findByPaymentId(paymentId("payment-001"))).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("stores only non-bearer lifecycle and active-claim columns", async () => {
    await seedReservation();
    const repository = await connectLifecycleRepository();
    await repository.startEffect(startSwap());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const result = await pool.query<{ column_name: string; table_name: string }>(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (
              'cashu_active_proof_claims',
              'cashu_active_invoice_payment_claims',
              'cashu_operator_effects',
              'cashu_proof_reservation_events'
            )
          ORDER BY table_name, ordinal_position
        `,
      );
      const columns = result.rows.map((row) => `${row.table_name}.${row.column_name}`);
      expect(columns).not.toEqual([]);
      expect(columns.join(" ")).not.toMatch(/secret|signature|dleq|witness|payload|token/i);
      expect(columns).toContain("cashu_operator_effects.operator_reference");
      expect(columns).toContain("cashu_proof_reservation_events.proof_state_snapshot_fingerprint");
    } finally {
      await pool.end();
    }
  });
});

async function seedReservation(overrides: ReservationOverrides = {}) {
  await seedInvoice(
    overrides.invoiceId ?? "invoice-001",
    `checkout-${overrides.invoiceId ?? "001"}`,
  );
  await seedKeyset();
  const repository = await connectReservationRepository();
  await repository.reserve(reservationInput(overrides));
  return repository;
}

async function seedInvoice(
  requestedInvoiceId = "invoice-001",
  requestedIdempotencyKey = "checkout-001",
): Promise<void> {
  const repository = await connectInvoiceRepository();
  await repository.createOpenInvoice(invoiceRecord(requestedInvoiceId, requestedIdempotencyKey));
}

async function seedKeyset(): Promise<void> {
  const repository = await connectKeysetRepository();
  await repository.persistObservation({
    operatorId: operatorId("operator-a"),
    snapshot: createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: true,
          id: KEYSET_ID,
          keys: { "1": KEYSET_PUBLIC_KEY },
          unit: "usdc",
        },
      ],
      mintUrl: MINT_A,
      observedAt: CREATED_AT,
    }),
    unit: "usdc",
  });
}

async function seedMeltQuote(): Promise<PostgresCashuStellarMeltQuoteRepository> {
  await seedOpaqueCustody();
  const repository = await connectQuoteRepository();
  await repository.begin({
    amount: 2,
    attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
    paymentId: paymentId("payment-001"),
    request: MELT_REQUEST,
    startedAt: unixTimestamp(RESERVED_AT),
  });
  await repository.recordQuote({
    attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
    paymentId: paymentId("payment-001"),
    quote: meltQuote(),
  });
  return repository;
}

async function seedOpaqueCustody(): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const keyId = "lifecycle-test-key";
  const nonce = Buffer.alloc(12, 9);
  try {
    await pool.query("BEGIN");
    await pool.query(
      `
        INSERT INTO cashu_proof_custody_nonce_uses (key_id, nonce, payment_id, created_at)
        VALUES ($1, $2, 'payment-001', $3)
      `,
      [keyId, nonce, RESERVED_AT],
    );
    await pool.query(
      `
        INSERT INTO cashu_bearer_proof_custody (
          payment_id,
          binding_fingerprint,
          record_fingerprint,
          schema_version,
          encryption_algorithm,
          key_id,
          nonce,
          authentication_tag,
          ciphertext,
          proof_count,
          created_at
        )
        VALUES (
          'payment-001',
          $1,
          $2,
          1,
          'aes-256-gcm-v1',
          $3,
          $4,
          $5,
          $6,
          2,
          $7
        )
      `,
      [
        createFingerprint("custody-binding"),
        createFingerprint("custody-record"),
        keyId,
        nonce,
        Buffer.alloc(16, 9),
        Buffer.from([9]),
        RESERVED_AT,
      ],
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
}

async function persistProofState(
  first: CashuProofStateValue,
  second: CashuProofStateValue,
  observedAt: number,
): Promise<void> {
  const repository = await connectProofStateRepository();
  await repository.persistObservation(stateObservation(first, second, observedAt));
}

async function connectInvoiceRepository(): Promise<PostgresInvoiceRepository> {
  const repository = await PostgresInvoiceRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectKeysetRepository(): Promise<PostgresCashuKeysetRepository> {
  const repository = await PostgresCashuKeysetRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectReservationRepository(): Promise<PostgresCashuProofReservationRepository> {
  const repository = await PostgresCashuProofReservationRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectProofStateRepository(): Promise<PostgresCashuProofStateRepository> {
  const repository = await PostgresCashuProofStateRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectQuoteRepository(): Promise<PostgresCashuStellarMeltQuoteRepository> {
  const repository = await PostgresCashuStellarMeltQuoteRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function connectLifecycleRepository(): Promise<PostgresCashuProofReservationLifecycleRepository> {
  const repository = await PostgresCashuProofReservationLifecycleRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function closeRepository(repository: { close(): Promise<void> }): Promise<void> {
  await repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
}

function invoiceRecord(
  requestedInvoiceId: string,
  requestedIdempotencyKey: string,
): CreateOpenInvoiceRecord {
  const ownerId = merchantId("merchant-001");
  const invoice = createInvoiceV1({
    amount: minorUnits(2),
    createdAt: unixTimestamp(CREATED_AT),
    expiresAt: unixTimestamp(EXPIRES_AT),
    id: invoiceId(requestedInvoiceId),
    merchantId: ownerId,
  });
  return {
    cashuPaymentRequest: CASHU_PAYMENT_REQUEST_ISSUER.issue({
      invoice,
      issuedAt: invoice.createdAt,
    }),
    idempotencyKey: idempotencyKey(requestedIdempotencyKey),
    invoice,
    requestFingerprint: createFingerprint(requestedInvoiceId),
  };
}

interface ReservationOverrides {
  readonly invoiceId?: string;
  readonly paymentId?: string;
  readonly proofReferences?: ReserveCashuProofsInput["proofReferences"];
}

function reservationInput(overrides: ReservationOverrides = {}): ReserveCashuProofsInput {
  return {
    invoiceId: invoiceId(overrides.invoiceId ?? "invoice-001"),
    keysetObservedAt: unixTimestamp(CREATED_AT),
    mintUrl: MINT_A,
    operatorId: operatorId("operator-a"),
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
    proofReferences: overrides.proofReferences ?? [
      proofReference(PROOF_Y_B),
      proofReference(PROOF_Y_A),
    ],
    reservedAt: unixTimestamp(RESERVED_AT),
    unit: "usdc",
  };
}

function startSwap(
  overrides: {
    readonly dispatchFingerprint?: string;
    readonly effectId?: string;
    readonly eventId?: string;
    readonly paymentId?: string;
    readonly startedAt?: number;
  } = {},
): StartCashuOperatorEffectInput {
  return {
    dispatchFingerprint: cashuOperatorDispatchFingerprint(
      overrides.dispatchFingerprint ?? createFingerprint(overrides.effectId ?? "effect-001"),
    ),
    effectId: cashuOperatorEffectId(overrides.effectId ?? "effect-001"),
    eventId: cashuReservationLifecycleEventId(overrides.eventId ?? "event-start"),
    kind: "swap",
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
    startedAt: unixTimestamp(overrides.startedAt ?? RESERVED_AT + 1),
  };
}

function startMelt(
  overrides: {
    readonly operatorReference?: string;
    readonly operatorReferenceExpiresAt?: number;
    readonly startedAt?: number;
  } = {},
): StartCashuOperatorEffectInput {
  return {
    ...startSwap(overrides.startedAt === undefined ? {} : { startedAt: overrides.startedAt }),
    kind: "melt",
    operatorReference: cashuOperatorReference(overrides.operatorReference ?? MELT_QUOTE_ID),
    operatorReferenceExpiresAt: unixTimestamp(
      overrides.operatorReferenceExpiresAt ?? RESERVED_AT + 10,
    ),
  };
}

function meltQuote(
  overrides: { readonly observedAt?: number; readonly state?: "PAID" | "PENDING" | "UNPAID" } = {},
) {
  return createCashuStellarMeltQuoteV1({
    amount: 2,
    expiry: RESERVED_AT + 10,
    method: CASHU_STELLAR_METHOD,
    mintUrl: MINT_A,
    observedAt: overrides.observedAt ?? RESERVED_AT + 1,
    quoteId: MELT_QUOTE_ID,
    request: MELT_REQUEST,
    state: overrides.state ?? "UNPAID",
    unit: CASHU_STELLAR_UNIT,
  });
}

function stellarPaymentRequest(amount: number): string {
  const decimalAmount = `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
  const parameters = new URLSearchParams({
    amount: decimalAmount,
    asset_code: CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
    asset_issuer: CASHU_STELLAR_TESTNET_USDC_ISSUER,
    destination: STELLAR_DESTINATION,
    network_passphrase: CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  });
  return `web+stellar:pay?${parameters.toString()}`;
}

interface TerminalOverrides {
  readonly evidenceAt?: number;
  readonly evidenceKind?: "swap_succeeded" | "melt_paid";
  readonly proofStateObservedAt?: number;
  readonly recordedAt?: number;
}

function consumeInput(overrides: TerminalOverrides = {}): ConsumeCashuProofReservationInput {
  return {
    effectId: cashuOperatorEffectId("effect-001"),
    eventId: cashuReservationLifecycleEventId("event-consume"),
    evidenceAt: unixTimestamp(overrides.evidenceAt ?? RESERVED_AT + 3),
    evidenceKind: overrides.evidenceKind ?? "swap_succeeded",
    paymentId: paymentId("payment-001"),
    proofStateObservedAt: unixTimestamp(overrides.proofStateObservedAt ?? RESERVED_AT + 4),
    recordedAt: unixTimestamp(overrides.recordedAt ?? RESERVED_AT + 5),
  };
}

function releaseAfterFailure(
  overrides: {
    readonly evidenceAt?: number;
    readonly evidenceKind?: "swap_rejected" | "melt_unpaid_after_expiry";
    readonly proofStateObservedAt?: number;
    readonly recordedAt?: number;
  } = {},
): ReleaseCashuProofReservationInput {
  return {
    effectId: cashuOperatorEffectId("effect-001"),
    eventId: cashuReservationLifecycleEventId("event-release"),
    evidenceAt: unixTimestamp(overrides.evidenceAt ?? RESERVED_AT + 3),
    evidenceKind: overrides.evidenceKind ?? "swap_rejected",
    kind: "after_failure",
    paymentId: paymentId("payment-001"),
    proofStateObservedAt: unixTimestamp(overrides.proofStateObservedAt ?? RESERVED_AT + 4),
    recordedAt: unixTimestamp(overrides.recordedAt ?? RESERVED_AT + 5),
  };
}

function stateObservation(
  first: CashuProofStateValue,
  second: CashuProofStateValue,
  observedAt: number,
): PersistCashuProofStateObservation {
  return {
    operatorId: operatorId("operator-a"),
    paymentId: paymentId("payment-001"),
    snapshot: createCashuProofStateSnapshotV1({
      mintUrl: MINT_A,
      observedAt,
      states: [
        { state: first, y: PROOF_Y_A },
        { state: second, y: PROOF_Y_B },
      ],
    }),
    unit: "usdc",
  };
}

function proofReference(y: string) {
  return createCashuProofReferenceV1({ amount: 1, keysetId: KEYSET_ID, y });
}

function createFingerprint(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

async function expectLifecycleCounts(expected: {
  readonly activeInvoices: number;
  readonly activeProofs: number;
  readonly effects: number;
  readonly events: number;
  readonly reservations?: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{
      active_invoices: string;
      active_proofs: string;
      effects: string;
      events: string;
      reservations: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM cashu_active_invoice_payment_claims) AS active_invoices,
        (SELECT COUNT(*) FROM cashu_active_proof_claims) AS active_proofs,
        (SELECT COUNT(*) FROM cashu_operator_effects) AS effects,
        (SELECT COUNT(*) FROM cashu_proof_reservation_events) AS events,
        (SELECT COUNT(*) FROM cashu_proof_reservations) AS reservations
    `);
    expect(result.rows[0]).toEqual({
      active_invoices: String(expected.activeInvoices),
      active_proofs: String(expected.activeProofs),
      effects: String(expected.effects),
      events: String(expected.events),
      reservations: String(expected.reservations ?? 1),
    });
  } finally {
    await pool.end();
  }
}

function requireDatabaseUrl(): string {
  if (DATABASE_URL === undefined) {
    throw new Error("CASHMESH_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  }
  return DATABASE_URL;
}

async function errorFromAsync(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to reject.");
}
