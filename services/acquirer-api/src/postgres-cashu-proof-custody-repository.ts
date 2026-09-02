import { createHash, timingSafeEqual } from "node:crypto";
import {
  CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION,
  type CashuBearerProofBundleV1,
  type CashuProofReferenceV1,
  createCashuProofReferenceV1,
  isCashuBearerProofBundleValidatedForInitialCustodyV1,
  normalizeCashuMintUrl,
  restoreCashuBearerProofBundleV1,
} from "@cashmesh/cashu";
import {
  invoiceId,
  operatorId,
  type PaymentId,
  paymentId,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM,
  type CashuProofCustodyCipher,
  CashuProofCustodyCipherError,
  type CashuProofCustodyKeyId,
  cashuProofCustodyKeyId,
} from "./cashu-proof-custody-cipher";
import {
  CASHU_PROOF_CUSTODY_SCHEMA_VERSION,
  type CashuProofCustodyMetadataV1,
  type CashuProofCustodyRepository,
  CashuProofCustodyRepositoryError,
  type StoreCashuProofCustodyInput,
  type StoreCashuProofCustodyResult,
} from "./cashu-proof-custody-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface ReservationScopeRow extends QueryResultRow {
  readonly created_at: string;
  readonly effect_exists: boolean;
  readonly expires_at: string;
  readonly invoice_id: string;
  readonly invoice_state: string;
  readonly latest_state: string | null;
  readonly mint_url: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly reserved_at: string;
  readonly schema_version: number;
  readonly unit: string;
}

interface ReservedProofRow extends QueryResultRow {
  readonly amount: string;
  readonly keyset_id: string;
  readonly position: number;
  readonly proof_y: string;
}

