import { createHash } from "node:crypto";
import {
  type AcceptedOperatorRouteV1,
  type CashuPaymentRequestV1,
  type CashuStellarSettlementDestination,
  cashuStellarSettlementDestination,
  createCashuPaymentRequestV1,
} from "@cashmesh/cashu";
import {
  createInvoiceV1,
  type InvoiceId,
  invoiceId,
  type MerchantId,
  merchantId,
  minorUnits,
  type OpenInvoiceV1,
  type OperatorTier,
  operatorId,
  type SettlementMode,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  type CreateOpenInvoiceRecord,
  type CreateOpenInvoiceResult,
  type FindInvoiceCreationRecord,
  type InvoiceRepository,
  InvoiceRepositoryError,
  type IssuedInvoiceV1,
} from "./invoice-repository";
import { applyPostgresMigrations } from "./postgres-schema";

export interface StoredCashuPaymentRequestRow {
  readonly cashu_schema_version: number | null;
  readonly encoded_request: string | null;
  readonly encoding: string | null;
  readonly issued_at: string | null;
  readonly mint_policy: string | null;
  readonly operator_count: number | null;
  readonly route_set_fingerprint: string | null;
  readonly transport_url: string | null;
}

interface InvoiceRow extends QueryResultRow, StoredCashuPaymentRequestRow {
  readonly amount: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly id: string;
  readonly merchant_id: string;
  readonly paid_at: string | null;
  readonly schema_version: number;
  readonly state: string;
  readonly unit: string;
}

interface CreationRow extends InvoiceRow {
  readonly request_fingerprint: string;
}

export interface StoredCashuOperatorRouteRow {
  readonly mint_url: string;
  readonly mode: string;
  readonly operator_id: string;
  readonly position: number;
  readonly reason: string;
  readonly settlement_destination: string;
  readonly tier: string;
}

interface CashuOperatorRow extends QueryResultRow, StoredCashuOperatorRouteRow {}

interface ReservationRow extends QueryResultRow {
  readonly invoice_id: string;
  readonly request_fingerprint: string;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

const ISSUED_INVOICE_SELECT = `
  SELECT
    invoice.id,
    invoice.merchant_id,
    invoice.schema_version,
    invoice.unit,
    invoice.amount,
    invoice.created_at,
    invoice.expires_at,
    invoice.state,
    invoice.paid_at,
    cashu.schema_version AS cashu_schema_version,
    cashu.encoded_request,
    cashu.encoding,
    cashu.issued_at,
    cashu.mint_policy,
    cashu.operator_count,
    cashu.route_set_fingerprint,
    cashu.transport_url
  FROM merchant_invoices AS invoice
  LEFT JOIN invoice_cashu_requests AS cashu
    ON cashu.invoice_id = invoice.id
    AND cashu.merchant_id = invoice.merchant_id
`;

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
      const cashuPaymentRequest = validateCashuPaymentRequest(
        input.invoice,
        input.cashuPaymentRequest,
      );
      const settlementDestination = validateSettlementDestination(input.settlementDestination);
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
        await this.insertCashuPaymentRequest(
          client,
          input.invoice,
          cashuPaymentRequest,
          settlementDestination,
        );
        return Object.freeze({
          cashuPaymentRequest,
          invoice: input.invoice,
          replayed: false,
        });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findOpenInvoice(
    ownerId: MerchantId,
    requestedInvoiceId: InvoiceId,
  ): Promise<IssuedInvoiceV1 | undefined> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const result = await client.query<InvoiceRow>(
        `${ISSUED_INVOICE_SELECT}
          WHERE invoice.merchant_id = $1 AND invoice.id = $2 AND invoice.state = 'open'`,
        [ownerId, requestedInvoiceId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : await this.mapIssuedInvoice(client, row);
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      client?.release();
    }
  }

