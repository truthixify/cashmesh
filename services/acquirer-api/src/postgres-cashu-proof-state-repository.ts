import { createHash } from "node:crypto";
import {
  CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION,
  type CashuProofStateSnapshotV1,
  cashuProofY,
  createCashuProofStateSnapshotV1,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import {
  type OperatorId,
  operatorId,
  type PaymentId,
  paymentId,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  type CashuProofStateRepository,
  CashuProofStateRepositoryError,
  type FindFreshCashuProofStateObservation,
  type PersistCashuProofStateObservation,
  type PersistCashuProofStateObservationResult,
} from "./cashu-proof-state-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface ProofStateObservationRow extends QueryResultRow {
  readonly mint_url: string;
  readonly observed_at: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly schema_version: number;
  readonly snapshot_fingerprint: string;
  readonly unit: string;
}

interface ProofStateObservationEntryRow extends QueryResultRow {
  readonly payment_id: string;
  readonly position: number;
  readonly proof_y: string;
  readonly state: string;
}

interface ReservationScopeRow extends QueryResultRow {
  readonly mint_url: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly reserved_at: string;
  readonly schema_version: number;
  readonly unit: string;
}

interface ReservedProofYRow extends QueryResultRow {
  readonly position: number;
  readonly proof_y: string;
}

interface BooleanResultRow extends QueryResultRow {
  readonly has_regression: boolean;
}