interface CustodyRow extends QueryResultRow {
  readonly authentication_tag: Buffer;
  readonly binding_fingerprint: string;
  readonly ciphertext: Buffer;
  readonly created_at: string;
  readonly encryption_algorithm: string;
  readonly key_id: string;
  readonly nonce: Buffer;
  readonly payment_id: string;
  readonly proof_count: number;
  readonly record_fingerprint: string;
  readonly schema_version: number;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

interface ReservationScope {
  readonly createdAt: UnixTimestamp;
  readonly effectExists: boolean;
  readonly expiresAt: UnixTimestamp;
  readonly invoiceId: string;
  readonly invoiceState: string;
  readonly latestState: string | null;
  readonly mintUrl: string;
  readonly operatorId: string;
  readonly paymentId: PaymentId;
  readonly proofReferences: readonly CashuProofReferenceV1[];
  readonly reservedAt: UnixTimestamp;
  readonly unit: string;
}

interface StoredCustodyRecord {
  readonly authenticationTag: Uint8Array;
  readonly bindingFingerprint: string;
  readonly ciphertext: Uint8Array;
  readonly createdAt: UnixTimestamp;
  readonly keyId: CashuProofCustodyKeyId;
  readonly nonce: Uint8Array;
  readonly paymentId: PaymentId;
  readonly proofCount: number;
  readonly recordFingerprint: string;
}

const RESERVATION_SELECT = `
  SELECT
    reservation.payment_id,
    reservation.invoice_id,
    reservation.operator_id,
    reservation.mint_url,
    reservation.unit,
    reservation.schema_version,
    reservation.reserved_at,
    invoice.created_at,
    invoice.expires_at,
    invoice.state AS invoice_state,
    (
      SELECT state
      FROM cashu_proof_reservation_events
      WHERE payment_id = reservation.payment_id
      ORDER BY sequence DESC
      LIMIT 1
    ) AS latest_state,
    EXISTS (
      SELECT 1
      FROM cashu_operator_effects
      WHERE payment_id = reservation.payment_id
    ) AS effect_exists
  FROM cashu_proof_reservations AS reservation
  JOIN merchant_invoices AS invoice ON invoice.id = reservation.invoice_id
`;

const CUSTODY_SELECT = `
  SELECT
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
  FROM cashu_bearer_proof_custody
`;

const UNIT_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MAX_UNIT_LENGTH = 32;

export interface PostgresCashuProofCustodyRepositoryOptions {
  readonly cipher: CashuProofCustodyCipher;
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresCashuProofCustodyRepository implements CashuProofCustodyRepository {
  private constructor(
    private readonly pool: Pool,
    private readonly cipher: CashuProofCustodyCipher,
  ) {}

  static async connect(
    options: PostgresCashuProofCustodyRepositoryOptions,
  ): Promise<PostgresCashuProofCustodyRepository> {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options) ||
      typeof options.connectionString !== "string" ||
      options.connectionString.trim() === "" ||
      typeof options.cipher?.encrypt !== "function" ||
      typeof options.cipher.decrypt !== "function"
    ) {
      throw storageUnavailable();
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw storageUnavailable();
    }
    const pool = new Pool({
      application_name: "cashmesh-proof-custody",
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
    const repository = new PostgresCashuProofCustodyRepository(pool, options.cipher);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      if (error instanceof CashuProofCustodyRepositoryError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async store(input: StoreCashuProofCustodyInput): Promise<StoreCashuProofCustodyResult> {
    const validated = validateStoreInput(input);
    const plaintext = validated.bearerProofs.serializeForEncryption();
    try {
      return await this.withTransaction(async (client) => {
        const reservation = await this.requireReservation(client, validated.paymentId, true);
        assertBundleMatchesReservation(validated.bearerProofs, reservation);
        const existing = await this.loadStoredRecord(client, reservation);
        if (existing !== undefined) {
          const storedBundle = await this.decryptRecord(existing, reservation);
          try {
            const storedPlaintext = storedBundle.serializeForEncryption();
            try {
              if (
                existing.createdAt !== validated.createdAt ||
                !equalBytes(storedPlaintext, plaintext)
              ) {
                return failCustodyConflict();
              }
            } finally {
              storedPlaintext.fill(0);
            }
          } finally {
            storedBundle.destroy();
          }
          return Object.freeze({ metadata: metadataFrom(existing), replayed: true });
        }
        if (
          reservation.latestState !== null ||
          reservation.effectExists ||
          reservation.invoiceState !== "open" ||
          validated.createdAt < reservation.reservedAt ||
          validated.createdAt < reservation.createdAt ||
          validated.createdAt >= reservation.expiresAt
        ) {
          return failInvalidReservationState();
        }
        const bindingFingerprint = createBindingFingerprint(reservation, validated.createdAt);
        const encrypted = await encryptForStorage(this.cipher, plaintext, bindingFingerprint);
        const stored: StoredCustodyRecord = Object.freeze({
          authenticationTag: encrypted.authenticationTag,
          bindingFingerprint,
          ciphertext: encrypted.ciphertext,
          createdAt: validated.createdAt,
          keyId: encrypted.keyId,
          nonce: encrypted.nonce,
          paymentId: reservation.paymentId,
          proofCount: reservation.proofReferences.length,
          recordFingerprint: createRecordFingerprint({
            authenticationTag: encrypted.authenticationTag,
            bindingFingerprint,
            ciphertext: encrypted.ciphertext,
            createdAt: validated.createdAt,
            keyId: encrypted.keyId,
            nonce: encrypted.nonce,
            paymentId: reservation.paymentId,
            proofCount: reservation.proofReferences.length,
          }),
        });
        await client.query(
          `
            INSERT INTO cashu_proof_custody_nonce_uses (
              key_id,
              nonce,
              payment_id,
              created_at
            )
            VALUES ($1, $2, $3, $4)
          `,
          [stored.keyId, Buffer.from(stored.nonce), stored.paymentId, stored.createdAt],
        );
        await client.query(
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
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          `,
          [
            stored.paymentId,
            stored.bindingFingerprint,
            stored.recordFingerprint,
            CASHU_PROOF_CUSTODY_SCHEMA_VERSION,
            CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM,
            stored.keyId,
            Buffer.from(stored.nonce),
            Buffer.from(stored.authenticationTag),
            Buffer.from(stored.ciphertext),
            stored.proofCount,
            stored.createdAt,
          ],
        );
        return Object.freeze({ metadata: metadataFrom(stored), replayed: false });
      });
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      plaintext.fill(0);
    }
  }

  async findMetadata(
    requestedPaymentId: PaymentId,
  ): Promise<CashuProofCustodyMetadataV1 | undefined> {
    try {
      const validatedPaymentId = validatePaymentId(requestedPaymentId);
      return await this.withTransaction(async (client) => {
        const reservation = await this.loadReservation(client, validatedPaymentId, true);
        if (reservation === undefined) {
          return undefined;
        }
        const record = await this.loadStoredRecord(client, reservation);
        return record === undefined ? undefined : metadataFrom(record);
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async withDecryptedBundle<T>(
    requestedPaymentId: PaymentId,
    use: (bundle: CashuBearerProofBundleV1) => Promise<T> | T,
  ): Promise<T | undefined> {
    if (typeof use !== "function") {
      return failInvalidInput();
    }
    const bundle = await this.retrieveBundle(requestedPaymentId);
    if (bundle === undefined) {
      return undefined;
    }
    try {
      return await use(bundle);
    } finally {
      bundle.destroy();
    }
  }

  private async retrieveBundle(
    requestedPaymentId: PaymentId,
  ): Promise<CashuBearerProofBundleV1 | undefined> {
    try {
      const validatedPaymentId = validatePaymentId(requestedPaymentId);
      return await this.withTransaction(async (client) => {
        const reservation = await this.loadReservation(client, validatedPaymentId, true);
        if (reservation === undefined) {
          return undefined;
        }
        const record = await this.loadStoredRecord(client, reservation);
        if (record === undefined) {
          return undefined;
        }
        if (reservation.latestState === "consumed" || reservation.latestState === "released") {
          return failInvalidRecord();
        }
        return await this.decryptRecord(record, reservation);
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private async decryptRecord(
    record: StoredCustodyRecord,
    reservation: ReservationScope,
  ): Promise<CashuBearerProofBundleV1> {
    let plaintext: Uint8Array;
    try {
      plaintext = await this.cipher.decrypt(
        {
          algorithm: CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM,
          authenticationTag: record.authenticationTag,
          ciphertext: record.ciphertext,
          keyId: record.keyId,
          nonce: record.nonce,
        },
        bindingAad(record.bindingFingerprint),
      );
    } catch (error) {
      throw mapCipherReadError(error);
    }
    try {
      const bundle = restoreCashuBearerProofBundleV1(plaintext);
      try {
        assertBundleMatchesReservation(bundle, reservation, "record");
        return bundle;
      } catch (error) {
        bundle.destroy();
        throw error;
      }
    } catch (error) {
      if (error instanceof CashuProofCustodyRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    } finally {
      plaintext.fill(0);
    }
  }

  private async loadStoredRecord(
    client: PoolClient,
    reservation: ReservationScope,
  ): Promise<StoredCustodyRecord | undefined> {
    const result = await client.query<CustodyRow>(`${CUSTODY_SELECT} WHERE payment_id = $1`, [
      reservation.paymentId,
    ]);
    if (result.rows.length > 1) {
      return failInvalidRecord();
    }
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return mapStoredRecord(row, reservation);
  }

  private async requireReservation(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    lock: boolean,
  ): Promise<ReservationScope> {
    const reservation = await this.loadReservation(client, requestedPaymentId, lock);
    if (reservation === undefined) {
      throw new CashuProofCustodyRepositoryError(
        "reservation_not_found",
        "Cashu bearer proof custody requires an existing reservation.",
      );
    }
    return reservation;
  }

  private async loadReservation(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    lock: boolean,
  ): Promise<ReservationScope | undefined> {
    const result = await client.query<ReservationScopeRow>(
      `${RESERVATION_SELECT} WHERE reservation.payment_id = $1 ${lock ? "FOR UPDATE OF reservation" : ""}`,
      [requestedPaymentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const proofResult = await client.query<ReservedProofRow>(
      `
        SELECT position, proof_y, keyset_id, amount
        FROM cashu_reserved_proofs
        WHERE payment_id = $1
        ORDER BY position
      `,
      [requestedPaymentId],
    );
    try {
      const storedPaymentId = paymentId(row.payment_id);
      const storedInvoiceId = invoiceId(row.invoice_id);
      const storedOperatorId = operatorId(row.operator_id);
      const mintUrl = normalizeCashuMintUrl(row.mint_url);
      const unit = normalizeUnit(row.unit);
      if (
        row.schema_version !== 1 ||
        storedPaymentId !== requestedPaymentId ||
        storedInvoiceId !== row.invoice_id ||
        storedOperatorId !== row.operator_id ||
        mintUrl !== row.mint_url ||
        proofResult.rows.length === 0 ||
        ![null, "dispatch_started", "pending", "needs_attention", "consumed", "released"].includes(
          row.latest_state,
        )
      ) {
        return failInvalidRecord();
      }
      const proofReferences = proofResult.rows.map((proof, position) => {
        if (proof.position !== position) {
          return failInvalidRecord();
        }
        return createCashuProofReferenceV1({
          amount: parseSafeInteger(proof.amount),
          keysetId: proof.keyset_id,
          y: proof.proof_y,
        });
      });
      return Object.freeze({
        createdAt: unixTimestamp(parseSafeInteger(row.created_at)),
        effectExists: row.effect_exists,
        expiresAt: unixTimestamp(parseSafeInteger(row.expires_at)),
        invoiceId: storedInvoiceId,
        invoiceState: row.invoice_state,
        latestState: row.latest_state,
        mintUrl,
        operatorId: storedOperatorId,
        paymentId: storedPaymentId,
        proofReferences: Object.freeze(proofReferences),
        reservedAt: unixTimestamp(parseSafeInteger(row.reserved_at)),
        unit,
      });
    } catch (error) {
      if (error instanceof CashuProofCustodyRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
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

function validateStoreInput(input: StoreCashuProofCustodyInput): StoreCashuProofCustodyInput {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !isCashuBearerProofBundleValidatedForInitialCustodyV1(input.bearerProofs) ||
      typeof input.paymentId !== "string" ||
      typeof input.createdAt !== "number"
    ) {
      return failInvalidInput();
    }
    return Object.freeze({
      bearerProofs: input.bearerProofs,
      createdAt: unixTimestamp(input.createdAt),
      paymentId: paymentId(input.paymentId),
    });
  } catch (error) {
    if (error instanceof CashuProofCustodyRepositoryError) {
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
    if (error instanceof CashuProofCustodyRepositoryError) {
      throw error;
    }
    return failInvalidInput();
  }
}

function assertBundleMatchesReservation(
  bundle: CashuBearerProofBundleV1,
  reservation: ReservationScope,
  source: "input" | "record" = "input",
): void {
  const references = bundle.proofReferencesForBinding();
  if (
    bundle.invoiceId !== reservation.invoiceId ||
    bundle.mintUrl !== reservation.mintUrl ||
    bundle.unit !== reservation.unit ||
    bundle.proofCount !== reservation.proofReferences.length ||
    references.length !== reservation.proofReferences.length ||
    references.some((reference, position) => {
      const expected = reservation.proofReferences[position];
      return (
        expected === undefined ||
        reference.amount !== expected.amount ||
        reference.keysetId !== expected.keysetId ||
        reference.y !== expected.y
      );
    })
  ) {
    if (source === "record") {
      failInvalidRecord();
    }
    failInvalidInput();
  }
}

function mapStoredRecord(row: CustodyRow, reservation: ReservationScope): StoredCustodyRecord {
  try {
    if (
      row.schema_version !== CASHU_PROOF_CUSTODY_SCHEMA_VERSION ||
      row.encryption_algorithm !== CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM ||
      row.payment_id !== reservation.paymentId ||
      !Buffer.isBuffer(row.nonce) ||
      !Buffer.isBuffer(row.authentication_tag) ||
      !Buffer.isBuffer(row.ciphertext) ||
      row.nonce.byteLength !== 12 ||
      row.authentication_tag.byteLength !== 16 ||
      row.ciphertext.byteLength === 0 ||
      row.ciphertext.byteLength > 65_536 ||
      !Number.isSafeInteger(row.proof_count) ||
      row.proof_count !== reservation.proofReferences.length
    ) {
      return failInvalidRecord();
    }
    const record: StoredCustodyRecord = Object.freeze({
      authenticationTag: Uint8Array.from(row.authentication_tag),
      bindingFingerprint: parseFingerprint(row.binding_fingerprint),
      ciphertext: Uint8Array.from(row.ciphertext),
      createdAt: unixTimestamp(parseSafeInteger(row.created_at)),
      keyId: cashuProofCustodyKeyId(row.key_id),
      nonce: Uint8Array.from(row.nonce),
      paymentId: paymentId(row.payment_id),
      proofCount: row.proof_count,
      recordFingerprint: parseFingerprint(row.record_fingerprint),
    });
    if (
      record.bindingFingerprint !== createBindingFingerprint(reservation, record.createdAt) ||
      record.recordFingerprint !== createRecordFingerprint(record) ||
      record.createdAt < reservation.reservedAt ||
      record.createdAt < reservation.createdAt ||
      record.createdAt >= reservation.expiresAt ||
      reservation.latestState === "consumed" ||
      reservation.latestState === "released"
    ) {
      return failInvalidRecord();
    }
    return record;
  } catch (error) {
    if (error instanceof CashuProofCustodyRepositoryError) {
      throw error;
    }
    return failInvalidRecord();
  }
}

async function encryptForStorage(
  cipher: CashuProofCustodyCipher,
  plaintext: Uint8Array,
  bindingFingerprint: string,
) {
  try {
    return await cipher.encrypt(plaintext, bindingAad(bindingFingerprint));
  } catch (error) {
    if (error instanceof CashuProofCustodyCipherError && error.code === "key_unavailable") {
      throw new CashuProofCustodyRepositoryError(
        "key_unavailable",
        "Cashu bearer proof encryption key is unavailable.",
      );
    }
    throw storageUnavailable();
  }
}

function mapCipherReadError(error: unknown): CashuProofCustodyRepositoryError {
  if (error instanceof CashuProofCustodyCipherError && error.code === "key_unavailable") {
    return new CashuProofCustodyRepositoryError(
      "key_unavailable",
      "Cashu bearer proof decryption key is unavailable.",
    );
  }
  return new CashuProofCustodyRepositoryError(
    "invalid_record",
    "Stored Cashu bearer proof custody failed authentication.",
  );
}

function createBindingFingerprint(reservation: ReservationScope, createdAt: UnixTimestamp): string {
  return sha256({
    createdAt,
    invoiceId: reservation.invoiceId,
    mintUrl: reservation.mintUrl,
    operatorId: reservation.operatorId,
    paymentId: reservation.paymentId,
    proofReferences: reservation.proofReferences,
    reservedAt: reservation.reservedAt,
    schemaVersion: CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION,
    unit: reservation.unit,
  });
}

function createRecordFingerprint(record: {
  readonly authenticationTag: Uint8Array;
  readonly bindingFingerprint: string;
  readonly ciphertext: Uint8Array;
  readonly createdAt: UnixTimestamp;
  readonly keyId: CashuProofCustodyKeyId;
  readonly nonce: Uint8Array;
  readonly paymentId: PaymentId;
  readonly proofCount: number;
}): string {
  return sha256({
    algorithm: CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM,
    authenticationTag: Buffer.from(record.authenticationTag).toString("base64"),
    bindingFingerprint: record.bindingFingerprint,
    ciphertext: Buffer.from(record.ciphertext).toString("base64"),
    createdAt: record.createdAt,
    keyId: record.keyId,
    nonce: Buffer.from(record.nonce).toString("base64"),
    paymentId: record.paymentId,
    proofCount: record.proofCount,
    schemaVersion: CASHU_PROOF_CUSTODY_SCHEMA_VERSION,
  });
}

function metadataFrom(record: StoredCustodyRecord): CashuProofCustodyMetadataV1 {
  return Object.freeze({
    createdAt: record.createdAt,
    paymentId: record.paymentId,
    proofCount: record.proofCount,
    schemaVersion: CASHU_PROOF_CUSTODY_SCHEMA_VERSION,
  });
}

function bindingAad(bindingFingerprint: string): Uint8Array {
  return Uint8Array.from(Buffer.from(parseFingerprint(bindingFingerprint), "hex"));
}

function parseFingerprint(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return failInvalidRecord();
  }
  return value;
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

function normalizeUnit(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_UNIT_LENGTH ||
    value !== value.trim() ||
    !UNIT_PATTERN.test(value)
  ) {
    return failInvalidRecord();
  }
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function failInvalidInput(): never {
  throw new CashuProofCustodyRepositoryError(
    "invalid_input",
    "Cashu bearer proof custody input is invalid.",
  );
}

function failInvalidRecord(): never {
  throw new CashuProofCustodyRepositoryError(
    "invalid_record",
    "Stored Cashu bearer proof custody is invalid.",
  );
}

function failCustodyConflict(): never {
  throw new CashuProofCustodyRepositoryError(
    "custody_conflict",
    "Cashu bearer proof custody already contains different evidence.",
  );
}

function failInvalidReservationState(): never {
  throw new CashuProofCustodyRepositoryError(
    "invalid_reservation_state",
    "Cashu bearer proof custody requires an active pre-dispatch reservation.",
  );
}

function storageUnavailable(): CashuProofCustodyRepositoryError {
  return new CashuProofCustodyRepositoryError(
    "storage_unavailable",
    "Cashu bearer proof custody storage is unavailable.",
  );
}

function mapStorageError(error: unknown): CashuProofCustodyRepositoryError {
  if (error instanceof CashuProofCustodyRepositoryError) {
    return error;
  }
  const databaseError = error as PostgresErrorShape;
  if (
    databaseError.code === "23505" &&
    databaseError.constraint === "cashu_proof_custody_nonce_uses_pkey"
  ) {
    return new CashuProofCustodyRepositoryError(
      "nonce_conflict",
      "Cashu bearer proof encryption nonce was already used with this key.",
    );
  }
  return storageUnavailable();
}
