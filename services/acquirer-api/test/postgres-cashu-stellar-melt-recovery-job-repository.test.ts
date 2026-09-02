import { createHash } from "node:crypto";

import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
  CASHU_STELLAR_TESTNET_USDC_ISSUER,
  CASHU_STELLAR_UNIT,
  CashuPaymentRequestIssuer,
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
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuOperatorReference,
  cashuReservationLifecycleEventId,
} from "../src/cashu-proof-reservation-lifecycle-repository";
import { cashuStellarMeltQuoteAttemptId } from "../src/cashu-stellar-melt-quote-repository";
import {
  CASHU_STELLAR_MELT_RECOVERY_INITIAL_DELAY_SECONDS,
  CashuStellarMeltRecoveryJobRepositoryError,
  cashuStellarMeltRecoveryLeaseToken,
} from "../src/cashu-stellar-melt-recovery-job-repository";
import type { CreateOpenInvoiceRecord } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresCashuProofReservationLifecycleRepository } from "../src/postgres-cashu-proof-reservation-lifecycle-repository";
import { PostgresCashuProofReservationRepository } from "../src/postgres-cashu-proof-reservation-repository";
import { PostgresCashuProofStateRepository } from "../src/postgres-cashu-proof-state-repository";
import { PostgresCashuStellarMeltQuoteRepository } from "../src/postgres-cashu-stellar-melt-quote-repository";
import { PostgresCashuStellarMeltRecoveryJobRepository } from "../src/postgres-cashu-stellar-melt-recovery-job-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const MINT_URL = "https://mint-a.cashmesh.example";
const CREATED_AT = 1_788_950_000;
const RESERVED_AT = CREATED_AT + 1;
const EFFECT_STARTED_AT = RESERVED_AT + 1;
const FIRST_ATTEMPT_AT = EFFECT_STARTED_AT + CASHU_STELLAR_MELT_RECOVERY_INITIAL_DELAY_SECONDS;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_Y_A = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const PROOF_Y_B = "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5";
const QUOTE_ID = "019e6d5a-2347-7000-89e2-35fe79f92c0e";
const QUOTE_EXPIRY = RESERVED_AT + 10;
const DESTINATION = "GATTMQEODSDX45WZK2JFIYETXWYCU5GRJ5I3Z7P2UDYD6YFVONDM4CX4";
const PAYMENT_REQUEST = stellarPaymentRequest();
const repositories: Array<{ close(): Promise<void> }> = [];
const REQUEST_ISSUER = new CashuPaymentRequestIssuer({
  operators: [
    {
      mintUrl: MINT_URL,
      operatorId: operatorId("operator-a"),
      requestedMode: "immediate_conversion",
      tier: "trusted",
    },
  ],
  transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
});

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL Stellar melt recovery jobs", () => {
  beforeAll(async () => {
    const repository = await connectJobRepository();
    await closeRepository(repository);
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(`
        TRUNCATE
          cashu_stellar_melt_recovery_outcomes,
          cashu_stellar_melt_recovery_leases,
          cashu_stellar_melt_recovery_jobs,
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

  it("creates one immutable scheduled job with a new melt effect and reconstructs it", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();

    const job = await repository.findByPaymentId(paymentId("payment-001"));

    expect(job).toEqual({
      attempts: [],
      effectId: "effect-001",
      initialAttemptAt: FIRST_ATTEMPT_AT,
      nextAttemptAt: FIRST_ATTEMPT_AT,
      paymentId: "payment-001",
      schemaVersion: 1,
      state: "scheduled",
    });
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(job?.attempts)).toBe(true);
  });

  it("does not lease before eligibility and claims once at the boundary", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();

    await expect(
      repository.claimNext(claim("lease-early", FIRST_ATTEMPT_AT - 1)),
    ).resolves.toBeUndefined();
    const leased = await repository.claimNext(claim("lease-1", FIRST_ATTEMPT_AT));
    await expect(
      repository.claimNext(claim("lease-other", FIRST_ATTEMPT_AT)),
    ).resolves.toBeUndefined();

    expect(leased).toEqual({
      attemptNumber: 1,
      claimedAt: FIRST_ATTEMPT_AT,
      expiresAt: FIRST_ATTEMPT_AT + 90,
      leaseToken: "lease-1",
      paymentId: "payment-001",
      schemaVersion: 1,
      workerId: "worker-a",
    });
  });

  it("uses row skipping so concurrent workers cannot claim one payment twice", async () => {
    await seedRecoverableMelt();
    const first = await connectJobRepository();
    const second = await connectJobRepository();

    const claims = await Promise.all([
      first.claimNext(claim("lease-a", FIRST_ATTEMPT_AT)),
      second.claimNext(claim("lease-b", FIRST_ATTEMPT_AT)),
    ]);

    expect(claims.filter((value) => value !== undefined)).toHaveLength(1);
    const stored = await first.findByPaymentId(paymentId("payment-001"));
    expect(stored).toMatchObject({ attempts: [{ lease: { attemptNumber: 1 } }], state: "leased" });
  });

  it("does not grant a claim queued behind a terminal lifecycle event", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    const blocker = await pool.connect();
    let release: Promise<void> | undefined;
    let concurrentClaim: ReturnType<typeof repository.claimNext> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT payment_id FROM cashu_stellar_melt_recovery_jobs WHERE payment_id = $1 FOR UPDATE",
        ["payment-001"],
      );

      release = releaseMelt(FIRST_ATTEMPT_AT + 1);
      await waitForBlockedQuery(pool, "INSERT INTO cashu_proof_reservation_events");
      concurrentClaim = repository.claimNext(claim("lease-race", FIRST_ATTEMPT_AT));
      await expect(concurrentClaim).resolves.toBeUndefined();

      await blocker.query("COMMIT");
      await release;
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await release?.catch(() => undefined);
      await concurrentClaim?.catch(() => undefined);
      blocker.release();
      await pool.end();
    }
  });

  it("rejects a retry outcome queued behind a terminal lifecycle event", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();
    const lease = await repository.claimNext(claim("lease-1", FIRST_ATTEMPT_AT));
    if (lease === undefined) {
      throw new Error("Expected a recovery lease.");
    }
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    const blocker = await pool.connect();
    let release: Promise<void> | undefined;
    let concurrentOutcome: ReturnType<typeof repository.recordOutcome> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT payment_id FROM cashu_stellar_melt_recovery_jobs WHERE payment_id = $1 FOR UPDATE",
        ["payment-001"],
      );

      release = releaseMelt(FIRST_ATTEMPT_AT + 1);
      await waitForBlockedQuery(pool, "INSERT INTO cashu_proof_reservation_events");
      concurrentOutcome = repository.recordOutcome({
        kind: "retry_scheduled",
        leaseToken: lease.leaseToken,
        nextAttemptAt: unixTimestamp(FIRST_ATTEMPT_AT + 31),
        paymentId: lease.paymentId,
        reason: "nonterminal_evidence",
        recordedAt: unixTimestamp(FIRST_ATTEMPT_AT + 1),
      });
      await waitForBlockedQuery(pool, "cashu_stellar_melt_recovery_jobs");

      await blocker.query("COMMIT");
      await release;
      await expect(concurrentOutcome).rejects.toMatchObject({ code: "lease_lost" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      await release?.catch(() => undefined);
      await concurrentOutcome?.catch(() => undefined);
      blocker.release();
      await pool.end();
    }
  });

  it("records and exactly replays a retry before granting the next attempt", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();
    const firstLease = await repository.claimNext(claim("lease-1", FIRST_ATTEMPT_AT));
    if (firstLease === undefined) {
      throw new Error("Expected the first recovery lease.");
    }
    const outcome = {
      kind: "retry_scheduled" as const,
      leaseToken: firstLease.leaseToken,
      nextAttemptAt: unixTimestamp(FIRST_ATTEMPT_AT + 31),
      paymentId: firstLease.paymentId,
      reason: "nonterminal_evidence" as const,
      recordedAt: unixTimestamp(FIRST_ATTEMPT_AT + 1),
    };

    const stored = await repository.recordOutcome(outcome);
    const replay = await repository.recordOutcome(outcome);
    await expect(
      repository.claimNext(claim("lease-2-early", FIRST_ATTEMPT_AT + 30)),
    ).resolves.toBeUndefined();
    const secondLease = await repository.claimNext(claim("lease-2", FIRST_ATTEMPT_AT + 31));

    expect(stored).toMatchObject({
      job: { nextAttemptAt: FIRST_ATTEMPT_AT + 31, state: "scheduled" },
      replayed: false,
    });
    expect(replay).toEqual({ job: stored.job, replayed: true });
    expect(secondLease).toMatchObject({ attemptNumber: 2, leaseToken: "lease-2" });
  });

  it("rejects a changed outcome under the same lease token", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();
    const lease = await repository.claimNext(claim("lease-1", FIRST_ATTEMPT_AT));
    if (lease === undefined) {
      throw new Error("Expected a recovery lease.");
    }
    await repository.recordOutcome({
      kind: "retry_scheduled",
      leaseToken: lease.leaseToken,
      nextAttemptAt: unixTimestamp(FIRST_ATTEMPT_AT + 31),
      paymentId: lease.paymentId,
      reason: "nonterminal_evidence",
      recordedAt: unixTimestamp(FIRST_ATTEMPT_AT + 1),
    });

    await expect(
      repository.recordOutcome({
        kind: "attention_required",
        leaseToken: lease.leaseToken,
        paymentId: lease.paymentId,
        reason: "retry_exhausted",
        recordedAt: unixTimestamp(FIRST_ATTEMPT_AT + 1),
      }),
    ).rejects.toMatchObject({ code: "lease_conflict" });
  });

  it("reclaims an expired lease and fences its late outcome", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();
    const firstLease = await repository.claimNext(claim("lease-1", FIRST_ATTEMPT_AT));
    const secondLease = await repository.claimNext(claim("lease-2", FIRST_ATTEMPT_AT + 90));
    if (firstLease === undefined || secondLease === undefined) {
      throw new Error("Expected both recovery leases.");
    }

    await expect(
      repository.recordOutcome({
        kind: "retry_scheduled",
        leaseToken: firstLease.leaseToken,
        nextAttemptAt: unixTimestamp(FIRST_ATTEMPT_AT + 91),
        paymentId: firstLease.paymentId,
        reason: "worker_aborted",
        recordedAt: unixTimestamp(FIRST_ATTEMPT_AT + 90),
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
    await expect(repository.findByPaymentId(paymentId("payment-001"))).resolves.toMatchObject({
      lease: { attemptNumber: 2, leaseToken: "lease-2" },
      state: "leased",
    });
  });

  it("stops automatic claims after an attention outcome", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();
    const lease = await repository.claimNext(claim("lease-1", FIRST_ATTEMPT_AT));
    if (lease === undefined) {
      throw new Error("Expected a recovery lease.");
    }
    await repository.recordOutcome({
      kind: "attention_required",
      leaseToken: lease.leaseToken,
      paymentId: lease.paymentId,
      reason: "operator_response_invalid",
      recordedAt: unixTimestamp(FIRST_ATTEMPT_AT + 1),
    });

    await expect(
      repository.claimNext(claim("lease-2", FIRST_ATTEMPT_AT + 90)),
    ).resolves.toBeUndefined();
    await expect(repository.findByPaymentId(paymentId("payment-001"))).resolves.toMatchObject({
      outcome: { reason: "operator_response_invalid" },
      state: "attention_required",
    });
  });

  it("derives completion from the terminal lifecycle and never leases it again", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();
    const lease = await repository.claimNext(claim("lease-1", FIRST_ATTEMPT_AT));
    if (lease === undefined) {
      throw new Error("Expected a recovery lease.");
    }
    await releaseMelt(FIRST_ATTEMPT_AT + 1);

    const outcome = await repository.recordOutcome({
      kind: "released",
      leaseToken: lease.leaseToken,
      paymentId: lease.paymentId,
      recordedAt: unixTimestamp(FIRST_ATTEMPT_AT + 1),
    });

    expect(outcome.job).toMatchObject({ state: "completed", terminalState: "released" });
    await expect(
      repository.claimNext(claim("lease-2", FIRST_ATTEMPT_AT + 90)),
    ).resolves.toBeUndefined();
  });

  it("enforces eligibility, fencing, duration, and append-only history for direct writers", async () => {
    await seedRecoverableMelt();
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await expect(
        pool.query(
          `
            INSERT INTO cashu_stellar_melt_recovery_leases (
              lease_token,
              payment_id,
              attempt_number,
              worker_id,
              schema_version,
              claimed_at,
              expires_at
            ) VALUES ('raw-early', 'payment-001', 1, 'worker-raw', 1, $1, $2)
          `,
          [FIRST_ATTEMPT_AT - 1, FIRST_ATTEMPT_AT + 89],
        ),
      ).rejects.toMatchObject({ code: "55000" });

      await expect(
        pool.query(
          `
            INSERT INTO cashu_stellar_melt_recovery_leases (
              lease_token,
              payment_id,
              attempt_number,
              worker_id,
              schema_version,
              claimed_at,
              expires_at
            ) VALUES ('raw-long', 'payment-001', 1, 'worker-raw', 1, $1, $2)
          `,
          [FIRST_ATTEMPT_AT, FIRST_ATTEMPT_AT + 301],
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await pool.query(
        `
          INSERT INTO cashu_stellar_melt_recovery_leases (
            lease_token,
            payment_id,
            attempt_number,
            worker_id,
            schema_version,
            claimed_at,
            expires_at
          ) VALUES ('raw-lease', 'payment-001', 1, 'worker-raw', 1, $1, $2)
        `,
        [FIRST_ATTEMPT_AT, FIRST_ATTEMPT_AT + 90],
      );
      await expect(
        pool.query("UPDATE cashu_stellar_melt_recovery_leases SET worker_id = 'other-worker'"),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        pool.query(
          `
            INSERT INTO cashu_stellar_melt_recovery_outcomes (
              lease_token,
              payment_id,
              outcome_kind,
              reason,
              recorded_at,
              next_attempt_at
            ) VALUES ('raw-lease', 'payment-001', 'accepted', NULL, $1, NULL)
          `,
          [FIRST_ATTEMPT_AT + 1],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await pool.end();
    }
  });

  it("rejects invalid identifiers, times, and lease lengths before storage", async () => {
    await seedRecoverableMelt();
    const repository = await connectJobRepository();

    for (const input of [
      {
        ...claim("lease-invalid", FIRST_ATTEMPT_AT),
        leaseToken: "bad lease" as ReturnType<typeof cashuStellarMeltRecoveryLeaseToken>,
      },
      { ...claim("lease-1", FIRST_ATTEMPT_AT), workerId: "bad worker" },
      {
        ...claim("lease-1", FIRST_ATTEMPT_AT),
        expiresAt: unixTimestamp(FIRST_ATTEMPT_AT + 301),
      },
    ]) {
      await expect(repository.claimNext(input)).rejects.toBeInstanceOf(
        CashuStellarMeltRecoveryJobRepositoryError,
      );
    }
  });
});

function claim(leaseToken: string, claimedAt: number) {
  return {
    claimedAt: unixTimestamp(claimedAt),
    expiresAt: unixTimestamp(claimedAt + 90),
    leaseToken: cashuStellarMeltRecoveryLeaseToken(leaseToken),
    workerId: "worker-a",
  };
}

async function seedRecoverableMelt(): Promise<void> {
  const invoiceRepository = await connectInvoiceRepository();
  await invoiceRepository.createOpenInvoice(invoiceRecord());
  const keysetRepository = await connectKeysetRepository();
  await keysetRepository.persistObservation({
    operatorId: operatorId("operator-a"),
    snapshot: createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: false,
          id: KEYSET_ID,
          keys: { "1": KEYSET_PUBLIC_KEY },
          unit: CASHU_STELLAR_UNIT,
        },
      ],
      mintUrl: MINT_URL,
      observedAt: CREATED_AT,
    }),
    unit: CASHU_STELLAR_UNIT,
  });
  const reservationRepository = await connectReservationRepository();
  await reservationRepository.reserve({
    invoiceId: invoiceId("invoice-001"),
    keysetObservedAt: unixTimestamp(CREATED_AT),
    mintUrl: MINT_URL,
    operatorId: operatorId("operator-a"),
    paymentId: paymentId("payment-001"),
    proofReferences: [proofReference(PROOF_Y_B), proofReference(PROOF_Y_A)],
    reservedAt: unixTimestamp(RESERVED_AT),
    unit: CASHU_STELLAR_UNIT,
  });
  await seedOpaqueCustody();
  const quoteRepository = await connectQuoteRepository();
  await quoteRepository.begin({
    amount: 2,
    attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
    paymentId: paymentId("payment-001"),
    request: PAYMENT_REQUEST,
    startedAt: unixTimestamp(RESERVED_AT),
  });
  await quoteRepository.recordQuote({
    attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
    paymentId: paymentId("payment-001"),
    quote: meltQuote("UNPAID", EFFECT_STARTED_AT),
  });
  const lifecycleRepository = await connectLifecycleRepository();
  await lifecycleRepository.startEffect({
    dispatchFingerprint: cashuOperatorDispatchFingerprint(createFingerprint("dispatch-001")),
    effectId: cashuOperatorEffectId("effect-001"),
    eventId: cashuReservationLifecycleEventId("event-start-001"),
    kind: "melt",
    operatorReference: cashuOperatorReference(QUOTE_ID),
    operatorReferenceExpiresAt: unixTimestamp(QUOTE_EXPIRY),
    paymentId: paymentId("payment-001"),
    startedAt: unixTimestamp(EFFECT_STARTED_AT),
  });
}

async function releaseMelt(recordedAt: number): Promise<void> {
  const quoteRepository = await connectQuoteRepository();
  await quoteRepository.observe({
    attemptId: cashuStellarMeltQuoteAttemptId("quote-attempt-001"),
    paymentId: paymentId("payment-001"),
    quote: meltQuote("UNPAID", QUOTE_EXPIRY + 1),
  });
  const proofStateRepository = await connectProofStateRepository();
  await proofStateRepository.persistObservation({
    operatorId: operatorId("operator-a"),
    paymentId: paymentId("payment-001"),
    snapshot: createCashuProofStateSnapshotV1({
      mintUrl: MINT_URL,
      observedAt: QUOTE_EXPIRY + 2,
      states: [
        { state: "UNSPENT", y: PROOF_Y_A },
        { state: "UNSPENT", y: PROOF_Y_B },
      ],
    }),
    unit: CASHU_STELLAR_UNIT,
  });
  const lifecycleRepository = await connectLifecycleRepository();
  await lifecycleRepository.release({
    effectId: cashuOperatorEffectId("effect-001"),
    eventId: cashuReservationLifecycleEventId("event-release-001"),
    evidenceAt: unixTimestamp(QUOTE_EXPIRY + 1),
    evidenceKind: "melt_unpaid_after_expiry",
    kind: "after_failure",
    paymentId: paymentId("payment-001"),
    proofStateObservedAt: unixTimestamp(QUOTE_EXPIRY + 2),
    recordedAt: unixTimestamp(recordedAt),
  });
}

function invoiceRecord(): CreateOpenInvoiceRecord {
  const invoice = createInvoiceV1({
    amount: minorUnits(2),
    createdAt: unixTimestamp(CREATED_AT),
    expiresAt: unixTimestamp(CREATED_AT + 300),
    id: invoiceId("invoice-001"),
    merchantId: merchantId("merchant-001"),
  });
  return {
    cashuPaymentRequest: REQUEST_ISSUER.issue({ invoice, issuedAt: invoice.createdAt }),
    idempotencyKey: idempotencyKey("checkout-001"),
    invoice,
    requestFingerprint: createFingerprint("invoice-001"),
    settlementDestination: DESTINATION,
  };
}

function meltQuote(state: "PAID" | "PENDING" | "UNPAID", observedAt: number) {
  return createCashuStellarMeltQuoteV1({
    amount: 2,
    expiry: QUOTE_EXPIRY,
    feeReserve: 0,
    method: CASHU_STELLAR_METHOD,
    mintUrl: MINT_URL,
    observedAt,
    quoteId: QUOTE_ID,
    request: PAYMENT_REQUEST,
    state,
    unit: CASHU_STELLAR_UNIT,
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

function proofReference(y: string) {
  return createCashuProofReferenceV1({ amount: 1, keysetId: KEYSET_ID, y });
}

async function seedOpaqueCustody(): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const nonce = Buffer.alloc(12, 31);
  try {
    await pool.query("BEGIN");
    await pool.query(
      `
        INSERT INTO cashu_proof_custody_nonce_uses (key_id, nonce, payment_id, created_at)
        VALUES ('recovery-job-test-key', $1, 'payment-001', $2)
      `,
      [nonce, RESERVED_AT],
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
        ) VALUES (
          'payment-001', $1, $2, 1, 'aes-256-gcm-v1', 'recovery-job-test-key', $3, $4, $5, 2, $6
        )
      `,
      [
        createFingerprint("custody-binding"),
        createFingerprint("custody-record"),
        nonce,
        Buffer.alloc(16, 31),
        Buffer.from([31]),
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

function createFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function connectInvoiceRepository(): Promise<PostgresInvoiceRepository> {
  return track(
    await PostgresInvoiceRepository.connect({
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    }),
  );
}

async function connectKeysetRepository(): Promise<PostgresCashuKeysetRepository> {
  return track(
    await PostgresCashuKeysetRepository.connect({
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    }),
  );
}

async function connectReservationRepository(): Promise<PostgresCashuProofReservationRepository> {
  return track(
    await PostgresCashuProofReservationRepository.connect({
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    }),
  );
}

async function connectProofStateRepository(): Promise<PostgresCashuProofStateRepository> {
  return track(
    await PostgresCashuProofStateRepository.connect({
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    }),
  );
}

async function connectQuoteRepository(): Promise<PostgresCashuStellarMeltQuoteRepository> {
  return track(
    await PostgresCashuStellarMeltQuoteRepository.connect({
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    }),
  );
}

async function connectLifecycleRepository(): Promise<PostgresCashuProofReservationLifecycleRepository> {
  return track(
    await PostgresCashuProofReservationLifecycleRepository.connect({
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    }),
  );
}

async function connectJobRepository(): Promise<PostgresCashuStellarMeltRecoveryJobRepository> {
  return track(
    await PostgresCashuStellarMeltRecoveryJobRepository.connect({
      connectionString: requireDatabaseUrl(),
      maxConnections: 4,
    }),
  );
}

function track<T extends { close(): Promise<void> }>(repository: T): T {
  repositories.push(repository);
  return repository;
}

async function closeRepository(repository: { close(): Promise<void> }): Promise<void> {
  await repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
}

async function waitForBlockedQuery(pool: Pool, queryFragment: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ blocked: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE $1
        ) AS blocked
      `,
      [`%${queryFragment}%`],
    );
    if (result.rows[0]?.blocked === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for blocked PostgreSQL query: ${queryFragment}`);
}

function requireDatabaseUrl(): string {
  if (DATABASE_URL === undefined) {
    throw new Error("CASHMESH_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  }
  return DATABASE_URL;
}
