import { type PaymentId, paymentId, type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { cashuOperatorEffectId } from "./cashu-proof-reservation-lifecycle-repository";
import {
  CASHU_STELLAR_MELT_RECOVERY_ATTENTION_REASONS,
  CASHU_STELLAR_MELT_RECOVERY_INITIAL_DELAY_SECONDS,
  CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION,
  CASHU_STELLAR_MELT_RECOVERY_RETRY_REASONS,
  type CashuStellarMeltRecoveryAttemptV1,
  type CashuStellarMeltRecoveryAttentionReason,
  type CashuStellarMeltRecoveryJobRepository,
  CashuStellarMeltRecoveryJobRepositoryError,
  type CashuStellarMeltRecoveryJobV1,
  type CashuStellarMeltRecoveryLeaseOutcomeV1,
  type CashuStellarMeltRecoveryLeaseV1,
  type CashuStellarMeltRecoveryRetryReason,
  type ClaimCashuStellarMeltRecoveryJobInput,
  cashuStellarMeltRecoveryLeaseToken,
  type RecordCashuStellarMeltRecoveryOutcomeInput,
  type RecordCashuStellarMeltRecoveryOutcomeResult,
} from "./cashu-stellar-melt-recovery-job-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface JobRow extends QueryResultRow {
  readonly effect_id: string;
  readonly effect_kind: string;
  readonly effect_started_at: string;
  readonly initial_attempt_at: string;
  readonly lifecycle_recorded_at: string | null;
  readonly lifecycle_state: string | null;
  readonly payment_id: string;
  readonly schema_version: number;
}

interface AttemptRow extends QueryResultRow {
  readonly attempt_number: number;
  readonly claimed_at: string;
  readonly expires_at: string;
  readonly lease_token: string;
  readonly next_attempt_at: string | null;
  readonly outcome_kind: string | null;
  readonly outcome_recorded_at: string | null;
  readonly reason: string | null;
  readonly schema_version: number;
  readonly worker_id: string;
}

interface LeaseRow extends QueryResultRow {
  readonly attempt_number: number;
  readonly claimed_at: string;
  readonly expires_at: string;
  readonly lease_token: string;
  readonly payment_id: string;
  readonly schema_version: number;
  readonly worker_id: string;
}

interface CandidateRow extends QueryResultRow {
  readonly payment_id: string;
}

interface EligibilityRow extends QueryResultRow {
  readonly attempt_number: number;
  readonly is_eligible: boolean;
}

interface CurrentLeaseRow extends QueryResultRow {
  readonly lease_token: string;
}

