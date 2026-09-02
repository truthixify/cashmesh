import {
  CashuPaymentRequestIssuer,
  type CashuProofStateValue,
  createCashuKeysetSnapshotV1,
  createCashuProofReferenceV1,
  createCashuProofStateSnapshotV1,
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

import type { ReserveCashuProofsInput } from "../src/cashu-proof-reservation-repository";
import {
  CashuProofStateRepositoryError,
  type FindFreshCashuProofStateObservation,
  type PersistCashuProofStateObservation,
} from "../src/cashu-proof-state-repository";
import type { CreateOpenInvoiceRecord } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresCashuProofReservationRepository } from "../src/postgres-cashu-proof-reservation-repository";
import { PostgresCashuProofStateRepository } from "../src/postgres-cashu-proof-state-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const MINT_A = "https://mint-a.cashmesh.example";
const MINT_B = "https://mint-b.cashmesh.example";
const CREATED_AT = 1_788_000_000;
const EXPIRES_AT = CREATED_AT + 300;
const RESERVED_AT = CREATED_AT + 1;
const KEYSET_ID = "000f715baf5d4c2e";
const KEYSET_PUBLIC_KEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const PROOF_Y_A = "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05";
const PROOF_Y_B = "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5";
const PROOF_Y_C = "02b79a5775181e7973cab6c33eea75d943d9974acefd4d2a267f0f76ef567915ff";
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

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL Cashu proof-state evidence", () => {
  beforeAll(async () => {
    const repository = await PostgresCashuProofStateRepository.connect({
      connectionString: requireDatabaseUrl(),
    });
    await repository.close();
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(`
        TRUNCATE
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

  it("persists exact non-bearer state evidence across repository restart", async () => {
    await seedReservation();
    const input = stateObservation();
    const firstRepository = await connectStateRepository();
    const first = await firstRepository.persistObservation(input);
    await closeRepository(firstRepository);

    const restartedRepository = await connectStateRepository();
    const found = await restartedRepository.findLatestFreshSnapshot(freshLookup());
    const replay = await restartedRepository.persistObservation(input);

    expect(first).toEqual({ replayed: false, snapshot: input.snapshot });
    expect(found).toEqual(input.snapshot);
    expect(replay).toEqual({ replayed: true, snapshot: input.snapshot });
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found?.states)).toBe(true);
    expect(JSON.stringify(found)).not.toMatch(/secret|signature|dleq|witness/i);
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("returns the latest snapshot inside explicit inclusive freshness bounds", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(stateObservation({ observedAt: RESERVED_AT + 1 }));
    await repository.persistObservation(
      stateObservation({
        observedAt: RESERVED_AT + 2,
        states: stateEntries("PENDING", "UNSPENT"),
      }),
    );
    await repository.persistObservation(
      stateObservation({
        observedAt: RESERVED_AT + 3,
        states: stateEntries("UNSPENT", "UNSPENT"),
      }),
    );

    const latest = await repository.findLatestFreshSnapshot(
      freshLookup({
        observedAtOrAfter: RESERVED_AT + 1,
        observedAtOrBefore: RESERVED_AT + 2,
      }),
    );
    const lowerBoundary = await repository.findLatestFreshSnapshot(
      freshLookup({
        observedAtOrAfter: RESERVED_AT + 1,
        observedAtOrBefore: RESERVED_AT + 1,
      }),
    );
    const gap = await repository.findLatestFreshSnapshot(
      freshLookup({
        observedAtOrAfter: RESERVED_AT + 4,
        observedAtOrBefore: RESERVED_AT + 5,
      }),
    );

    expect(latest?.observedAt).toBe(RESERVED_AT + 2);
    expect(latest?.states).toEqual(stateEntries("PENDING", "UNSPENT"));
    expect(lowerBoundary?.observedAt).toBe(RESERVED_AT + 1);
    expect(gap).toBeUndefined();
    await expectStateRowCounts({ entries: 6, observations: 3 });
  });

  it("scopes freshness lookup by payment, operator, mint, and unit", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(stateObservation());

    await expect(
      repository.findLatestFreshSnapshot(freshLookup({ paymentId: "payment-other" })),
    ).resolves.toBeUndefined();
    await expect(
      repository.findLatestFreshSnapshot(freshLookup({ operatorId: "operator-b" })),
    ).resolves.toBeUndefined();
    await expect(
      repository.findLatestFreshSnapshot(freshLookup({ mintUrl: MINT_B })),
    ).resolves.toBeUndefined();
    await expect(
      repository.findLatestFreshSnapshot(freshLookup({ unit: "sat" })),
    ).resolves.toBeUndefined();
  });

  it("requires an existing reservation with the exact scope and observation time", async () => {
    const repository = await connectStateRepository();
    await expect(repository.persistObservation(stateObservation())).rejects.toMatchObject({
      code: "reservation_not_found",
    });

    await seedReservation();
    await expect(
      repository.persistObservation(stateObservation({ operatorId: "operator-b" })),
    ).rejects.toMatchObject({ code: "reservation_scope_mismatch" });
    await expect(
      repository.persistObservation(stateObservation({ mintUrl: MINT_B })),
    ).rejects.toMatchObject({ code: "reservation_scope_mismatch" });
    await expect(
      repository.persistObservation(stateObservation({ unit: "sat" })),
    ).rejects.toMatchObject({ code: "reservation_scope_mismatch" });
    await expect(
      repository.persistObservation(stateObservation({ observedAt: CREATED_AT })),
    ).rejects.toMatchObject({ code: "observation_before_reservation" });
    await expectStateRowCounts({ entries: 0, observations: 0 });
  });

  it("requires the complete exact reserved proof set", async () => {
    await seedReservation();
    const repository = await connectStateRepository();

    await expect(
      repository.persistObservation(
        stateObservation({ states: [{ state: "UNSPENT", y: PROOF_Y_A }] }),
      ),
    ).rejects.toMatchObject({ code: "proof_set_mismatch" });
    await expect(
      repository.persistObservation(
        stateObservation({
          states: [...stateEntries("UNSPENT", "PENDING"), { state: "UNSPENT", y: PROOF_Y_C }],
        }),
      ),
    ).rejects.toMatchObject({ code: "proof_set_mismatch" });
    await expectStateRowCounts({ entries: 0, observations: 0 });
  });

  it("rejects different evidence at the same payment observation time", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(stateObservation());

    const error = await errorFromAsync(() =>
      repository.persistObservation(
        stateObservation({ states: stateEntries("PENDING", "PENDING") }),
      ),
    );

    expect(error).toBeInstanceOf(CashuProofStateRepositoryError);
    expect(error).toMatchObject({ code: "observation_conflict" });
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("allows pending recovery and makes SPENT terminal per proof", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    const observations = [
      stateObservation({ observedAt: RESERVED_AT + 1 }),
      stateObservation({
        observedAt: RESERVED_AT + 2,
        states: stateEntries("PENDING", "UNSPENT"),
      }),
      stateObservation({
        observedAt: RESERVED_AT + 3,
        states: stateEntries("UNSPENT", "SPENT"),
      }),
      stateObservation({
        observedAt: RESERVED_AT + 4,
        states: stateEntries("SPENT", "SPENT"),
      }),
      stateObservation({
        observedAt: RESERVED_AT + 5,
        states: stateEntries("SPENT", "SPENT"),
      }),
    ];

    for (const observation of observations) {
      await repository.persistObservation(observation);
    }

    await expectStateRowCounts({ entries: 10, observations: 5 });
  });

  it("rejects later non-spent state after SPENT evidence", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(
      stateObservation({ states: stateEntries("SPENT", "PENDING") }),
    );

    const error = await errorFromAsync(() =>
      repository.persistObservation(
        stateObservation({
          observedAt: RESERVED_AT + 2,
          states: stateEntries("UNSPENT", "UNSPENT"),
        }),
      ),
    );

    expect(error).toMatchObject({ code: "spent_state_regression" });
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("rejects backfilled SPENT evidence before a later non-spent observation", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(
      stateObservation({
        observedAt: RESERVED_AT + 3,
        states: stateEntries("UNSPENT", "UNSPENT"),
      }),
    );

    const error = await errorFromAsync(() =>
      repository.persistObservation(
        stateObservation({
          observedAt: RESERVED_AT + 2,
          states: stateEntries("SPENT", "PENDING"),
        }),
      ),
    );

    expect(error).toMatchObject({ code: "spent_state_regression" });
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("converges concurrent exact observations on one durable snapshot", async () => {
    await seedReservation();
    const firstRepository = await connectStateRepository();
    const secondRepository = await connectStateRepository();
    const input = stateObservation();

    const [first, second] = await Promise.all([
      firstRepository.persistObservation(input),
      secondRepository.persistObservation(input),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.snapshot).toEqual(second.snapshot);
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("serializes concurrent conflicting observations without retaining the loser", async () => {
    await seedReservation();
    const firstRepository = await connectStateRepository();
    const secondRepository = await connectStateRepository();

    const outcomes = await Promise.allSettled([
      firstRepository.persistObservation(stateObservation()),
      secondRepository.persistObservation(
        stateObservation({ states: stateEntries("PENDING", "SPENT") }),
      ),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: "observation_conflict" }),
      status: "rejected",
    });
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("fails closed when stored state no longer matches its fingerprint", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(stateObservation());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(
        "ALTER TABLE cashu_proof_state_observation_entries DISABLE TRIGGER cashu_proof_state_observation_entries_append_only",
      );
      try {
        await pool.query(
          "UPDATE cashu_proof_state_observation_entries SET state = 'PENDING' WHERE proof_y = $1",
          [PROOF_Y_A],
        );
      } finally {
        await pool.query(
          "ALTER TABLE cashu_proof_state_observation_entries ENABLE TRIGGER cashu_proof_state_observation_entries_append_only",
        );
      }
    } finally {
      await pool.end();
    }

    await expect(repository.findLatestFreshSnapshot(freshLookup())).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("fails closed when stored history regresses after SPENT evidence", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(
      stateObservation({ states: stateEntries("SPENT", "SPENT") }),
    );
    await repository.persistObservation(
      stateObservation({
        observedAt: RESERVED_AT + 2,
        states: stateEntries("SPENT", "SPENT"),
      }),
    );
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(
        "ALTER TABLE cashu_proof_state_observation_entries DISABLE TRIGGER cashu_proof_state_observation_entries_append_only",
      );
      await pool.query(
        "ALTER TABLE cashu_proof_state_observation_entries DISABLE TRIGGER cashu_proof_state_observation_entries_valid",
      );
      try {
        await pool.query(
          `
            UPDATE cashu_proof_state_observation_entries
            SET state = 'UNSPENT'
            WHERE proof_y = $1
              AND snapshot_fingerprint = (
                SELECT snapshot_fingerprint
                FROM cashu_proof_state_observations
                WHERE observed_at = $2
              )
          `,
          [PROOF_Y_A, RESERVED_AT + 2],
        );
      } finally {
        await pool.query(
          "ALTER TABLE cashu_proof_state_observation_entries ENABLE TRIGGER cashu_proof_state_observation_entries_valid",
        );
        await pool.query(
          "ALTER TABLE cashu_proof_state_observation_entries ENABLE TRIGGER cashu_proof_state_observation_entries_append_only",
        );
      }
    } finally {
      await pool.end();
    }

    await expect(
      repository.findLatestFreshSnapshot(
        freshLookup({
          observedAtOrAfter: RESERVED_AT + 1,
          observedAtOrBefore: RESERVED_AT + 2,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("rejects row-level mutation of durable proof-state evidence", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(stateObservation());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      for (const mutation of [
        "UPDATE cashu_proof_state_observations SET observed_at = observed_at + 1",
        "DELETE FROM cashu_proof_state_observation_entries",
      ]) {
        const error = await errorFromAsync(() => pool.query(mutation));
        expect(error).toMatchObject({ code: "55000" });
      }
    } finally {
      await pool.end();
    }
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("enforces complete proof sets and terminal SPENT below the repository", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("BEGIN");
      await insertRawObservationHeader(pool, "d".repeat(64), RESERVED_AT + 1);
      const missingEntriesError = await errorFromAsync(() => pool.query("COMMIT"));
      expect(missingEntriesError).toMatchObject({ code: "23514" });
      await pool.query("ROLLBACK");

      await repository.persistObservation(
        stateObservation({ states: stateEntries("SPENT", "SPENT") }),
      );
      await pool.query("BEGIN");
      await insertRawObservationHeader(pool, "e".repeat(64), RESERVED_AT + 2);
      await insertRawObservationEntries(pool, "e".repeat(64), "UNSPENT", "SPENT");
      const terminalError = await errorFromAsync(() => pool.query("COMMIT"));
      expect(terminalError).toMatchObject({ code: "23514" });
      await pool.query("ROLLBACK");
    } finally {
      await pool.end();
    }
    await expectStateRowCounts({ entries: 2, observations: 1 });
  });

  it("stores only scoped proof-state evidence columns", async () => {
    await seedReservation();
    const repository = await connectStateRepository();
    await repository.persistObservation(stateObservation());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const result = await pool.query<{ column_name: string; table_name: string }>(
        `
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (
              'cashu_proof_state_observations',
              'cashu_proof_state_observation_entries'
            )
          ORDER BY table_name, ordinal_position
        `,
      );
      expect(result.rows.map((row) => `${row.table_name}.${row.column_name}`)).toEqual([
        "cashu_proof_state_observation_entries.snapshot_fingerprint",
        "cashu_proof_state_observation_entries.payment_id",
        "cashu_proof_state_observation_entries.position",
        "cashu_proof_state_observation_entries.proof_y",
        "cashu_proof_state_observation_entries.state",
        "cashu_proof_state_observations.snapshot_fingerprint",
        "cashu_proof_state_observations.payment_id",
        "cashu_proof_state_observations.operator_id",
        "cashu_proof_state_observations.mint_url",
        "cashu_proof_state_observations.unit",
        "cashu_proof_state_observations.schema_version",
        "cashu_proof_state_observations.observed_at",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("rejects an inverted freshness interval before querying storage", async () => {
    const repository = await connectStateRepository();

    await expect(
      repository.findLatestFreshSnapshot(
        freshLookup({
          observedAtOrAfter: RESERVED_AT + 2,
          observedAtOrBefore: RESERVED_AT + 1,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

async function seedReservation(): Promise<void> {
  const invoiceRepository = await connectInvoiceRepository();
  await invoiceRepository.createOpenInvoice(invoiceRecord());

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
      mintUrl: MINT_A,
      observedAt: CREATED_AT,
    }),
    unit: "usdc",
  });

  const reservationRepository = await connectReservationRepository();
  await reservationRepository.reserve(reservationInput());
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

async function connectStateRepository(): Promise<PostgresCashuProofStateRepository> {
  const repository = await PostgresCashuProofStateRepository.connect({
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

function invoiceRecord(): CreateOpenInvoiceRecord {
  const ownerId = merchantId("merchant-001");
  const invoice = createInvoiceV1({
    amount: minorUnits(2),
    createdAt: unixTimestamp(CREATED_AT),
    expiresAt: unixTimestamp(EXPIRES_AT),
    id: invoiceId("invoice-001"),
    merchantId: ownerId,
  });
  return {
    cashuPaymentRequest: CASHU_PAYMENT_REQUEST_ISSUER.issue({
      invoice,
      issuedAt: invoice.createdAt,
    }),
    idempotencyKey: idempotencyKey("checkout-001"),
    invoice,
    requestFingerprint: "c".repeat(64),
  };
}

function reservationInput(): ReserveCashuProofsInput {
  return {
    invoiceId: invoiceId("invoice-001"),
    keysetObservedAt: unixTimestamp(CREATED_AT),
    mintUrl: MINT_A,
    operatorId: operatorId("operator-a"),
    paymentId: paymentId("payment-001"),
    proofReferences: [proofReference(PROOF_Y_B), proofReference(PROOF_Y_A)],
    reservedAt: unixTimestamp(RESERVED_AT),
    unit: "usdc",
  };
}

interface StateObservationOverrides {
  readonly mintUrl?: string;
  readonly observedAt?: number;
  readonly operatorId?: string;
  readonly paymentId?: string;
  readonly states?: readonly { readonly state: string; readonly y: string }[];
  readonly unit?: string;
}

function stateObservation(
  overrides: StateObservationOverrides = {},
): PersistCashuProofStateObservation {
  return {
    operatorId: operatorId(overrides.operatorId ?? "operator-a"),
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
    snapshot: createCashuProofStateSnapshotV1({
      mintUrl: overrides.mintUrl ?? MINT_A,
      observedAt: overrides.observedAt ?? RESERVED_AT + 1,
      states: overrides.states ?? stateEntries("UNSPENT", "PENDING"),
    }),
    unit: overrides.unit ?? "usdc",
  };
}

interface FreshLookupOverrides {
  readonly mintUrl?: string;
  readonly observedAtOrAfter?: number;
  readonly observedAtOrBefore?: number;
  readonly operatorId?: string;
  readonly paymentId?: string;
  readonly unit?: string;
}

function freshLookup(overrides: FreshLookupOverrides = {}): FindFreshCashuProofStateObservation {
  return {
    mintUrl: overrides.mintUrl ?? MINT_A,
    observedAtOrAfter: unixTimestamp(overrides.observedAtOrAfter ?? RESERVED_AT + 1),
    observedAtOrBefore: unixTimestamp(overrides.observedAtOrBefore ?? RESERVED_AT + 1),
    operatorId: operatorId(overrides.operatorId ?? "operator-a"),
    paymentId: paymentId(overrides.paymentId ?? "payment-001"),
    unit: overrides.unit ?? "usdc",
  };
}

function stateEntries(
  stateA: CashuProofStateValue,
  stateB: CashuProofStateValue,
): readonly { readonly state: CashuProofStateValue; readonly y: string }[] {
  return [
    { state: stateA, y: PROOF_Y_A },
    { state: stateB, y: PROOF_Y_B },
  ];
}

function proofReference(y: string) {
  return createCashuProofReferenceV1({ amount: 1, keysetId: KEYSET_ID, y });
}

async function insertRawObservationHeader(
  pool: Pool,
  fingerprint: string,
  observedAt: number,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO cashu_proof_state_observations (
        snapshot_fingerprint,
        payment_id,
        operator_id,
        mint_url,
        unit,
        schema_version,
        observed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [fingerprint, "payment-001", "operator-a", MINT_A, "usdc", 1, observedAt],
  );
}

async function insertRawObservationEntries(
  pool: Pool,
  fingerprint: string,
  stateA: CashuProofStateValue,
  stateB: CashuProofStateValue,
): Promise<void> {
  for (const [position, state] of stateEntries(stateA, stateB).entries()) {
    await pool.query(
      `
        INSERT INTO cashu_proof_state_observation_entries (
          snapshot_fingerprint,
          payment_id,
          position,
          proof_y,
          state
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [fingerprint, "payment-001", position, state.y, state.state],
    );
  }
}

async function expectStateRowCounts(expected: {
  readonly entries: number;
  readonly observations: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{ entries: string; observations: string }>(`
      SELECT
        (SELECT COUNT(*) FROM cashu_proof_state_observations) AS observations,
        (SELECT COUNT(*) FROM cashu_proof_state_observation_entries) AS entries
    `);
    expect(result.rows[0]).toEqual({
      entries: String(expected.entries),
      observations: String(expected.observations),
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
