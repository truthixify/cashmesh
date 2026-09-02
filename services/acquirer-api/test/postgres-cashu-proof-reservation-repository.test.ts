import {
  CashuPaymentRequestIssuer,
  createCashuKeysetSnapshotV1,
  createCashuProofReferenceV1,
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
  CashuProofReservationRepositoryError,
  type ReserveCashuProofsInput,
} from "../src/cashu-proof-reservation-repository";
import type { CreateOpenInvoiceRecord } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresCashuProofReservationRepository } from "../src/postgres-cashu-proof-reservation-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const MINT_A = "https://mint-a.cashmesh.example";
const MINT_B = "https://mint-b.cashmesh.example";
const CREATED_AT = 1_788_000_000;
const EXPIRES_AT = CREATED_AT + 300;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_Y_A = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const PROOF_Y_B = "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5";
const repositories: Array<{ close(): Promise<void> }> = [];
const CASHU_PAYMENT_REQUEST_ISSUER = new CashuPaymentRequestIssuer({
  operators: [
    {
      mintUrl: MINT_A,
      operatorId: operatorId("operator-a"),
      tier: "trusted",
    },
    {
      mintUrl: MINT_B,
      operatorId: operatorId("operator-b"),
      tier: "convertible",
    },
  ],
  transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
});

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL Cashu proof reservations", () => {
  beforeAll(async () => {
    const repository = await PostgresCashuProofReservationRepository.connect({
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

  it("persists an exact non-bearer reservation across repository restart", async () => {
    await seedInvoiceAndKeyset();
    const input = reservationInput();
    const firstRepository = await connectReservationRepository();
    const first = await firstRepository.reserve(input);
    await closeRepository(firstRepository);

    const restartedRepository = await connectReservationRepository();
    const found = await restartedRepository.findByPaymentId(paymentId("payment-001"));
    const replay = await restartedRepository.reserve(input);

    expect(first.replayed).toBe(false);
    expect(first.reservation).toEqual({
      grossAmount: 2,
      invoiceId: "invoice-001",
      keysetObservedAt: CREATED_AT,
      mintUrl: MINT_A,
      operatorId: "operator-a",
      paymentId: "payment-001",
      proofReferences: [
        { amount: 1, keysetId: KEYSET_ID, y: PROOF_Y_A },
        { amount: 1, keysetId: KEYSET_ID, y: PROOF_Y_B },
      ],
      reservedAt: CREATED_AT + 1,
      schemaVersion: 1,
      unit: "usdc",
    });
    expect(found).toEqual(first.reservation);
    expect(replay).toEqual({ replayed: true, reservation: first.reservation });
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found?.proofReferences)).toBe(true);
    expect(JSON.stringify(found)).not.toMatch(/secret|signature|dleq|witness/i);
    await expectReservationRowCounts({ proofs: 2, reservations: 1 });
  });

  it("rejects changed terms under an existing payment identifier", async () => {
    await seedInvoiceAndKeyset();
    const repository = await connectReservationRepository();
    await repository.reserve(reservationInput());

    const error = await errorFromAsync(() =>
      repository.reserve(reservationInput({ reservedAt: CREATED_AT + 2 })),
    );

    expect(error).toBeInstanceOf(CashuProofReservationRepositoryError);
    expect(error).toMatchObject({ code: "payment_conflict" });
    await expectReservationRowCounts({ proofs: 2, reservations: 1 });
  });

  it.each([
    {
      code: "invalid_input",
      name: "keyset evidence observed after reservation",
      overrides: { keysetObservedAt: CREATED_AT + 2 },
    },
    {
      code: "route_not_accepted",
      name: "a crossed operator and mint route",
      overrides: { mintUrl: MINT_B, operatorId: "operator-a" },
    },
    {
      code: "reservation_window_closed",
      name: "a reservation at invoice expiry",
      overrides: { reservedAt: EXPIRES_AT },
    },
    {
      code: "reservation_window_closed",
      name: "a reservation before invoice creation",
      overrides: { keysetObservedAt: CREATED_AT - 1, reservedAt: CREATED_AT - 1 },
    },
  ])("rejects $name", async ({ code, overrides }) => {
    await seedInvoiceAndKeyset();
    const repository = await connectReservationRepository();

    const error = await errorFromAsync(() => repository.reserve(reservationInput(overrides)));

    expect(error).toMatchObject({ code });
    await expectReservationRowCounts({ proofs: 0, reservations: 0 });
  });

  it("requires every keyset from the selected operator observation", async () => {
    await seedInvoice();
    await seedKeyset({ mintUrl: MINT_A, operatorId: "operator-b" });
    const repository = await connectReservationRepository();

    const error = await errorFromAsync(() => repository.reserve(reservationInput()));

    expect(error).toMatchObject({ code: "keyset_evidence_missing" });
    await expectReservationRowCounts({ proofs: 0, reservations: 0 });
  });

  it("keeps identical proof Ys at distinct mint URLs independent", async () => {
    await seedInvoiceAndKeyset();
    await seedKeyset({ mintUrl: MINT_B, operatorId: "operator-b" });
    const repository = await connectReservationRepository();
    await repository.reserve(reservationInput());
    await repository.reserve(
      reservationInput({
        mintUrl: MINT_B,
        operatorId: "operator-b",
        paymentId: "payment-002",
      }),
    );

    await expectReservationRowCounts({ proofs: 4, reservations: 2 });
  });

  it("converges concurrent exact reservation attempts", async () => {
    await seedInvoiceAndKeyset();
    const firstRepository = await connectReservationRepository();
    const secondRepository = await connectReservationRepository();
    const input = reservationInput();

    const [first, second] = await Promise.all([
      firstRepository.reserve(input),
      secondRepository.reserve(input),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.reservation).toEqual(second.reservation);
    await expectReservationRowCounts({ proofs: 2, reservations: 1 });
  });

  it("allows only one concurrent payment to reserve a proof", async () => {
    await seedInvoiceAndKeyset();
    const firstRepository = await connectReservationRepository();
    const secondRepository = await connectReservationRepository();

    const outcomes = await Promise.allSettled([
      firstRepository.reserve(reservationInput({ paymentId: "payment-a" })),
      secondRepository.reserve(reservationInput({ paymentId: "payment-b" })),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: "proof_conflict" }),
      status: "rejected",
    });
    await expectReservationRowCounts({ proofs: 2, reservations: 1 });
  });

  it("rolls back a new header and earlier proof when a later proof conflicts", async () => {
    await seedInvoiceAndKeyset();
    const repository = await connectReservationRepository();
    await repository.reserve(
      reservationInput({
        paymentId: "payment-existing",
        proofReferences: [proofReference(PROOF_Y_B)],
      }),
    );

    const error = await errorFromAsync(() =>
      repository.reserve(
        reservationInput({
          paymentId: "payment-conflict",
          proofReferences: [proofReference(PROOF_Y_B), proofReference(PROOF_Y_A)],
        }),
      ),
    );

    expect(error).toMatchObject({ code: "proof_conflict" });
    await expectReservationRowCounts({ proofs: 1, reservations: 1 });
    await expect(
      repository.findByPaymentId(paymentId("payment-conflict")),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed and duplicate proof references before writing", async () => {
    await seedInvoiceAndKeyset();
    const repository = await connectReservationRepository();
    const duplicate = proofReference(PROOF_Y_A);

    const duplicateError = await errorFromAsync(() =>
      repository.reserve(reservationInput({ proofReferences: [duplicate, duplicate] })),
    );
    const malformedError = await errorFromAsync(() =>
      repository.reserve(
        reservationInput({
          proofReferences: [{ ...duplicate, y: `02${"ff".repeat(32)}` }],
        }),
      ),
    );

    expect(duplicateError).toMatchObject({ code: "invalid_input" });
    expect(malformedError).toMatchObject({ code: "invalid_input" });
    await expectReservationRowCounts({ proofs: 0, reservations: 0 });
  });

  it("fails closed when a stored reservation no longer matches its fingerprint", async () => {
    await seedInvoiceAndKeyset();
    const repository = await connectReservationRepository();
    await repository.reserve(reservationInput());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(
        "ALTER TABLE cashu_proof_reservations DISABLE TRIGGER cashu_proof_reservations_append_only",
      );
      try {
        await pool.query("UPDATE cashu_proof_reservations SET reservation_fingerprint = $1", [
          "f".repeat(64),
        ]);
      } finally {
        await pool.query(
          "ALTER TABLE cashu_proof_reservations ENABLE TRIGGER cashu_proof_reservations_append_only",
        );
      }
    } finally {
      await pool.end();
    }

    const error = await errorFromAsync(() => repository.findByPaymentId(paymentId("payment-001")));

    expect(error).toMatchObject({ code: "invalid_record" });
  });

  it("rejects row-level mutation of reservations and proof references", async () => {
    await seedInvoiceAndKeyset();
    const repository = await connectReservationRepository();
    await repository.reserve(reservationInput());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      for (const mutation of [
        "UPDATE cashu_proof_reservations SET gross_amount = gross_amount + 1",
        "DELETE FROM cashu_reserved_proofs",
      ]) {
        const error = await errorFromAsync(() => pool.query(mutation));
        expect(error).toMatchObject({ code: "55000" });
      }
    } finally {
      await pool.end();
    }

    await expectReservationRowCounts({ proofs: 2, reservations: 1 });
  });

  it("refuses to commit missing or inconsistent proof rows below the repository", async () => {
    await seedInvoiceAndKeyset();
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      for (const setup of [
        async () => insertRawReservation(pool, "raw-empty", "a".repeat(64), 2),
        async () => {
          await insertRawReservation(pool, "raw-mismatch", "b".repeat(64), 2);
          await pool.query(
            `
              INSERT INTO cashu_reserved_proofs (
                payment_id, mint_url, unit, position, proof_y, keyset_id, amount
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            ["raw-mismatch", MINT_A, "usdc", 0, PROOF_Y_A, KEYSET_ID, 1],
          );
        },
      ]) {
        await pool.query("BEGIN");
        await setup();
        const error = await errorFromAsync(() => pool.query("COMMIT"));
        expect(error).toMatchObject({ code: "23514" });
        await pool.query("ROLLBACK");
      }
    } finally {
      await pool.end();
    }
  });

  it("requires the selected operator observation below the repository", async () => {
    await seedInvoiceAndKeyset();
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("BEGIN");
      await insertRawReservation(pool, "raw-unobserved", "d".repeat(64), 1, CREATED_AT - 1);
      await pool.query(
        `
          INSERT INTO cashu_reserved_proofs (
            payment_id, mint_url, unit, position, proof_y, keyset_id, amount
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        ["raw-unobserved", MINT_A, "usdc", 0, PROOF_Y_A, KEYSET_ID, 1],
      );

      const error = await errorFromAsync(() => pool.query("COMMIT"));

      expect(error).toMatchObject({ code: "23514" });
      await pool.query("ROLLBACK");
    } finally {
      await pool.end();
    }
  });

  it("stores no bearer-proof columns", async () => {
    await seedInvoiceAndKeyset();
    const repository = await connectReservationRepository();
    await repository.reserve(reservationInput());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const result = await pool.query<{ column_name: string; table_name: string }>(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('cashu_proof_reservations', 'cashu_reserved_proofs')
          ORDER BY table_name, ordinal_position
        `,
      );
      expect(result.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
        "cashu_proof_reservations.payment_id",
        "cashu_proof_reservations.reservation_fingerprint",
        "cashu_proof_reservations.invoice_id",
        "cashu_proof_reservations.operator_id",
        "cashu_proof_reservations.mint_url",
        "cashu_proof_reservations.unit",
        "cashu_proof_reservations.schema_version",
        "cashu_proof_reservations.keyset_observed_at",
        "cashu_proof_reservations.reserved_at",
        "cashu_proof_reservations.gross_amount",
        "cashu_reserved_proofs.payment_id",
        "cashu_reserved_proofs.mint_url",
        "cashu_reserved_proofs.unit",
        "cashu_reserved_proofs.position",
        "cashu_reserved_proofs.proof_y",
        "cashu_reserved_proofs.keyset_id",
        "cashu_reserved_proofs.amount",
      ]);
    } finally {
      await pool.end();
    }
  });
});

async function seedInvoiceAndKeyset(): Promise<void> {
  await seedInvoice();
  await seedKeyset();
}

async function seedInvoice(): Promise<void> {
  const invoiceRepository = await connectInvoiceRepository();
  await invoiceRepository.createOpenInvoice(invoiceRecord());
}

async function seedKeyset(
  overrides: { readonly mintUrl?: string; readonly operatorId?: string } = {},
): Promise<void> {
  const repository = await connectKeysetRepository();
  const snapshot = createCashuKeysetSnapshotV1({
    keysets: [
      {
        active: true,
        id: KEYSET_ID,
        keys: { "1": KEYSET_PUBLIC_KEY },
        unit: "usdc",
      },
    ],
    mintUrl: overrides.mintUrl ?? MINT_A,
    observedAt: CREATED_AT,
  });
  await repository.persistObservation({
    operatorId: operatorId(overrides.operatorId ?? "operator-a"),
    snapshot,
    unit: "usdc",
  });
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

async function closeRepository(repository: { close(): Promise<void> }): Promise<void> {
  await repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
}

function invoiceRecord(
  overrides: {
    readonly idempotencyKey?: string;
    readonly invoiceId?: string;
    readonly merchantId?: string;
  } = {},
): CreateOpenInvoiceRecord {
  const ownerId = merchantId(overrides.merchantId ?? "merchant-001");
  const invoice = createInvoiceV1({
    amount: minorUnits(2),
    createdAt: unixTimestamp(CREATED_AT),
    expiresAt: unixTimestamp(EXPIRES_AT),
    id: invoiceId(overrides.invoiceId ?? "invoice-001"),
    merchantId: ownerId,
  });
  return {
    cashuPaymentRequest: CASHU_PAYMENT_REQUEST_ISSUER.issue({
      invoice,
      issuedAt: invoice.createdAt,
    }),
    idempotencyKey: idempotencyKey(overrides.idempotencyKey ?? "checkout-001"),
    invoice,
    requestFingerprint: "c".repeat(64),
  };
}

interface ReservationOverrides {
  readonly invoiceId?: string;
  readonly keysetObservedAt?: number;
  readonly mintUrl?: string;
  readonly operatorId?: string;
  readonly paymentId?: string;
  readonly proofReferences?: ReserveCashuProofsInput["proofReferences"];
  readonly reservedAt?: number;
}

function reservationInput(overrides: ReservationOverrides = {}): ReserveCashuProofsInput {
  return {
    invoiceId: invoiceId(overrides.invoiceId ?? "invoice-001"),
    keysetObservedAt: unixTimestamp(overrides.keysetObservedAt ?? CREATED_AT),
    mintUrl: overrides.mintUrl ?? MINT_A,
    operatorId: operatorId(overrides.operatorId ?? "operator-a"),
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
    proofReferences: overrides.proofReferences ?? [
      proofReference(PROOF_Y_B),
      proofReference(PROOF_Y_A),
    ],
    reservedAt: unixTimestamp(overrides.reservedAt ?? CREATED_AT + 1),
    unit: "usdc",
  };
}

function proofReference(y: string) {
  return createCashuProofReferenceV1({ amount: 1, keysetId: KEYSET_ID, y });
}

async function insertRawReservation(
  pool: Pool,
  requestedPaymentId: string,
  fingerprint: string,
  grossAmount: number,
  keysetObservedAt = CREATED_AT,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO cashu_proof_reservations (
        payment_id,
        reservation_fingerprint,
        invoice_id,
        operator_id,
        mint_url,
        unit,
        schema_version,
        keyset_observed_at,
        reserved_at,
        gross_amount
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `,
    [
      requestedPaymentId,
      fingerprint,
      "invoice-001",
      "operator-a",
      MINT_A,
      "usdc",
      1,
      keysetObservedAt,
      CREATED_AT + 1,
      grossAmount,
    ],
  );
}

async function expectReservationRowCounts(expected: {
  readonly proofs: number;
  readonly reservations: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{ proofs: string; reservations: string }>(`
      SELECT
        (SELECT COUNT(*) FROM cashu_proof_reservations) AS reservations,
        (SELECT COUNT(*) FROM cashu_reserved_proofs) AS proofs
    `);
    expect(result.rows[0]).toEqual({
      proofs: String(expected.proofs),
      reservations: String(expected.reservations),
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