interface ProposedRegressionRow extends QueryResultRow {
  readonly has_later_non_spent: boolean;
  readonly has_prior_spent: boolean;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

interface ValidatedObservation {
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly snapshot: CashuProofStateSnapshotV1;
  readonly unit: string;
}

interface ValidatedFreshLookup {
  readonly mintUrl: string;
  readonly observedAtOrAfter: UnixTimestamp;
  readonly observedAtOrBefore: UnixTimestamp;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly unit: string;
}

interface ReservationEvidence {
  readonly mintUrl: string;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly proofYs: readonly string[];
  readonly reservedAt: UnixTimestamp;
  readonly unit: string;
}

const OBSERVATION_SELECT = `
  SELECT
    snapshot_fingerprint,
    payment_id,
    operator_id,
    mint_url,
    unit,
    schema_version,
    observed_at
  FROM cashu_proof_state_observations
`;
const UNIT_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MAX_UNIT_LENGTH = 32;

export interface PostgresCashuProofStateRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresCashuProofStateRepository implements CashuProofStateRepository {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    options: PostgresCashuProofStateRepositoryOptions,
  ): Promise<PostgresCashuProofStateRepository> {
    if (options.connectionString.trim() === "") {
      throw new CashuProofStateRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection string is required.",
      );
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw new CashuProofStateRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection pool size must be a positive integer.",
      );
    }
    const pool = new Pool({
      application_name: "cashmesh-proof-state-store",
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
    const repository = new PostgresCashuProofStateRepository(pool);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      if (error instanceof CashuProofStateRepositoryError) {
        throw error;
      }
      throw new CashuProofStateRepositoryError(
        "storage_unavailable",
        "PostgreSQL Cashu proof-state storage could not be initialized.",
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async persistObservation(
    input: PersistCashuProofStateObservation,
  ): Promise<PersistCashuProofStateObservationResult> {
    try {
      const observation = validateObservation(input);
      const fingerprint = createObservationFingerprint(observation);
      return await this.withTransaction(async (client) => {
        const reservation = await this.loadReservationEvidence(client, observation.paymentId, true);
        if (reservation === undefined) {
          throw new CashuProofStateRepositoryError(
            "reservation_not_found",
            "Cashu proof-state observation requires an existing proof reservation.",
          );
        }
        assertObservationReservationBinding(observation, reservation);
        await this.assertStoredHistory(client, observation.paymentId);

        const existing = await this.findObservationAt(
          client,
          observation.paymentId,
          observation.snapshot.observedAt,
        );
        if (existing !== undefined) {
          if (existing.snapshot_fingerprint !== fingerprint) {
            throw new CashuProofStateRepositoryError(
              "observation_conflict",
              "A different Cashu proof-state observation already exists at this time.",
            );
          }
          const snapshot = await this.mapObservation(client, existing);
          return Object.freeze({ replayed: true, snapshot });
        }

        await this.assertObservationWritable(client, observation.paymentId);
        await this.assertProposedTransition(client, observation);
        await client.query(
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
          [
            fingerprint,
            observation.paymentId,
            observation.operatorId,
            observation.snapshot.mintUrl,
            observation.unit,
            observation.snapshot.schemaVersion,
            observation.snapshot.observedAt,
          ],
        );

        for (const [position, state] of observation.snapshot.states.entries()) {
          await client.query(
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
            [fingerprint, observation.paymentId, position, state.y, state.state],
          );
        }

        return Object.freeze({ replayed: false, snapshot: observation.snapshot });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findLatestFreshSnapshot(
    input: FindFreshCashuProofStateObservation,
  ): Promise<CashuProofStateSnapshotV1 | undefined> {
    let client: PoolClient | undefined;
    try {
      const lookup = validateFreshLookup(input);
      client = await this.pool.connect();
      const result = await client.query<ProofStateObservationRow>(
        `
          ${OBSERVATION_SELECT}
          WHERE payment_id = $1
            AND operator_id = $2
            AND mint_url = $3
            AND unit = $4
            AND observed_at >= $5
            AND observed_at <= $6
          ORDER BY observed_at DESC, snapshot_fingerprint
          LIMIT 1
        `,
        [
          lookup.paymentId,
          lookup.operatorId,
          lookup.mintUrl,
          lookup.unit,
          lookup.observedAtOrAfter,
          lookup.observedAtOrBefore,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return undefined;
      }
      await this.assertStoredHistory(client, lookup.paymentId);
      return await this.mapObservation(client, row);
    } catch (error) {
      throw mapStorageError(error);
    } finally {
      client?.release();
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
  }

  private async findObservationAt(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    observedAt: UnixTimestamp,
  ): Promise<ProofStateObservationRow | undefined> {
    const result = await client.query<ProofStateObservationRow>(
      `${OBSERVATION_SELECT} WHERE payment_id = $1 AND observed_at = $2`,
      [requestedPaymentId, observedAt],
    );
    return result.rows[0];
  }

  private async loadReservationEvidence(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    lock: boolean,
  ): Promise<ReservationEvidence | undefined> {
    const reservation = await client.query<ReservationScopeRow>(
      `
        SELECT payment_id, operator_id, mint_url, unit, schema_version, reserved_at
        FROM cashu_proof_reservations
        WHERE payment_id = $1
        ${lock ? "FOR UPDATE" : ""}
      `,
      [requestedPaymentId],
    );
    const row = reservation.rows[0];
    if (row === undefined) {
      return undefined;
    }

    const proofs = await client.query<ReservedProofYRow>(
      `
        SELECT position, proof_y
        FROM cashu_reserved_proofs
        WHERE payment_id = $1
        ORDER BY position
      `,
      [requestedPaymentId],
    );

    try {
      if (row.schema_version !== 1 || proofs.rows.length === 0) {
        return failInvalidRecord();
      }
      const validatedPaymentId = paymentId(row.payment_id);
      const validatedOperatorId = operatorId(row.operator_id);
      const mintUrl = normalizeCashuMintUrl(row.mint_url);
      const unit = normalizeUnit(row.unit);
      const reservedAt = unixTimestamp(parseSafeInteger(row.reserved_at));
      if (
        validatedPaymentId !== row.payment_id ||
        validatedPaymentId !== requestedPaymentId ||
        validatedOperatorId !== row.operator_id ||
        mintUrl !== row.mint_url ||
        unit !== row.unit
      ) {
        return failInvalidRecord();
      }

      const proofYs = Array.from(proofs.rows, (proof, position) => {
        if (proof.position !== position) {
          return failInvalidRecord();
        }
        const y = cashuProofY(proof.proof_y);
        const previous = proofs.rows[position - 1];
        if (previous !== undefined && previous.proof_y >= y) {
          return failInvalidRecord();
        }
        return y;
      });
      return Object.freeze({
        mintUrl,
        operatorId: validatedOperatorId,
        paymentId: validatedPaymentId,
        proofYs: Object.freeze(proofYs),
        reservedAt,
        unit,
      });
    } catch (error) {
      if (error instanceof CashuProofStateRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
  }

  private async mapObservation(
    client: PoolClient,
    row: ProofStateObservationRow,
  ): Promise<CashuProofStateSnapshotV1> {
    const entries = await client.query<ProofStateObservationEntryRow>(
      `
        SELECT payment_id, position, proof_y, state
        FROM cashu_proof_state_observation_entries
        WHERE snapshot_fingerprint = $1
        ORDER BY position
      `,
      [row.snapshot_fingerprint],
    );

    try {
      if (
        row.schema_version !== CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION ||
        entries.rows.length === 0
      ) {
        return failInvalidRecord();
      }
      const storedPaymentId = paymentId(row.payment_id);
      const storedOperatorId = operatorId(row.operator_id);
      const mintUrl = normalizeCashuMintUrl(row.mint_url);
      const unit = normalizeUnit(row.unit);
      const observedAt = unixTimestamp(parseSafeInteger(row.observed_at));
      if (
        storedPaymentId !== row.payment_id ||
        storedOperatorId !== row.operator_id ||
        mintUrl !== row.mint_url ||
        unit !== row.unit
      ) {
        return failInvalidRecord();
      }

      const snapshot = createCashuProofStateSnapshotV1({
        mintUrl,
        observedAt,
        schemaVersion: row.schema_version,
        states: Array.from(entries.rows, (entry, position) => {
          if (entry.payment_id !== storedPaymentId || entry.position !== position) {
            return failInvalidRecord();
          }
          return { state: entry.state, y: entry.proof_y };
        }),
      });
      const reservation = await this.loadReservationEvidence(client, storedPaymentId, false);
      if (
        reservation === undefined ||
        reservation.operatorId !== storedOperatorId ||
        reservation.mintUrl !== mintUrl ||
        reservation.unit !== unit ||
        snapshot.observedAt < reservation.reservedAt ||
        !equalProofYs(
          snapshot.states.map((state) => state.y),
          reservation.proofYs,
        ) ||
        createObservationFingerprint({
          operatorId: storedOperatorId,
          paymentId: storedPaymentId,
          snapshot,
          unit,
        }) !== row.snapshot_fingerprint
      ) {
        return failInvalidRecord();
      }
      return snapshot;
    } catch (error) {
      if (error instanceof CashuProofStateRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
  }

  private async assertStoredHistory(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<void> {
    const result = await client.query<BooleanResultRow>(
      `
        WITH first_spent AS (
          SELECT spent_entry.proof_y, MIN(spent_observation.observed_at) AS observed_at
          FROM cashu_proof_state_observations AS spent_observation
          JOIN cashu_proof_state_observation_entries AS spent_entry
            ON spent_entry.snapshot_fingerprint = spent_observation.snapshot_fingerprint
          WHERE spent_observation.payment_id = $1
            AND spent_entry.state = 'SPENT'
          GROUP BY spent_entry.proof_y
        )
        SELECT EXISTS (
          SELECT 1
          FROM first_spent
          JOIN cashu_proof_state_observations AS later_observation
            ON later_observation.payment_id = $1
            AND later_observation.observed_at > first_spent.observed_at
          JOIN cashu_proof_state_observation_entries AS later_entry
            ON later_entry.snapshot_fingerprint = later_observation.snapshot_fingerprint
            AND later_entry.proof_y = first_spent.proof_y
          WHERE later_entry.state <> 'SPENT'
        ) AS has_regression
      `,
      [requestedPaymentId],
    );
    if (result.rows[0]?.has_regression === true) {
      return failInvalidRecord();
    }
  }

  private async assertProposedTransition(
    client: PoolClient,
    observation: ValidatedObservation,
  ): Promise<void> {
    const spentYs = observation.snapshot.states
      .filter((state) => state.state === "SPENT")
      .map((state) => state.y);
    const nonSpentYs = observation.snapshot.states
      .filter((state) => state.state !== "SPENT")
      .map((state) => state.y);
    const result = await client.query<ProposedRegressionRow>(
      `
        SELECT
          EXISTS (
            SELECT 1
            FROM cashu_proof_state_observations AS prior_observation
            JOIN cashu_proof_state_observation_entries AS prior_entry
              ON prior_entry.snapshot_fingerprint = prior_observation.snapshot_fingerprint
            WHERE prior_observation.payment_id = $1
              AND prior_observation.observed_at < $2
              AND prior_entry.state = 'SPENT'
              AND prior_entry.proof_y = ANY($3::text[])
          ) AS has_prior_spent,
          EXISTS (
            SELECT 1
            FROM cashu_proof_state_observations AS later_observation
            JOIN cashu_proof_state_observation_entries AS later_entry
              ON later_entry.snapshot_fingerprint = later_observation.snapshot_fingerprint
            WHERE later_observation.payment_id = $1
              AND later_observation.observed_at > $2
              AND later_entry.state <> 'SPENT'
              AND later_entry.proof_y = ANY($4::text[])
          ) AS has_later_non_spent
      `,
      [observation.paymentId, observation.snapshot.observedAt, nonSpentYs, spentYs],
    );
    const row = result.rows[0];
    if (row?.has_prior_spent === true || row?.has_later_non_spent === true) {
      throw new CashuProofStateRepositoryError(
        "spent_state_regression",
        "Cashu proof state cannot regress after SPENT evidence.",
      );
    }
  }

  private async assertObservationWritable(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<void> {
    const result = await client.query<{ state: string }>(
      `
        SELECT state
        FROM cashu_proof_reservation_events
        WHERE payment_id = $1
        ORDER BY sequence DESC
        LIMIT 1
      `,
      [requestedPaymentId],
    );
    if (["consumed", "released"].includes(result.rows[0]?.state ?? "")) {
      throw new CashuProofStateRepositoryError(
        "reservation_terminal",
        "Cashu proof-state observations cannot extend a terminal reservation.",
      );
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

function validateObservation(input: PersistCashuProofStateObservation): ValidatedObservation {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      typeof input.operatorId !== "string" ||
      typeof input.paymentId !== "string"
    ) {
      return failInvalidInput();
    }
    return Object.freeze({
      operatorId: operatorId(input.operatorId),
      paymentId: paymentId(input.paymentId),
      snapshot: createCashuProofStateSnapshotV1(input.snapshot),
      unit: normalizeUnit(input.unit),
    });
  } catch (error) {
    if (error instanceof CashuProofStateRepositoryError) {
      throw error;
    }
    return failInvalidInput();
  }
}

function validateFreshLookup(input: FindFreshCashuProofStateObservation): ValidatedFreshLookup {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      typeof input.operatorId !== "string" ||
      typeof input.paymentId !== "string"
    ) {
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
      paymentId: paymentId(input.paymentId),
      unit: normalizeUnit(input.unit),
    });
  } catch (error) {
    if (error instanceof CashuProofStateRepositoryError) {
      throw error;
    }
    return failInvalidInput();
  }
}

function assertObservationReservationBinding(
  observation: ValidatedObservation,
  reservation: ReservationEvidence,
): void {
  if (
    observation.operatorId !== reservation.operatorId ||
    observation.snapshot.mintUrl !== reservation.mintUrl ||
    observation.unit !== reservation.unit
  ) {
    throw new CashuProofStateRepositoryError(
      "reservation_scope_mismatch",
      "Cashu proof-state observation does not match its reservation scope.",
    );
  }
  if (observation.snapshot.observedAt < reservation.reservedAt) {
    throw new CashuProofStateRepositoryError(
      "observation_before_reservation",
      "Cashu proof-state observation cannot predate its reservation.",
    );
  }
  if (
    !equalProofYs(
      observation.snapshot.states.map((state) => state.y),
      reservation.proofYs,
    )
  ) {
    throw new CashuProofStateRepositoryError(
      "proof_set_mismatch",
      "Cashu proof-state observation does not contain its exact reserved proof set.",
    );
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
    throw new Error("Cashu proof-state unit is invalid.");
  }
  return value;
}

function equalProofYs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createObservationFingerprint(observation: ValidatedObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mintUrl: observation.snapshot.mintUrl,
        observedAt: observation.snapshot.observedAt,
        operatorId: observation.operatorId,
        paymentId: observation.paymentId,
        schemaVersion: observation.snapshot.schemaVersion,
        states: observation.snapshot.states,
        unit: observation.unit,
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
  throw new CashuProofStateRepositoryError(
    "invalid_input",
    "Cashu proof-state repository input is invalid.",
  );
}

function failInvalidRecord(): never {
  throw new CashuProofStateRepositoryError(
    "invalid_record",
    "Stored Cashu proof-state observation is invalid.",
  );
}

function mapStorageError(error: unknown): CashuProofStateRepositoryError {
  if (error instanceof CashuProofStateRepositoryError) {
    return error;
  }
  const databaseError = error as PostgresErrorShape;
  if (
    databaseError.code === "23505" &&
    databaseError.constraint === "cashu_proof_state_observations_payment_time_unique"
  ) {
    return new CashuProofStateRepositoryError(
      "observation_conflict",
      "A different Cashu proof-state observation already exists at this time.",
    );
  }
  return new CashuProofStateRepositoryError(
    "storage_unavailable",
    "Cashu proof-state storage operation failed.",
  );
}
