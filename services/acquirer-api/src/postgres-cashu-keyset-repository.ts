import { createHash } from "node:crypto";
import {
  CASHU_KEYSET_SNAPSHOT_SCHEMA_VERSION,
  type CashuKeysetSnapshotEntryV1,
  type CashuKeysetSnapshotV1,
  createCashuKeysetSnapshotV1,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import { type OperatorId, operatorId, type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  type CashuKeysetRepository,
  CashuKeysetRepositoryError,
  type FindFreshCashuKeysetObservation,
  type PersistCashuKeysetObservation,
  type PersistCashuKeysetObservationResult,
} from "./cashu-keyset-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface KeysetIdentityRow extends QueryResultRow {
  readonly final_expiry: string | null;
  readonly identity_fingerprint: string;
  readonly input_fee_ppk: string;
  readonly keys: unknown;
  readonly keyset_id: string;
  readonly mint_url: string;
  readonly unit: string;
}

interface KeysetObservationRow extends QueryResultRow {
  readonly mint_url: string;
  readonly observed_at: string;
  readonly operator_id: string;
  readonly schema_version: number;
  readonly snapshot_fingerprint: string;
  readonly unit: string;
}

interface KeysetObservationEntryRow extends QueryResultRow {
  readonly active: boolean;
  readonly final_expiry: string | null;
  readonly identity_fingerprint: string;
  readonly input_fee_ppk: string;
  readonly keys: unknown;
  readonly keyset_id: string;
  readonly mint_url: string;
  readonly position: number;
  readonly unit: string;
}

interface ValidatedObservation {
  readonly operatorId: OperatorId;
  readonly snapshot: CashuKeysetSnapshotV1;
  readonly unit: string;
}

interface ValidatedFreshLookup {
  readonly mintUrl: string;
  readonly observedAtOrAfter: UnixTimestamp;
  readonly observedAtOrBefore: UnixTimestamp;
  readonly operatorId: OperatorId;
  readonly unit: string;
}

const UNIT_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MAX_UNIT_LENGTH = 32;