interface StoredOutcomeRow extends QueryResultRow {
  readonly lease_payment_id: string;
  readonly lease_token: string;
  readonly next_attempt_at: string | null;
  readonly outcome_kind: string | null;
  readonly payment_id: string | null;
  readonly reason: string | null;
  readonly recorded_at: string | null;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

interface ValidatedOutcome {
  readonly kind: "accepted" | "attention_required" | "released" | "retry_scheduled";
  readonly leaseToken: ReturnType<typeof cashuStellarMeltRecoveryLeaseToken>;
  readonly nextAttemptAt?: UnixTimestamp;
  readonly paymentId: PaymentId;
  readonly reason?: string;
  readonly recordedAt: UnixTimestamp;
}

const JOB_SELECT = `
  SELECT
    job.payment_id,
    job.effect_id,
    job.schema_version,
    job.initial_attempt_at,
    effect.effect_kind,
    effect.started_at AS effect_started_at,
    lifecycle.state AS lifecycle_state,
    lifecycle.recorded_at AS lifecycle_recorded_at
  FROM cashu_stellar_melt_recovery_jobs AS job
  JOIN cashu_operator_effects AS effect
    ON effect.effect_id = job.effect_id
    AND effect.payment_id = job.payment_id
  LEFT JOIN LATERAL (
    SELECT event.state, event.recorded_at
    FROM cashu_proof_reservation_events AS event
    WHERE event.payment_id = job.payment_id
    ORDER BY event.sequence DESC
    LIMIT 1
  ) AS lifecycle ON TRUE
`;

const ATTEMPT_SELECT = `
  SELECT
    lease.lease_token,
    lease.attempt_number,
    lease.worker_id,
    lease.schema_version,
    lease.claimed_at,
    lease.expires_at,
    outcome.outcome_kind,
    outcome.reason,
    outcome.recorded_at AS outcome_recorded_at,
    outcome.next_attempt_at
  FROM cashu_stellar_melt_recovery_leases AS lease
  LEFT JOIN cashu_stellar_melt_recovery_outcomes AS outcome
    ON outcome.lease_token = lease.lease_token
    AND outcome.payment_id = lease.payment_id
`;

const MAX_UNIX_TIMESTAMP = 9_007_199_254_740_991;
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface PostgresCashuStellarMeltRecoveryJobRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresCashuStellarMeltRecoveryJobRepository
  implements CashuStellarMeltRecoveryJobRepository
{
  private constructor(private readonly pool: Pool) {}

  static async connect(
    options: PostgresCashuStellarMeltRecoveryJobRepositoryOptions,
  ): Promise<PostgresCashuStellarMeltRecoveryJobRepository> {
    if (options.connectionString.trim() === "") {
      throw storageUnavailable();
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw storageUnavailable();
    }
    const pool = new Pool({
      application_name: "cashmesh-stellar-melt-recovery-jobs",
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
    const repository = new PostgresCashuStellarMeltRecoveryJobRepository(pool);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      throw mapStorageError(error);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async claimNext(
    input: ClaimCashuStellarMeltRecoveryJobInput,
  ): Promise<CashuStellarMeltRecoveryLeaseV1 | undefined> {
    try {
      const claim = validateClaim(input);
      return await this.withTransaction(async (client) => {
        const candidate = await client.query<CandidateRow>(
          `
            SELECT job.payment_id
            FROM cashu_stellar_melt_recovery_jobs AS job
            LEFT JOIN LATERAL (
              SELECT lease.lease_token, lease.attempt_number, lease.expires_at
              FROM cashu_stellar_melt_recovery_leases AS lease
              WHERE lease.payment_id = job.payment_id
              ORDER BY lease.attempt_number DESC
              LIMIT 1
            ) AS latest_lease ON TRUE
            LEFT JOIN cashu_stellar_melt_recovery_outcomes AS latest_outcome
              ON latest_outcome.lease_token = latest_lease.lease_token
            LEFT JOIN LATERAL (
              SELECT event.state
              FROM cashu_proof_reservation_events AS event
              WHERE event.payment_id = job.payment_id
              ORDER BY event.sequence DESC
              LIMIT 1
            ) AS lifecycle ON TRUE
            WHERE lifecycle.state IN ('dispatch_started', 'pending', 'needs_attention')
              AND (
                (latest_lease.lease_token IS NULL AND job.initial_attempt_at <= $1)
                OR (
                  latest_lease.lease_token IS NOT NULL
                  AND latest_outcome.lease_token IS NULL
                  AND latest_lease.expires_at <= $1
                )
                OR (
                  latest_outcome.outcome_kind = 'retry_scheduled'
                  AND latest_outcome.next_attempt_at <= $1
                )
              )
            ORDER BY
              CASE
                WHEN latest_lease.lease_token IS NULL THEN job.initial_attempt_at
                WHEN latest_outcome.lease_token IS NULL THEN latest_lease.expires_at
                ELSE latest_outcome.next_attempt_at
              END,
              job.payment_id
            FOR UPDATE OF job SKIP LOCKED
            LIMIT 1
          `,
          [claim.claimedAt],
        );
        const selected = candidate.rows[0];
        if (selected === undefined) {
          return undefined;
        }

        const eligibility = await client.query<EligibilityRow>(
          `
            SELECT
              COALESCE(latest_lease.attempt_number, 0) + 1 AS attempt_number,
              lifecycle.state IN ('dispatch_started', 'pending', 'needs_attention')
                AND (
                  (latest_lease.lease_token IS NULL AND job.initial_attempt_at <= $2)
                  OR (
                    latest_lease.lease_token IS NOT NULL
                    AND latest_outcome.lease_token IS NULL
                    AND latest_lease.expires_at <= $2
                  )
                  OR (
                    latest_outcome.outcome_kind = 'retry_scheduled'
                    AND latest_outcome.next_attempt_at <= $2
                  )
                ) AS is_eligible
            FROM cashu_stellar_melt_recovery_jobs AS job
            LEFT JOIN LATERAL (
              SELECT lease.lease_token, lease.attempt_number, lease.expires_at
              FROM cashu_stellar_melt_recovery_leases AS lease
              WHERE lease.payment_id = job.payment_id
              ORDER BY lease.attempt_number DESC
              LIMIT 1
            ) AS latest_lease ON TRUE
            LEFT JOIN cashu_stellar_melt_recovery_outcomes AS latest_outcome
              ON latest_outcome.lease_token = latest_lease.lease_token
            LEFT JOIN LATERAL (
              SELECT event.state
              FROM cashu_proof_reservation_events AS event
              WHERE event.payment_id = job.payment_id
              ORDER BY event.sequence DESC
              LIMIT 1
            ) AS lifecycle ON TRUE
            WHERE job.payment_id = $1
          `,
          [selected.payment_id, claim.claimedAt],
        );
        const current = eligibility.rows[0];
        if (
          current === undefined ||
          !current.is_eligible ||
          !Number.isSafeInteger(current.attempt_number) ||
          current.attempt_number < 1
        ) {
          return undefined;
        }

        const result = await client.query<LeaseRow>(
          `
            INSERT INTO cashu_stellar_melt_recovery_leases (
              lease_token,
              payment_id,
              attempt_number,
              worker_id,
              schema_version,
              claimed_at,
              expires_at
            )
            VALUES ($1, $2, $3, $4, 1, $5, $6)
            RETURNING
              lease_token,
              payment_id,
              attempt_number,
              worker_id,
              schema_version,
              claimed_at,
              expires_at
          `,
          [
            claim.leaseToken,
            selected.payment_id,
            current.attempt_number,
            claim.workerId,
            claim.claimedAt,
            claim.expiresAt,
          ],
        );
        const row = result.rows[0];
        return row === undefined ? undefined : mapLease(row);
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByPaymentId(
    requestedPaymentId: PaymentId,
  ): Promise<CashuStellarMeltRecoveryJobV1 | undefined> {
    try {
      const validatedPaymentId = validatePaymentId(requestedPaymentId);
      return await this.withReadSnapshot(async (client) =>
        this.findJob(client, validatedPaymentId),
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async recordOutcome(
    input: RecordCashuStellarMeltRecoveryOutcomeInput,
  ): Promise<RecordCashuStellarMeltRecoveryOutcomeResult> {
    try {
      const outcome = validateOutcome(input);
      return await this.withTransaction(async (client) => {
        const jobLock = await client.query(
          `
            SELECT payment_id
            FROM cashu_stellar_melt_recovery_jobs
            WHERE payment_id = $1
            FOR UPDATE
          `,
          [outcome.paymentId],
        );
        if (jobLock.rowCount !== 1) {
          throw leaseLost();
        }
        const currentLease = await client.query<CurrentLeaseRow>(
          `
            SELECT lease_token
            FROM cashu_stellar_melt_recovery_leases
            WHERE payment_id = $1
            ORDER BY attempt_number DESC
            LIMIT 1
          `,
          [outcome.paymentId],
        );
        if (currentLease.rows[0]?.lease_token !== outcome.leaseToken) {
          throw leaseLost();
        }
        const existing = await this.findStoredOutcome(client, outcome.leaseToken);
        if (existing?.outcome_kind !== null && existing !== undefined) {
          assertStoredOutcome(existing, outcome);
          const job = await this.requireJob(client, outcome.paymentId);
          return Object.freeze({ job, replayed: true });
        }
        if (existing === undefined || existing.lease_payment_id !== outcome.paymentId) {
          throw leaseLost();
        }

        const inserted = await client.query(
          `
            INSERT INTO cashu_stellar_melt_recovery_outcomes (
              lease_token,
              payment_id,
              outcome_kind,
              reason,
              recorded_at,
              next_attempt_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING
            RETURNING lease_token
          `,
          [
            outcome.leaseToken,
            outcome.paymentId,
            outcome.kind,
            outcome.reason ?? null,
            outcome.recordedAt,
            outcome.nextAttemptAt ?? null,
          ],
        );
        if (inserted.rowCount === 0) {
          const concurrent = await this.findStoredOutcome(client, outcome.leaseToken);
          if (concurrent === undefined || concurrent.outcome_kind === null) {
            throw invalidRecord();
          }
          assertStoredOutcome(concurrent, outcome);
        }
        const job = await this.requireJob(client, outcome.paymentId);
        return Object.freeze({ job, replayed: inserted.rowCount === 0 });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
  }

  private async findJob(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<CashuStellarMeltRecoveryJobV1 | undefined> {
    const result = await client.query<JobRow>(`${JOB_SELECT} WHERE job.payment_id = $1`, [
      requestedPaymentId,
    ]);
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    const attempts = await client.query<AttemptRow>(
      `${ATTEMPT_SELECT} WHERE lease.payment_id = $1 ORDER BY lease.attempt_number`,
      [requestedPaymentId],
    );
    return mapJob(row, attempts.rows);
  }

  private async requireJob(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<CashuStellarMeltRecoveryJobV1> {
    const job = await this.findJob(client, requestedPaymentId);
    if (job === undefined) {
      throw invalidRecord();
    }
    return job;
  }

  private async findStoredOutcome(
    client: PoolClient,
    leaseToken: ReturnType<typeof cashuStellarMeltRecoveryLeaseToken>,
  ): Promise<StoredOutcomeRow | undefined> {
    const result = await client.query<StoredOutcomeRow>(
      `
        SELECT
          lease.lease_token,
          lease.payment_id AS lease_payment_id,
          outcome.payment_id,
          outcome.outcome_kind,
          outcome.reason,
          outcome.recorded_at,
          outcome.next_attempt_at
        FROM cashu_stellar_melt_recovery_leases AS lease
        LEFT JOIN cashu_stellar_melt_recovery_outcomes AS outcome
          ON outcome.lease_token = lease.lease_token
          AND outcome.payment_id = lease.payment_id
        WHERE lease.lease_token = $1
      `,
      [leaseToken],
    );
    return result.rows[0];
  }

  private async withTransaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async withReadSnapshot<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function validateClaim(input: ClaimCashuStellarMeltRecoveryJobInput): {
  readonly claimedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly leaseToken: ReturnType<typeof cashuStellarMeltRecoveryLeaseToken>;
  readonly workerId: string;
} {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      typeof input.workerId !== "string" ||
      !INTERNAL_ID_PATTERN.test(input.workerId)
    ) {
      throw invalidInput();
    }
    const claimedAt = unixTimestamp(input.claimedAt);
    const expiresAt = unixTimestamp(input.expiresAt);
    if (expiresAt <= claimedAt || expiresAt - claimedAt > 300) {
      throw invalidInput();
    }
    return Object.freeze({
      claimedAt,
      expiresAt,
      leaseToken: cashuStellarMeltRecoveryLeaseToken(input.leaseToken),
      workerId: input.workerId,
    });
  } catch (error) {
    if (error instanceof CashuStellarMeltRecoveryJobRepositoryError) {
      throw error;
    }
    throw invalidInput();
  }
}

function validateOutcome(input: RecordCashuStellarMeltRecoveryOutcomeInput): ValidatedOutcome {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw invalidInput();
    }
    const base = {
      kind: input.kind,
      leaseToken: cashuStellarMeltRecoveryLeaseToken(input.leaseToken),
      paymentId: paymentId(input.paymentId),
      recordedAt: unixTimestamp(input.recordedAt),
    };
    if (input.kind === "accepted" || input.kind === "released") {
      return Object.freeze(base);
    }
    if (input.kind === "retry_scheduled") {
      if (!CASHU_STELLAR_MELT_RECOVERY_RETRY_REASONS.includes(input.reason)) {
        throw invalidInput();
      }
      const nextAttemptAt = unixTimestamp(input.nextAttemptAt);
      if (nextAttemptAt <= base.recordedAt) {
        throw invalidInput();
      }
      return Object.freeze({ ...base, nextAttemptAt, reason: input.reason });
    }
    if (
      input.kind !== "attention_required" ||
      !CASHU_STELLAR_MELT_RECOVERY_ATTENTION_REASONS.includes(input.reason)
    ) {
      throw invalidInput();
    }
    return Object.freeze({ ...base, reason: input.reason });
  } catch (error) {
    if (error instanceof CashuStellarMeltRecoveryJobRepositoryError) {
      throw error;
    }
    throw invalidInput();
  }
}

function validatePaymentId(value: PaymentId): PaymentId {
  try {
    return paymentId(value);
  } catch {
    throw invalidInput();
  }
}

function mapJob(row: JobRow, attemptRows: readonly AttemptRow[]): CashuStellarMeltRecoveryJobV1 {
  try {
    const requestedPaymentId = paymentId(row.payment_id);
    const effectId = cashuOperatorEffectId(row.effect_id);
    const effectStartedAt = unixTimestamp(parseSafeInteger(row.effect_started_at));
    const initialAttemptAt = unixTimestamp(parseSafeInteger(row.initial_attempt_at));
    if (
      row.schema_version !== CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION ||
      row.effect_kind !== "melt" ||
      initialAttemptAt !==
        Math.min(
          MAX_UNIX_TIMESTAMP,
          effectStartedAt + CASHU_STELLAR_MELT_RECOVERY_INITIAL_DELAY_SECONDS,
        ) ||
      row.lifecycle_state === null ||
      row.lifecycle_recorded_at === null
    ) {
      throw invalidRecord();
    }
    const attempts = mapAttempts(requestedPaymentId, initialAttemptAt, attemptRows);
    const base = Object.freeze({
      attempts,
      effectId,
      initialAttemptAt,
      paymentId: requestedPaymentId,
      schemaVersion: CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION,
    });
    if (row.lifecycle_state === "consumed" || row.lifecycle_state === "released") {
      const terminalState = row.lifecycle_state === "consumed" ? "accepted" : "released";
      const latestOutcome = attempts.at(-1)?.outcome;
      if (
        latestOutcome !== undefined &&
        (latestOutcome.kind === "accepted" || latestOutcome.kind === "released") &&
        latestOutcome.kind !== terminalState
      ) {
        throw invalidRecord();
      }
      return Object.freeze({
        ...base,
        completedAt: unixTimestamp(parseSafeInteger(row.lifecycle_recorded_at)),
        state: "completed",
        terminalState,
      });
    }
    if (!isActiveLifecycleState(row.lifecycle_state)) {
      throw invalidRecord();
    }
    const latest = attempts.at(-1);
    if (latest === undefined) {
      return Object.freeze({ ...base, nextAttemptAt: initialAttemptAt, state: "scheduled" });
    }
    if (latest.outcome === undefined) {
      return Object.freeze({ ...base, lease: latest.lease, state: "leased" });
    }
    if (latest.outcome.kind === "retry_scheduled") {
      return Object.freeze({
        ...base,
        nextAttemptAt: latest.outcome.nextAttemptAt,
        state: "scheduled",
      });
    }
    if (latest.outcome.kind === "attention_required") {
      return Object.freeze({ ...base, outcome: latest.outcome, state: "attention_required" });
    }
    throw invalidRecord();
  } catch (error) {
    if (error instanceof CashuStellarMeltRecoveryJobRepositoryError) {
      throw error;
    }
    throw invalidRecord();
  }
}

function mapAttempts(
  requestedPaymentId: PaymentId,
  initialAttemptAt: UnixTimestamp,
  rows: readonly AttemptRow[],
): readonly CashuStellarMeltRecoveryAttemptV1[] {
  const attempts: CashuStellarMeltRecoveryAttemptV1[] = [];
  let eligibleAt = initialAttemptAt;
  for (const [position, row] of rows.entries()) {
    const lease = mapLease({ ...row, payment_id: requestedPaymentId });
    if (lease.attemptNumber !== position + 1 || lease.claimedAt < eligibleAt) {
      throw invalidRecord();
    }
    const outcome = mapOutcome(row);
    if (outcome === undefined) {
      eligibleAt = lease.expiresAt;
    } else if (outcome.recordedAt < lease.claimedAt || outcome.recordedAt > lease.expiresAt) {
      throw invalidRecord();
    } else if (outcome.kind === "retry_scheduled") {
      eligibleAt = outcome.nextAttemptAt;
    } else if (position !== rows.length - 1) {
      throw invalidRecord();
    }
    attempts.push(Object.freeze({ lease, ...(outcome !== undefined && { outcome }) }));
  }
  return Object.freeze(attempts);
}

function mapLease(row: LeaseRow): CashuStellarMeltRecoveryLeaseV1 {
  const claimedAt = unixTimestamp(parseSafeInteger(row.claimed_at));
  const expiresAt = unixTimestamp(parseSafeInteger(row.expires_at));
  if (
    row.schema_version !== CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION ||
    !Number.isSafeInteger(row.attempt_number) ||
    row.attempt_number < 1 ||
    row.attempt_number > 1024 ||
    !INTERNAL_ID_PATTERN.test(row.worker_id) ||
    expiresAt <= claimedAt ||
    expiresAt - claimedAt > 300
  ) {
    throw invalidRecord();
  }
  return Object.freeze({
    attemptNumber: row.attempt_number,
    claimedAt,
    expiresAt,
    leaseToken: cashuStellarMeltRecoveryLeaseToken(row.lease_token),
    paymentId: paymentId(row.payment_id),
    schemaVersion: CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION,
    workerId: row.worker_id,
  });
}

function mapOutcome(row: AttemptRow): CashuStellarMeltRecoveryLeaseOutcomeV1 | undefined {
  if (row.outcome_kind === null) {
    if (row.reason !== null || row.outcome_recorded_at !== null || row.next_attempt_at !== null) {
      throw invalidRecord();
    }
    return undefined;
  }
  if (row.outcome_recorded_at === null) {
    throw invalidRecord();
  }
  const recordedAt = unixTimestamp(parseSafeInteger(row.outcome_recorded_at));
  if (row.outcome_kind === "accepted" || row.outcome_kind === "released") {
    if (row.reason !== null || row.next_attempt_at !== null) {
      throw invalidRecord();
    }
    return Object.freeze({ kind: row.outcome_kind, recordedAt });
  }
  if (row.outcome_kind === "retry_scheduled") {
    if (row.reason === null || !isRetryReason(row.reason) || row.next_attempt_at === null) {
      throw invalidRecord();
    }
    const nextAttemptAt = unixTimestamp(parseSafeInteger(row.next_attempt_at));
    if (nextAttemptAt <= recordedAt) {
      throw invalidRecord();
    }
    return Object.freeze({ kind: row.outcome_kind, nextAttemptAt, reason: row.reason, recordedAt });
  }
  if (
    row.outcome_kind !== "attention_required" ||
    row.reason === null ||
    !isAttentionReason(row.reason) ||
    row.next_attempt_at !== null
  ) {
    throw invalidRecord();
  }
  return Object.freeze({ kind: row.outcome_kind, reason: row.reason, recordedAt });
}

function assertStoredOutcome(row: StoredOutcomeRow, expected: ValidatedOutcome): void {
  if (
    row.lease_payment_id !== expected.paymentId ||
    row.payment_id !== expected.paymentId ||
    row.outcome_kind !== expected.kind ||
    row.reason !== (expected.reason ?? null) ||
    row.recorded_at === null ||
    parseSafeInteger(row.recorded_at) !== expected.recordedAt ||
    (row.next_attempt_at === null ? undefined : parseSafeInteger(row.next_attempt_at)) !==
      expected.nextAttemptAt
  ) {
    throw new CashuStellarMeltRecoveryJobRepositoryError(
      "lease_conflict",
      "Cashu Stellar melt recovery lease already has a different outcome.",
    );
  }
}

function isActiveLifecycleState(value: string): boolean {
  return value === "dispatch_started" || value === "pending" || value === "needs_attention";
}

function isRetryReason(value: string): value is CashuStellarMeltRecoveryRetryReason {
  return (CASHU_STELLAR_MELT_RECOVERY_RETRY_REASONS as readonly string[]).includes(value);
}

function isAttentionReason(value: string): value is CashuStellarMeltRecoveryAttentionReason {
  return (CASHU_STELLAR_MELT_RECOVERY_ATTENTION_REASONS as readonly string[]).includes(value);
}

function parseSafeInteger(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalidRecord();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidRecord();
  }
  return parsed;
}

function mapStorageError(error: unknown): CashuStellarMeltRecoveryJobRepositoryError {
  if (error instanceof CashuStellarMeltRecoveryJobRepositoryError) {
    return error;
  }
  const postgres = postgresError(error);
  if (postgres?.code === "55000") {
    return leaseLost();
  }
  if (postgres?.code === "23505") {
    return new CashuStellarMeltRecoveryJobRepositoryError(
      "lease_conflict",
      "Cashu Stellar melt recovery lease identity conflicts with stored history.",
    );
  }
  if (postgres?.code === "23514" || postgres?.code === "22003") {
    return invalidRecord();
  }
  return storageUnavailable();
}

function postgresError(error: unknown): PostgresErrorShape | undefined {
  return typeof error === "object" && error !== null ? (error as PostgresErrorShape) : undefined;
}

function invalidInput(): CashuStellarMeltRecoveryJobRepositoryError {
  return new CashuStellarMeltRecoveryJobRepositoryError(
    "invalid_input",
    "Cashu Stellar melt recovery job input is invalid.",
  );
}

function invalidRecord(): CashuStellarMeltRecoveryJobRepositoryError {
  return new CashuStellarMeltRecoveryJobRepositoryError(
    "invalid_record",
    "Cashu Stellar melt recovery job history is invalid.",
  );
}

function leaseLost(): CashuStellarMeltRecoveryJobRepositoryError {
  return new CashuStellarMeltRecoveryJobRepositoryError(
    "lease_lost",
    "Cashu Stellar melt recovery lease is no longer current.",
  );
}

function storageUnavailable(): CashuStellarMeltRecoveryJobRepositoryError {
  return new CashuStellarMeltRecoveryJobRepositoryError(
    "storage_unavailable",
    "PostgreSQL Cashu Stellar melt recovery job storage is unavailable.",
  );
}
