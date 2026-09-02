import { createHash } from "node:crypto";
import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
  CASHU_STELLAR_TESTNET_USDC_ISSUER,
  CASHU_STELLAR_UNIT,
  CashuPaymentRequestIssuer,
  type CreateCashuStellarMeltQuoteInputV1,
  createCashuKeysetSnapshotV1,
  createCashuProofReferenceV1,
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
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuOperatorReference,
  cashuReservationLifecycleEventId,
} from "../src/cashu-proof-reservation-lifecycle-repository";
import {
  type BeginCashuStellarMeltQuoteAttemptInput,
  cashuStellarMeltQuoteAttemptId,
} from "../src/cashu-stellar-melt-quote-repository";
import type { CreateOpenInvoiceRecord } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresCashuProofReservationLifecycleRepository } from "../src/postgres-cashu-proof-reservation-lifecycle-repository";
import { PostgresCashuProofReservationRepository } from "../src/postgres-cashu-proof-reservation-repository";
import { PostgresCashuStellarMeltQuoteRepository } from "../src/postgres-cashu-stellar-melt-quote-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const MINT_URL = "https://mint-a.cashmesh.example";
const CREATED_AT = 1_788_400_000;
const EXPIRES_AT = CREATED_AT + 300;
const RESERVED_AT = CREATED_AT + 1;
const CUSTODY_AT = CREATED_AT + 2;
const ATTEMPT_STARTED_AT = CREATED_AT + 3;
const QUOTE_OBSERVED_AT = CREATED_AT + 4;
const QUOTE_EXPIRY = CREATED_AT + 120;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_Y_A = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const PROOF_Y_B = "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5";
const QUOTE_ID = "01890f3c-7b62-7a4f-bc7d-1a2b3c4d5e6f";
const OTHER_QUOTE_ID = "01890f3c-7b63-7f41-8d2e-2b3c4d5e6f70";
const DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const REQUEST = paymentRequest(1);
const repositories: Array<{ close(): Promise<void> }> = [];
const REQUEST_ISSUER = new CashuPaymentRequestIssuer({
  operators: [
    {
      mintUrl: MINT_URL,
      operatorId: operatorId("operator-a"),
      tier: "trusted",
    },
  ],
  transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
});

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL Cashu Stellar melt quotes", () => {
  beforeAll(async () => {
    const repository = await PostgresCashuStellarMeltQuoteRepository.connect({
      connectionString: requireDatabaseUrl(),
    });
    await repository.close();
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(`
        TRUNCATE
          merchant_invoice_payment_postings,
          merchant_invoice_payment_journals,
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

  it("persists one creation authorization and quote history across restart", async () => {
    await seedActiveReservation();
    const firstRepository = await connectQuoteRepository();
    const begun = await firstRepository.begin(beginInput());
    await closeRepository(firstRepository);

    const restartedRepository = await connectQuoteRepository();
    const replayedIntent = await restartedRepository.begin(beginInput());
    const quoted = await restartedRepository.recordQuote({
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: quote(),
    });
    await restartedRepository.observe(observation("PENDING", QUOTE_OBSERVED_AT + 1));
    await restartedRepository.observe(observation("UNPAID", QUOTE_OBSERVED_AT + 2));
    const paid = await restartedRepository.observe(observation("PAID", QUOTE_OBSERVED_AT + 3));
    await closeRepository(restartedRepository);

    const recoveredRepository = await connectQuoteRepository();
    const found = await recoveredRepository.findByPaymentId(paymentId("payment-001"));
    const replayedAfterOutcome = await recoveredRepository.begin(beginInput());

    expect(begun).toMatchObject({
      attempt: { attemptId: "attempt-001", observations: [], state: "creating" },
      replayed: false,
    });
    expect(replayedIntent).toEqual({ attempt: begun.attempt, replayed: true });
    expect(quoted).toMatchObject({
      attempt: { latestQuote: { state: "UNPAID" }, state: "quoted" },
      replayed: false,
    });
    expect(paid.attempt).toMatchObject({ latestQuote: { state: "PAID" }, state: "quoted" });
    expect(found).toEqual(paid.attempt);
    expect(replayedAfterOutcome).toEqual({ attempt: paid.attempt, replayed: true });
    expect(found?.observations.map((item) => item.state)).toEqual([
      "UNPAID",
      "PENDING",
      "UNPAID",
      "PAID",
    ]);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found?.observations)).toBe(true);
    expect(Object.isFrozen(found?.observations[0])).toBe(true);
    await expectQuoteCounts({ attempts: 1, observations: 4, outcomes: 1 });
  });

  it("converges concurrent exact begins and rejects a second payment binding", async () => {
    await seedActiveReservation();
    const first = await connectQuoteRepository();
    const second = await connectQuoteRepository();

    const results = await Promise.all([first.begin(beginInput()), second.begin(beginInput())]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.attempt).toEqual(results[1]?.attempt);
    await expect(first.begin(beginInput({ attemptId: "attempt-other" }))).rejects.toMatchObject({
      code: "attempt_conflict",
    });
    await expectQuoteCounts({ attempts: 1, observations: 0, outcomes: 0 });
  });

  it("records transport ambiguity once and never turns it into retry permission", async () => {
    await seedActiveReservation();
    const repository = await connectQuoteRepository();
    await repository.begin(beginInput());
    const ambiguousInput = {
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      reason: "transport_ambiguous" as const,
      recordedAt: unixTimestamp(QUOTE_OBSERVED_AT),
    };
    const first = await repository.recordAmbiguous(ambiguousInput);
    await closeRepository(repository);

    const restarted = await connectQuoteRepository();
    const replay = await restarted.recordAmbiguous(ambiguousInput);
    const beginReplay = await restarted.begin(beginInput());

    expect(first).toMatchObject({
      attempt: {
        ambiguityReason: "transport_ambiguous",
        ambiguousAt: QUOTE_OBSERVED_AT,
        observations: [],
        state: "ambiguous",
      },
      replayed: false,
    });
    expect(replay).toEqual({ attempt: first.attempt, replayed: true });
    expect(beginReplay).toEqual({ attempt: first.attempt, replayed: true });
    await expect(
      restarted.recordQuote({
        attemptId: ambiguousInput.attemptId,
        paymentId: ambiguousInput.paymentId,
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(
      restarted.recordAmbiguous({
        ...ambiguousInput,
        recordedAt: unixTimestamp(QUOTE_OBSERVED_AT + 1),
      }),
    ).rejects.toMatchObject({ code: "quote_conflict" });
    await expectQuoteCounts({ attempts: 1, observations: 0, outcomes: 1 });
  });

  it("replays persisted quote ownership after dispatch has advanced", async () => {
    await seedActiveReservation();
    const repository = await connectQuoteRepository();
    await repository.begin(beginInput());
    const recorded = await repository.recordQuote({
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: quote(),
    });
    const lifecycle = await connectLifecycleRepository();
    await lifecycle.startEffect({
      dispatchFingerprint: cashuOperatorDispatchFingerprint("b".repeat(64)),
      effectId: cashuOperatorEffectId("effect-001"),
      eventId: cashuReservationLifecycleEventId("event-start"),
      kind: "melt",
      operatorReference: cashuOperatorReference(QUOTE_ID),
      operatorReferenceExpiresAt: unixTimestamp(QUOTE_EXPIRY),
      paymentId: paymentId("payment-001"),
      startedAt: unixTimestamp(QUOTE_OBSERVED_AT + 1),
    });

    const replay = await repository.begin(beginInput());

    expect(replay).toEqual({ attempt: recorded.attempt, replayed: true });
  });

  it("blocks dispatch until an unresolved attempt has a quoted outcome", async () => {
    await seedActiveReservation();
    const repository = await connectQuoteRepository();
    const begun = await repository.begin(beginInput());
    const lifecycle = await connectLifecycleRepository();
    const effect = {
      dispatchFingerprint: cashuOperatorDispatchFingerprint("c".repeat(64)),
      effectId: cashuOperatorEffectId("effect-001"),
      eventId: cashuReservationLifecycleEventId("event-start"),
      kind: "melt",
      operatorReference: cashuOperatorReference(QUOTE_ID),
      operatorReferenceExpiresAt: unixTimestamp(QUOTE_EXPIRY),
      paymentId: paymentId("payment-001"),
      startedAt: unixTimestamp(QUOTE_OBSERVED_AT + 1),
    } as const;

    await expect(lifecycle.startEffect(effect)).rejects.toMatchObject({
      code: "quote_evidence_missing",
    });
    const replay = await repository.begin(beginInput());

    expect(replay).toEqual({ attempt: begun.attempt, replayed: true });
    await expectQuoteCounts({ attempts: 1, observations: 0, outcomes: 0 });

    const recorded = await repository.recordQuote({
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: quote(),
    });
    const started = await lifecycle.startEffect(effect);

    expect(recorded.attempt.state).toBe("quoted");
    expect(started.replayed).toBe(false);
    await expectQuoteCounts({ attempts: 1, observations: 1, outcomes: 1 });
  });

  it("requires exact invoice terms, encrypted custody, and an active reservation", async () => {
    await seedReservation({ withCustody: false });
    const repository = await connectQuoteRepository();

    await expect(repository.begin(beginInput())).rejects.toMatchObject({
      code: "custody_not_found",
    });
    await seedOpaqueCustody("payment-001", 1);
    await expect(
      repository.begin(beginInput({ amount: 2, request: paymentRequest(2) })),
    ).rejects.toMatchObject({ code: "terms_mismatch" });
    await expect(repository.begin(beginInput({ startedAt: CUSTODY_AT - 1 }))).rejects.toMatchObject(
      { code: "invoice_window_closed" },
    );

    const lifecycle = await connectLifecycleRepository();
    await lifecycle.startEffect({
      dispatchFingerprint: cashuOperatorDispatchFingerprint("a".repeat(64)),
      effectId: cashuOperatorEffectId("effect-001"),
      eventId: cashuReservationLifecycleEventId("event-start"),
      kind: "swap",
      paymentId: paymentId("payment-001"),
      startedAt: unixTimestamp(ATTEMPT_STARTED_AT),
    });
    await expect(
      repository.begin(beginInput({ startedAt: ATTEMPT_STARTED_AT + 1 })),
    ).rejects.toMatchObject({ code: "reservation_not_active" });
    await expect(
      repository.begin(beginInput({ paymentId: "payment-missing" })),
    ).rejects.toMatchObject({ code: "reservation_not_found" });
    await expectQuoteCounts({ attempts: 0, observations: 0, outcomes: 0 });
  });

  it("binds initial quote terms and prevents quote identity reuse at one mint", async () => {
    await seedActiveReservation();
    await seedActiveReservation({
      invoiceId: "invoice-002",
      nonceFill: 2,
      paymentId: "payment-002",
      proofY: PROOF_Y_B,
    });
    const repository = await connectQuoteRepository();
    await repository.begin(beginInput());
    await repository.begin(beginInput({ attemptId: "attempt-002", paymentId: "payment-002" }));

    await expect(
      repository.recordQuote({
        attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
        paymentId: paymentId("payment-001"),
        quote: quote({ state: "PENDING" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.recordQuote({
        attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
        paymentId: paymentId("payment-001"),
        quote: quote({ expiry: ATTEMPT_STARTED_AT + 901 }),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.recordQuote({
        attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
        paymentId: paymentId("payment-001"),
        quote: quote({ mintUrl: "https://mint-other.cashmesh.example" }),
      }),
    ).rejects.toMatchObject({ code: "terms_mismatch" });

    const recorded = await repository.recordQuote({
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: quote(),
    });
    const replay = await repository.recordQuote({
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: quote(),
    });
    expect(recorded.replayed).toBe(false);
    expect(replay).toEqual({ attempt: recorded.attempt, replayed: true });
    await expect(
      repository.recordQuote({
        attemptId: cashuStellarMeltQuoteAttemptId("attempt-002"),
        paymentId: paymentId("payment-002"),
        quote: quote(),
      }),
    ).rejects.toMatchObject({ code: "quote_conflict" });
    await expectQuoteCounts({ attempts: 2, observations: 1, outcomes: 1 });
  });

  it("rejects observation equivocation, time regression, and PAID regression", async () => {
    await seedActiveReservation();
    const repository = await connectQuoteRepository();
    await repository.begin(beginInput());
    await repository.recordQuote({
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: quote(),
    });

    const initialReplay = await repository.observe(observation("UNPAID", QUOTE_OBSERVED_AT));
    await repository.observe(observation("PENDING", QUOTE_OBSERVED_AT + 2));
    await expect(
      repository.observe(observation("UNPAID", QUOTE_OBSERVED_AT + 2)),
    ).rejects.toMatchObject({ code: "observation_conflict" });
    await expect(
      repository.observe(observation("UNPAID", QUOTE_OBSERVED_AT + 1)),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    const paid = await repository.observe(observation("PAID", QUOTE_OBSERVED_AT + 3));
    const paidReplay = await repository.observe(observation("PAID", QUOTE_OBSERVED_AT + 3));
    await expect(
      repository.observe(observation("UNPAID", QUOTE_OBSERVED_AT + 4)),
    ).rejects.toMatchObject({ code: "invalid_transition" });

    expect(initialReplay.replayed).toBe(true);
    expect(paidReplay).toEqual({ attempt: paid.attempt, replayed: true });
    await expectQuoteCounts({ attempts: 1, observations: 3, outcomes: 1 });
  });

  it("enforces append-only rows and detects corrupted evidence on read", async () => {
    await seedActiveReservation();
    const repository = await connectQuoteRepository();
    await repository.begin(beginInput());
    await repository.recordQuote({
      attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
      paymentId: paymentId("payment-001"),
      quote: quote(),
    });

    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const mutation = await errorFromAsync(() =>
        pool.query(
          "UPDATE cashu_stellar_melt_quote_attempts SET started_at = started_at + 1 WHERE attempt_id = 'attempt-001'",
        ),
      );
      const deletion = await errorFromAsync(() =>
        pool.query(
          "DELETE FROM cashu_stellar_melt_quote_outcomes WHERE attempt_id = 'attempt-001'",
        ),
      );
      expect(mutation).toMatchObject({ code: "55000" });
      expect(deletion).toMatchObject({ code: "55000" });

      await pool.query(
        "ALTER TABLE cashu_stellar_melt_quote_observations DISABLE TRIGGER cashu_stellar_quote_observations_append_only",
      );
      await pool.query(
        "ALTER TABLE cashu_stellar_melt_quote_observations DISABLE TRIGGER cashu_stellar_quote_observations_complete",
      );
      try {
        await pool.query(
          "UPDATE cashu_stellar_melt_quote_observations SET state = 'PENDING' WHERE attempt_id = 'attempt-001'",
        );
      } finally {
        await pool.query(
          "ALTER TABLE cashu_stellar_melt_quote_observations ENABLE TRIGGER cashu_stellar_quote_observations_complete",
        );
        await pool.query(
          "ALTER TABLE cashu_stellar_melt_quote_observations ENABLE TRIGGER cashu_stellar_quote_observations_append_only",
        );
      }
    } finally {
      await pool.end();
    }

    await expect(repository.findByPaymentId(paymentId("payment-001"))).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("rejects a quoted outcome without its atomic initial observation", async () => {
    await seedActiveReservation();
    const repository = await connectQuoteRepository();
    await repository.begin(beginInput());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const error = await errorFromAsync(() =>
        pool.query(
          `
            INSERT INTO cashu_stellar_melt_quote_outcomes (
              attempt_id,
              outcome_fingerprint,
              payment_id,
              mint_url,
              outcome_kind,
              ambiguity_reason,
              quote_id,
              fee_reserve,
              expiry,
              schema_version,
              recorded_at
            )
            VALUES ($1, $2, $3, $4, 'quoted', NULL, $5, 0, $6, 1, $7)
          `,
          [
            "attempt-001",
            "a".repeat(64),
            "payment-001",
            MINT_URL,
            OTHER_QUOTE_ID,
            QUOTE_EXPIRY,
            QUOTE_OBSERVED_AT,
          ],
        ),
      );
      expect(error).toMatchObject({ code: "23514" });
      const count = await pool.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM cashu_stellar_melt_quote_outcomes",
      );
      expect(count.rows[0]?.count).toBe("0");
    } finally {
      await pool.end();
    }
  });
});

interface SeedReservationOptions {
  readonly invoiceId?: string;
  readonly nonceFill?: number;
  readonly paymentId?: string;
  readonly proofY?: string;
  readonly withCustody?: boolean;
}

async function seedActiveReservation(options: SeedReservationOptions = {}): Promise<void> {
  await seedReservation(options);
}

async function seedReservation(options: SeedReservationOptions = {}): Promise<void> {
  const requestedInvoiceId = options.invoiceId ?? "invoice-001";
  const requestedPaymentId = options.paymentId ?? "payment-001";
  const invoiceRepository = await connectInvoiceRepository();
  await invoiceRepository.createOpenInvoice(invoiceRecord(requestedInvoiceId));
  const keysetRepository = await connectKeysetRepository();
  await keysetRepository.persistObservation({
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
      mintUrl: MINT_URL,
      observedAt: CREATED_AT,
    }),
    unit: "usdc",
  });
  const reservationRepository = await connectReservationRepository();
  await reservationRepository.reserve({
    invoiceId: invoiceId(requestedInvoiceId),
    keysetObservedAt: unixTimestamp(CREATED_AT),
    mintUrl: MINT_URL,
    operatorId: operatorId("operator-a"),
    paymentId: paymentId(requestedPaymentId),
    proofReferences: [
      createCashuProofReferenceV1({
        amount: 1,
        keysetId: KEYSET_ID,
        y: options.proofY ?? PROOF_Y_A,
      }),
    ],
    reservedAt: unixTimestamp(RESERVED_AT),
    unit: "usdc",
  });
  if (options.withCustody !== false) {
    await seedOpaqueCustody(requestedPaymentId, options.nonceFill ?? 1);
  }
}

async function seedOpaqueCustody(requestedPaymentId: string, nonceFill: number): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const keyId = `test-key-${requestedPaymentId}`;
  const nonce = Buffer.alloc(12, nonceFill);
  try {
    await pool.query("BEGIN");
    await pool.query(
      `
        INSERT INTO cashu_proof_custody_nonce_uses (key_id, nonce, payment_id, created_at)
        VALUES ($1, $2, $3, $4)
      `,
      [keyId, nonce, requestedPaymentId, CUSTODY_AT],
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
        VALUES ($1, $2, $3, 1, 'aes-256-gcm-v1', $4, $5, $6, $7, 1, $8)
      `,
      [
        requestedPaymentId,
        sha256(`binding-${requestedPaymentId}`),
        sha256(`record-${requestedPaymentId}`),
        keyId,
        nonce,
        Buffer.alloc(16, nonceFill),
        Buffer.from([nonceFill]),
        CUSTODY_AT,
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

function beginInput(
  overrides: {
    readonly amount?: number;
    readonly attemptId?: string;
    readonly paymentId?: string;
    readonly request?: string;
    readonly startedAt?: number;
  } = {},
): BeginCashuStellarMeltQuoteAttemptInput {
  return {
    amount: overrides.amount ?? 1,
    attemptId: cashuStellarMeltQuoteAttemptId(overrides.attemptId ?? "attempt-001"),
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
    request: overrides.request ?? REQUEST,
    startedAt: unixTimestamp(overrides.startedAt ?? ATTEMPT_STARTED_AT),
  };
}

function observation(state: "PAID" | "PENDING" | "UNPAID", observedAt: number) {
  return {
    attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
    paymentId: paymentId("payment-001"),
    quote: quote({ observedAt, state }),
  };
}

function quote(overrides: Partial<CreateCashuStellarMeltQuoteInputV1> = {}) {
  return createCashuStellarMeltQuoteV1({
    amount: 1,
    expiry: QUOTE_EXPIRY,
    feeReserve: 1,
    method: CASHU_STELLAR_METHOD,
    mintUrl: MINT_URL,
    observedAt: QUOTE_OBSERVED_AT,
    quoteId: QUOTE_ID,
    request: REQUEST,
    state: "UNPAID",
    unit: CASHU_STELLAR_UNIT,
    ...overrides,
  });
}

function paymentRequest(amount: number): string {
  const decimalAmount = `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
  const parameters = new URLSearchParams({
    amount: decimalAmount,
    asset_code: CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
    asset_issuer: CASHU_STELLAR_TESTNET_USDC_ISSUER,
    destination: DESTINATION,
    network_passphrase: CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  });
  return `web+stellar:pay?${parameters.toString()}`;
}

function invoiceRecord(requestedInvoiceId: string): CreateOpenInvoiceRecord {
  const invoice = createInvoiceV1({
    amount: minorUnits(1),
    createdAt: unixTimestamp(CREATED_AT),
    expiresAt: unixTimestamp(EXPIRES_AT),
    id: invoiceId(requestedInvoiceId),
    merchantId: merchantId("merchant-001"),
  });
  return {
    cashuPaymentRequest: REQUEST_ISSUER.issue({ invoice, issuedAt: invoice.createdAt }),
    idempotencyKey: idempotencyKey(`checkout-${requestedInvoiceId}`),
    invoice,
    requestFingerprint: sha256(requestedInvoiceId),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function connectQuoteRepository(): Promise<PostgresCashuStellarMeltQuoteRepository> {
  const repository = await PostgresCashuStellarMeltQuoteRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
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

async function expectQuoteCounts(expected: {
  readonly attempts: number;
  readonly observations: number;
  readonly outcomes: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{
      attempts: string;
      observations: string;
      outcomes: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM cashu_stellar_melt_quote_attempts) AS attempts,
        (SELECT COUNT(*) FROM cashu_stellar_melt_quote_outcomes) AS outcomes,
        (SELECT COUNT(*) FROM cashu_stellar_melt_quote_observations) AS observations
    `);
    expect(result.rows[0]).toEqual({
      attempts: String(expected.attempts),
      observations: String(expected.observations),
      outcomes: String(expected.outcomes),
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