  async findOpenInvoiceById(requestedInvoiceId: InvoiceId): Promise<IssuedInvoiceV1 | undefined> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const result = await client.query<InvoiceRow>(
        `${ISSUED_INVOICE_SELECT}
          WHERE invoice.id = $1 AND invoice.state = 'open'`,
        [requestedInvoiceId],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : await this.mapIssuedInvoice(client, row);
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      client?.release();
    }
  }

  async findInvoiceCreation(
    input: FindInvoiceCreationRecord,
  ): Promise<IssuedInvoiceV1 | undefined> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const row = await this.findCreationRow(client, input.merchantId, input.idempotencyKey);
      if (row === undefined) {
        return undefined;
      }
      if (row.request_fingerprint !== input.requestFingerprint) {
        throw new InvoiceRepositoryError(
          "idempotency_conflict",
          "Idempotency key was already used for a different invoice request.",
        );
      }
      return await this.mapIssuedInvoice(client, row);
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      client?.release();
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
  }

  private async insertCashuPaymentRequest(
    client: PoolClient,
    invoice: OpenInvoiceV1,
    request: CashuPaymentRequestV1,
    settlementDestination: CashuStellarSettlementDestination,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO invoice_cashu_requests (
          invoice_id,
          merchant_id,
          schema_version,
          encoded_request,
          encoding,
          issued_at,
          mint_policy,
          operator_count,
          route_set_fingerprint,
          transport_url
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        invoice.id,
        invoice.merchantId,
        request.schemaVersion,
        request.encodedRequest,
        request.encoding,
        request.issuedAt,
        request.mintPolicy,
        request.operators.length,
        createCashuPaymentRequestRouteSetFingerprint(
          invoice.merchantId,
          request,
          settlementDestination,
        ),
        request.transportUrl,
      ],
    );

    for (const [position, route] of request.operators.entries()) {
      await client.query(
        `
          INSERT INTO invoice_cashu_request_operators (
            invoice_id,
            merchant_id,
            position,
            operator_id,
            mint_url,
            mode,
            tier,
            reason,
            settlement_destination
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          invoice.id,
          invoice.merchantId,
          position,
          route.operatorId,
          route.mintUrl,
          route.mode,
          route.tier,
          route.reason,
          settlementDestination,
        ],
      );
    }
  }

  private async readReplay(
    client: PoolClient,
    input: CreateOpenInvoiceRecord,
  ): Promise<CreateOpenInvoiceResult> {
    const row = await this.findCreationRow(client, input.invoice.merchantId, input.idempotencyKey);
    if (row === undefined) {
      throw new InvoiceRepositoryError(
        "invalid_record",
        "Invoice idempotency record has no matching issued invoice.",
      );
    }
    if (row.request_fingerprint !== input.requestFingerprint) {
      throw new InvoiceRepositoryError(
        "idempotency_conflict",
        "Idempotency key was already used for a different invoice request.",
      );
    }
    const issuedInvoice = await this.mapIssuedInvoice(client, row);
    return Object.freeze({ ...issuedInvoice, replayed: true });
  }

  private async findCreationRow(
    client: PoolClient,
    ownerId: MerchantId,
    requestKey: string,
  ): Promise<CreationRow | undefined> {
    const result = await client.query<CreationRow>(
      `
        SELECT
          creation.request_fingerprint,
          invoice.id,
          invoice.merchant_id,
          invoice.schema_version,
          invoice.unit,
          invoice.amount,
          invoice.created_at,
          invoice.expires_at,
          invoice.state,
          invoice.paid_at,
          cashu.schema_version AS cashu_schema_version,
          cashu.encoded_request,
          cashu.encoding,
          cashu.issued_at,
          cashu.mint_policy,
          cashu.operator_count,
          cashu.route_set_fingerprint,
          cashu.transport_url
        FROM invoice_creation_requests AS creation
        JOIN merchant_invoices AS invoice
          ON invoice.id = creation.invoice_id
          AND invoice.merchant_id = creation.merchant_id
        LEFT JOIN invoice_cashu_requests AS cashu
          ON cashu.invoice_id = invoice.id
          AND cashu.merchant_id = invoice.merchant_id
        WHERE creation.merchant_id = $1 AND creation.idempotency_key = $2
      `,
      [ownerId, requestKey],
    );
    return result.rows[0];
  }

  private async mapIssuedInvoice(client: PoolClient, row: InvoiceRow): Promise<IssuedInvoiceV1> {
    const invoice = mapInvoiceRow(row);
    const operators = await client.query<CashuOperatorRow>(
      `
        SELECT position, operator_id, mint_url, mode, tier, reason, settlement_destination
        FROM invoice_cashu_request_operators
        WHERE invoice_id = $1
        ORDER BY position
      `,
      [invoice.id],
    );
    const cashuPaymentRequest = reconstructStoredCashuPaymentRequest(row, operators.rows, invoice);
    return Object.freeze({ cashuPaymentRequest, invoice });
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
  if (row.schema_version !== 1 || row.unit !== "usdc") {
    throw new InvoiceRepositoryError(
      "invalid_record",
      "Stored invoice schema, unit, or state is unsupported.",
    );
  }
  try {
    const createdAt = unixTimestamp(parseSafeInteger(row.created_at));
    const expiresAt = unixTimestamp(parseSafeInteger(row.expires_at));
    const paidAt = row.paid_at === null ? undefined : unixTimestamp(parseSafeInteger(row.paid_at));
    if (
      !(
        (row.state === "open" && paidAt === undefined) ||
        (row.state === "paid" && paidAt !== undefined && paidAt >= createdAt && paidAt < expiresAt)
      )
    ) {
      throw new Error("Stored invoice state is invalid.");
    }
    return createInvoiceV1({
      amount: minorUnits(parseSafeInteger(row.amount)),
      createdAt,
      expiresAt,
      id: invoiceId(row.id),
      merchantId: merchantId(row.merchant_id),
    });
  } catch {
    throw new InvoiceRepositoryError("invalid_record", "Stored invoice fields are invalid.");
  }
}

export function reconstructStoredCashuPaymentRequest(
  row: StoredCashuPaymentRequestRow,
  operatorRows: readonly StoredCashuOperatorRouteRow[],
  invoice: OpenInvoiceV1,
): CashuPaymentRequestV1 {
  try {
    if (
      row.cashu_schema_version !== 1 ||
      row.encoded_request === null ||
      row.encoding !== "creqA" ||
      row.issued_at === null ||
      row.mint_policy !== "strict" ||
      row.operator_count !== operatorRows.length ||
      row.route_set_fingerprint === null ||
      row.transport_url === null ||
      operatorRows.length === 0
    ) {
      return failInvalidCashuRecord();
    }
    const issuedAt = unixTimestamp(parseSafeInteger(row.issued_at));
    if (issuedAt !== invoice.createdAt) {
      return failInvalidCashuRecord();
    }
    const settlementDestination = cashuStellarSettlementDestination(
      operatorRows[0]?.settlement_destination ?? "",
    );
    if (
      !operatorRows.every((operator) => operator.settlement_destination === settlementDestination)
    ) {
      return failInvalidCashuRecord();
    }
    const configuredRoutes = operatorRows.map((operator, position) => {
      if (
        operator.position !== position ||
        !isOperatorTier(operator.tier) ||
        !isSettlementMode(operator.mode)
      ) {
        return failInvalidCashuRecord();
      }
      return {
        mintUrl: operator.mint_url,
        operatorId: operatorId(operator.operator_id),
        requestedMode: operator.mode,
        tier: operator.tier,
      };
    });
    const reconstructed = createCashuPaymentRequestV1({
      invoice,
      issuedAt,
      mintPolicy: "strict",
      operators: configuredRoutes,
      transportUrl: row.transport_url,
    });
    if (
      reconstructed.encodedRequest !== row.encoded_request ||
      reconstructed.transportUrl !== row.transport_url ||
      row.route_set_fingerprint !==
        createCashuPaymentRequestRouteSetFingerprint(
          invoice.merchantId,
          reconstructed,
          settlementDestination,
        ) ||
      !operatorRows.every((operator, position) =>
        sameOperatorRoute(operator, reconstructed.operators[position]),
      )
    ) {
      return failInvalidCashuRecord();
    }
    return reconstructed;
  } catch (error) {
    if (error instanceof InvoiceRepositoryError) {
      throw error;
    }
    return failInvalidCashuRecord();
  }
}

export function createCashuPaymentRequestRouteSetFingerprint(
  ownerId: MerchantId,
  request: CashuPaymentRequestV1,
  settlementDestination: CashuStellarSettlementDestination,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        amount: request.amount,
        encodedRequest: request.encodedRequest,
        encoding: request.encoding,
        expiresAt: request.expiresAt,
        invoiceId: request.invoiceId,
        issuedAt: request.issuedAt,
        merchantId: ownerId,
        mintPolicy: request.mintPolicy,
        operators: request.operators.map((route, position) => ({
          mintUrl: route.mintUrl,
          mode: route.mode,
          operatorId: route.operatorId,
          position,
          reason: route.reason,
          settlementDestination,
          tier: route.tier,
        })),
        schemaVersion: request.schemaVersion,
        transportUrl: request.transportUrl,
        unit: request.unit,
      }),
    )
    .digest("hex");
}

function validateCashuPaymentRequest(
  invoice: OpenInvoiceV1,
  request: CashuPaymentRequestV1,
): CashuPaymentRequestV1 {
  try {
    if (request.issuedAt !== invoice.createdAt) {
      return failInvalidCashuRecord();
    }
    const reconstructed = createCashuPaymentRequestV1({
      invoice,
      issuedAt: request.issuedAt,
      mintPolicy: request.mintPolicy,
      operators: request.operators.map((route) => ({
        mintUrl: route.mintUrl,
        operatorId: operatorId(route.operatorId),
        requestedMode: route.mode,
        tier: route.tier,
      })),
      transportUrl: request.transportUrl,
    });
    if (!sameCashuPaymentRequest(request, reconstructed)) {
      return failInvalidCashuRecord();
    }
    return reconstructed;
  } catch (error) {
    if (error instanceof InvoiceRepositoryError) {
      throw error;
    }
    return failInvalidCashuRecord();
  }
}

function sameCashuPaymentRequest(
  left: CashuPaymentRequestV1,
  right: CashuPaymentRequestV1,
): boolean {
  return (
    left.amount === right.amount &&
    left.encodedRequest === right.encodedRequest &&
    left.encoding === right.encoding &&
    left.expiresAt === right.expiresAt &&
    left.invoiceId === right.invoiceId &&
    left.issuedAt === right.issuedAt &&
    left.mintPolicy === right.mintPolicy &&
    left.schemaVersion === right.schemaVersion &&
    left.transportUrl === right.transportUrl &&
    left.unit === right.unit &&
    left.operators.length === right.operators.length &&
    left.operators.every((route, position) => sameAcceptedRoute(route, right.operators[position]))
  );
}

function sameOperatorRoute(
  row: StoredCashuOperatorRouteRow,
  route: AcceptedOperatorRouteV1 | undefined,
): boolean {
  return (
    route !== undefined &&
    row.mint_url === route.mintUrl &&
    row.mode === route.mode &&
    row.operator_id === route.operatorId &&
    row.reason === route.reason &&
    row.tier === route.tier
  );
}

function sameAcceptedRoute(
  left: AcceptedOperatorRouteV1,
  right: AcceptedOperatorRouteV1 | undefined,
): boolean {
  return (
    right !== undefined &&
    left.mintUrl === right.mintUrl &&
    left.mode === right.mode &&
    left.operatorId === right.operatorId &&
    left.reason === right.reason &&
    left.tier === right.tier
  );
}

function validateSettlementDestination(value: string): CashuStellarSettlementDestination {
  try {
    return cashuStellarSettlementDestination(value);
  } catch {
    return failInvalidCashuRecord();
  }
}

function isOperatorTier(value: string): value is Exclude<OperatorTier, "unlisted"> {
  return value === "trusted" || value === "convertible";
}

function isSettlementMode(value: string): value is SettlementMode {
  return value === "trusted_hold" || value === "immediate_conversion";
}

function failInvalidCashuRecord(): never {
  throw new InvoiceRepositoryError("invalid_record", "Stored Cashu payment request is invalid.");
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
      databaseError.constraint === "invoice_creation_requests_invoice_unique" ||
      databaseError.constraint === "invoice_cashu_requests_pkey" ||
      databaseError.constraint === "invoice_cashu_requests_identity_unique")
  ) {
    return new InvoiceRepositoryError(
      "invoice_id_conflict",
      "Generated invoice identifier is already in use.",
    );
  }
  return new InvoiceRepositoryError("storage_unavailable", "Invoice storage operation failed.");
}