export interface PostgresCashuKeysetRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresCashuKeysetRepository implements CashuKeysetRepository {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    options: PostgresCashuKeysetRepositoryOptions,
  ): Promise<PostgresCashuKeysetRepository> {
    if (options.connectionString.trim() === "") {
      throw new CashuKeysetRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection string is required.",
      );
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw new CashuKeysetRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection pool size must be a positive integer.",
      );
    }
    const pool = new Pool({
      application_name: "cashmesh-keyset-store",
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
    const repository = new PostgresCashuKeysetRepository(pool);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      if (error instanceof CashuKeysetRepositoryError) {
        throw error;
      }
      throw new CashuKeysetRepositoryError(
        "storage_unavailable",
        "PostgreSQL Cashu keyset storage could not be initialized.",
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async persistObservation(
    input: PersistCashuKeysetObservation,
  ): Promise<PersistCashuKeysetObservationResult> {
    try {
      const observation = validateObservation(input);
      const snapshotFingerprint = createSnapshotFingerprint(observation);
      return await this.withTransaction(async (client) => {
        for (const keyset of observation.snapshot.keysets) {
          await this.persistKeysetIdentity(client, observation.snapshot, keyset);
        }

        const inserted = await client.query<KeysetObservationRow>(
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
            ON CONFLICT DO NOTHING
            RETURNING
              snapshot_fingerprint,
              operator_id,
              mint_url,
              unit,
              schema_version,
              observed_at
          `,
          [
            snapshotFingerprint,
            observation.operatorId,
            observation.snapshot.mintUrl,
            observation.unit,
            observation.snapshot.schemaVersion,
            observation.snapshot.observedAt,
          ],
        );

        if (inserted.rowCount === 0) {
          const existing = await this.findObservationAt(client, observation);
          if (existing === undefined) {
            return failInvalidRecord();
          }
          if (existing.snapshot_fingerprint !== snapshotFingerprint) {
            throw new CashuKeysetRepositoryError(
              "observation_conflict",
              "A different Cashu keyset observation already exists at this time.",
            );
          }
          const snapshot = await this.mapObservation(client, existing);
          return Object.freeze({ replayed: true, snapshot });
        }

        for (const [position, keyset] of observation.snapshot.keysets.entries()) {
          await client.query(
            `
              INSERT INTO cashu_keyset_observation_entries (
                snapshot_fingerprint,
                mint_url,
                unit,
                position,
                keyset_id,
                active
              )
              VALUES ($1, $2, $3, $4, $5, $6)
            `,
            [
              snapshotFingerprint,
              observation.snapshot.mintUrl,
              observation.unit,
              position,
              keyset.id,
              keyset.active,
            ],
          );
        }

        return Object.freeze({ replayed: false, snapshot: observation.snapshot });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findLatestFreshSnapshot(
    input: FindFreshCashuKeysetObservation,
  ): Promise<CashuKeysetSnapshotV1 | undefined> {
    let client: PoolClient | undefined;
    try {
      const lookup = validateFreshLookup(input);
      client = await this.pool.connect();
      const result = await client.query<KeysetObservationRow>(
        `
          SELECT
            snapshot_fingerprint,
            operator_id,
            mint_url,
            unit,
            schema_version,
            observed_at
          FROM cashu_keyset_observations
          WHERE operator_id = $1
            AND mint_url = $2
            AND unit = $3
            AND observed_at >= $4
            AND observed_at <= $5
          ORDER BY observed_at DESC, snapshot_fingerprint
          LIMIT 1
        `,
        [
          lookup.operatorId,
          lookup.mintUrl,
          lookup.unit,
          lookup.observedAtOrAfter,
          lookup.observedAtOrBefore,
        ],
      );
      const row = result.rows[0];
      return row === undefined ? undefined : await this.mapObservation(client, row);
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      client?.release();
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
  }

  private async persistKeysetIdentity(
    client: PoolClient,
    snapshot: CashuKeysetSnapshotV1,
    keyset: CashuKeysetSnapshotEntryV1,
  ): Promise<void> {
    const identityFingerprint = createIdentityFingerprint(snapshot.mintUrl, keyset);
    await client.query(
      `
        INSERT INTO cashu_keysets (
          mint_url,
          keyset_id,
          unit,
          input_fee_ppk,
          final_expiry,
          keys,
          identity_fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT DO NOTHING
      `,
      [
        snapshot.mintUrl,
        keyset.id,
        keyset.unit,
        keyset.inputFeePpk,
        keyset.finalExpiry ?? null,
        JSON.stringify(keyset.keys),
        identityFingerprint,
      ],
    );
    const stored = await client.query<KeysetIdentityRow>(
      `
        SELECT
          mint_url,
          keyset_id,
          unit,
          input_fee_ppk,
          final_expiry,
          keys,
          identity_fingerprint
        FROM cashu_keysets
        WHERE mint_url = $1 AND keyset_id = $2
      `,
      [snapshot.mintUrl, keyset.id],
    );
    const row = stored.rows[0];
    if (row === undefined) {
      return failInvalidRecord();
    }
    validateStoredIdentity(row);
    if (row.identity_fingerprint !== identityFingerprint) {
      throw new CashuKeysetRepositoryError(
        "keyset_collision",
        "Cashu keyset identifier was already observed with different immutable material.",
      );
    }
  }

  private async findObservationAt(
    client: PoolClient,
    observation: ValidatedObservation,
  ): Promise<KeysetObservationRow | undefined> {
    const result = await client.query<KeysetObservationRow>(
      `
        SELECT
          snapshot_fingerprint,
          operator_id,
          mint_url,
          unit,
          schema_version,
          observed_at
        FROM cashu_keyset_observations
        WHERE operator_id = $1 AND mint_url = $2 AND unit = $3 AND observed_at = $4
      `,
      [
        observation.operatorId,
        observation.snapshot.mintUrl,
        observation.unit,
        observation.snapshot.observedAt,
      ],
    );
    return result.rows[0];
  }

  private async mapObservation(
    client: PoolClient,
    observationRow: KeysetObservationRow,
  ): Promise<CashuKeysetSnapshotV1> {
    const entries = await client.query<KeysetObservationEntryRow>(
      `
        SELECT
          entry.position,
          entry.mint_url,
          entry.unit,
          entry.keyset_id,
          entry.active,
          keyset.input_fee_ppk,
          keyset.final_expiry,
          keyset.keys,
          keyset.identity_fingerprint
        FROM cashu_keyset_observation_entries AS entry
        JOIN cashu_keysets AS keyset
          ON keyset.mint_url = entry.mint_url
          AND keyset.keyset_id = entry.keyset_id
          AND keyset.unit = entry.unit
        WHERE entry.snapshot_fingerprint = $1
        ORDER BY entry.position
      `,
      [observationRow.snapshot_fingerprint],
    );

    try {
      if (
        observationRow.schema_version !== CASHU_KEYSET_SNAPSHOT_SCHEMA_VERSION ||
        entries.rows.length === 0
      ) {
        return failInvalidRecord();
      }
      const storedOperatorId = operatorId(observationRow.operator_id);
      const mintUrl = normalizeCashuMintUrl(observationRow.mint_url);
      if (mintUrl !== observationRow.mint_url) {
        return failInvalidRecord();
      }
      const unit = normalizeUnit(observationRow.unit);
      const observedAt = unixTimestamp(parseSafeInteger(observationRow.observed_at));
      const snapshot = createCashuKeysetSnapshotV1({
        keysets: entries.rows.map((row, position) => {
          if (row.position !== position || row.mint_url !== mintUrl || row.unit !== unit) {
            return failInvalidRecord();
          }
          return {
            active: row.active,
            ...(row.final_expiry !== null && {
              finalExpiry: parsePositiveSafeInteger(row.final_expiry),
            }),
            id: row.keyset_id,
            inputFeePpk: parseSafeInteger(row.input_fee_ppk),
            keys: row.keys as Readonly<Record<string, string>>,
            unit: row.unit,
          };
        }),
        mintUrl,
        observedAt,
        schemaVersion: observationRow.schema_version,
      });
      if (snapshot.keysets.some((keyset) => keyset.unit !== unit)) {
        return failInvalidRecord();
      }
      for (const [position, keyset] of snapshot.keysets.entries()) {
        const row = entries.rows[position];
        if (
          row === undefined ||
          row.keyset_id !== keyset.id ||
          row.identity_fingerprint !== createIdentityFingerprint(mintUrl, keyset)
        ) {
          return failInvalidRecord();
        }
      }
      const fingerprint = createSnapshotFingerprint({
        operatorId: storedOperatorId,
        snapshot,
        unit,
      });
      if (fingerprint !== observationRow.snapshot_fingerprint) {
        return failInvalidRecord();
      }
      return snapshot;
    } catch (error) {
      if (error instanceof CashuKeysetRepositoryError) {
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

function validateObservation(input: PersistCashuKeysetObservation): ValidatedObservation {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return failInvalidInput();
    }
    if (typeof input.operatorId !== "string") {
      return failInvalidInput();
    }
    const validatedOperatorId = operatorId(input.operatorId);
    const unit = normalizeUnit(input.unit);
    const snapshot = createCashuKeysetSnapshotV1(input.snapshot);
    if (snapshot.keysets.some((keyset) => keyset.unit !== unit)) {
      return failInvalidInput();
    }
    return Object.freeze({ operatorId: validatedOperatorId, snapshot, unit });
  } catch (error) {
    if (error instanceof CashuKeysetRepositoryError) {
      throw error;
    }
    return failInvalidInput();
  }
}

function validateFreshLookup(input: FindFreshCashuKeysetObservation): ValidatedFreshLookup {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return failInvalidInput();
    }
    if (typeof input.operatorId !== "string") {
      return failInvalidInput();
    }
    const observedAtOrAfter = unixTimestamp(input.observedAtOrAfter);
    const observedAtOrBefore = unixTimestamp(input.observedAtOrBefore);
    if (observedAtOrAfter > observedAtOrBefore) {
      return failInvalidInput();
    }
    return Object.freeze({
      mintUrl: normalizeCashuMintUrl(input.mintUrl),
      observedAtOrAfter,
      observedAtOrBefore,
      operatorId: operatorId(input.operatorId),
      unit: normalizeUnit(input.unit),
    });
  } catch (error) {
    if (error instanceof CashuKeysetRepositoryError) {
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
    throw new Error("Cashu unit is invalid.");
  }
  return value;
}

function validateStoredIdentity(row: KeysetIdentityRow): void {
  try {
    const mintUrl = normalizeCashuMintUrl(row.mint_url);
    if (mintUrl !== row.mint_url) {
      failInvalidRecord();
    }
    const snapshot = createCashuKeysetSnapshotV1({
      keysets: [
        {
          active: false,
          ...(row.final_expiry !== null && {
            finalExpiry: parsePositiveSafeInteger(row.final_expiry),
          }),
          id: row.keyset_id,
          inputFeePpk: parseSafeInteger(row.input_fee_ppk),
          keys: row.keys as Readonly<Record<string, string>>,
          unit: normalizeUnit(row.unit),
        },
      ],
      mintUrl,
      observedAt: 0,
    });
    const keyset = snapshot.keysets[0];
    if (
      keyset === undefined ||
      createIdentityFingerprint(snapshot.mintUrl, keyset) !== row.identity_fingerprint
    ) {
      failInvalidRecord();
    }
  } catch (error) {
    if (error instanceof CashuKeysetRepositoryError) {
      throw error;
    }
    failInvalidRecord();
  }
}

function createIdentityFingerprint(mintUrl: string, keyset: CashuKeysetSnapshotEntryV1): string {
  return sha256({
    finalExpiry: keyset.finalExpiry ?? null,
    id: keyset.id,
    inputFeePpk: keyset.inputFeePpk,
    keys: keyset.keys,
    mintUrl,
    schemaVersion: CASHU_KEYSET_SNAPSHOT_SCHEMA_VERSION,
    unit: keyset.unit,
  });
}

function createSnapshotFingerprint(observation: ValidatedObservation): string {
  return sha256({
    keysets: observation.snapshot.keysets.map((keyset) => ({
      active: keyset.active,
      finalExpiry: keyset.finalExpiry ?? null,
      id: keyset.id,
      inputFeePpk: keyset.inputFeePpk,
      keys: keyset.keys,
      unit: keyset.unit,
    })),
    mintUrl: observation.snapshot.mintUrl,
    observedAt: observation.snapshot.observedAt,
    operatorId: observation.operatorId,
    schemaVersion: observation.snapshot.schemaVersion,
    unit: observation.unit,
  });
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function parsePositiveSafeInteger(value: string): number {
  const parsed = parseSafeInteger(value);
  if (parsed === 0) {
    return failInvalidRecord();
  }
  return parsed;
}

function failInvalidInput(): never {
  throw new CashuKeysetRepositoryError(
    "invalid_input",
    "Cashu keyset repository input is invalid.",
  );
}

function failInvalidRecord(): never {
  throw new CashuKeysetRepositoryError(
    "invalid_record",
    "Stored Cashu keyset observation is invalid.",
  );
}

function mapStorageError(error: unknown): CashuKeysetRepositoryError {
  if (error instanceof CashuKeysetRepositoryError) {
    return error;
  }
  return new CashuKeysetRepositoryError(
    "storage_unavailable",
    "Cashu keyset storage operation failed.",
  );
}
