import { createHash } from "node:crypto";
import {
  CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION,
  CASHU_STELLAR_UNIT,
  type CashuStellarMeltQuoteRequestV1,
  type CashuStellarMeltQuoteState,
  type CashuStellarMeltQuoteV1,
  createCashuStellarMeltQuoteRequestV1,
  createCashuStellarMeltQuoteV1,
  MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import {
  invoiceId,
  type OperatorId,
  operatorId,
  type PaymentId,
  paymentId,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  type BeginCashuStellarMeltQuoteAttemptInput,
  CASHU_STELLAR_MELT_QUOTE_AMBIGUITY_REASONS,
  CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
  type CashuStellarMeltQuoteAmbiguityReason,
  type CashuStellarMeltQuoteAttemptId,
  type CashuStellarMeltQuoteAttemptResult,
  type CashuStellarMeltQuoteAttemptV1,
  type CashuStellarMeltQuoteRepository,
  CashuStellarMeltQuoteRepositoryError,
  cashuStellarMeltQuoteAttemptId,
  type ObserveCashuStellarMeltQuoteInput,
  type RecordAmbiguousCashuStellarMeltQuoteAttemptInput,
  type RecordCashuStellarMeltQuoteInput,
} from "./cashu-stellar-melt-quote-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface AttemptRow extends QueryResultRow {
  readonly amount: string;
  readonly attempt_fingerprint: string;
  readonly attempt_id: string;
  readonly invoice_id: string;
  readonly method: string;
  readonly mint_url: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly request: string;
  readonly schema_version: number;
  readonly started_at: string;
  readonly unit: string;
}

interface OutcomeRow extends QueryResultRow {
  readonly ambiguity_reason: string | null;
  readonly attempt_id: string;
  readonly expiry: string | null;
  readonly fee_reserve: string | null;
  readonly mint_url: string;
  readonly outcome_fingerprint: string;
  readonly outcome_kind: string;
  readonly payment_id: string;
  readonly quote_id: string | null;
  readonly recorded_at: string;
  readonly schema_version: number;
}

interface ObservationRow extends QueryResultRow {
  readonly attempt_id: string;
  readonly mint_url: string;
  readonly observed_at: string;
  readonly payment_id: string;
  readonly quote_id: string;
  readonly schema_version: number;
  readonly snapshot_fingerprint: string;
  readonly state: string;
}

interface ReservationContextRow extends QueryResultRow {
  readonly active_proof_count: string;
  readonly created_at: string;
  readonly custody_created_at: string | null;
  readonly effect_count: string;
  readonly event_count: string;
  readonly expires_at: string;
  readonly invoice_amount: string;
  readonly invoice_id: string;
  readonly invoice_state: string;
  readonly invoice_unit: string;
  readonly mint_url: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly reservation_schema_version: number;
  readonly reservation_unit: string;
  readonly reserved_at: string;
  readonly reserved_proof_count: string;
}

