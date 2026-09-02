import {
  type CashuKeysetSnapshotV1,
  CashuPaymentRequestIssuer,
  createCashuKeysetSnapshotV1,
} from "@cashmesh/cashu";
import {
  createInvoiceV1,
  idempotencyKey,
  invoiceId,
  merchantId,
  minorUnits,
  operatorId,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool } from "pg";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";
import {
  CashuKeysetRepositoryError,
  type PersistCashuKeysetObservation,
} from "../src/cashu-keyset-repository";
import { type CreateOpenInvoiceRecord, InvoiceRepositoryError } from "../src/invoice-repository";
import { PostgresCashuKeysetRepository } from "../src/postgres-cashu-keyset-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const repositories: Array<{ close(): Promise<void> }> = [];
const KEYSET_MINT_URL = "https://mint-keys.cashmesh.example";
const KEYSET_OBSERVED_AT = 1_788_100_000;
const VERSION_ZERO_KEYSET_ID = "000f715baf5d4c2e";
const VERSION_ZERO_PUBLIC_KEY =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const SECOND_VERSION_ZERO_KEYSET_ID = "00b1c9938f01121e";
const SECOND_VERSION_ZERO_PUBLIC_KEY =
  "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const CASHU_PAYMENT_REQUEST_ISSUER = new CashuPaymentRequestIssuer({
  operators: [
    {
      mintUrl: "https://mint-a.cashmesh.example",
      operatorId: operatorId("operator-a"),
      tier: "trusted",
    },
    {
      mintUrl: "https://mint-b.cashmesh.example",
      operatorId: operatorId("operator-b"),
      tier: "convertible",
    },
  ],
  transportUrl: "https://pay.cashmesh.example/v1/cashu/payments",
});

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL repositories", () => {
  beforeAll(async () => {
    const repository = await PostgresInvoiceRepository.connect({
      connectionString: requireDatabaseUrl(),
    });
    await repository.close();
  });

  beforeEach(async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(
        `
          TRUNCATE
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
        `,
      );
    } finally {
      await pool.end();
    }
  });

  afterEach(async () => {
    await Promise.all(repositories.splice(0).map(async (repository) => repository.close()));
  });

  it("persists an exact idempotent replay across repository restart", async () => {
    const firstRepository = await connectRepository();
    const first = await firstRepository.createOpenInvoice(record());
    await closeRepository(firstRepository);

    const restartedRepository = await connectRepository();
    const foundByPaymentId = await restartedRepository.findOpenInvoiceById(
      invoiceId("invoice-001"),
    );
    const replay = await restartedRepository.createOpenInvoice(
      record({ invoiceId: "invoice-candidate-after-restart" }),
    );

    expect(foundByPaymentId).toEqual({
      cashuPaymentRequest: first.cashuPaymentRequest,
      invoice: first.invoice,
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.invoice).toEqual(first.invoice);
    expect(replay.invoice.id).toBe("invoice-001");
  });

  it("replays the HTTP creation response after app restart and invoice expiry", async () => {
    const firstRepository = await connectRepository();
    const firstApp = buildApp({
      cashuPaymentRequestIssuer: CASHU_PAYMENT_REQUEST_ISSUER,
      clock: () => 1_788_000_000,
      invoiceIdFactory: () => "invoice-api-001",
      invoiceRepository: firstRepository,
    });
    const first = await firstApp.inject({
      method: "POST",
      url: "/v1/merchants/merchant-001/invoices",
      headers: { "idempotency-key": "checkout-api-001" },
      payload: { amount: 1_234, expiresAt: 1_788_000_300 },
    });
    await firstApp.close();
    repositories.splice(repositories.indexOf(firstRepository), 1);

    const restartedRepository = await connectRepository();
    const restartedApp = buildApp({
      cashuPaymentRequestIssuer: {
        issue: () => {
          throw new Error("Persisted replay must not issue a new Cashu request.");
        },
      },
      clock: () => 1_788_000_301,
      invoiceIdFactory: () => {
        throw new Error("Replay must not generate a new invoice identifier.");
      },
      invoiceRepository: restartedRepository,
    });
    const replay = await restartedApp.inject({
      method: "POST",
      url: "/v1/merchants/merchant-001/invoices",
      headers: { "idempotency-key": "checkout-api-001" },
      payload: { amount: 1_234, expiresAt: 1_788_000_300 },
    });
    const expiredPayment = await restartedApp.inject({
      method: "POST",
      url: "/v1/cashu/payments",
      headers: { "content-type": "application/json" },
      payload: paymentPayload("invoice-api-001"),
    });
    await restartedApp.close();
    repositories.splice(repositories.indexOf(restartedRepository), 1);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    expect(expiredPayment.statusCode).toBe(410);
    expect(expiredPayment.headers["cache-control"]).toBe("no-store");
    expect(expiredPayment.json()).toMatchObject({
      error: { code: "payment_request_expired" },
    });
  });

  it("serializes concurrent requests with the same merchant idempotency key", async () => {
    const firstRepository = await connectRepository();
    const secondRepository = await connectRepository();

    const [first, second] = await Promise.all([
      firstRepository.createOpenInvoice(record({ invoiceId: "invoice-concurrent-a" })),
      secondRepository.createOpenInvoice(record({ invoiceId: "invoice-concurrent-b" })),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.invoice.id).toBe(second.invoice.id);
    await expectRowCounts({ creations: 1, invoices: 1 });
  });

  it("rejects a changed request under the same idempotency key", async () => {
    const repository = await connectRepository();
    await repository.createOpenInvoice(record());

    const error = await errorFromAsync(() =>
      repository.createOpenInvoice(
        record({ fingerprint: "b".repeat(64), invoiceId: "invoice-conflict" }),
      ),
    );

    expect(error).toBeInstanceOf(InvoiceRepositoryError);
    expect(error).toMatchObject({ code: "idempotency_conflict" });
    await expectRowCounts({ creations: 1, invoices: 1 });
  });

  it("scopes idempotency and lookup to the merchant", async () => {
    const repository = await connectRepository();
    const first = await repository.createOpenInvoice(record());
    const second = await repository.createOpenInvoice(
      record({ invoiceId: "invoice-002", merchantId: "merchant-002" }),
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(false);
    await expect(
      repository.findOpenInvoice(merchantId("merchant-002"), invoiceId("invoice-001")),
    ).resolves.toBeUndefined();
    await expect(
      repository.findOpenInvoice(merchantId("merchant-001"), invoiceId("invoice-001")),
    ).resolves.toEqual({
      cashuPaymentRequest: first.cashuPaymentRequest,
      invoice: first.invoice,
    });
    await expect(repository.findOpenInvoiceById(invoiceId("invoice-001"))).resolves.toEqual({
      cashuPaymentRequest: first.cashuPaymentRequest,
      invoice: first.invoice,
    });
  });

  it("rolls back the idempotency reservation when an invoice id collides", async () => {
    const repository = await connectRepository();
    await repository.createOpenInvoice(record());

    const error = await errorFromAsync(() =>
      repository.createOpenInvoice(
        record({ idempotencyKey: "checkout-002", merchantId: "merchant-002" }),
      ),
    );

    expect(error).toMatchObject({ code: "invoice_id_conflict" });
    await expectRowCounts({ creations: 1, invoices: 1 });
  });

  it("rejects a mismatched Cashu sidecar before reserving an invoice", async () => {
    const repository = await connectRepository();
    const input = record();

    const error = await errorFromAsync(() =>
      repository.createOpenInvoice({
        ...input,
        cashuPaymentRequest: {
          ...input.cashuPaymentRequest,
          encodedRequest: `${input.cashuPaymentRequest.encodedRequest}A`,
        },
      }),
    );

    expect(error).toMatchObject({ code: "invalid_record" });
    await expectRowCounts({ creations: 0, invoices: 0 });
  });

  it("refuses migration history unknown to the running build", async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("INSERT INTO cashmesh_schema_migrations (version, name) VALUES ($1, $2)", [
        999,
        "unknown_future_migration",
      ]);

      const error = await errorFromAsync(() =>
        PostgresInvoiceRepository.connect({ connectionString: requireDatabaseUrl() }),
      );

      expect(error).toMatchObject({ code: "storage_unavailable" });
    } finally {
      await pool.query("DELETE FROM cashmesh_schema_migrations WHERE version = $1", [999]);
      await pool.end();
    }
  });

  it("rejects a stored Cashu request that no longer matches its invoice", async () => {
    const repository = await connectRepository();
    await repository.createOpenInvoice(record());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(
        "UPDATE invoice_cashu_requests SET encoded_request = $1 WHERE invoice_id = $2",
        ["creqAinvalid", "invoice-001"],
      );
    } finally {
      await pool.end();
    }

    const error = await errorFromAsync(() =>
      repository.findOpenInvoice(merchantId("merchant-001"), invoiceId("invoice-001")),
    );

    expect(error).toMatchObject({ code: "invalid_record" });
  });

  it("refuses to commit a Cashu request after its last operator route is removed", async () => {
    const repository = await connectRepository();
    await repository.createOpenInvoice(record());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("BEGIN");
      await pool.query("DELETE FROM invoice_cashu_request_operators WHERE invoice_id = $1", [
        "invoice-001",
      ]);

      const error = await errorFromAsync(() => pool.query("COMMIT"));

      expect(error).toMatchObject({ code: "23514" });
    } finally {
      await pool.query("ROLLBACK");
      await pool.end();
    }
  });

  it("refuses to commit an invoice after its Cashu request is removed", async () => {
    const repository = await connectRepository();
    await repository.createOpenInvoice(record());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("BEGIN");
      await pool.query("DELETE FROM invoice_cashu_request_operators WHERE invoice_id = $1", [
        "invoice-001",
      ]);
      await pool.query("DELETE FROM invoice_cashu_requests WHERE invoice_id = $1", ["invoice-001"]);

      const error = await errorFromAsync(() => pool.query("COMMIT"));

      expect(error).toMatchObject({ code: "23514" });
    } finally {
      await pool.query("ROLLBACK");
      await pool.end();
    }
  });

  it.each([
    {
      name: "identifier",
      values: ["bad invoice", "merchant-001", 1, "usdc", 100, 1_788_000_000, 1_788_000_300, "open"],
    },
    {
      name: "amount",
      values: [
        "invoice-raw-001",
        "merchant-001",
        1,
        "usdc",
        0,
        1_788_000_000,
        1_788_000_300,
        "open",
      ],
    },
    {
      name: "expiry",
      values: [
        "invoice-raw-002",
        "merchant-001",
        1,
        "usdc",
        100,
        1_788_000_000,
        1_788_000_000,
        "open",
      ],
    },
    {
      name: "state",
      values: [
        "invoice-raw-003",
        "merchant-001",
        1,
        "usdc",
        100,
        1_788_000_000,
        1_788_000_300,
        "paid",
      ],
    },
  ])("enforces the $name constraint below the application", async ({ values }) => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const error = await errorFromAsync(() =>
        pool.query(
          `
            INSERT INTO merchant_invoices (
              id, merchant_id, schema_version, unit, amount, created_at, expires_at, state
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          values,
        ),
      );
      expect(error).toMatchObject({ code: "23514" });
    } finally {
      await pool.end();
    }
  });

  it("persists an exact Cashu keyset observation across repository restart", async () => {
    const firstRepository = await connectKeysetRepository();
    const input = keysetObservation();
    const first = await firstRepository.persistObservation(input);
    await closeRepository(firstRepository);

    const restartedRepository = await connectKeysetRepository();
    const found = await restartedRepository.findLatestFreshSnapshot({
      mintUrl: KEYSET_MINT_URL,
      observedAtOrAfter: unixTimestamp(KEYSET_OBSERVED_AT),
      observedAtOrBefore: unixTimestamp(KEYSET_OBSERVED_AT),
      operatorId: operatorId("operator-a"),
      unit: "usdc",
    });
    const replay = await restartedRepository.persistObservation(input);

    expect(first).toEqual({ replayed: false, snapshot: input.snapshot });
    expect(found).toEqual(input.snapshot);
    expect(replay).toEqual({ replayed: true, snapshot: input.snapshot });
    expect(Object.isFrozen(found)).toBe(true);
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("allows later activity changes and returns the latest snapshot inside inclusive bounds", async () => {
    const repository = await connectKeysetRepository();
    const inactive = keysetObservation({ active: false });
    const active = keysetObservation({ active: true, observedAt: KEYSET_OBSERVED_AT + 10 });
    const future = keysetObservation({ active: false, observedAt: KEYSET_OBSERVED_AT + 20 });
    await repository.persistObservation(inactive);
    await repository.persistObservation(active);
    await repository.persistObservation(future);

    const latest = await repository.findLatestFreshSnapshot({
      mintUrl: KEYSET_MINT_URL,
      observedAtOrAfter: unixTimestamp(KEYSET_OBSERVED_AT),
      observedAtOrBefore: unixTimestamp(KEYSET_OBSERVED_AT + 10),
      operatorId: operatorId("operator-a"),
      unit: "usdc",
    });
    const lowerBoundary = await repository.findLatestFreshSnapshot({
      mintUrl: KEYSET_MINT_URL,
      observedAtOrAfter: unixTimestamp(KEYSET_OBSERVED_AT),
      observedAtOrBefore: unixTimestamp(KEYSET_OBSERVED_AT),
      operatorId: operatorId("operator-a"),
      unit: "usdc",
    });
    const gap = await repository.findLatestFreshSnapshot({
      mintUrl: KEYSET_MINT_URL,
      observedAtOrAfter: unixTimestamp(KEYSET_OBSERVED_AT + 1),
      observedAtOrBefore: unixTimestamp(KEYSET_OBSERVED_AT + 9),
      operatorId: operatorId("operator-a"),
      unit: "usdc",
    });

    expect(latest?.observedAt).toBe(KEYSET_OBSERVED_AT + 10);
    expect(latest?.keysets[0]?.active).toBe(true);
    expect(lowerBoundary?.observedAt).toBe(KEYSET_OBSERVED_AT);
    expect(lowerBoundary?.keysets[0]?.active).toBe(false);
    expect(gap).toBeUndefined();
    await expectKeysetRowCounts({ entries: 3, keysets: 1, observations: 3 });
  });

  it("scopes fresh keyset lookup by operator, mint, and unit", async () => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation());
    const lookup = {
      mintUrl: KEYSET_MINT_URL,
      observedAtOrAfter: unixTimestamp(KEYSET_OBSERVED_AT),
      observedAtOrBefore: unixTimestamp(KEYSET_OBSERVED_AT),
      operatorId: operatorId("operator-a"),
      unit: "usdc",
    };

    const wrongOperator = await repository.findLatestFreshSnapshot({
      ...lookup,
      operatorId: operatorId("operator-b"),
    });
    const wrongMint = await repository.findLatestFreshSnapshot({
      ...lookup,
      mintUrl: "https://another-mint.cashmesh.example",
    });
    const wrongUnit = await repository.findLatestFreshSnapshot({ ...lookup, unit: "sat" });

    expect(wrongOperator).toBeUndefined();
    expect(wrongMint).toBeUndefined();
    expect(wrongUnit).toBeUndefined();
  });

  it("rejects a persisted snapshot containing more than one unit", async () => {
    const repository = await connectKeysetRepository();
    const snapshot = createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: true,
          id: VERSION_ZERO_KEYSET_ID,
          keys: { "1": VERSION_ZERO_PUBLIC_KEY },
          unit: "usdc",
        },
        {
          active: true,
          id: SECOND_VERSION_ZERO_KEYSET_ID,
          keys: { "1": SECOND_VERSION_ZERO_PUBLIC_KEY },
          unit: "sat",
        },
      ],
      mintUrl: KEYSET_MINT_URL,
      observedAt: KEYSET_OBSERVED_AT,
    });

    const error = await errorFromAsync(() =>
      repository.persistObservation({
        operatorId: operatorId("operator-a"),
        snapshot,
        unit: "usdc",
      }),
    );

    expect(error).toMatchObject({ code: "invalid_input" });
    await expectKeysetRowCounts({ entries: 0, keysets: 0, observations: 0 });
  });

  it.each([
    {
      name: "input fee",
      overrides: { inputFeePpk: 1 },
    },
    {
      name: "unit",
      overrides: { unit: "sat" },
    },
    {
      name: "final expiry",
      overrides: { finalExpiry: KEYSET_OBSERVED_AT + 1_000 },
    },
  ])("rejects historical version zero keyset reuse with a changed $name", async ({ overrides }) => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation());

    const error = await errorFromAsync(() =>
      repository.persistObservation(
        keysetObservation({ ...overrides, observedAt: KEYSET_OBSERVED_AT + 1 }),
      ),
    );

    expect(error).toBeInstanceOf(CashuKeysetRepositoryError);
    expect(error).toMatchObject({ code: "keyset_collision" });
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("shares keyset collision history across operator identities", async () => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation({ operatorId: "operator-a" }));

    const error = await errorFromAsync(() =>
      repository.persistObservation(
        keysetObservation({
          inputFeePpk: 10,
          observedAt: KEYSET_OBSERVED_AT + 1,
          operatorId: "operator-b",
        }),
      ),
    );

    expect(error).toMatchObject({ code: "keyset_collision" });
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("rolls back new identities when a later keyset in the snapshot collides", async () => {
    const repository = await connectKeysetRepository();
    const existingSnapshot = createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: true,
          id: SECOND_VERSION_ZERO_KEYSET_ID,
          keys: { "1": SECOND_VERSION_ZERO_PUBLIC_KEY },
          unit: "usdc",
        },
      ],
      mintUrl: KEYSET_MINT_URL,
      observedAt: KEYSET_OBSERVED_AT,
    });
    await repository.persistObservation({
      operatorId: operatorId("operator-a"),
      snapshot: existingSnapshot,
      unit: "usdc",
    });
    const collidingSnapshot = createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: true,
          id: VERSION_ZERO_KEYSET_ID,
          keys: { "1": VERSION_ZERO_PUBLIC_KEY },
          unit: "usdc",
        },
        {
          active: true,
          id: SECOND_VERSION_ZERO_KEYSET_ID,
          inputFeePpk: 1,
          keys: { "1": SECOND_VERSION_ZERO_PUBLIC_KEY },
          unit: "usdc",
        },
      ],
      mintUrl: KEYSET_MINT_URL,
      observedAt: KEYSET_OBSERVED_AT + 1,
    });

    const error = await errorFromAsync(() =>
      repository.persistObservation({
        operatorId: operatorId("operator-a"),
        snapshot: collidingSnapshot,
        unit: "usdc",
      }),
    );

    expect(error).toMatchObject({ code: "keyset_collision" });
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("keeps identical keyset identifiers at distinct mint URLs independent", async () => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation());
    await repository.persistObservation(
      keysetObservation({
        inputFeePpk: 10,
        mintUrl: "https://another-mint.cashmesh.example",
        observedAt: KEYSET_OBSERVED_AT + 1,
      }),
    );

    await expectKeysetRowCounts({ entries: 2, keysets: 2, observations: 2 });
  });

  it("rejects different activity at the same operator observation time", async () => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation({ active: true }));

    const error = await errorFromAsync(() =>
      repository.persistObservation(keysetObservation({ active: false })),
    );

    expect(error).toMatchObject({ code: "observation_conflict" });
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("converges concurrent exact observations on one durable record", async () => {
    const firstRepository = await connectKeysetRepository();
    const secondRepository = await connectKeysetRepository();
    const input = keysetObservation();

    const [first, second] = await Promise.all([
      firstRepository.persistObservation(input),
      secondRepository.persistObservation(input),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.snapshot).toEqual(second.snapshot);
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("serializes concurrent conflicting observations without retaining the loser", async () => {
    const firstRepository = await connectKeysetRepository();
    const secondRepository = await connectKeysetRepository();

    const outcomes = await Promise.allSettled([
      firstRepository.persistObservation(keysetObservation({ active: true })),
      secondRepository.persistObservation(keysetObservation({ active: false })),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.objectContaining({ code: "observation_conflict" }),
      status: "rejected",
    });
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("fails closed when stored observation activity no longer matches its fingerprint", async () => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation({ active: true }));
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query(
        "ALTER TABLE cashu_keyset_observation_entries DISABLE TRIGGER cashu_keyset_observation_entries_append_only",
      );
      try {
        await pool.query("UPDATE cashu_keyset_observation_entries SET active = NOT active");
      } finally {
        await pool.query(
          "ALTER TABLE cashu_keyset_observation_entries ENABLE TRIGGER cashu_keyset_observation_entries_append_only",
        );
      }
    } finally {
      await pool.end();
    }

    const error = await errorFromAsync(() =>
      repository.findLatestFreshSnapshot({
        mintUrl: KEYSET_MINT_URL,
        observedAtOrAfter: unixTimestamp(KEYSET_OBSERVED_AT),
        observedAtOrBefore: unixTimestamp(KEYSET_OBSERVED_AT),
        operatorId: operatorId("operator-a"),
        unit: "usdc",
      }),
    );

    expect(error).toMatchObject({ code: "invalid_record" });
  });

  it("validates stored keyset material before accepting a new observation", async () => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("ALTER TABLE cashu_keysets DISABLE TRIGGER cashu_keysets_append_only");
      try {
        await pool.query("UPDATE cashu_keysets SET input_fee_ppk = input_fee_ppk + 1");
      } finally {
        await pool.query("ALTER TABLE cashu_keysets ENABLE TRIGGER cashu_keysets_append_only");
      }
    } finally {
      await pool.end();
    }

    const error = await errorFromAsync(() =>
      repository.persistObservation(keysetObservation({ observedAt: KEYSET_OBSERVED_AT + 1 })),
    );

    expect(error).toMatchObject({ code: "invalid_record" });
    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("rejects row-level mutation of durable Cashu keyset evidence", async () => {
    const repository = await connectKeysetRepository();
    await repository.persistObservation(keysetObservation());
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      const mutations = [
        "UPDATE cashu_keysets SET input_fee_ppk = input_fee_ppk + 1",
        "UPDATE cashu_keyset_observations SET observed_at = observed_at + 1",
        "DELETE FROM cashu_keyset_observation_entries",
      ];
      for (const mutation of mutations) {
        const error = await errorFromAsync(() => pool.query(mutation));
        expect(error).toMatchObject({ code: "55000" });
      }
    } finally {
      await pool.end();
    }

    await expectKeysetRowCounts({ entries: 1, keysets: 1, observations: 1 });
  });

  it("rejects an inverted freshness interval before querying storage", async () => {
    const repository = await connectKeysetRepository();

    const error = await errorFromAsync(() =>
      repository.findLatestFreshSnapshot({
        mintUrl: KEYSET_MINT_URL,
        observedAtOrAfter: unixTimestamp(KEYSET_OBSERVED_AT + 1),
        observedAtOrBefore: unixTimestamp(KEYSET_OBSERVED_AT),
        operatorId: operatorId("operator-a"),
        unit: "usdc",
      }),
    );

    expect(error).toMatchObject({ code: "invalid_input" });
    await expectKeysetRowCounts({ entries: 0, keysets: 0, observations: 0 });
  });

  it("refuses to commit a Cashu keyset observation without entries", async () => {
    const pool = new Pool({ connectionString: requireDatabaseUrl() });
    try {
      await pool.query("BEGIN");
      await pool.query(
        `
          INSERT INTO cashu_keyset_observations (
            snapshot_fingerprint,
            operator_id,
            mint_url,
            unit,
            schema_version,
            observed_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        ["a".repeat(64), "operator-a", KEYSET_MINT_URL, "usdc", 1, KEYSET_OBSERVED_AT],
      );

      const error = await errorFromAsync(() => pool.query("COMMIT"));

      expect(error).toMatchObject({ code: "23514" });
    } finally {
      await pool.query("ROLLBACK");
      await pool.end();
    }
  });
});

