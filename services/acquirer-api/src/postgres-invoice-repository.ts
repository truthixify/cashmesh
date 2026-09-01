import {
  createInvoiceV1,
  type InvoiceId,
  invoiceId,
  type MerchantId,
  merchantId,
  minorUnits,
  type OpenInvoiceV1,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  type CreateOpenInvoiceRecord,
  type CreateOpenInvoiceResult,
  type FindInvoiceCreationRecord,
  type InvoiceRepository,
  InvoiceRepositoryError,
} from "./invoice-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface InvoiceRow extends QueryResultRow {
  readonly amount: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly id: string;
  readonly merchant_id: string;
  readonly schema_version: number;
  readonly state: string;
  readonly unit: string;
}

interface ReservationRow extends QueryResultRow {
  readonly invoice_id: string;
  readonly request_fingerprint: string;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

export interface PostgresInvoiceRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresInvoiceRepository implements InvoiceRepository {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    options: PostgresInvoiceRepositoryOptions,
  ): Promise<PostgresInvoiceRepository> {
    if (options.connectionString.trim() === "") {
      throw new InvoiceRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection string is required.",
      );
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw new InvoiceRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection pool size must be a positive integer.",
      );
    }
    const pool = new Pool({
      application_name: "cashmesh-acquirer-api",
      connectionString: options.connectionString,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      idle_in_transaction_session_timeout: 10_000,
      lock_timeout: 5_000,
      max: maxConnections,
      query_timeout: 12_000,
      statement_timeout: 10_000,
    });
    pool.on("error", (error) => options.onBackgroundError?.(error));
    const repository = new PostgresInvoiceRepository(pool);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      if (error instanceof InvoiceRepositoryError) {
        throw error;
      }
      throw new InvoiceRepositoryError(
        "storage_unavailable",
        "PostgreSQL invoice storage could not be initialized.",
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createOpenInvoice(input: CreateOpenInvoiceRecord): Promise<CreateOpenInvoiceResult> {
    try {
      return await this.withTransaction(async (client) => {
        const reservation = await client.query<ReservationRow>(
          `
            INSERT INTO invoice_creation_requests (
              merchant_id,
              idempotency_key,
              request_fingerprint,
              invoice_id,
              created_at
            )
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (merchant_id, idempotency_key) DO NOTHING
            RETURNING invoice_id, request_fingerprint
          `,
          [
            input.invoice.merchantId,
            input.idempotencyKey,
            input.requestFingerprint,
            input.invoice.id,
            input.invoice.createdAt,
          ],
        );

        if (reservation.rowCount === 0) {
          return this.readReplay(client, input);
        }

        await client.query(
          `
            INSERT INTO merchant_invoices (
              id,
              merchant_id,
              schema_version,
              unit,
              amount,
              created_at,
              expires_at,
              state
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            input.invoice.id,
            input.invoice.merchantId,
            input.invoice.schemaVersion,
            input.invoice.unit,
            input.invoice.amount,
            input.invoice.createdAt,
            input.invoice.expiresAt,
            input.invoice.state,
          ],
        );
        return Object.freeze({ invoice: input.invoice, replayed: false });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findOpenInvoice(
    ownerId: MerchantId,
    requestedInvoiceId: InvoiceId,
  ): Promise<OpenInvoiceV1 | undefined> {
    try {
      const result = await this.pool.query<InvoiceRow>(
        `
          SELECT id, merchant_id, schema_version, unit, amount, created_at, expires_at, state
          FROM merchant_invoices
          WHERE merchant_id = $1 AND id = $2
        `,
        [ownerId, requestedInvoiceId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : mapInvoiceRow(row);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findInvoiceCreation(input: FindInvoiceCreationRecord): Promise<OpenInvoiceV1 | undefined> {
    try {
      const result = await this.pool.query<InvoiceRow & ReservationRow>(
        `
          SELECT
            request.invoice_id,
            request.request_fingerprint,
            invoice.id,
            invoice.merchant_id,
            invoice.schema_version,
            invoice.unit,
            invoice.amount,
            invoice.created_at,
            invoice.expires_at,
            invoice.state
          FROM invoice_creation_requests AS request
          JOIN merchant_invoices AS invoice
            ON invoice.id = request.invoice_id
            AND invoice.merchant_id = request.merchant_id
          WHERE request.merchant_id = $1 AND request.idempotency_key = $2
        `,
        [input.merchantId, input.idempotencyKey],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      if (row.request_fingerprint !== input.requestFingerprint) {
        throw new InvoiceRepositoryError(
          "idempotency_conflict",
          "Idempotency key was already used for a different invoice request.",
        );
      }
      return mapInvoiceRow(row);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
  }

  private async readReplay(
    client: PoolClient,
    input: CreateOpenInvoiceRecord,
  ): Promise<CreateOpenInvoiceResult> {
    const result = await client.query<InvoiceRow & ReservationRow>(
      `
        SELECT
          request.invoice_id,
          request.request_fingerprint,
          invoice.id,
          invoice.merchant_id,
          invoice.schema_version,
          invoice.unit,
          invoice.amount,
          invoice.created_at,
          invoice.expires_at,
          invoice.state
        FROM invoice_creation_requests AS request
        JOIN merchant_invoices AS invoice
          ON invoice.id = request.invoice_id
          AND invoice.merchant_id = request.merchant_id
        WHERE request.merchant_id = $1 AND request.idempotency_key = $2
      `,
      [input.invoice.merchantId, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new InvoiceRepositoryError(
        "invalid_record",
        "Invoice idempotency record has no matching invoice.",
      );
    }
    if (row.request_fingerprint !== input.requestFingerprint) {
      throw new InvoiceRepositoryError(
        "idempotency_conflict",
        "Idempotency key was already used for a different invoice request.",
      );
    }
    return Object.freeze({ invoice: mapInvoiceRow(row), replayed: true });
  }

  private async withTransaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original transaction failure is the actionable error.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapInvoiceRow(row: InvoiceRow): OpenInvoiceV1 {
  if (row.schema_version !== 1 || row.unit !== "usdc" || row.state !== "open") {
    throw new InvoiceRepositoryError(
      "invalid_record",
      "Stored invoice schema, unit, or state is unsupported.",
    );
  }
  try {
    return createInvoiceV1({
      amount: minorUnits(parseSafeInteger(row.amount)),
      createdAt: unixTimestamp(parseSafeInteger(row.created_at)),
      expiresAt: unixTimestamp(parseSafeInteger(row.expires_at)),
      id: invoiceId(row.id),
      merchantId: merchantId(row.merchant_id),
    });
  } catch {
    throw new InvoiceRepositoryError("invalid_record", "Stored invoice fields are invalid.");
  }
}

function parseSafeInteger(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new InvoiceRepositoryError("invalid_record", "Stored integer field is invalid.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvoiceRepositoryError("invalid_record", "Stored integer field exceeds safe bounds.");
  }
  return parsed;
}

function mapStorageError(error: unknown): InvoiceRepositoryError {
  if (error instanceof InvoiceRepositoryError) {
    return error;
  }
  const databaseError = error as PostgresErrorShape;
  if (
    databaseError.code === "23505" &&
    (databaseError.constraint === "merchant_invoices_pkey" ||
      databaseError.constraint === "merchant_invoices_identity_unique" ||
      databaseError.constraint === "invoice_creation_requests_invoice_unique")
  ) {
    return new InvoiceRepositoryError(
      "invoice_id_conflict",
      "Generated invoice identifier is already in use.",
    );
  }
  return new InvoiceRepositoryError("storage_unavailable", "Invoice storage operation failed.");
}
