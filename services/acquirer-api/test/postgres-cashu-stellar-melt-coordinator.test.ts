import { createHash, createSecretKey } from "node:crypto";

import {
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
  CASHU_STELLAR_TESTNET_USDC_ISSUER,
  CASHU_STELLAR_UNIT,
  CashuPaymentRequestIssuer,
  CashuStellarMeltExecutionClient,
  createCashuKeysetSnapshotV1,
  createCashuProofStateSnapshotV1,
  createCashuStellarMeltQuoteV1,
  validateCashuPaymentProofsForCustodyV1,
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
  Aes256GcmCashuProofCustodyCipher,
  type CashuProofCustodyKey,
  type CashuProofCustodyKeyId,
  type CashuProofCustodyKeyProvider,
  cashuProofCustodyKeyId,
  createCashuProofCustodyKey,
} from "../src/cashu-proof-custody-cipher";
import { CashuStellarMeltCoordinator } from "../src/cashu-stellar-melt-coordinator";
import { cashuStellarMeltQuoteAttemptId } from "../src/cashu-stellar-melt-quote-repository";
import { CashuStellarMeltRecoveryCoordinator } from "../src/cashu-stellar-melt-recovery-coordinator";
import type { CreateOpenInvoiceRecord } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresCashuProofCustodyRepository } from "../src/postgres-cashu-proof-custody-repository";
import { PostgresCashuProofReservationLifecycleRepository } from "../src/postgres-cashu-proof-reservation-lifecycle-repository";
import { PostgresCashuProofReservationRepository } from "../src/postgres-cashu-proof-reservation-repository";
import { PostgresCashuProofStateRepository } from "../src/postgres-cashu-proof-state-repository";
import { PostgresCashuStellarMeltQuoteRepository } from "../src/postgres-cashu-stellar-melt-quote-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const MINT_URL = "https://mint-a.cashmesh.example";
const CREATED_AT = 1_788_700_000;
const INVOICE_EXPIRES_AT = CREATED_AT + 600;
const RESERVED_AT = CREATED_AT + 1;
const CUSTODY_AT = CREATED_AT + 2;
const ATTEMPT_STARTED_AT = CREATED_AT + 3;
const QUOTE_OBSERVED_AT = CREATED_AT + 4;
const QUOTE_EXPIRY = CREATED_AT + 300;
const DISPATCH_PREPARED_AT = CREATED_AT + 10;
const DISPATCH_STARTED_AT = CREATED_AT + 11;
const OPERATOR_OBSERVED_AT = CREATED_AT + 12;
const PENDING_RECORDED_AT = CREATED_AT + 13;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_SECRET = "daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9";
const PROOF_SIGNATURE = "024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc";
const PROOF_DLEQ = {
  e: "b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4",
  r: "a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861",
  s: "8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8",
} as const;
const QUOTE_ID = "01890f3c-7b62-7a4f-bc7d-1a2b3c4d5e6f";
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
const CUSTODY_KEY = createCashuProofCustodyKey(
  cashuProofCustodyKeyId("coordinator-custody-key"),
  createSecretKey(new Uint8Array(32).fill(17)),
);

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL Cashu Stellar melt coordination", () => {
  beforeAll(async () => {
    const repository = await connectInvoiceRepository();
    await closeRepository(repository);
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

  it("persists one authorized dispatch and recovers without a second operator call", async () => {
    await seedDispatchState();
    let operatorCalls = 0;
    let requestBody: string | undefined;
    const executor = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: () => OPERATOR_OBSERVED_AT,
      fetch: async (_input, init) => {
        operatorCalls += 1;
        requestBody = String(init?.body);
        return jsonResponse(quoteResponse("PENDING"));
      },
    });
    const firstRepositories = await connectCoordinatorRepositories();
    const firstCoordinator = coordinator(firstRepositories, executor);

    const firstResult = await firstCoordinator.dispatch({ paymentId: "payment-001" });

    expect(firstResult).toMatchObject({
      lifecycle: {
        events: [
          { recordedAt: DISPATCH_STARTED_AT, state: "dispatch_started" },
          {
            evidenceAt: OPERATOR_OBSERVED_AT,
            recordedAt: PENDING_RECORDED_AT,
            state: "pending",
          },
        ],
        state: "pending",
      },
      observedAt: OPERATOR_OBSERVED_AT,
      paymentId: "payment-001",
      state: "operator_pending",
    });
    expect(operatorCalls).toBe(1);
    expect(JSON.parse(requestBody ?? "{}")).toMatchObject({
      prefer_async: true,
      quote: QUOTE_ID,
    });
    expect(JSON.stringify(firstResult)).not.toContain(PROOF_SECRET);
    await closeCoordinatorRepositories(firstRepositories);

    const restartedRepositories = await connectCoordinatorRepositories();
    const restartedCoordinator = coordinator(restartedRepositories, executor);
    const recovered = await restartedCoordinator.dispatch({ paymentId: "payment-001" });
    const quoteAttempt = await restartedRepositories.quote.findByPaymentId(
      paymentId("payment-001"),
    );
    const custody = await restartedRepositories.custody.findMetadata(paymentId("payment-001"));

    expect(recovered).toMatchObject({
      lifecycle: { state: "pending" },
      state: "recovery_required",
    });
    expect(operatorCalls).toBe(1);
    expect(quoteAttempt?.state).toBe("quoted");
    expect(quoteAttempt?.observations.map((observation) => observation.state)).toEqual([
      "UNPAID",
      "PENDING",
    ]);
    expect(custody).toMatchObject({ paymentId: "payment-001", proofCount: 1 });
    await expectPersistedCounts({ observations: 2 });

    let quoteChecks = 0;
    let proofObservations = 0;
    const recoveryCoordinator = new CashuStellarMeltRecoveryCoordinator(
      {
        lifecycleRepository: restartedRepositories.lifecycle,
        proofStateObservers: [
          {
            mintUrl: MINT_URL,
            async observe(input) {
              proofObservations += 1;
              return createCashuProofStateSnapshotV1({
                mintUrl: MINT_URL,
                observedAt: OPERATOR_OBSERVED_AT + 2,
                states: input.proofReferences.map((proof) => ({ state: "SPENT", y: proof.y })),
              });
            },
          },
        ],
        proofStateRepository: restartedRepositories.proofStates,
        quoteCheckers: [
          {
            mintUrl: MINT_URL,
            async check() {
              quoteChecks += 1;
              return quote("PAID", OPERATOR_OBSERVED_AT + 1);
            },
          },
        ],
        quoteRepository: restartedRepositories.quote,
        reservationRepository: restartedRepositories.reservations,
      },
      { clock: () => OPERATOR_OBSERVED_AT + 3 },
    );

    const accepted = await recoveryCoordinator.recover({ paymentId: "payment-001" });
    const replay = await recoveryCoordinator.recover({ paymentId: "payment-001" });
    const terminalCustody = await restartedRepositories.custody.findMetadata(
      paymentId("payment-001"),
    );

    expect(accepted).toMatchObject({
      accounting: {
        invoice: { state: "paid" },
        journalEntry: { reference: { settlementMode: "immediate_conversion" } },
      },
      lifecycle: { state: "consumed" },
      replayed: false,
      state: "accepted",
    });
    expect(replay).toMatchObject({ lifecycle: { state: "consumed" }, replayed: true });
    expect({ operatorCalls, proofObservations, quoteChecks }).toEqual({
      operatorCalls: 1,
      proofObservations: 1,
      quoteChecks: 1,
    });
    expect(terminalCustody).toBeUndefined();
    await expectPersistedCounts({
      custody: 0,
      events: 3,
      journals: 1,
      observations: 3,
      paidInvoices: 1,
    });
  });

  it("persists post-authorization transport ambiguity across restart", async () => {
    await seedDispatchState();
    let operatorCalls = 0;
    const executor = new CashuStellarMeltExecutionClient(MINT_URL, {
      clock: () => OPERATOR_OBSERVED_AT,
      fetch: async () => {
        operatorCalls += 1;
        throw new TypeError("fixture transport failure");
      },
    });
    const firstRepositories = await connectCoordinatorRepositories();
    const firstCoordinator = coordinator(firstRepositories, executor);

    const firstResult = await firstCoordinator.dispatch({ paymentId: "payment-001" });

    expect(firstResult).toMatchObject({
      attentionReason: "transport_ambiguous",
      lifecycle: {
        events: [
          { recordedAt: DISPATCH_STARTED_AT, state: "dispatch_started" },
          {
            evidenceKind: "transport_ambiguous",
            recordedAt: PENDING_RECORDED_AT,
            state: "needs_attention",
          },
        ],
        state: "needs_attention",
      },
      state: "needs_attention",
    });
    expect(operatorCalls).toBe(1);
    await closeCoordinatorRepositories(firstRepositories);

    const restartedRepositories = await connectCoordinatorRepositories();
    const restartedCoordinator = coordinator(restartedRepositories, executor);
    const recovered = await restartedCoordinator.dispatch({ paymentId: "payment-001" });
    const custody = await restartedRepositories.custody.findMetadata(paymentId("payment-001"));

    expect(recovered).toMatchObject({
      lifecycle: { state: "needs_attention" },
      state: "recovery_required",
    });
    expect(operatorCalls).toBe(1);
    expect(custody).toMatchObject({ paymentId: "payment-001", proofCount: 1 });
    await expectPersistedCounts({ observations: 1 });
  });
});