async function connectRepository(): Promise<PostgresInvoiceRepository> {
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

async function closeRepository(repository: { close(): Promise<void> }): Promise<void> {
  await repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
}

interface KeysetObservationOverrides {
  readonly active?: boolean;
  readonly finalExpiry?: number;
  readonly inputFeePpk?: number;
  readonly mintUrl?: string;
  readonly observedAt?: number;
  readonly operatorId?: string;
  readonly unit?: string;
}

function keysetObservation(
  overrides: KeysetObservationOverrides = {},
): PersistCashuKeysetObservation {
  const unit = overrides.unit ?? "usdc";
  return {
    operatorId: operatorId(overrides.operatorId ?? "operator-a"),
    snapshot: keysetSnapshot({ ...overrides, unit }),
    unit,
  };
}

function keysetSnapshot(overrides: KeysetObservationOverrides = {}): CashuKeysetSnapshotV1 {
  return createCashuKeysetSnapshotV1({
    keysets: [
      {
        active: overrides.active ?? true,
        ...(overrides.finalExpiry !== undefined && { finalExpiry: overrides.finalExpiry }),
        id: VERSION_ZERO_KEYSET_ID,
        inputFeePpk: overrides.inputFeePpk ?? 0,
        keys: { "1": VERSION_ZERO_PUBLIC_KEY },
        unit: overrides.unit ?? "usdc",
      },
    ],
    mintUrl: overrides.mintUrl ?? KEYSET_MINT_URL,
    observedAt: overrides.observedAt ?? KEYSET_OBSERVED_AT,
  });
}

function record(
  overrides: {
    readonly fingerprint?: string;
    readonly idempotencyKey?: string;
    readonly invoiceId?: string;
    readonly merchantId?: string;
  } = {},
): CreateOpenInvoiceRecord {
  const ownerId = merchantId(overrides.merchantId ?? "merchant-001");
  const invoice = createInvoiceV1({
    amount: minorUnits(1_234),
    createdAt: unixTimestamp(1_788_000_000),
    expiresAt: unixTimestamp(1_788_000_300),
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
    requestFingerprint: overrides.fingerprint ?? "a".repeat(64),
  };
}

function paymentPayload(requestedInvoiceId: string): string {
  return JSON.stringify({
    id: requestedInvoiceId,
    mint: "https://mint-a.cashmesh.example",
    proofs: [
      {
        C: `02${"11".repeat(32)}`,
        amount: 1_234,
        id: "009a1f293253e41e",
        secret: "test-only-no-value",
      },
    ],
    unit: "usdc",
  });
}

async function expectRowCounts(expected: {
  readonly creations: number;
  readonly invoices: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{
      cashu_operators: string;
      cashu_requests: string;
      creations: string;
      invoices: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM invoice_creation_requests) AS creations,
        (SELECT COUNT(*) FROM merchant_invoices) AS invoices,
        (SELECT COUNT(*) FROM invoice_cashu_requests) AS cashu_requests,
        (SELECT COUNT(*) FROM invoice_cashu_request_operators) AS cashu_operators
    `);
    expect(result.rows[0]).toEqual({
      cashu_operators: String(expected.invoices * 2),
      cashu_requests: String(expected.invoices),
      creations: String(expected.creations),
      invoices: String(expected.invoices),
    });
  } finally {
    await pool.end();
  }
}

async function expectKeysetRowCounts(expected: {
  readonly entries: number;
  readonly keysets: number;
  readonly observations: number;
}): Promise<void> {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  try {
    const result = await pool.query<{
      entries: string;
      keysets: string;
      observations: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM cashu_keysets) AS keysets,
        (SELECT COUNT(*) FROM cashu_keyset_observations) AS observations,
        (SELECT COUNT(*) FROM cashu_keyset_observation_entries) AS entries
    `);
    expect(result.rows[0]).toEqual({
      entries: String(expected.entries),
      keysets: String(expected.keysets),
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
