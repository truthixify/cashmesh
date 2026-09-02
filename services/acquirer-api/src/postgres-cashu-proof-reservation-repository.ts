import { createHash } from "node:crypto";
import {
  createCashuProofReferenceV1,
  MAX_NUT18_PAYMENT_PROOFS,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import { invoiceId, operatorId, type PaymentId, paymentId, unixTimestamp } from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
  type CashuProofReservationRepository,
  CashuProofReservationRepositoryError,
  type CashuProofReservationV1,
  type ReserveCashuProofsInput,
  type ReserveCashuProofsResult,
} from "./cashu-proof-reservation-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface ReservationRow extends QueryResultRow {
  readonly gross_amount: string;
  readonly invoice_id: string;
  readonly keyset_observed_at: string;
  readonly mint_url: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly reservation_fingerprint: string;
  readonly reserved_at: string;
  readonly schema_version: number;
  readonly unit: string;
}

interface ReservedProofRow extends QueryResultRow {
  readonly amount: string;
  readonly keyset_id: string;
  readonly mint_url: string;
  readonly position: number;
  readonly proof_y: string;
  readonly unit: string;
}

interface InvoiceRouteRow extends QueryResultRow {
  readonly created_at: string;
  readonly expires_at: string;
  readonly route_accepted: boolean;
  readonly schema_version: number;
  readonly state: string;
  readonly unit: string;
}

interface ObservedKeysetRow extends QueryResultRow {
  readonly keyset_id: string;
}

