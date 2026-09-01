import { CashuPaymentRequestIssuer } from "@cashmesh/cashu";
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
import { type CreateOpenInvoiceRecord, InvoiceRepositoryError } from "../src/invoice-repository";
import { PostgresInvoiceRepository } from "../src/postgres-invoice-repository";

const DATABASE_URL = process.env.CASHMESH_TEST_DATABASE_URL;
const repositories: PostgresInvoiceRepository[] = [];
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

describe.skipIf(DATABASE_URL === undefined)("PostgreSQL invoice repository", () => {
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
        "TRUNCATE invoice_cashu_request_operators, invoice_cashu_requests, invoice_creation_requests, merchant_invoices",
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
});

async function connectRepository(): Promise<PostgresInvoiceRepository> {
  const repository = await PostgresInvoiceRepository.connect({
    connectionString: requireDatabaseUrl(),
    maxConnections: 4,
  });
  repositories.push(repository);
  return repository;
}

async function closeRepository(repository: PostgresInvoiceRepository): Promise<void> {
  await repository.close();
  repositories.splice(repositories.indexOf(repository), 1);
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