interface CoordinatorRepositories {
  readonly custody: PostgresCashuProofCustodyRepository;
  readonly keysets: PostgresCashuKeysetRepository;
  readonly lifecycle: PostgresCashuProofReservationLifecycleRepository;
  readonly proofStates: PostgresCashuProofStateRepository;
  readonly quote: PostgresCashuStellarMeltQuoteRepository;
  readonly reservations: PostgresCashuProofReservationRepository;
}

async function seedDispatchState(): Promise<void> {
  const invoiceRepository = await connectInvoiceRepository();
  await invoiceRepository.createOpenInvoice(invoiceRecord());
  await closeRepository(invoiceRepository);

  const validation = validatedPayment();
  const keysetRepository = await connectKeysetRepository();
  await keysetRepository.persistObservation({
    operatorId: operatorId("operator-a"),
    snapshot: keysetSnapshot(),
    unit: CASHU_STELLAR_UNIT,
  });
  await closeRepository(keysetRepository);

  const reservationRepository = await connectReservationRepository();
  await reservationRepository.reserve({
    invoiceId: invoiceId("invoice-001"),
    keysetObservedAt: unixTimestamp(CREATED_AT),
    mintUrl: MINT_URL,
    operatorId: operatorId("operator-a"),
    paymentId: paymentId("payment-001"),
    proofReferences: validation.validation.proofReferences,
    reservedAt: unixTimestamp(RESERVED_AT),
    unit: CASHU_STELLAR_UNIT,
  });
  await closeRepository(reservationRepository);

  const custodyRepository = await connectCustodyRepository(21);
  try {
    await custodyRepository.store({
      bearerProofs: validation.bearerProofs,
      createdAt: unixTimestamp(CUSTODY_AT),
      paymentId: paymentId("payment-001"),
    });
  } finally {
    validation.bearerProofs.destroy();
  }
  await closeRepository(custodyRepository);

  const quoteRepository = await connectQuoteRepository();
  await quoteRepository.begin({
    amount: 1,
    attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
    paymentId: paymentId("payment-001"),
    request: PAYMENT_REQUEST,
    startedAt: unixTimestamp(ATTEMPT_STARTED_AT),
  });
  await quoteRepository.recordQuote({
    attemptId: cashuStellarMeltQuoteAttemptId("attempt-001"),
    paymentId: paymentId("payment-001"),
    quote: quote("UNPAID", QUOTE_OBSERVED_AT),
  });
  await closeRepository(quoteRepository);
}