interface PreDispatchRow extends QueryResultRow {
  readonly has_custody: boolean;
  readonly has_effect: boolean;
  readonly has_event: boolean;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

interface ValidatedBegin {
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly paymentId: PaymentId;
  readonly request: CashuStellarMeltQuoteRequestV1;
  readonly startedAt: UnixTimestamp;
}

interface ValidatedAmbiguous {
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly paymentId: PaymentId;
  readonly reason: CashuStellarMeltQuoteAmbiguityReason;
  readonly recordedAt: UnixTimestamp;
}

interface ValidatedQuoteInput {
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly paymentId: PaymentId;
  readonly quote: CashuStellarMeltQuoteV1;
}

interface StoredAttemptBase {
  readonly attemptFingerprint: string;
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly invoiceId: ReturnType<typeof invoiceId>;
  readonly mintUrl: string;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly request: CashuStellarMeltQuoteRequestV1;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION;
  readonly startedAt: UnixTimestamp;
}

const ATTEMPT_SELECT = `
  SELECT
    attempt_id,
    attempt_fingerprint,
    payment_id,
    invoice_id,
    operator_id,
    mint_url,
    method,
    unit,
    amount,
    request,
    schema_version,
    started_at
  FROM cashu_stellar_melt_quote_attempts
`;

const OUTCOME_SELECT = `
  SELECT
    attempt_id,
    outcome_fingerprint,
    payment_id,
    mint_url,
    outcome_kind,
    ambiguity_reason,
    quote_id,
    fee_reserve,
    expiry,
    schema_version,
    recorded_at
  FROM cashu_stellar_melt_quote_outcomes
`;

const OBSERVATION_SELECT = `
  SELECT
    snapshot_fingerprint,
    attempt_id,
    payment_id,
    mint_url,
    quote_id,
    schema_version,
    observed_at,
    state
  FROM cashu_stellar_melt_quote_observations
`;

export interface PostgresCashuStellarMeltQuoteRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresCashuStellarMeltQuoteRepository implements CashuStellarMeltQuoteRepository {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    options: PostgresCashuStellarMeltQuoteRepositoryOptions,
  ): Promise<PostgresCashuStellarMeltQuoteRepository> {
    if (options.connectionString.trim() === "") {
      throw new CashuStellarMeltQuoteRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection string is required.",
      );
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw new CashuStellarMeltQuoteRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection pool size must be a positive integer.",
      );
    }
    const pool = new Pool({
      application_name: "cashmesh-stellar-melt-quotes",
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
    const repository = new PostgresCashuStellarMeltQuoteRepository(pool);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      if (error instanceof CashuStellarMeltQuoteRepositoryError) {
        throw error;
      }
      throw new CashuStellarMeltQuoteRepositoryError(
        "storage_unavailable",
        "PostgreSQL Cashu Stellar melt quote storage could not be initialized.",
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async begin(
    input: BeginCashuStellarMeltQuoteAttemptInput,
  ): Promise<CashuStellarMeltQuoteAttemptResult> {
    try {
      const validated = validateBegin(input);
      return await this.withTransaction(async (client) => {
        const context = await this.requireReservationContext(client, validated.paymentId);
        const attempt = createAttemptFromContext(validated, context);
        const existing = await this.findConflictingAttempts(
          client,
          attempt.attemptId,
          attempt.paymentId,
        );
        if (existing.length > 0) {
          return await this.replayBegin(client, existing, attempt.attemptFingerprint);
        }
        assertBeginPreconditions(attempt, context);

        const inserted = await client.query<AttemptRow>(
          `
            INSERT INTO cashu_stellar_melt_quote_attempts (
              attempt_id,
              attempt_fingerprint,
              payment_id,
              invoice_id,
              operator_id,
              mint_url,
              method,
              unit,
              amount,
              request,
              schema_version,
              started_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT DO NOTHING
            RETURNING
              attempt_id,
              attempt_fingerprint,
              payment_id,
              invoice_id,
              operator_id,
              mint_url,
              method,
              unit,
              amount,
              request,
              schema_version,
              started_at
          `,
          [
            attempt.attemptId,
            attempt.attemptFingerprint,
            attempt.paymentId,
            attempt.invoiceId,
            attempt.operatorId,
            attempt.mintUrl,
            attempt.request.method,
            attempt.request.unit,
            attempt.request.amount,
            attempt.request.request,
            attempt.schemaVersion,
            attempt.startedAt,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          const concurrent = await this.findConflictingAttempts(
            client,
            attempt.attemptId,
            attempt.paymentId,
          );
          return await this.replayBegin(client, concurrent, attempt.attemptFingerprint);
        }
        return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: false });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByPaymentId(
    requestedPaymentId: PaymentId,
  ): Promise<CashuStellarMeltQuoteAttemptV1 | undefined> {
    try {
      const validatedPaymentId = validatePaymentId(requestedPaymentId);
      return await this.withTransaction(async (client) => {
        const result = await client.query<AttemptRow>(
          `${ATTEMPT_SELECT} WHERE payment_id = $1 FOR SHARE`,
          [validatedPaymentId],
        );
        const row = result.rows[0];
        return row === undefined ? undefined : await this.mapAttempt(client, row);
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async recordAmbiguous(
    input: RecordAmbiguousCashuStellarMeltQuoteAttemptInput,
  ): Promise<CashuStellarMeltQuoteAttemptResult> {
    try {
      const validated = validateAmbiguous(input);
      return await this.withTransaction(async (client) => {
        await this.lockReservation(client, validated.paymentId);
        const row = await this.lockAttempt(client, validated.attemptId, validated.paymentId);
        const attempt = mapAttemptBase(row);
        if (validated.recordedAt < attempt.startedAt) {
          return failInvalidInput();
        }
        const fingerprint = createAmbiguousOutcomeFingerprint(attempt, validated);
        const existing = await this.findOutcome(client, attempt.attemptId);
        if (existing !== undefined) {
          if (existing.outcome_kind !== "ambiguous") {
            return failInvalidTransition();
          }
          if (existing.outcome_fingerprint !== fingerprint) {
            throw new CashuStellarMeltQuoteRepositoryError(
              "quote_conflict",
              "Cashu Stellar melt quote attempt already has a different outcome.",
            );
          }
          return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: true });
        }

        await this.assertOutcomeWritable(client, attempt.paymentId);

        await client.query(
          `
            INSERT INTO cashu_stellar_melt_quote_outcomes (
              attempt_id,
              outcome_fingerprint,
              payment_id,
              mint_url,
              outcome_kind,
              ambiguity_reason,
              quote_id,
              fee_reserve,
              expiry,
              schema_version,
              recorded_at
            )
            VALUES ($1, $2, $3, $4, 'ambiguous', $5, NULL, NULL, NULL, $6, $7)
          `,
          [
            attempt.attemptId,
            fingerprint,
            attempt.paymentId,
            attempt.mintUrl,
            validated.reason,
            attempt.schemaVersion,
            validated.recordedAt,
          ],
        );
        return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: false });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async recordQuote(
    input: RecordCashuStellarMeltQuoteInput,
  ): Promise<CashuStellarMeltQuoteAttemptResult> {
    try {
      const validated = validateQuoteInput(input);
      return await this.withTransaction(async (client) => {
        await this.lockReservation(client, validated.paymentId);
        const row = await this.lockAttempt(client, validated.attemptId, validated.paymentId);
        const attempt = mapAttemptBase(row);
        assertInitialQuote(attempt, validated.quote);
        const outcomeFingerprint = createQuotedOutcomeFingerprint(attempt, validated.quote);
        const observationFingerprint = createObservationFingerprint(attempt, validated.quote);
        const existing = await this.findOutcome(client, attempt.attemptId);
        if (existing !== undefined) {
          if (existing.outcome_kind !== "quoted") {
            return failInvalidTransition();
          }
          const initialObservation = await this.findObservation(
            client,
            attempt.attemptId,
            validated.quote.observedAt,
          );
          if (
            existing.outcome_fingerprint !== outcomeFingerprint ||
            initialObservation?.snapshot_fingerprint !== observationFingerprint
          ) {
            throw new CashuStellarMeltQuoteRepositoryError(
              "quote_conflict",
              "Cashu Stellar melt quote attempt already has different quote terms.",
            );
          }
          return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: true });
        }

        await this.assertOutcomeWritable(client, attempt.paymentId);

        await client.query(
          `
            INSERT INTO cashu_stellar_melt_quote_outcomes (
              attempt_id,
              outcome_fingerprint,
              payment_id,
              mint_url,
              outcome_kind,
              ambiguity_reason,
              quote_id,
              fee_reserve,
              expiry,
              schema_version,
              recorded_at
            )
            VALUES ($1, $2, $3, $4, 'quoted', NULL, $5, $6, $7, $8, $9)
          `,
          [
            attempt.attemptId,
            outcomeFingerprint,
            attempt.paymentId,
            attempt.mintUrl,
            validated.quote.quoteId,
            validated.quote.feeReserve,
            validated.quote.expiry,
            attempt.schemaVersion,
            validated.quote.observedAt,
          ],
        );
        await this.insertObservation(client, attempt, validated.quote, observationFingerprint);
        return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: false });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async observe(
    input: ObserveCashuStellarMeltQuoteInput,
  ): Promise<CashuStellarMeltQuoteAttemptResult> {
    try {
      const validated = validateQuoteInput(input);
      return await this.withTransaction(async (client) => {
        const row = await this.lockAttempt(client, validated.attemptId, validated.paymentId);
        const attempt = mapAttemptBase(row);
        const outcome = await this.findOutcome(client, attempt.attemptId);
        if (outcome === undefined || outcome.outcome_kind !== "quoted") {
          return failInvalidTransition();
        }
        assertObservedQuote(attempt, outcome, validated.quote);
        const fingerprint = createObservationFingerprint(attempt, validated.quote);
        const existing = await this.findObservation(
          client,
          attempt.attemptId,
          validated.quote.observedAt,
        );
        if (existing !== undefined) {
          if (existing.snapshot_fingerprint !== fingerprint) {
            throw new CashuStellarMeltQuoteRepositoryError(
              "observation_conflict",
              "Cashu Stellar melt quote observation time already has different evidence.",
            );
          }
          return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: true });
        }

        const latest = await this.findLatestObservation(client, attempt.attemptId);
        if (
          latest === undefined ||
          validated.quote.observedAt <= parseSafeInteger(latest.observed_at) ||
          (latest.state === "PAID" && validated.quote.state !== "PAID")
        ) {
          return failInvalidTransition();
        }
        await this.insertObservation(client, attempt, validated.quote, fingerprint);
        return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: false });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private async requireReservationContext(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<ReservationContextRow> {
    const result = await client.query<ReservationContextRow>(
      `
        SELECT
          reservation.payment_id,
          reservation.invoice_id,
          reservation.operator_id,
          reservation.mint_url,
          reservation.unit AS reservation_unit,
          reservation.schema_version AS reservation_schema_version,
          reservation.reserved_at,
          invoice.unit AS invoice_unit,
          invoice.amount AS invoice_amount,
          invoice.created_at,
          invoice.expires_at,
          invoice.state AS invoice_state,
          custody.created_at AS custody_created_at,
          (SELECT COUNT(*) FROM cashu_reserved_proofs WHERE payment_id = $1)
            AS reserved_proof_count,
          (SELECT COUNT(*) FROM cashu_active_proof_claims WHERE payment_id = $1)
            AS active_proof_count,
          (SELECT COUNT(*) FROM cashu_operator_effects WHERE payment_id = $1)
            AS effect_count,
          (SELECT COUNT(*) FROM cashu_proof_reservation_events WHERE payment_id = $1)
            AS event_count
        FROM cashu_proof_reservations AS reservation
        JOIN merchant_invoices AS invoice ON invoice.id = reservation.invoice_id
        LEFT JOIN cashu_bearer_proof_custody AS custody
          ON custody.payment_id = reservation.payment_id
        WHERE reservation.payment_id = $1
        FOR UPDATE OF reservation, invoice
      `,
      [requestedPaymentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CashuStellarMeltQuoteRepositoryError(
        "reservation_not_found",
        "Cashu Stellar melt quote attempt requires a proof reservation.",
      );
    }
    return row;
  }

  private async findConflictingAttempts(
    client: PoolClient,
    attemptId: CashuStellarMeltQuoteAttemptId,
    requestedPaymentId: PaymentId,
  ): Promise<readonly AttemptRow[]> {
    const result = await client.query<AttemptRow>(
      `${ATTEMPT_SELECT} WHERE attempt_id = $1 OR payment_id = $2 FOR UPDATE`,
      [attemptId, requestedPaymentId],
    );
    return result.rows;
  }

  private async replayBegin(
    client: PoolClient,
    rows: readonly AttemptRow[],
    expectedFingerprint: string,
  ): Promise<CashuStellarMeltQuoteAttemptResult> {
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined || row.attempt_fingerprint !== expectedFingerprint) {
      throw new CashuStellarMeltQuoteRepositoryError(
        "attempt_conflict",
        "Cashu Stellar melt quote attempt identity is already bound to different terms.",
      );
    }
    return Object.freeze({ attempt: await this.mapAttempt(client, row), replayed: true });
  }

  private async lockAttempt(
    client: PoolClient,
    attemptId: CashuStellarMeltQuoteAttemptId,
    requestedPaymentId: PaymentId,
  ): Promise<AttemptRow> {
    const result = await client.query<AttemptRow>(
      `${ATTEMPT_SELECT} WHERE attempt_id = $1 OR payment_id = $2 FOR UPDATE`,
      [attemptId, requestedPaymentId],
    );
    const row = result.rows.length === 1 ? result.rows[0] : undefined;
    if (row === undefined) {
      if (result.rows.length === 0) {
        throw new CashuStellarMeltQuoteRepositoryError(
          "attempt_not_found",
          "Cashu Stellar melt quote attempt was not found.",
        );
      }
      throw new CashuStellarMeltQuoteRepositoryError(
        "attempt_conflict",
        "Cashu Stellar melt quote attempt does not match its payment.",
      );
    }
    if (row.attempt_id !== attemptId || row.payment_id !== requestedPaymentId) {
      throw new CashuStellarMeltQuoteRepositoryError(
        "attempt_conflict",
        "Cashu Stellar melt quote attempt does not match its payment.",
      );
    }
    return row;
  }

  private async lockReservation(client: PoolClient, requestedPaymentId: PaymentId): Promise<void> {
    const result = await client.query(
      "SELECT payment_id FROM cashu_proof_reservations WHERE payment_id = $1 FOR UPDATE",
      [requestedPaymentId],
    );
    if (result.rowCount !== 1) {
      throw new CashuStellarMeltQuoteRepositoryError(
        "reservation_not_found",
        "Cashu Stellar melt quote attempt requires its proof reservation.",
      );
    }
  }

  private async assertOutcomeWritable(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<void> {
    const result = await client.query<PreDispatchRow>(
      `
        SELECT
          EXISTS (
            SELECT 1 FROM cashu_bearer_proof_custody WHERE payment_id = $1
          ) AS has_custody,
          EXISTS (
            SELECT 1 FROM cashu_operator_effects WHERE payment_id = $1
          ) AS has_effect,
          EXISTS (
            SELECT 1 FROM cashu_proof_reservation_events WHERE payment_id = $1
          ) AS has_event
      `,
      [requestedPaymentId],
    );
    const row = result.rows[0];
    if (row === undefined || !row.has_custody || row.has_effect || row.has_event) {
      failInvalidTransition();
    }
  }

  private async findOutcome(
    client: PoolClient,
    attemptId: CashuStellarMeltQuoteAttemptId,
  ): Promise<OutcomeRow | undefined> {
    const result = await client.query<OutcomeRow>(`${OUTCOME_SELECT} WHERE attempt_id = $1`, [
      attemptId,
    ]);
    return result.rows[0];
  }

  private async findObservation(
    client: PoolClient,
    attemptId: CashuStellarMeltQuoteAttemptId,
    observedAt: UnixTimestamp,
  ): Promise<ObservationRow | undefined> {
    const result = await client.query<ObservationRow>(
      `${OBSERVATION_SELECT} WHERE attempt_id = $1 AND observed_at = $2`,
      [attemptId, observedAt],
    );
    return result.rows[0];
  }

  private async findLatestObservation(
    client: PoolClient,
    attemptId: CashuStellarMeltQuoteAttemptId,
  ): Promise<ObservationRow | undefined> {
    const result = await client.query<ObservationRow>(
      `${OBSERVATION_SELECT} WHERE attempt_id = $1 ORDER BY observed_at DESC LIMIT 1`,
      [attemptId],
    );
    return result.rows[0];
  }

  private async insertObservation(
    client: PoolClient,
    attempt: StoredAttemptBase,
    quote: CashuStellarMeltQuoteV1,
    fingerprint: string,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO cashu_stellar_melt_quote_observations (
          snapshot_fingerprint,
          attempt_id,
          payment_id,
          mint_url,
          quote_id,
          schema_version,
          observed_at,
          state
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        fingerprint,
        attempt.attemptId,
        attempt.paymentId,
        attempt.mintUrl,
        quote.quoteId,
        quote.schemaVersion,
        quote.observedAt,
        quote.state,
      ],
    );
  }

  private async mapAttempt(
    client: PoolClient,
    row: AttemptRow,
  ): Promise<CashuStellarMeltQuoteAttemptV1> {
    const attempt = mapAttemptBase(row);
    const outcome = await this.findOutcome(client, attempt.attemptId);
    const observationResult = await client.query<ObservationRow>(
      `${OBSERVATION_SELECT} WHERE attempt_id = $1 ORDER BY observed_at`,
      [attempt.attemptId],
    );
    if (outcome === undefined) {
      if (observationResult.rows.length !== 0) {
        return failInvalidRecord();
      }
      return Object.freeze({
        ...publicAttemptBase(attempt),
        observations: Object.freeze([]) as readonly [],
        state: "creating",
      });
    }

    if (
      outcome.attempt_id !== attempt.attemptId ||
      outcome.payment_id !== attempt.paymentId ||
      outcome.mint_url !== attempt.mintUrl ||
      outcome.schema_version !== attempt.schemaVersion
    ) {
      return failInvalidRecord();
    }
    if (outcome.outcome_kind === "ambiguous") {
      const reason = parseAmbiguityReason(outcome.ambiguity_reason);
      const ambiguousAt = unixTimestamp(parseSafeInteger(outcome.recorded_at));
      if (
        outcome.quote_id !== null ||
        outcome.fee_reserve !== null ||
        outcome.expiry !== null ||
        ambiguousAt < attempt.startedAt ||
        observationResult.rows.length !== 0 ||
        createAmbiguousOutcomeFingerprint(attempt, {
          attemptId: attempt.attemptId,
          paymentId: attempt.paymentId,
          reason,
          recordedAt: ambiguousAt,
        }) !== outcome.outcome_fingerprint
      ) {
        return failInvalidRecord();
      }
      return Object.freeze({
        ...publicAttemptBase(attempt),
        ambiguityReason: reason,
        ambiguousAt,
        observations: Object.freeze([]) as readonly [],
        state: "ambiguous",
      });
    }
    if (outcome.outcome_kind !== "quoted") {
      return failInvalidRecord();
    }

    const recordedAt = unixTimestamp(parseSafeInteger(outcome.recorded_at));
    const expiry = parseSafeInteger(outcome.expiry ?? "");
    const feeReserve = parseSafeInteger(outcome.fee_reserve ?? "");
    const observations = observationResult.rows.map((observation) =>
      mapObservation(attempt, outcome, observation, expiry, feeReserve),
    );
    const first = observations[0];
    if (
      first === undefined ||
      first.observedAt !== recordedAt ||
      first.state !== "UNPAID" ||
      recordedAt < attempt.startedAt ||
      first.expiry <= first.observedAt ||
      first.expiry - attempt.startedAt > MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS ||
      createQuotedOutcomeFingerprint(attempt, first) !== outcome.outcome_fingerprint
    ) {
      return failInvalidRecord();
    }
    for (let position = 1; position < observations.length; position += 1) {
      const previous = observations[position - 1];
      const current = observations[position];
      if (
        previous === undefined ||
        current === undefined ||
        current.observedAt <= previous.observedAt ||
        (previous.state === "PAID" && current.state !== "PAID")
      ) {
        return failInvalidRecord();
      }
    }
    const latestQuote = observations.at(-1);
    if (latestQuote === undefined) {
      return failInvalidRecord();
    }
    return Object.freeze({
      ...publicAttemptBase(attempt),
      latestQuote,
      observations: Object.freeze(observations),
      state: "quoted",
    });
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

function validateBegin(input: BeginCashuStellarMeltQuoteAttemptInput): ValidatedBegin {
  try {
    requireObject(input);
    if (
      typeof input.attemptId !== "string" ||
      typeof input.paymentId !== "string" ||
      typeof input.request !== "string"
    ) {
      return failInvalidInput();
    }
    return Object.freeze({
      attemptId: cashuStellarMeltQuoteAttemptId(input.attemptId),
      paymentId: paymentId(input.paymentId),
      request: createCashuStellarMeltQuoteRequestV1({
        amount: input.amount,
        request: input.request,
      }),
      startedAt: unixTimestamp(input.startedAt),
    });
  } catch (error) {
    return mapValidationError(error);
  }
}

function validateAmbiguous(
  input: RecordAmbiguousCashuStellarMeltQuoteAttemptInput,
): ValidatedAmbiguous {
  try {
    requireObject(input);
    if (
      typeof input.attemptId !== "string" ||
      typeof input.paymentId !== "string" ||
      !CASHU_STELLAR_MELT_QUOTE_AMBIGUITY_REASONS.includes(input.reason)
    ) {
      return failInvalidInput();
    }
    return Object.freeze({
      attemptId: cashuStellarMeltQuoteAttemptId(input.attemptId),
      paymentId: paymentId(input.paymentId),
      reason: input.reason,
      recordedAt: unixTimestamp(input.recordedAt),
    });
  } catch (error) {
    return mapValidationError(error);
  }
}

function validateQuoteInput(
  input: RecordCashuStellarMeltQuoteInput | ObserveCashuStellarMeltQuoteInput,
): ValidatedQuoteInput {
  try {
    requireObject(input);
    if (
      typeof input.attemptId !== "string" ||
      typeof input.paymentId !== "string" ||
      typeof input.quote !== "object" ||
      input.quote === null ||
      Array.isArray(input.quote)
    ) {
      return failInvalidInput();
    }
    return Object.freeze({
      attemptId: cashuStellarMeltQuoteAttemptId(input.attemptId),
      paymentId: paymentId(input.paymentId),
      quote: createCashuStellarMeltQuoteV1(input.quote),
    });
  } catch (error) {
    return mapValidationError(error);
  }
}

function validatePaymentId(value: PaymentId): PaymentId {
  try {
    if (typeof value !== "string") {
      return failInvalidInput();
    }
    return paymentId(value);
  } catch (error) {
    return mapValidationError(error);
  }
}

function createAttemptFromContext(
  input: ValidatedBegin,
  row: ReservationContextRow,
): StoredAttemptBase {
  try {
    const base = {
      attemptId: input.attemptId,
      invoiceId: invoiceId(row.invoice_id),
      mintUrl: normalizeCashuMintUrl(row.mint_url),
      operatorId: operatorId(row.operator_id),
      paymentId: paymentId(row.payment_id),
      request: input.request,
      schemaVersion: CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
      startedAt: input.startedAt,
    };
    return Object.freeze({ ...base, attemptFingerprint: createAttemptFingerprint(base) });
  } catch (error) {
    if (error instanceof CashuStellarMeltQuoteRepositoryError) {
      throw error;
    }
    return failInvalidRecord();
  }
}

function assertBeginPreconditions(attempt: StoredAttemptBase, row: ReservationContextRow): void {
  if (row.custody_created_at === null) {
    throw new CashuStellarMeltQuoteRepositoryError(
      "custody_not_found",
      "Cashu Stellar melt quote creation requires encrypted proof custody.",
    );
  }
  const createdAt = parseSafeInteger(row.created_at);
  const expiresAt = parseSafeInteger(row.expires_at);
  const reservedAt = parseSafeInteger(row.reserved_at);
  const custodyCreatedAt = parseSafeInteger(row.custody_created_at);
  if (
    row.reservation_schema_version !== 1 ||
    row.payment_id !== attempt.paymentId ||
    row.invoice_id !== attempt.invoiceId ||
    row.operator_id !== attempt.operatorId ||
    normalizeCashuMintUrl(row.mint_url) !== attempt.mintUrl ||
    row.reservation_unit !== CASHU_STELLAR_UNIT ||
    row.invoice_unit !== CASHU_STELLAR_UNIT
  ) {
    failInvalidRecord();
  }
  if (parseSafeInteger(row.invoice_amount) !== attempt.request.amount) {
    throw new CashuStellarMeltQuoteRepositoryError(
      "terms_mismatch",
      "Cashu Stellar melt quote amount does not match the merchant invoice.",
    );
  }
  if (
    row.invoice_state !== "open" ||
    attempt.startedAt < createdAt ||
    attempt.startedAt < reservedAt ||
    attempt.startedAt < custodyCreatedAt ||
    attempt.startedAt >= expiresAt
  ) {
    throw new CashuStellarMeltQuoteRepositoryError(
      "invoice_window_closed",
      "Cashu Stellar melt quote attempt is outside the open invoice window.",
    );
  }
  const reservedProofs = parseSafeInteger(row.reserved_proof_count);
  if (
    reservedProofs === 0 ||
    parseSafeInteger(row.active_proof_count) !== reservedProofs ||
    parseSafeInteger(row.effect_count) !== 0 ||
    parseSafeInteger(row.event_count) !== 0
  ) {
    throw new CashuStellarMeltQuoteRepositoryError(
      "reservation_not_active",
      "Cashu Stellar melt quote creation requires an active pre-dispatch reservation.",
    );
  }
}

function mapAttemptBase(row: AttemptRow): StoredAttemptBase {
  try {
    const request = createCashuStellarMeltQuoteRequestV1({
      amount: parseSafeInteger(row.amount),
      request: row.request,
    });
    const base = {
      attemptId: cashuStellarMeltQuoteAttemptId(row.attempt_id),
      invoiceId: invoiceId(row.invoice_id),
      mintUrl: normalizeCashuMintUrl(row.mint_url),
      operatorId: operatorId(row.operator_id),
      paymentId: paymentId(row.payment_id),
      request,
      schemaVersion: CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
      startedAt: unixTimestamp(parseSafeInteger(row.started_at)),
    };
    if (
      row.schema_version !== CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION ||
      row.method !== request.method ||
      row.unit !== request.unit ||
      row.mint_url !== base.mintUrl ||
      createAttemptFingerprint(base) !== row.attempt_fingerprint
    ) {
      return failInvalidRecord();
    }
    return Object.freeze({ ...base, attemptFingerprint: row.attempt_fingerprint });
  } catch (error) {
    if (error instanceof CashuStellarMeltQuoteRepositoryError) {
      throw error;
    }
    return failInvalidRecord();
  }
}

function publicAttemptBase(attempt: StoredAttemptBase) {
  return {
    attemptId: attempt.attemptId,
    invoiceId: attempt.invoiceId,
    mintUrl: attempt.mintUrl,
    operatorId: attempt.operatorId,
    paymentId: attempt.paymentId,
    request: attempt.request,
    schemaVersion: attempt.schemaVersion,
    startedAt: attempt.startedAt,
  } as const;
}

function mapObservation(
  attempt: StoredAttemptBase,
  outcome: OutcomeRow,
  row: ObservationRow,
  expiry: number,
  feeReserve: number,
): CashuStellarMeltQuoteV1 {
  try {
    if (
      row.attempt_id !== attempt.attemptId ||
      row.payment_id !== attempt.paymentId ||
      row.mint_url !== attempt.mintUrl ||
      row.quote_id !== outcome.quote_id ||
      row.schema_version !== CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION
    ) {
      return failInvalidRecord();
    }
    const quote = createCashuStellarMeltQuoteV1({
      amount: attempt.request.amount,
      expiry,
      feeReserve,
      method: attempt.request.method,
      mintUrl: attempt.mintUrl,
      observedAt: parseSafeInteger(row.observed_at),
      quoteId: row.quote_id,
      request: attempt.request.request,
      schemaVersion: row.schema_version,
      state: parseQuoteState(row.state),
      unit: attempt.request.unit,
    });
    if (createObservationFingerprint(attempt, quote) !== row.snapshot_fingerprint) {
      return failInvalidRecord();
    }
    return quote;
  } catch (error) {
    if (error instanceof CashuStellarMeltQuoteRepositoryError) {
      throw error;
    }
    return failInvalidRecord();
  }
}

function assertInitialQuote(attempt: StoredAttemptBase, quote: CashuStellarMeltQuoteV1): void {
  assertMatchingTerms(attempt, quote);
  if (
    quote.state !== "UNPAID" ||
    quote.observedAt < attempt.startedAt ||
    quote.expiry <= quote.observedAt ||
    quote.expiry - attempt.startedAt > MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS
  ) {
    failInvalidInput();
  }
}

function assertObservedQuote(
  attempt: StoredAttemptBase,
  outcome: OutcomeRow,
  quote: CashuStellarMeltQuoteV1,
): void {
  assertMatchingTerms(attempt, quote);
  if (
    outcome.quote_id !== quote.quoteId ||
    parseSafeInteger(outcome.fee_reserve ?? "") !== quote.feeReserve ||
    parseSafeInteger(outcome.expiry ?? "") !== quote.expiry
  ) {
    throw new CashuStellarMeltQuoteRepositoryError(
      "terms_mismatch",
      "Cashu Stellar melt quote observation changed immutable quote terms.",
    );
  }
}

function assertMatchingTerms(attempt: StoredAttemptBase, quote: CashuStellarMeltQuoteV1): void {
  if (
    quote.mintUrl !== attempt.mintUrl ||
    quote.method !== attempt.request.method ||
    quote.unit !== attempt.request.unit ||
    quote.amount !== attempt.request.amount ||
    quote.request !== attempt.request.request
  ) {
    throw new CashuStellarMeltQuoteRepositoryError(
      "terms_mismatch",
      "Cashu Stellar melt quote does not match its persisted creation intent.",
    );
  }
}

function createAttemptFingerprint(attempt: Omit<StoredAttemptBase, "attemptFingerprint">): string {
  return sha256({
    amount: attempt.request.amount,
    attemptId: attempt.attemptId,
    invoiceId: attempt.invoiceId,
    method: attempt.request.method,
    mintUrl: attempt.mintUrl,
    operatorId: attempt.operatorId,
    paymentId: attempt.paymentId,
    request: attempt.request.request,
    schemaVersion: attempt.schemaVersion,
    startedAt: attempt.startedAt,
    unit: attempt.request.unit,
  });
}

function createAmbiguousOutcomeFingerprint(
  attempt: StoredAttemptBase,
  input: ValidatedAmbiguous,
): string {
  return sha256({
    ambiguityReason: input.reason,
    attemptFingerprint: attempt.attemptFingerprint,
    attemptId: attempt.attemptId,
    kind: "ambiguous",
    paymentId: attempt.paymentId,
    recordedAt: input.recordedAt,
    schemaVersion: attempt.schemaVersion,
  });
}

function createQuotedOutcomeFingerprint(
  attempt: StoredAttemptBase,
  quote: CashuStellarMeltQuoteV1,
): string {
  return sha256({
    amount: quote.amount,
    attemptFingerprint: attempt.attemptFingerprint,
    attemptId: attempt.attemptId,
    expiry: quote.expiry,
    feeReserve: quote.feeReserve,
    kind: "quoted",
    method: quote.method,
    mintUrl: quote.mintUrl,
    paymentId: attempt.paymentId,
    quoteId: quote.quoteId,
    recordedAt: quote.observedAt,
    request: quote.request,
    schemaVersion: attempt.schemaVersion,
    unit: quote.unit,
  });
}

function createObservationFingerprint(
  attempt: StoredAttemptBase,
  quote: CashuStellarMeltQuoteV1,
): string {
  return sha256({
    amount: quote.amount,
    attemptId: attempt.attemptId,
    expiry: quote.expiry,
    feeReserve: quote.feeReserve,
    method: quote.method,
    mintUrl: quote.mintUrl,
    observedAt: quote.observedAt,
    operatorId: attempt.operatorId,
    paymentId: attempt.paymentId,
    quoteId: quote.quoteId,
    request: quote.request,
    schemaVersion: quote.schemaVersion,
    state: quote.state,
    unit: quote.unit,
  });
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseAmbiguityReason(value: string | null): CashuStellarMeltQuoteAmbiguityReason {
  if (
    !CASHU_STELLAR_MELT_QUOTE_AMBIGUITY_REASONS.includes(
      value as CashuStellarMeltQuoteAmbiguityReason,
    )
  ) {
    return failInvalidRecord();
  }
  return value as CashuStellarMeltQuoteAmbiguityReason;
}

function parseQuoteState(value: string): CashuStellarMeltQuoteState {
  if (value !== "UNPAID" && value !== "PENDING" && value !== "PAID") {
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

function requireObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failInvalidInput();
  }
}

function mapValidationError(error: unknown): never {
  if (error instanceof CashuStellarMeltQuoteRepositoryError) {
    throw error;
  }
  return failInvalidInput();
}

function failInvalidInput(): never {
  throw new CashuStellarMeltQuoteRepositoryError(
    "invalid_input",
    "Cashu Stellar melt quote repository input is invalid.",
  );
}

function failInvalidRecord(): never {
  throw new CashuStellarMeltQuoteRepositoryError(
    "invalid_record",
    "Stored Cashu Stellar melt quote evidence is invalid.",
  );
}

function failInvalidTransition(): never {
  throw new CashuStellarMeltQuoteRepositoryError(
    "invalid_transition",
    "Cashu Stellar melt quote attempt transition is invalid.",
  );
}

function mapStorageError(error: unknown): CashuStellarMeltQuoteRepositoryError {
  if (error instanceof CashuStellarMeltQuoteRepositoryError) {
    return error;
  }
  const databaseError = error as PostgresErrorShape;
  if (databaseError.code === "23505") {
    if (databaseError.constraint === "cashu_stellar_quote_outcomes_mint_quote_unique") {
      return new CashuStellarMeltQuoteRepositoryError(
        "quote_conflict",
        "Cashu Stellar melt quote is already bound to another payment.",
      );
    }
    if (
      databaseError.constraint === "cashu_stellar_quote_observations_attempt_time_unique" ||
      databaseError.constraint === "cashu_stellar_melt_quote_observations_pkey"
    ) {
      return new CashuStellarMeltQuoteRepositoryError(
        "observation_conflict",
        "Cashu Stellar melt quote observation conflicts with stored evidence.",
      );
    }
    if (
      databaseError.constraint === "cashu_stellar_melt_quote_attempts_pkey" ||
      databaseError.constraint === "cashu_stellar_melt_quote_attempts_payment_id_key"
    ) {
      return new CashuStellarMeltQuoteRepositoryError(
        "attempt_conflict",
        "Cashu Stellar melt quote attempt conflicts with stored ownership.",
      );
    }
  }
  return new CashuStellarMeltQuoteRepositoryError(
    "storage_unavailable",
    "Cashu Stellar melt quote storage operation failed.",
  );
}