interface LifecycleReplayRow extends QueryResultRow {
  readonly active_claims: string;
  readonly latest_state: string | null;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

const RESERVATION_SELECT = `
  SELECT
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
  FROM cashu_proof_reservations
`;
const UNIT_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MAX_UNIT_LENGTH = 32;

export interface PostgresCashuProofReservationRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresCashuProofReservationRepository implements CashuProofReservationRepository {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    options: PostgresCashuProofReservationRepositoryOptions,
  ): Promise<PostgresCashuProofReservationRepository> {
    if (options.connectionString.trim() === "") {
      throw new CashuProofReservationRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection string is required.",
      );
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw new CashuProofReservationRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection pool size must be a positive integer.",
      );
    }
    const pool = new Pool({
      application_name: "cashmesh-proof-reservations",
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
    const repository = new PostgresCashuProofReservationRepository(pool);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      if (error instanceof CashuProofReservationRepositoryError) {
        throw error;
      }
      throw new CashuProofReservationRepositoryError(
        "storage_unavailable",
        "PostgreSQL Cashu proof reservation storage could not be initialized.",
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async reserve(input: ReserveCashuProofsInput): Promise<ReserveCashuProofsResult> {
    try {
      const reservation = createReservation(input);
      const fingerprint = createReservationFingerprint(reservation);
      return await this.withTransaction(async (client) => {
        const existing = await this.findReservationRow(client, reservation.paymentId);
        if (existing !== undefined) {
          return await this.replayReservation(client, existing, fingerprint);
        }

        await this.assertInvoiceRoute(client, reservation);
        await this.assertKeysetEvidence(client, reservation);
        const inserted = await client.query<ReservationRow>(
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
            ON CONFLICT DO NOTHING
            RETURNING
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
          `,
          [
            reservation.paymentId,
            fingerprint,
            reservation.invoiceId,
            reservation.operatorId,
            reservation.mintUrl,
            reservation.unit,
            reservation.schemaVersion,
            reservation.keysetObservedAt,
            reservation.reservedAt,
            reservation.grossAmount,
          ],
        );
        if (inserted.rowCount === 0) {
          const concurrent = await this.findReservationRow(client, reservation.paymentId);
          if (concurrent === undefined) {
            return failInvalidRecord();
          }
          return await this.replayReservation(client, concurrent, fingerprint);
        }

        for (const [position, proof] of reservation.proofReferences.entries()) {
          await client.query(
            `
              INSERT INTO cashu_reserved_proofs (
                payment_id,
                mint_url,
                unit,
                position,
                proof_y,
                keyset_id,
                amount
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            `,
            [
              reservation.paymentId,
              reservation.mintUrl,
              reservation.unit,
              position,
              proof.y,
              proof.keysetId,
              proof.amount,
            ],
          );
        }
        return Object.freeze({ replayed: false, reservation });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByPaymentId(
    requestedPaymentId: PaymentId,
  ): Promise<CashuProofReservationV1 | undefined> {
    let client: PoolClient | undefined;
    try {
      const validatedPaymentId = validatePaymentId(requestedPaymentId);
      client = await this.pool.connect();
      const row = await this.findReservationRow(client, validatedPaymentId);
      return row === undefined ? undefined : await this.mapReservation(client, row);
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      client?.release();
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
  }

  private async assertInvoiceRoute(
    client: PoolClient,
    reservation: CashuProofReservationV1,
  ): Promise<void> {
    const result = await client.query<InvoiceRouteRow>(
      `
        SELECT
          invoice.schema_version,
          invoice.unit,
          invoice.created_at,
          invoice.expires_at,
          invoice.state,
          EXISTS (
            SELECT 1
            FROM invoice_cashu_request_operators AS route
            JOIN invoice_cashu_requests AS request
              ON request.invoice_id = route.invoice_id
            WHERE route.invoice_id = invoice.id
              AND route.operator_id = $2
              AND route.mint_url = $3
              AND request.route_set_fingerprint IS NOT NULL
          ) AS route_accepted
        FROM merchant_invoices AS invoice
        WHERE invoice.id = $1
        FOR UPDATE
      `,
      [reservation.invoiceId, reservation.operatorId, reservation.mintUrl],
    );
    const row = result.rows[0];
    if (row === undefined || row.schema_version !== 1 || row.state !== "open") {
      throw new CashuProofReservationRepositoryError(
        "invoice_not_open",
        "Cashu proofs can only be reserved for an open invoice.",
      );
    }
    if (row.unit !== reservation.unit) {
      return failInvalidInput();
    }
    const createdAt = parseSafeInteger(row.created_at);
    const expiresAt = parseSafeInteger(row.expires_at);
    if (reservation.reservedAt < createdAt || reservation.reservedAt >= expiresAt) {
      throw new CashuProofReservationRepositoryError(
        "reservation_window_closed",
        "Cashu proofs cannot be reserved outside the invoice window.",
      );
    }
    if (!row.route_accepted) {
      throw new CashuProofReservationRepositoryError(
        "route_not_accepted",
        "Cashu proofs do not match an operator route accepted by the invoice.",
      );
    }
  }

  private async replayReservation(
    client: PoolClient,
    row: ReservationRow,
    expectedFingerprint: string,
  ): Promise<ReserveCashuProofsResult> {
    if (row.reservation_fingerprint !== expectedFingerprint) {
      throw new CashuProofReservationRepositoryError(
        "payment_conflict",
        "Payment identifier was already used for a different proof reservation.",
      );
    }
    const reservation = await this.mapReservation(client, row);
    const lifecycle = await client.query<LifecycleReplayRow>(
      `
        SELECT
          (
            SELECT state
            FROM cashu_proof_reservation_events
            WHERE payment_id = $1
            ORDER BY sequence DESC
            LIMIT 1
          ) AS latest_state,
          (
            SELECT COUNT(*)
            FROM cashu_active_proof_claims
            WHERE payment_id = $1
          ) AS active_claims
      `,
      [reservation.paymentId],
    );
    const lifecycleRow = lifecycle.rows[0];
    if (lifecycleRow?.latest_state === "released") {
      throw new CashuProofReservationRepositoryError(
        "reservation_released",
        "Released Cashu proof reservations cannot be reactivated by replay.",
      );
    }
    if (
      lifecycleRow === undefined ||
      parseSafeInteger(lifecycleRow.active_claims) !== reservation.proofReferences.length
    ) {
      return failInvalidRecord();
    }
    return Object.freeze({ replayed: true, reservation });
  }

  private async assertKeysetEvidence(
    client: PoolClient,
    reservation: CashuProofReservationV1,
  ): Promise<void> {
    const expectedKeysetIds = new Set(reservation.proofReferences.map((proof) => proof.keysetId));
    const result = await client.query<ObservedKeysetRow>(
      `
        SELECT DISTINCT entry.keyset_id
        FROM cashu_keyset_observations AS observation
        JOIN cashu_keyset_observation_entries AS entry
          ON entry.snapshot_fingerprint = observation.snapshot_fingerprint
        WHERE observation.operator_id = $1
          AND observation.mint_url = $2
          AND observation.unit = $3
          AND observation.observed_at = $4
          AND entry.keyset_id = ANY($5::text[])
      `,
      [
        reservation.operatorId,
        reservation.mintUrl,
        reservation.unit,
        reservation.keysetObservedAt,
        [...expectedKeysetIds],
      ],
    );
    if (
      result.rows.length !== expectedKeysetIds.size ||
      result.rows.some((row) => !expectedKeysetIds.has(row.keyset_id))
    ) {
      throw new CashuProofReservationRepositoryError(
        "keyset_evidence_missing",
        "Cashu proof reservation lacks matching keyset observation evidence.",
      );
    }
  }

  private async findReservationRow(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<ReservationRow | undefined> {
    const result = await client.query<ReservationRow>(
      `${RESERVATION_SELECT} WHERE payment_id = $1`,
      [requestedPaymentId],
    );
    return result.rows[0];
  }

  private async mapReservation(
    client: PoolClient,
    row: ReservationRow,
  ): Promise<CashuProofReservationV1> {
    const proofs = await client.query<ReservedProofRow>(
      `
        SELECT position, mint_url, unit, proof_y, keyset_id, amount
        FROM cashu_reserved_proofs
        WHERE payment_id = $1
        ORDER BY position
      `,
      [row.payment_id],
    );
    try {
      if (
        row.schema_version !== CASHU_PROOF_RESERVATION_SCHEMA_VERSION ||
        proofs.rows.length === 0
      ) {
        return failInvalidRecord();
      }
      const reservation = createReservation({
        invoiceId: invoiceId(row.invoice_id),
        keysetObservedAt: unixTimestamp(parseSafeInteger(row.keyset_observed_at)),
        mintUrl: row.mint_url,
        operatorId: operatorId(row.operator_id),
        paymentId: paymentId(row.payment_id),
        proofReferences: proofs.rows.map((proof, position) => {
          if (
            proof.position !== position ||
            proof.mint_url !== row.mint_url ||
            proof.unit !== row.unit
          ) {
            return failInvalidRecord();
          }
          return createCashuProofReferenceV1({
            amount: parseSafeInteger(proof.amount),
            keysetId: proof.keyset_id,
            y: proof.proof_y,
          });
        }),
        reservedAt: unixTimestamp(parseSafeInteger(row.reserved_at)),
        unit: row.unit,
      });
      if (
        reservation.schemaVersion !== row.schema_version ||
        reservation.grossAmount !== parseSafeInteger(row.gross_amount) ||
        reservation.mintUrl !== row.mint_url ||
        reservation.proofReferences.some((proof, position) => {
          const stored = proofs.rows[position];
          return (
            stored === undefined ||
            proof.amount !== parseSafeInteger(stored.amount) ||
            proof.keysetId !== stored.keyset_id ||
            proof.y !== stored.proof_y
          );
        }) ||
        createReservationFingerprint(reservation) !== row.reservation_fingerprint
      ) {
        return failInvalidRecord();
      }
      return reservation;
    } catch (error) {
      if (error instanceof CashuProofReservationRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
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

function createReservation(input: ReserveCashuProofsInput): CashuProofReservationV1 {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !Array.isArray(input.proofReferences) ||
      input.proofReferences.length === 0 ||
      input.proofReferences.length > MAX_NUT18_PAYMENT_PROOFS ||
      typeof input.invoiceId !== "string" ||
      typeof input.operatorId !== "string" ||
      typeof input.paymentId !== "string"
    ) {
      return failInvalidInput();
    }
    const proofYs = new Set<string>();
    let grossAmount = 0n;
    const proofReferences = input.proofReferences.map((proof) => {
      const reference = createCashuProofReferenceV1(proof);
      if (proofYs.has(reference.y)) {
        return failInvalidInput();
      }
      proofYs.add(reference.y);
      grossAmount += BigInt(reference.amount);
      if (grossAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
        return failInvalidInput();
      }
      return reference;
    });
    proofReferences.sort((left, right) => (left.y < right.y ? -1 : left.y > right.y ? 1 : 0));
    const keysetObservedAt = unixTimestamp(input.keysetObservedAt);
    const reservedAt = unixTimestamp(input.reservedAt);
    if (keysetObservedAt > reservedAt) {
      return failInvalidInput();
    }
    return Object.freeze({
      grossAmount: Number(grossAmount),
      invoiceId: invoiceId(input.invoiceId),
      keysetObservedAt,
      mintUrl: normalizeCashuMintUrl(input.mintUrl),
      operatorId: operatorId(input.operatorId),
      paymentId: paymentId(input.paymentId),
      proofReferences: Object.freeze(proofReferences),
      reservedAt,
      schemaVersion: CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
      unit: normalizeUnit(input.unit),
    });
  } catch (error) {
    if (error instanceof CashuProofReservationRepositoryError) {
      throw error;
    }
    return failInvalidInput();
  }
}

function validatePaymentId(value: PaymentId): PaymentId {
  try {
    if (typeof value !== "string") {
      return failInvalidInput();
    }
    return paymentId(value);
  } catch (error) {
    if (error instanceof CashuProofReservationRepositoryError) {
      throw error;
    }
    return failInvalidInput();
  }
}

function normalizeUnit(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_UNIT_LENGTH ||
    value !== value.trim() ||
    !UNIT_PATTERN.test(value)
  ) {
    throw new Error("Cashu reservation unit is invalid.");
  }
  return value;
}

function createReservationFingerprint(reservation: CashuProofReservationV1): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        grossAmount: reservation.grossAmount,
        invoiceId: reservation.invoiceId,
        keysetObservedAt: reservation.keysetObservedAt,
        mintUrl: reservation.mintUrl,
        operatorId: reservation.operatorId,
        paymentId: reservation.paymentId,
        proofReferences: reservation.proofReferences,
        reservedAt: reservation.reservedAt,
        schemaVersion: reservation.schemaVersion,
        unit: reservation.unit,
      }),
    )
    .digest("hex");
}

function parseSafeInteger(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return failInvalidRecord();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return failInvalidRecord();
  }
  return parsed;
}

function failInvalidInput(): never {
  throw new CashuProofReservationRepositoryError(
    "invalid_input",
    "Cashu proof reservation input is invalid.",
  );
}

function failInvalidRecord(): never {
  throw new CashuProofReservationRepositoryError(
    "invalid_record",
    "Stored Cashu proof reservation is invalid.",
  );
}

function mapStorageError(error: unknown): CashuProofReservationRepositoryError {
  if (error instanceof CashuProofReservationRepositoryError) {
    return error;
  }
  const databaseError = error as PostgresErrorShape;
  if (
    databaseError.code === "23505" &&
    databaseError.constraint === "cashu_active_proof_claims_pkey"
  ) {
    return new CashuProofReservationRepositoryError(
      "proof_conflict",
      "Cashu proof is already reserved by another payment.",
    );
  }
  return new CashuProofReservationRepositoryError(
    "storage_unavailable",
    "Cashu proof reservation storage operation failed.",
  );
}