function coordinator(
  repository: CoordinatorRepositories,
  executor: CashuStellarMeltExecutionClient,
): CashuStellarMeltCoordinator {
  return new CashuStellarMeltCoordinator(
    {
      custodyRepository: repository.custody,
      executors: [executor],
      keysetRepository: repository.keysets,
      lifecycleRepository: repository.lifecycle,
      quoteRepository: repository.quote,
      reservationRepository: repository.reservations,
    },
    {
      clock: sequenceClock(DISPATCH_PREPARED_AT, DISPATCH_STARTED_AT, PENDING_RECORDED_AT),
    },
  );
}

function validatedPayment() {
  return validateCashuPaymentProofsForCustodyV1({
    keysetSnapshot: keysetSnapshot(),
    rawPayload: JSON.stringify({
      id: "invoice-001",
      mint: MINT_URL,
      proofs: [
        {
          C: PROOF_SIGNATURE,
          amount: 1,
          dleq: PROOF_DLEQ,
          id: KEYSET_ID,
          secret: PROOF_SECRET,
        },
      ],
      unit: CASHU_STELLAR_UNIT,
    }),
    validatedAt: CREATED_AT,
  });
}

function keysetSnapshot() {
  return createCashuKeysetSnapshotV1({
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
  });
}

function quote(state: "PAID" | "PENDING" | "UNPAID", observedAt: number) {
  return createCashuStellarMeltQuoteV1({
    amount: 1,
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

function quoteResponse(state: "PENDING" | "UNPAID") {
  return {
    amount: 1,
    expiry: QUOTE_EXPIRY,
    fee_reserve: 0,
    method: CASHU_STELLAR_METHOD,
    quote: QUOTE_ID,
    request: PAYMENT_REQUEST,
    state,
    unit: CASHU_STELLAR_UNIT,
  };
}

function stellarPaymentRequest(): string {
  const parameters = new URLSearchParams({
    amount: "0.01",
    asset_code: CASHU_STELLAR_TESTNET_USDC_ASSET_CODE,
    asset_issuer: CASHU_STELLAR_TESTNET_USDC_ISSUER,
    destination: DESTINATION,
    network_passphrase: CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE,
  });
  return `web+stellar:pay?${parameters.toString()}`;
}

function invoiceRecord(): CreateOpenInvoiceRecord {
  const invoice = createInvoiceV1({
    amount: minorUnits(1),
    createdAt: unixTimestamp(CREATED_AT),
    expiresAt: unixTimestamp(INVOICE_EXPIRES_AT),
    id: invoiceId("invoice-001"),
    merchantId: merchantId("merchant-001"),
  });
  return {
    cashuPaymentRequest: REQUEST_ISSUER.issue({ invoice, issuedAt: invoice.createdAt }),
    idempotencyKey: idempotencyKey("checkout-invoice-001"),
    invoice,
    requestFingerprint: createHash("sha256").update("invoice-001").digest("hex"),
    settlementDestination: DESTINATION,
  };
}

function custodyCipher(nonceFill: number): Aes256GcmCashuProofCustodyCipher {
  return new Aes256GcmCashuProofCustodyCipher({
    keyProvider: keyProvider([CUSTODY_KEY]),
    randomBytes: () => new Uint8Array(12).fill(nonceFill),
  });
}

function keyProvider(keys: readonly CashuProofCustodyKey[]): CashuProofCustodyKeyProvider {
  const active = keys[0];
  if (active === undefined) {
    throw new Error("A test custody key is required.");
  }
  const byId = new Map<CashuProofCustodyKeyId, CashuProofCustodyKey>(
    keys.map((value) => [value.keyId, value]),
  );
  return {
    activeKey: async () => active,
    findKey: async (keyId) => byId.get(keyId),
  };
}

async function connectCoordinatorRepositories(): Promise<CoordinatorRepositories> {
  return {
    custody: await connectCustodyRepository(22),
    keysets: await connectKeysetRepository(),
    lifecycle: await connectLifecycleRepository(),
    proofStates: await connectProofStateRepository(),
    quote: await connectQuoteRepository(),
    reservations: await connectReservationRepository(),
  };
}

async function closeCoordinatorRepositories(repositoriesToClose: CoordinatorRepositories) {
  await Promise.all([
    closeRepository(repositoriesToClose.custody),
    closeRepository(repositoriesToClose.keysets),
    closeRepository(repositoriesToClose.lifecycle),
    closeRepository(repositoriesToClose.proofStates),
    closeRepository(repositoriesToClose.quote),
    closeRepository(repositoriesToClose.reservations),
  ]);
}

async function connectCustodyRepository(
  nonceFill: number,
): Promise<PostgresCashuProofCustodyRepository> {
  const repository = await PostgresCashuProofCustodyRepository.connect({
    cipher: custodyCipher(nonceFill),
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

async function connectLifecycleRepository(): Promise<PostgresCashuProofReservationLifecycleRepository> {
  const repository = await PostgresCashuProofReservationLifecycleRepository.connect({
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

async function connectProofStateRepository(): Promise<PostgresCashuProofStateRepository> {
  const repository = await PostgresCashuProofStateRepository.connect({
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

async function closeRepository(repository: { close(): Promise<void> }): Promise<void> {
  await repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
}

async function expectPersistedCounts(expected: {
  readonly custody?: number;
  readonly events?: number;
  readonly journals?: number;
  readonly observations: number;
  readonly paidInvoices?: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{
      custody: string;
      effects: string;
      events: string;
      journals: string;
      observations: string;
      paid_invoices: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM cashu_bearer_proof_custody) AS custody,
        (SELECT COUNT(*) FROM cashu_operator_effects) AS effects,
        (SELECT COUNT(*) FROM cashu_proof_reservation_events) AS events,
        (SELECT COUNT(*) FROM cashu_stellar_melt_quote_observations) AS observations,
        (SELECT COUNT(*) FROM merchant_invoice_payment_journals) AS journals,
        (SELECT COUNT(*) FROM merchant_invoices WHERE state = 'paid') AS paid_invoices
    `);
    expect(result.rows[0]).toEqual({
      custody: String(expected.custody ?? 1),
      effects: "1",
      events: String(expected.events ?? 2),
      journals: String(expected.journals ?? 0),
      observations: String(expected.observations),
      paid_invoices: String(expected.paidInvoices ?? 0),
    });
  } finally {
    await pool.end();
  }
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

function requireDatabaseUrl(): string {
  if (DATABASE_URL === undefined) {
    throw new Error("CASHMESH_TEST_DATABASE_URL is required for PostgreSQL integration tests.");
  }
  return DATABASE_URL;
}
