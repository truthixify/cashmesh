import { createHash } from "node:crypto";
import {
  CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION,
  type CashuProofStateValue,
  createCashuProofStateSnapshotV1,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import {
  type AcceptedInvoicePaymentV1,
  acceptInvoicePaymentV1,
  createInvoiceV1,
  type InvoiceId,
  invoiceId,
  type JournalEntryId,
  journalEntryId,
  type LedgerAccountV1,
  type MerchantId,
  type MinorUnitAmount,
  merchantId,
  minorUnits,
  type OperatorId,
  operatorId,
  type PaymentId,
  paymentId,
  type SettlementMode,
  settlementAssetAccount,
  settlementAssetId,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

import {
  type AcceptCashuInvoicePaymentInput,
  type AcceptCashuInvoicePaymentResult,
  CASHU_OPERATOR_ATTENTION_REASONS,
  CASHU_OPERATOR_EFFECT_KINDS,
  CASHU_OPERATOR_FAILURE_EVIDENCE,
  CASHU_OPERATOR_SUCCESS_EVIDENCE,
  CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
  type CashuOperatorAttentionReason,
  type CashuOperatorEffectId,
  type CashuOperatorEffectKind,
  type CashuOperatorEffectV1,
  type CashuOperatorFailureEvidence,
  type CashuOperatorSuccessEvidence,
  type CashuProofReservationLifecycleRepository,
  CashuProofReservationLifecycleRepositoryError,
  type CashuProofReservationLifecycleResult,
  type CashuProofReservationLifecycleV1,
  type CashuProofReservationState,
  type CashuReservationLifecycleEventId,
  type CashuReservationLifecycleEventV1,
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuOperatorReference,
  cashuReservationLifecycleEventId,
  type RecordCashuOperatorPendingInput,
  type ReleaseCashuProofReservationInput,
  type RequireCashuOperatorAttentionInput,
  type StartCashuOperatorEffectInput,
} from "./cashu-proof-reservation-lifecycle-repository";
import {
  type CashuStellarMeltQuoteAttemptRecord,
  type CashuStellarMeltQuoteObservationRecord,
  type CashuStellarMeltQuoteOutcomeRecord,
  mapCashuStellarMeltQuotedEvidenceRecord,
  type StoredCashuStellarMeltQuoteAttempt,
  type StoredCashuStellarMeltQuotedEvidence,
} from "./cashu-stellar-melt-quote-record";
import {
  reconstructStoredCashuPaymentRequest,
  type StoredCashuOperatorRouteRow,
  type StoredCashuPaymentRequestRow,
} from "./postgres-invoice-repository";
import { applyPostgresMigrations } from "./postgres-schema";

interface ReservationScopeRow extends QueryResultRow {
  readonly amount: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly invoice_id: string;
  readonly merchant_id: string;
  readonly invoice_state: string;
  readonly paid_at: string | null;
  readonly mint_url: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly reserved_at: string;
  readonly schema_version: number;
  readonly unit: string;
}

interface OperatorEffectRow extends QueryResultRow {
  readonly dispatch_fingerprint: string;
  readonly effect_fingerprint: string;
  readonly effect_id: string;
  readonly effect_kind: string;
  readonly invoice_id: string;
  readonly mint_url: string;
  readonly operator_id: string;
  readonly operator_reference: string | null;
  readonly operator_reference_expires_at: string | null;
  readonly payment_id: string;
  readonly schema_version: number;
  readonly started_at: string;
}

interface LifecycleEventRow extends QueryResultRow {
  readonly effect_id: string | null;
  readonly event_fingerprint: string;
  readonly event_id: string;
  readonly evidence_at: string | null;
  readonly evidence_kind: string | null;
  readonly journal_entry_id: string | null;
  readonly payment_id: string;
  readonly proof_state_snapshot_fingerprint: string | null;
  readonly recorded_at: string;
  readonly schema_version: number;
  readonly sequence: number;
  readonly state: string;
}

interface MeltQuoteAttemptRow extends QueryResultRow, CashuStellarMeltQuoteAttemptRecord {}

interface MeltQuoteOutcomeRow extends QueryResultRow, CashuStellarMeltQuoteOutcomeRecord {}

interface MeltQuoteObservationRow extends QueryResultRow, CashuStellarMeltQuoteObservationRecord {}

interface ProofStateObservationRow extends QueryResultRow {
  readonly mint_url: string;
  readonly observed_at: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly schema_version: number;
  readonly snapshot_fingerprint: string;
  readonly unit: string;
}

interface ProofStateEntryRow extends QueryResultRow {
  readonly payment_id: string;
  readonly position: number;
  readonly proof_y: string;
  readonly state: string;
}

interface ReservedProofYRow extends QueryResultRow {
  readonly position: number;
  readonly proof_y: string;
}

interface ProjectionCountRow extends QueryResultRow {
  readonly active_invoice_claims: string;
  readonly active_proof_claims: string;
  readonly reserved_proofs: string;
}

interface InvoiceRouteRow extends QueryResultRow, StoredCashuOperatorRouteRow {}

interface InvoiceCashuRequestRow extends QueryResultRow, StoredCashuPaymentRequestRow {}

interface PaymentJournalRow extends QueryResultRow {
  readonly accepted_at: string;
  readonly asset_account_id: string;
  readonly asset_account_kind: string;
  readonly effective_at: string;
  readonly fee_amount: string;
  readonly gross_amount: string;
  readonly invoice_id: string;
  readonly journal_entry_id: string;
  readonly journal_fingerprint: string;
  readonly merchant_id: string;
  readonly mint_url: string;
  readonly net_amount: string;
  readonly operator_id: string;
  readonly payment_id: string;
  readonly schema_version: number;
  readonly settlement_mode: string;
}

interface PaymentPostingRow extends QueryResultRow {
  readonly account_id: string | null;
  readonly account_kind: string;
  readonly amount: string;
  readonly journal_entry_id: string;
  readonly position: number;
  readonly side: string;
}

interface PostgresErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
}

interface ReservationScope {
  readonly amount: MinorUnitAmount;
  readonly createdAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly invoiceId: InvoiceId;
  readonly invoiceState: string;
  readonly merchantId: MerchantId;
  readonly paidAt?: UnixTimestamp;
  readonly mintUrl: string;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly reservedAt: UnixTimestamp;
  readonly unit: string;
}

type StoredEffect = CashuOperatorEffectV1 & {
  readonly fingerprint: string;
};

interface EventDraft {
  readonly effectId?: CashuOperatorEffectId;
  readonly eventId: CashuReservationLifecycleEventId;
  readonly evidenceAt?: UnixTimestamp;
  readonly evidenceKind?: string;
  readonly journalEntryId?: JournalEntryId;
  readonly paymentId: PaymentId;
  readonly proofStateSnapshotFingerprint?: string;
  readonly recordedAt: UnixTimestamp;
  readonly state: Exclude<CashuProofReservationState, "reserved">;
}

interface MappedEvent {
  readonly event: CashuReservationLifecycleEventV1;
  readonly fingerprint: string;
}

const RESERVATION_SCOPE_SELECT = `
  SELECT
    reservation.payment_id,
    reservation.invoice_id,
    reservation.operator_id,
    reservation.mint_url,
    reservation.unit,
    reservation.schema_version,
    reservation.reserved_at,
    invoice.amount,
    invoice.created_at,
    invoice.expires_at,
    invoice.merchant_id,
    invoice.paid_at,
    invoice.state AS invoice_state
  FROM cashu_proof_reservations AS reservation
  JOIN merchant_invoices AS invoice ON invoice.id = reservation.invoice_id
`;

const EFFECT_SELECT = `
  SELECT
    effect_id,
    effect_fingerprint,
    dispatch_fingerprint,
    payment_id,
    invoice_id,
    operator_id,
    mint_url,
    effect_kind,
    operator_reference,
    operator_reference_expires_at,
    schema_version,
    started_at
  FROM cashu_operator_effects
`;

const EVENT_SELECT = `
  SELECT
    event_id,
    event_fingerprint,
    payment_id,
    sequence,
    schema_version,
    state,
    recorded_at,
    effect_id,
    evidence_kind,
    evidence_at,
    journal_entry_id,
    proof_state_snapshot_fingerprint
  FROM cashu_proof_reservation_events
`;

const UNIT_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const MAX_UNIT_LENGTH = 32;
const STELLAR_TESTNET_USDC_SETTLEMENT_ASSET_ID = settlementAssetId("stellar-testnet-usdc-circle");

export interface PostgresCashuProofReservationLifecycleRepositoryOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly onBackgroundError?: (error: Error) => void;
}

export class PostgresCashuProofReservationLifecycleRepository
  implements CashuProofReservationLifecycleRepository
{
  private constructor(private readonly pool: Pool) {}

  static async connect(
    options: PostgresCashuProofReservationLifecycleRepositoryOptions,
  ): Promise<PostgresCashuProofReservationLifecycleRepository> {
    if (options.connectionString.trim() === "") {
      throw new CashuProofReservationLifecycleRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection string is required.",
      );
    }
    const maxConnections = options.maxConnections ?? 10;
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw new CashuProofReservationLifecycleRepositoryError(
        "storage_unavailable",
        "PostgreSQL connection pool size must be a positive integer.",
      );
    }
    const pool = new Pool({
      application_name: "cashmesh-reservation-lifecycle",
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
    const repository = new PostgresCashuProofReservationLifecycleRepository(pool);
    try {
      await repository.migrate();
      return repository;
    } catch (error) {
      await pool.end();
      if (error instanceof CashuProofReservationLifecycleRepositoryError) {
        throw error;
      }
      throw new CashuProofReservationLifecycleRepositoryError(
        "storage_unavailable",
        "PostgreSQL Cashu reservation lifecycle storage could not be initialized.",
      );
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async startEffect(
    input: StartCashuOperatorEffectInput,
  ): Promise<CashuProofReservationLifecycleResult> {
    try {
      const validated = validateStartEffect(input);
      return await this.withTransaction(async (client) => {
        const reservation = await this.requireReservation(client, validated.paymentId, true);
        const effect: CashuOperatorEffectV1 =
          validated.kind === "swap"
            ? Object.freeze({
                dispatchFingerprint: validated.dispatchFingerprint,
                effectId: validated.effectId,
                kind: "swap",
                schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
                startedAt: validated.startedAt,
              })
            : Object.freeze({
                dispatchFingerprint: validated.dispatchFingerprint,
                effectId: validated.effectId,
                kind: "melt",
                operatorReference: validated.operatorReference,
                operatorReferenceExpiresAt: validated.operatorReferenceExpiresAt,
                schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
                startedAt: validated.startedAt,
              });
        const draft: EventDraft = {
          effectId: effect.effectId,
          eventId: validated.eventId,
          paymentId: reservation.paymentId,
          recordedAt: effect.startedAt,
          state: "dispatch_started",
        };
        const replay = await this.replayEvent(client, draft, effect);
        if (replay !== undefined) {
          return replay;
        }
        const current = await this.loadLifecycle(client, reservation);
        if (current.state !== "reserved") {
          return failInvalidTransition();
        }
        if (
          reservation.invoiceState !== "open" ||
          effect.startedAt < reservation.createdAt ||
          effect.startedAt >= reservation.expiresAt ||
          effect.startedAt < reservation.reservedAt
        ) {
          return failInvalidTransition();
        }
        if (effect.kind === "melt") {
          await this.assertMeltQuoteEvidence(client, reservation, effect, "dispatch");
        }

        const effectFingerprint = createEffectFingerprint(reservation, effect);
        await client.query(
          `
            INSERT INTO cashu_operator_effects (
              effect_id,
              effect_fingerprint,
              dispatch_fingerprint,
              payment_id,
              invoice_id,
              operator_id,
              mint_url,
              effect_kind,
              operator_reference,
              operator_reference_expires_at,
              schema_version,
              started_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `,
          [
            effect.effectId,
            effectFingerprint,
            effect.dispatchFingerprint,
            reservation.paymentId,
            reservation.invoiceId,
            reservation.operatorId,
            reservation.mintUrl,
            effect.kind,
            effect.kind === "melt" ? effect.operatorReference : null,
            effect.kind === "melt" ? effect.operatorReferenceExpiresAt : null,
            effect.schemaVersion,
            effect.startedAt,
          ],
        );
        await this.insertEvent(client, draft, 0);
        return Object.freeze({
          lifecycle: await this.loadLifecycle(client, reservation),
          replayed: false,
        });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async recordPending(
    input: RecordCashuOperatorPendingInput,
  ): Promise<CashuProofReservationLifecycleResult> {
    const validated = validatePending(input);
    return await this.persistTransition({
      effectId: validated.effectId,
      eventId: validated.eventId,
      evidenceAt: validated.evidenceAt,
      evidenceKind: "operator_pending",
      paymentId: validated.paymentId,
      recordedAt: validated.recordedAt,
      state: "pending",
    });
  }

  async requireAttention(
    input: RequireCashuOperatorAttentionInput,
  ): Promise<CashuProofReservationLifecycleResult> {
    const validated = validateAttention(input);
    return await this.persistTransition({
      effectId: validated.effectId,
      eventId: validated.eventId,
      evidenceAt: validated.evidenceAt,
      evidenceKind: validated.reason,
      paymentId: validated.paymentId,
      recordedAt: validated.recordedAt,
      state: "needs_attention",
    });
  }

  async acceptPayment(
    input: AcceptCashuInvoicePaymentInput,
  ): Promise<AcceptCashuInvoicePaymentResult> {
    try {
      const validated = validatePaymentAcceptance(input);
      return await this.withTransaction(async (client) => {
        const reservation = await this.requireReservation(client, validated.paymentId, true);
        await this.assertEffectEvidence(
          client,
          reservation,
          validated.effectId,
          validated.evidenceKind,
          validated.evidenceAt,
          validated.recordedAt,
        );
        const proofStateFingerprint = await this.resolveProofStateEvidence(
          client,
          reservation,
          validated.proofStateObservedAt,
          "SPENT",
        );
        const draft: EventDraft = {
          effectId: validated.effectId,
          eventId: validated.eventId,
          evidenceAt: validated.evidenceAt,
          evidenceKind: validated.evidenceKind,
          journalEntryId: validated.journalEntryId,
          paymentId: validated.paymentId,
          proofStateSnapshotFingerprint: proofStateFingerprint,
          recordedAt: validated.recordedAt,
          state: "consumed",
        };
        const replay = await this.replayEvent(client, draft);
        if (replay !== undefined) {
          const accounting = await this.requireAcceptedPayment(client, reservation);
          assertAccountingMatchesInput(accounting, reservation, validated);
          return Object.freeze({ accounting, ...replay });
        }

        const accounting = await this.persistAcceptedPayment(client, reservation, validated);
        const transition = await this.persistTransitionInTransaction(client, reservation, draft);
        return Object.freeze({ accounting, ...transition });
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async release(
    input: ReleaseCashuProofReservationInput,
  ): Promise<CashuProofReservationLifecycleResult> {
    try {
      const validated = validateRelease(input);
      return await this.withTransaction(async (client) => {
        const reservation = await this.requireReservation(client, validated.paymentId, true);
        let draft: EventDraft;
        if (validated.kind === "pre_dispatch") {
          draft = {
            eventId: validated.eventId,
            evidenceKind: "pre_dispatch",
            paymentId: validated.paymentId,
            recordedAt: validated.recordedAt,
            state: "released",
          };
        } else {
          await this.assertEffectEvidence(
            client,
            reservation,
            validated.effectId,
            validated.evidenceKind,
            validated.evidenceAt,
            validated.recordedAt,
          );
          const proofStateFingerprint = await this.resolveProofStateEvidence(
            client,
            reservation,
            validated.proofStateObservedAt,
            "UNSPENT",
          );
          draft = {
            effectId: validated.effectId,
            eventId: validated.eventId,
            evidenceAt: validated.evidenceAt,
            evidenceKind: validated.evidenceKind,
            paymentId: validated.paymentId,
            proofStateSnapshotFingerprint: proofStateFingerprint,
            recordedAt: validated.recordedAt,
            state: "released",
          };
        }
        return await this.persistTransitionInTransaction(client, reservation, draft);
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findByPaymentId(
    requestedPaymentId: PaymentId,
  ): Promise<CashuProofReservationLifecycleV1 | undefined> {
    try {
      const validatedPaymentId = validatePaymentId(requestedPaymentId);
      return await this.withTransaction(async (client) => {
        const reservation = await this.loadReservation(client, validatedPaymentId, false);
        if (reservation === undefined) {
          return undefined;
        }
        const lifecycle = await this.loadLifecycle(client, reservation);
        await this.assertAccountingProjection(client, reservation, lifecycle);
        return lifecycle;
      }, true);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  async findAcceptedPaymentByPaymentId(
    requestedPaymentId: PaymentId,
  ): Promise<AcceptedInvoicePaymentV1 | undefined> {
    try {
      const validatedPaymentId = validatePaymentId(requestedPaymentId);
      return await this.withTransaction(async (client) => {
        const reservation = await this.loadReservation(client, validatedPaymentId, false);
        if (reservation === undefined) {
          return undefined;
        }
        const lifecycle = await this.loadLifecycle(client, reservation);
        const accounting = await this.loadAcceptedPayment(client, reservation);
        if (lifecycle.state !== "consumed") {
          if (accounting !== undefined) {
            return failInvalidRecord();
          }
          return undefined;
        }
        return accounting ?? failInvalidRecord();
      }, true);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private async persistTransition(
    draft: EventDraft,
  ): Promise<CashuProofReservationLifecycleResult> {
    try {
      return await this.withTransaction(async (client) => {
        const reservation = await this.requireReservation(client, draft.paymentId, true);
        return await this.persistTransitionInTransaction(client, reservation, draft);
      });
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  private async persistAcceptedPayment(
    client: PoolClient,
    reservation: ReservationScope,
    input: AcceptCashuInvoicePaymentInput,
  ): Promise<AcceptedInvoicePaymentV1> {
    const invoiceResult = await client.query<{ paid_at: string | null; state: string }>(
      "SELECT state, paid_at FROM merchant_invoices WHERE id = $1 FOR UPDATE",
      [reservation.invoiceId],
    );
    const invoiceRow = invoiceResult.rows[0];
    if (
      invoiceRow === undefined ||
      invoiceRow.state !== "open" ||
      invoiceRow.paid_at !== null ||
      reservation.invoiceState !== "open" ||
      reservation.paidAt !== undefined
    ) {
      return failInvalidTransition();
    }

    const settlementMode = await this.requireSettlementMode(client, reservation);
    if (settlementMode !== "immediate_conversion") {
      return failInvalidTransition();
    }
    const assetAccount = settlementAssetAccount(STELLAR_TESTNET_USDC_SETTLEMENT_ASSET_ID);

    let accounting: AcceptedInvoicePaymentV1;
    try {
      const invoice = createInvoiceV1({
        amount: reservation.amount,
        createdAt: reservation.createdAt,
        expiresAt: reservation.expiresAt,
        id: reservation.invoiceId,
        merchantId: reservation.merchantId,
      });
      accounting = acceptInvoicePaymentV1(invoice, {
        acceptedAt: input.proofStateObservedAt,
        assetAccount,
        effectiveAt: input.recordedAt,
        feeAmount: input.feeAmount,
        journalEntryId: input.journalEntryId,
        operatorId: reservation.operatorId,
        paymentId: reservation.paymentId,
        settlementMode,
      });
    } catch {
      return failInvalidTransition();
    }

    const asset = storeAccount(accounting.invoice.payment.assetAccount);
    await client.query(
      `
        INSERT INTO merchant_invoice_payment_journals (
          journal_entry_id,
          journal_fingerprint,
          invoice_id,
          merchant_id,
          payment_id,
          operator_id,
          mint_url,
          settlement_mode,
          asset_account_kind,
          asset_account_id,
          schema_version,
          accepted_at,
          effective_at,
          gross_amount,
          fee_amount,
          net_amount
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        accounting.journalEntry.id,
        createAccountingFingerprint(reservation, accounting),
        accounting.invoice.id,
        accounting.invoice.merchantId,
        accounting.invoice.payment.paymentId,
        accounting.invoice.payment.operatorId,
        reservation.mintUrl,
        accounting.invoice.payment.settlementMode,
        asset.kind,
        asset.id,
        accounting.journalEntry.schemaVersion,
        accounting.invoice.payment.acceptedAt,
        accounting.journalEntry.effectiveAt,
        accounting.invoice.payment.grossAmount,
        accounting.invoice.payment.feeAmount,
        accounting.invoice.payment.netAmount,
      ],
    );
    for (const [position, posting] of accounting.journalEntry.postings.entries()) {
      const account = storeAccount(posting.account);
      await client.query(
        `
          INSERT INTO merchant_invoice_payment_postings (
            journal_entry_id,
            position,
            side,
            account_kind,
            account_id,
            amount
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          accounting.journalEntry.id,
          position,
          posting.side,
          account.kind,
          account.id,
          posting.amount,
        ],
      );
    }
    const update = await client.query(
      `
        UPDATE merchant_invoices
        SET state = 'paid', paid_at = $2
        WHERE id = $1 AND state = 'open' AND paid_at IS NULL
      `,
      [reservation.invoiceId, accounting.invoice.paidAt],
    );
    if (update.rowCount !== 1) {
      return failInvalidTransition();
    }
    return accounting;
  }

  private async requireSettlementMode(
    client: PoolClient,
    reservation: ReservationScope,
  ): Promise<SettlementMode> {
    const requestResult = await client.query<InvoiceCashuRequestRow>(
      `
        SELECT
          schema_version AS cashu_schema_version,
          encoded_request,
          encoding,
          issued_at,
          mint_policy,
          operator_count,
          route_set_fingerprint,
          transport_url
        FROM invoice_cashu_requests
        WHERE invoice_id = $1 AND merchant_id = $2
      `,
      [reservation.invoiceId, reservation.merchantId],
    );
    const operatorResult = await client.query<InvoiceRouteRow>(
      `
        SELECT position, operator_id, mint_url, mode, tier, reason
        FROM invoice_cashu_request_operators
        WHERE invoice_id = $1 AND merchant_id = $2
        ORDER BY position
      `,
      [reservation.invoiceId, reservation.merchantId],
    );
    const requestRow = requestResult.rows[0];
    if (requestResult.rows.length !== 1 || requestRow === undefined) {
      return failInvalidRecord();
    }
    try {
      const issuedRequest = reconstructStoredCashuPaymentRequest(
        requestRow,
        operatorResult.rows,
        createInvoiceV1({
          amount: reservation.amount,
          createdAt: reservation.createdAt,
          expiresAt: reservation.expiresAt,
          id: reservation.invoiceId,
          merchantId: reservation.merchantId,
        }),
      );
      const route = issuedRequest.operators.find(
        (candidate) =>
          candidate.operatorId === reservation.operatorId &&
          candidate.mintUrl === reservation.mintUrl,
      );
      return route?.mode ?? failInvalidRecord();
    } catch {
      return failInvalidRecord();
    }
  }

  private async loadAcceptedPayment(
    client: PoolClient,
    reservation: ReservationScope,
  ): Promise<AcceptedInvoicePaymentV1 | undefined> {
    const journalResult = await client.query<PaymentJournalRow>(
      `
        SELECT
          journal_entry_id,
          journal_fingerprint,
          invoice_id,
          merchant_id,
          payment_id,
          operator_id,
          mint_url,
          settlement_mode,
          asset_account_kind,
          asset_account_id,
          schema_version,
          accepted_at,
          effective_at,
          gross_amount,
          fee_amount,
          net_amount
        FROM merchant_invoice_payment_journals
        WHERE payment_id = $1
      `,
      [reservation.paymentId],
    );
    const row = journalResult.rows[0];
    if (row === undefined) {
      return undefined;
    }
    if (journalResult.rows.length !== 1) {
      return failInvalidRecord();
    }
    const postingResult = await client.query<PaymentPostingRow>(
      `
        SELECT journal_entry_id, position, side, account_kind, account_id, amount
        FROM merchant_invoice_payment_postings
        WHERE journal_entry_id = $1
        ORDER BY position
      `,
      [row.journal_entry_id],
    );

    try {
      const settlementMode = await this.requireSettlementMode(client, reservation);
      const assetAccount = mapStoredAssetAccount(row);
      const accounting = acceptInvoicePaymentV1(
        createInvoiceV1({
          amount: reservation.amount,
          createdAt: reservation.createdAt,
          expiresAt: reservation.expiresAt,
          id: reservation.invoiceId,
          merchantId: reservation.merchantId,
        }),
        {
          acceptedAt: unixTimestamp(parseSafeInteger(row.accepted_at)),
          assetAccount,
          effectiveAt: unixTimestamp(parseSafeInteger(row.effective_at)),
          feeAmount: minorUnits(parseSafeInteger(row.fee_amount)),
          journalEntryId: journalEntryId(row.journal_entry_id),
          operatorId: reservation.operatorId,
          paymentId: reservation.paymentId,
          settlementMode,
        },
      );
      if (
        row.schema_version !== accounting.journalEntry.schemaVersion ||
        row.invoice_id !== reservation.invoiceId ||
        row.merchant_id !== reservation.merchantId ||
        row.payment_id !== reservation.paymentId ||
        row.operator_id !== reservation.operatorId ||
        row.mint_url !== reservation.mintUrl ||
        row.settlement_mode !== settlementMode ||
        row.asset_account_kind !== storeAccount(assetAccount).kind ||
        row.asset_account_id !== storeAccount(assetAccount).id ||
        parseSafeInteger(row.gross_amount) !== accounting.invoice.payment.grossAmount ||
        parseSafeInteger(row.net_amount) !== accounting.invoice.payment.netAmount ||
        reservation.invoiceState !== "paid" ||
        reservation.paidAt !== accounting.invoice.paidAt ||
        row.journal_fingerprint !== createAccountingFingerprint(reservation, accounting) ||
        !postingsMatch(postingResult.rows, accounting)
      ) {
        return failInvalidRecord();
      }
      return accounting;
    } catch (error) {
      if (error instanceof CashuProofReservationLifecycleRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
  }

  private async requireAcceptedPayment(
    client: PoolClient,
    reservation: ReservationScope,
  ): Promise<AcceptedInvoicePaymentV1> {
    return (await this.loadAcceptedPayment(client, reservation)) ?? failInvalidRecord();
  }

  private async assertAccountingProjection(
    client: PoolClient,
    reservation: ReservationScope,
    lifecycle: CashuProofReservationLifecycleV1,
  ): Promise<void> {
    const accounting = await this.loadAcceptedPayment(client, reservation);
    if (lifecycle.state !== "consumed") {
      if (accounting !== undefined) {
        return failInvalidRecord();
      }
      return;
    }
    const event = lifecycle.events.at(-1);
    if (
      accounting === undefined ||
      event?.state !== "consumed" ||
      event.journalEntryId !== accounting.journalEntry.id
    ) {
      return failInvalidRecord();
    }
  }

  private async assertEffectEvidence(
    client: PoolClient,
    reservation: ReservationScope,
    effectId: CashuOperatorEffectId,
    evidenceKind: string,
    evidenceAt: UnixTimestamp,
    recordedAt: UnixTimestamp,
  ): Promise<void> {
    const effect = (await this.loadLifecycle(client, reservation)).effect;
    if (
      effect === undefined ||
      effect.effectId !== effectId ||
      !evidenceMatchesEffect(evidenceKind, effect.kind) ||
      !evidenceTimeMatchesEffect(evidenceKind, evidenceAt, effect) ||
      evidenceAt < effect.startedAt ||
      evidenceAt > recordedAt
    ) {
      return failInvalidTransition();
    }
    if (evidenceKind === "melt_paid") {
      if (effect.kind !== "melt") {
        return failInvalidTransition();
      }
      await this.assertMeltPaidEvidence(client, reservation, effect, evidenceAt);
    }
  }

  private async assertMeltPaidEvidence(
    client: PoolClient,
    reservation: ReservationScope,
    effect: Extract<CashuOperatorEffectV1, { readonly kind: "melt" }>,
    evidenceAt: UnixTimestamp,
  ): Promise<void> {
    const evidence = await this.loadMeltQuotedEvidence(client, reservation.paymentId, true);
    if (evidence === undefined) {
      throw new CashuProofReservationLifecycleRepositoryError(
        "quote_evidence_missing",
        "Cashu melt payment acceptance requires persisted PAID quote evidence.",
      );
    }
    const paidObservation = evidence.observations.find(
      (observation) => observation.observedAt === evidenceAt,
    );
    if (paidObservation === undefined) {
      throw new CashuProofReservationLifecycleRepositoryError(
        "quote_evidence_missing",
        "Cashu melt payment acceptance requires persisted PAID quote evidence.",
      );
    }
    if (
      !meltQuoteAttemptMatchesReservation(evidence.attempt, reservation) ||
      evidence.attempt.mintUrl !== reservation.mintUrl ||
      cashuOperatorReference(paidObservation.quoteId) !== effect.operatorReference ||
      paidObservation.expiry !== effect.operatorReferenceExpiresAt ||
      paidObservation.state !== "PAID"
    ) {
      throw new CashuProofReservationLifecycleRepositoryError(
        "quote_evidence_mismatch",
        "Cashu melt payment acceptance does not match persisted PAID quote evidence.",
      );
    }
  }

  private async persistTransitionInTransaction(
    client: PoolClient,
    reservation: ReservationScope,
    draft: EventDraft,
  ): Promise<CashuProofReservationLifecycleResult> {
    const replay = await this.replayEvent(client, draft);
    if (replay !== undefined) {
      return replay;
    }
    const current = await this.loadLifecycle(client, reservation);
    const effect = current.effect;
    if (draft.state === "released" && draft.evidenceKind === "pre_dispatch") {
      if (
        current.state !== "reserved" ||
        effect !== undefined ||
        draft.recordedAt < reservation.reservedAt
      ) {
        return failInvalidTransition();
      }
      await this.insertEvent(client, draft, 0);
      await this.releaseActiveClaims(client, reservation.paymentId);
      return Object.freeze({
        lifecycle: await this.loadLifecycle(client, reservation),
        replayed: false,
      });
    }
    if (
      effect === undefined ||
      draft.effectId !== effect.effectId ||
      !["dispatch_started", "pending", "needs_attention"].includes(current.state) ||
      draft.recordedAt < (current.events.at(-1)?.recordedAt ?? effect.startedAt) ||
      draft.evidenceAt === undefined ||
      draft.evidenceAt < effect.startedAt ||
      draft.evidenceAt > draft.recordedAt ||
      !evidenceMatchesEffect(draft.evidenceKind, effect.kind) ||
      !evidenceTimeMatchesEffect(draft.evidenceKind, draft.evidenceAt, effect)
    ) {
      return failInvalidTransition();
    }
    if (draft.proofStateSnapshotFingerprint !== undefined) {
      const observedAt = await this.proofStateObservedAt(
        client,
        reservation.paymentId,
        draft.proofStateSnapshotFingerprint,
      );
      if (observedAt < draft.evidenceAt || observedAt > draft.recordedAt) {
        return failInvalidTransition();
      }
    }
    await this.insertEvent(client, draft, current.events.length);
    if (draft.state === "released") {
      await this.releaseActiveClaims(client, reservation.paymentId);
    }
    return Object.freeze({
      lifecycle: await this.loadLifecycle(client, reservation),
      replayed: false,
    });
  }

  private async releaseActiveClaims(
    client: PoolClient,
    requestedPaymentId: PaymentId,
  ): Promise<void> {
    await client.query("DELETE FROM cashu_active_proof_claims WHERE payment_id = $1", [
      requestedPaymentId,
    ]);
    await client.query("DELETE FROM cashu_active_invoice_payment_claims WHERE payment_id = $1", [
      requestedPaymentId,
    ]);
  }

  private async replayEvent(
    client: PoolClient,
    draft: EventDraft,
    expectedEffect?: CashuOperatorEffectV1,
  ): Promise<CashuProofReservationLifecycleResult | undefined> {
    const result = await client.query<LifecycleEventRow>(`${EVENT_SELECT} WHERE event_id = $1`, [
      draft.eventId,
    ]);
    const existing = result.rows[0];
    if (existing === undefined) {
      return undefined;
    }
    if (existing.payment_id !== draft.paymentId) {
      return failEventConflict();
    }
    const reservation = await this.requireReservation(client, draft.paymentId, false);
    const lifecycle = await this.loadLifecycle(client, reservation);
    const expectedFingerprint = createEventFingerprint(draft, existing.sequence);
    if (existing.event_fingerprint !== expectedFingerprint) {
      return failEventConflict();
    }
    if (expectedEffect !== undefined) {
      const storedEffect = lifecycle.effect;
      if (
        storedEffect === undefined ||
        createEffectFingerprint(reservation, storedEffect) !==
          createEffectFingerprint(reservation, expectedEffect)
      ) {
        return failEffectConflict();
      }
    }
    return Object.freeze({ lifecycle, replayed: true });
  }

  private async insertEvent(
    client: PoolClient,
    draft: EventDraft,
    sequence: number,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO cashu_proof_reservation_events (
          event_id,
          event_fingerprint,
          payment_id,
          sequence,
          schema_version,
          state,
          recorded_at,
          effect_id,
          evidence_kind,
          evidence_at,
          journal_entry_id,
          proof_state_snapshot_fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        draft.eventId,
        createEventFingerprint(draft, sequence),
        draft.paymentId,
        sequence,
        CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
        draft.state,
        draft.recordedAt,
        draft.effectId ?? null,
        draft.evidenceKind ?? null,
        draft.evidenceAt ?? null,
        draft.journalEntryId ?? null,
        draft.proofStateSnapshotFingerprint ?? null,
      ],
    );
  }

  private async requireReservation(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    lock: boolean,
  ): Promise<ReservationScope> {
    let reservation = await this.loadReservation(client, requestedPaymentId, lock);
    if (reservation === undefined) {
      throw new CashuProofReservationLifecycleRepositoryError(
        "reservation_not_found",
        "Cashu reservation lifecycle requires an existing proof reservation.",
      );
    }
    if (lock) {
      reservation = await this.loadReservation(client, requestedPaymentId, false);
      if (reservation === undefined) {
        return failInvalidRecord();
      }
    }
    return reservation;
  }

  private async loadReservation(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    lock: boolean,
  ): Promise<ReservationScope | undefined> {
    const result = await client.query<ReservationScopeRow>(
      `${RESERVATION_SCOPE_SELECT} WHERE reservation.payment_id = $1 ${lock ? "FOR UPDATE OF reservation" : ""}`,
      [requestedPaymentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    try {
      const storedPaymentId = paymentId(row.payment_id);
      const storedInvoiceId = invoiceId(row.invoice_id);
      const storedMerchantId = merchantId(row.merchant_id);
      const storedOperatorId = operatorId(row.operator_id);
      const mintUrl = normalizeCashuMintUrl(row.mint_url);
      const unit = normalizeUnit(row.unit);
      const createdAt = unixTimestamp(parseSafeInteger(row.created_at));
      const expiresAt = unixTimestamp(parseSafeInteger(row.expires_at));
      const paidAt =
        row.paid_at === null ? undefined : unixTimestamp(parseSafeInteger(row.paid_at));
      if (
        row.schema_version !== 1 ||
        storedPaymentId !== requestedPaymentId ||
        storedPaymentId !== row.payment_id ||
        storedInvoiceId !== row.invoice_id ||
        storedMerchantId !== row.merchant_id ||
        storedOperatorId !== row.operator_id ||
        mintUrl !== row.mint_url ||
        unit !== row.unit ||
        !(
          (row.invoice_state === "open" && paidAt === undefined) ||
          (row.invoice_state === "paid" &&
            paidAt !== undefined &&
            paidAt >= createdAt &&
            paidAt < expiresAt)
        )
      ) {
        return failInvalidRecord();
      }
      return Object.freeze({
        amount: minorUnits(parseSafeInteger(row.amount)),
        createdAt,
        expiresAt,
        invoiceId: storedInvoiceId,
        invoiceState: row.invoice_state,
        merchantId: storedMerchantId,
        mintUrl,
        operatorId: storedOperatorId,
        ...(paidAt === undefined ? {} : { paidAt }),
        paymentId: storedPaymentId,
        reservedAt: unixTimestamp(parseSafeInteger(row.reserved_at)),
        unit,
      });
    } catch (error) {
      if (error instanceof CashuProofReservationLifecycleRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
  }

  private async loadLifecycle(
    client: PoolClient,
    reservation: ReservationScope,
  ): Promise<CashuProofReservationLifecycleV1> {
    const effectResult = await client.query<OperatorEffectRow>(
      `${EFFECT_SELECT} WHERE payment_id = $1`,
      [reservation.paymentId],
    );
    const eventResult = await client.query<LifecycleEventRow>(
      `${EVENT_SELECT} WHERE payment_id = $1 ORDER BY sequence`,
      [reservation.paymentId],
    );
    const effect =
      effectResult.rows[0] === undefined ? undefined : mapEffect(effectResult.rows[0], reservation);
    if (effectResult.rows.length > 1 || (effect !== undefined && eventResult.rows.length === 0)) {
      return failInvalidRecord();
    }
    if (effect?.kind === "melt") {
      await this.assertMeltQuoteEvidence(client, reservation, effect, "stored");
    }

    const events: CashuReservationLifecycleEventV1[] = [];
    let currentState: CashuProofReservationState = "reserved";
    for (const [sequence, row] of eventResult.rows.entries()) {
      const mapped = await this.mapEvent(client, row, reservation, effect);
      if (
        row.sequence !== sequence ||
        !transitionAllowed(currentState, mapped.event.state) ||
        (sequence > 0 &&
          mapped.event.recordedAt < (events[sequence - 1]?.recordedAt ?? reservation.reservedAt))
      ) {
        return failInvalidRecord();
      }
      currentState = mapped.event.state;
      events.push(mapped.event);
    }
    if (
      (effect === undefined && events.some((event) => event.state !== "released")) ||
      (effect !== undefined && events[0]?.state !== "dispatch_started")
    ) {
      return failInvalidRecord();
    }
    await this.assertProjection(client, reservation.paymentId, currentState, effect !== undefined);
    return Object.freeze({
      ...(effect === undefined ? {} : { effect }),
      events: Object.freeze(events),
      paymentId: reservation.paymentId,
      schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
      state: currentState,
    });
  }

  private async mapEvent(
    client: PoolClient,
    row: LifecycleEventRow,
    reservation: ReservationScope,
    effect: CashuOperatorEffectV1 | undefined,
  ): Promise<MappedEvent> {
    try {
      if (
        row.schema_version !== CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION ||
        row.payment_id !== reservation.paymentId ||
        !Number.isSafeInteger(row.sequence) ||
        row.sequence < 0
      ) {
        return failInvalidRecord();
      }
      const eventId = cashuReservationLifecycleEventId(row.event_id);
      const recordedAt = unixTimestamp(parseSafeInteger(row.recorded_at));
      const effectId = row.effect_id === null ? undefined : cashuOperatorEffectId(row.effect_id);
      const storedJournalEntryId =
        row.journal_entry_id === null ? undefined : journalEntryId(row.journal_entry_id);
      if (
        (effect === undefined && effectId !== undefined) ||
        (effect !== undefined && effectId !== effect.effectId)
      ) {
        return failInvalidRecord();
      }
      const evidenceAt =
        row.evidence_at === null ? undefined : unixTimestamp(parseSafeInteger(row.evidence_at));
      let proofStateObservedAt: UnixTimestamp | undefined;
      if (row.proof_state_snapshot_fingerprint !== null) {
        const requiredState = row.state === "consumed" ? "SPENT" : "UNSPENT";
        proofStateObservedAt = await this.validateProofStateEvidenceByFingerprint(
          client,
          reservation,
          row.proof_state_snapshot_fingerprint,
          requiredState,
        );
      }
      const draft: EventDraft = {
        ...(effectId === undefined ? {} : { effectId }),
        eventId,
        ...(evidenceAt === undefined ? {} : { evidenceAt }),
        ...(row.evidence_kind === null ? {} : { evidenceKind: row.evidence_kind }),
        ...(storedJournalEntryId === undefined ? {} : { journalEntryId: storedJournalEntryId }),
        paymentId: reservation.paymentId,
        ...(row.proof_state_snapshot_fingerprint === null
          ? {}
          : { proofStateSnapshotFingerprint: row.proof_state_snapshot_fingerprint }),
        recordedAt,
        state: parseEventState(row.state),
      };
      const event = createPublicEvent(draft, row.sequence, proofStateObservedAt);
      const fingerprint = createEventFingerprint(draft, row.sequence);
      if (
        fingerprint !== row.event_fingerprint ||
        recordedAt < reservation.reservedAt ||
        (evidenceAt !== undefined && evidenceAt > recordedAt) ||
        !eventMatchesEffect(event, effect)
      ) {
        return failInvalidRecord();
      }
      return { event, fingerprint };
    } catch (error) {
      if (error instanceof CashuProofReservationLifecycleRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
  }

  private async resolveProofStateEvidence(
    client: PoolClient,
    reservation: ReservationScope,
    observedAt: UnixTimestamp,
    requiredState: CashuProofStateValue,
  ): Promise<string> {
    const result = await client.query<ProofStateObservationRow>(
      `
        SELECT
          snapshot_fingerprint,
          payment_id,
          operator_id,
          mint_url,
          unit,
          schema_version,
          observed_at
        FROM cashu_proof_state_observations
        WHERE payment_id = $1 AND observed_at = $2
      `,
      [reservation.paymentId, observedAt],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CashuProofReservationLifecycleRepositoryError(
        "proof_state_evidence_missing",
        "Cashu lifecycle transition requires exact proof-state evidence.",
      );
    }
    await this.validateProofStateEvidenceByFingerprint(
      client,
      reservation,
      row.snapshot_fingerprint,
      requiredState,
      true,
    );
    return row.snapshot_fingerprint;
  }

  private async validateProofStateEvidenceByFingerprint(
    client: PoolClient,
    reservation: ReservationScope,
    fingerprint: string,
    requiredState: CashuProofStateValue,
    inputEvidence = false,
  ): Promise<UnixTimestamp> {
    const observationResult = await client.query<ProofStateObservationRow>(
      `
        SELECT
          snapshot_fingerprint,
          payment_id,
          operator_id,
          mint_url,
          unit,
          schema_version,
          observed_at
        FROM cashu_proof_state_observations
        WHERE snapshot_fingerprint = $1 AND payment_id = $2
      `,
      [fingerprint, reservation.paymentId],
    );
    const entryResult = await client.query<ProofStateEntryRow>(
      `
        SELECT payment_id, position, proof_y, state
        FROM cashu_proof_state_observation_entries
        WHERE snapshot_fingerprint = $1
        ORDER BY position
      `,
      [fingerprint],
    );
    const proofResult = await client.query<ReservedProofYRow>(
      `
        SELECT position, proof_y
        FROM cashu_reserved_proofs
        WHERE payment_id = $1
        ORDER BY position
      `,
      [reservation.paymentId],
    );
    const row = observationResult.rows[0];
    try {
      if (
        row === undefined ||
        row.schema_version !== CASHU_PROOF_STATE_SNAPSHOT_SCHEMA_VERSION ||
        row.payment_id !== reservation.paymentId ||
        row.operator_id !== reservation.operatorId ||
        row.mint_url !== reservation.mintUrl ||
        row.unit !== reservation.unit ||
        entryResult.rows.length === 0 ||
        entryResult.rows.length !== proofResult.rows.length
      ) {
        return failInvalidRecord();
      }
      const snapshot = createCashuProofStateSnapshotV1({
        mintUrl: row.mint_url,
        observedAt: unixTimestamp(parseSafeInteger(row.observed_at)),
        schemaVersion: row.schema_version,
        states: Array.from(entryResult.rows, (entry, position) => {
          const proof = proofResult.rows[position];
          if (
            entry.payment_id !== reservation.paymentId ||
            entry.position !== position ||
            proof?.position !== position ||
            entry.proof_y !== proof.proof_y
          ) {
            return failInvalidRecord();
          }
          if (entry.state !== requiredState) {
            if (inputEvidence) {
              throw new CashuProofReservationLifecycleRepositoryError(
                "proof_state_evidence_missing",
                "Cashu lifecycle transition lacks the required uniform proof state.",
              );
            }
            return failInvalidRecord();
          }
          return { state: entry.state, y: entry.proof_y };
        }),
      });
      if (
        createProofStateFingerprint(reservation, snapshot) !== fingerprint ||
        snapshot.observedAt < reservation.reservedAt
      ) {
        return failInvalidRecord();
      }
      return snapshot.observedAt;
    } catch (error) {
      if (error instanceof CashuProofReservationLifecycleRepositoryError) {
        throw error;
      }
      return failInvalidRecord();
    }
  }

  private async proofStateObservedAt(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    fingerprint: string,
  ): Promise<UnixTimestamp> {
    const result = await client.query<{ observed_at: string }>(
      `
        SELECT observed_at
        FROM cashu_proof_state_observations
        WHERE payment_id = $1 AND snapshot_fingerprint = $2
      `,
      [requestedPaymentId, fingerprint],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return failInvalidRecord();
    }
    return unixTimestamp(parseSafeInteger(row.observed_at));
  }

  private async assertProjection(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    state: CashuProofReservationState,
    hasEffect: boolean,
  ): Promise<void> {
    const result = await client.query<ProjectionCountRow>(
      `
        SELECT
          (SELECT COUNT(*) FROM cashu_reserved_proofs WHERE payment_id = $1) AS reserved_proofs,
          (SELECT COUNT(*) FROM cashu_active_proof_claims WHERE payment_id = $1)
            AS active_proof_claims,
          (SELECT COUNT(*) FROM cashu_active_invoice_payment_claims WHERE payment_id = $1)
            AS active_invoice_claims
      `,
      [requestedPaymentId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return failInvalidRecord();
    }
    const reservedProofs = parseSafeInteger(row.reserved_proofs);
    const activeProofClaims = parseSafeInteger(row.active_proof_claims);
    const activeInvoiceClaims = parseSafeInteger(row.active_invoice_claims);
    if (
      reservedProofs === 0 ||
      (state === "released" && (activeProofClaims !== 0 || activeInvoiceClaims !== 0)) ||
      (state !== "released" && activeProofClaims !== reservedProofs) ||
      (state !== "released" && activeInvoiceClaims !== (hasEffect ? 1 : 0))
    ) {
      return failInvalidRecord();
    }
  }

  private async assertMeltQuoteEvidence(
    client: PoolClient,
    reservation: ReservationScope,
    effect: Extract<CashuOperatorEffectV1, { readonly kind: "melt" }>,
    mode: "dispatch" | "stored",
  ): Promise<void> {
    const evidence = await this.loadMeltQuotedEvidence(
      client,
      reservation.paymentId,
      mode === "dispatch",
    );
    if (evidence === undefined) {
      if (mode === "stored") {
        return failInvalidRecord();
      }
      throw new CashuProofReservationLifecycleRepositoryError(
        "quote_evidence_missing",
        "Cashu melt dispatch requires a persisted quoted outcome.",
      );
    }

    const dispatchQuote = evidence.observations
      .filter((observation) => observation.observedAt <= effect.startedAt)
      .at(-1);
    const latestQuote = evidence.observations.at(-1);
    const immutableTermsMatch =
      meltQuoteAttemptMatchesReservation(evidence.attempt, reservation) &&
      evidence.attempt.mintUrl === reservation.mintUrl &&
      dispatchQuote !== undefined &&
      cashuOperatorReference(dispatchQuote.quoteId) === effect.operatorReference &&
      dispatchQuote.expiry === effect.operatorReferenceExpiresAt &&
      evidence.recordedAt <= effect.startedAt &&
      dispatchQuote.state === "UNPAID";
    const dispatchStateMatches =
      latestQuote?.state === "UNPAID" && latestQuote.observedAt <= effect.startedAt;
    if (!immutableTermsMatch || (mode === "dispatch" && !dispatchStateMatches)) {
      if (mode === "stored") {
        return failInvalidRecord();
      }
      throw new CashuProofReservationLifecycleRepositoryError(
        "quote_evidence_mismatch",
        "Cashu melt dispatch does not match its persisted quote evidence.",
      );
    }
  }

  private async loadMeltQuotedEvidence(
    client: PoolClient,
    requestedPaymentId: PaymentId,
    lockAttempt: boolean,
  ): Promise<StoredCashuStellarMeltQuotedEvidence | undefined> {
    const attemptResult = await client.query<MeltQuoteAttemptRow>(
      `
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
        FROM cashu_stellar_melt_quote_attempts AS attempt
        WHERE attempt.payment_id = $1
        ${lockAttempt ? "FOR UPDATE OF attempt" : ""}
      `,
      [requestedPaymentId],
    );
    const attemptRow = attemptResult.rows[0];
    if (attemptRow === undefined) {
      return undefined;
    }
    const outcomeResult = await client.query<MeltQuoteOutcomeRow>(
      `
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
        WHERE attempt_id = $1
      `,
      [attemptRow.attempt_id],
    );
    const outcomeRow = outcomeResult.rows[0];
    if (outcomeRow === undefined) {
      return undefined;
    }
    const observationResult = await client.query<MeltQuoteObservationRow>(
      `
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
        WHERE attempt_id = $1
        ORDER BY observed_at
      `,
      [attemptRow.attempt_id],
    );
    try {
      return mapCashuStellarMeltQuotedEvidenceRecord(
        attemptRow,
        outcomeRow,
        observationResult.rows,
      );
    } catch {
      return failInvalidRecord();
    }
  }

  private async migrate(): Promise<void> {
    await this.withTransaction(async (client) => applyPostgresMigrations(client));
  }

  private async withTransaction<T>(
    action: (client: PoolClient) => Promise<T>,
    readOnlySnapshot = false,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        readOnlySnapshot ? "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
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

function validateStartEffect(input: StartCashuOperatorEffectInput): StartCashuOperatorEffectInput {
  try {
    requireObject(input);
    if (
      typeof input.dispatchFingerprint !== "string" ||
      typeof input.effectId !== "string" ||
      typeof input.eventId !== "string" ||
      typeof input.paymentId !== "string"
    ) {
      return failInvalidInput();
    }
    const kind = parseEffectKind(input.kind);
    const dispatchFingerprint = cashuOperatorDispatchFingerprint(input.dispatchFingerprint);
    const base = {
      dispatchFingerprint,
      effectId: cashuOperatorEffectId(input.effectId),
      eventId: cashuReservationLifecycleEventId(input.eventId),
      paymentId: paymentId(input.paymentId),
      startedAt: unixTimestamp(input.startedAt),
    };
    if (kind === "swap") {
      if (input.operatorReference !== undefined || input.operatorReferenceExpiresAt !== undefined) {
        return failInvalidInput();
      }
      return Object.freeze({ ...base, kind: "swap" });
    }
    if (
      typeof input.operatorReference !== "string" ||
      typeof input.operatorReferenceExpiresAt !== "number"
    ) {
      return failInvalidInput();
    }
    const operatorReference = cashuOperatorReference(input.operatorReference);
    const operatorReferenceExpiresAt = unixTimestamp(input.operatorReferenceExpiresAt);
    if (operatorReferenceExpiresAt <= base.startedAt) {
      return failInvalidInput();
    }
    return Object.freeze({
      ...base,
      kind: "melt",
      operatorReference,
      operatorReferenceExpiresAt,
    });
  } catch (error) {
    return mapValidationError(error);
  }
}

function validatePending(input: RecordCashuOperatorPendingInput): RecordCashuOperatorPendingInput {
  return validateEvidenceInput(input, (base) => Object.freeze(base));
}

function validateAttention(
  input: RequireCashuOperatorAttentionInput,
): RequireCashuOperatorAttentionInput {
  return validateEvidenceInput(input, (base) => {
    if (!CASHU_OPERATOR_ATTENTION_REASONS.includes(input.reason)) {
      return failInvalidInput();
    }
    return Object.freeze({ ...base, reason: input.reason });
  });
}

function validatePaymentAcceptance(
  input: AcceptCashuInvoicePaymentInput,
): AcceptCashuInvoicePaymentInput {
  return validateEvidenceInput(input, (base) => {
    if (
      input.evidenceKind !== "melt_paid" ||
      typeof input.journalEntryId !== "string" ||
      typeof input.feeAmount !== "number"
    ) {
      return failInvalidInput();
    }
    return Object.freeze({
      ...base,
      evidenceKind: "melt_paid",
      feeAmount: minorUnits(input.feeAmount),
      journalEntryId: journalEntryId(input.journalEntryId),
      proofStateObservedAt: unixTimestamp(input.proofStateObservedAt),
    });
  });
}

function validateRelease(
  input: ReleaseCashuProofReservationInput,
): ReleaseCashuProofReservationInput {
  try {
    requireObject(input);
    if (typeof input.eventId !== "string" || typeof input.paymentId !== "string") {
      return failInvalidInput();
    }
    const base = {
      eventId: cashuReservationLifecycleEventId(input.eventId),
      paymentId: paymentId(input.paymentId),
      recordedAt: unixTimestamp(input.recordedAt),
    };
    if (input.kind === "pre_dispatch") {
      return Object.freeze({ ...base, kind: "pre_dispatch" });
    }
    if (
      input.kind !== "after_failure" ||
      typeof input.effectId !== "string" ||
      !CASHU_OPERATOR_FAILURE_EVIDENCE.includes(input.evidenceKind)
    ) {
      return failInvalidInput();
    }
    return Object.freeze({
      ...base,
      effectId: cashuOperatorEffectId(input.effectId),
      evidenceAt: unixTimestamp(input.evidenceAt),
      evidenceKind: input.evidenceKind,
      kind: "after_failure",
      proofStateObservedAt: unixTimestamp(input.proofStateObservedAt),
    });
  } catch (error) {
    return mapValidationError(error);
  }
}

function validateEvidenceInput<T extends { readonly effectId: CashuOperatorEffectId }>(
  input:
    | RecordCashuOperatorPendingInput
    | RequireCashuOperatorAttentionInput
    | AcceptCashuInvoicePaymentInput,
  finish: (base: {
    readonly effectId: CashuOperatorEffectId;
    readonly eventId: CashuReservationLifecycleEventId;
    readonly evidenceAt: UnixTimestamp;
    readonly paymentId: PaymentId;
    readonly recordedAt: UnixTimestamp;
  }) => T,
): T {
  try {
    requireObject(input);
    if (
      typeof input.effectId !== "string" ||
      typeof input.eventId !== "string" ||
      typeof input.paymentId !== "string"
    ) {
      return failInvalidInput();
    }
    return finish({
      effectId: cashuOperatorEffectId(input.effectId),
      eventId: cashuReservationLifecycleEventId(input.eventId),
      evidenceAt: unixTimestamp(input.evidenceAt),
      paymentId: paymentId(input.paymentId),
      recordedAt: unixTimestamp(input.recordedAt),
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

function requireObject(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failInvalidInput();
  }
}

function parseEffectKind(value: unknown): CashuOperatorEffectKind {
  if (!CASHU_OPERATOR_EFFECT_KINDS.includes(value as CashuOperatorEffectKind)) {
    return failInvalidInput();
  }
  return value as CashuOperatorEffectKind;
}

function parseEventState(value: string): Exclude<CashuProofReservationState, "reserved"> {
  if (!["dispatch_started", "pending", "needs_attention", "consumed", "released"].includes(value)) {
    return failInvalidRecord();
  }
  return value as Exclude<CashuProofReservationState, "reserved">;
}

function mapEffect(row: OperatorEffectRow, reservation: ReservationScope): StoredEffect {
  try {
    const kind = parseEffectKind(row.effect_kind);
    const base = {
      dispatchFingerprint: cashuOperatorDispatchFingerprint(row.dispatch_fingerprint),
      effectId: cashuOperatorEffectId(row.effect_id),
      schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
      startedAt: unixTimestamp(parseSafeInteger(row.started_at)),
    };
    const effect: CashuOperatorEffectV1 =
      kind === "swap"
        ? Object.freeze({ ...base, kind: "swap" })
        : Object.freeze({
            ...base,
            kind: "melt",
            operatorReference: cashuOperatorReference(row.operator_reference ?? ""),
            operatorReferenceExpiresAt: unixTimestamp(
              parseSafeInteger(row.operator_reference_expires_at ?? ""),
            ),
          });
    const fingerprint = createEffectFingerprint(reservation, effect);
    if (
      row.schema_version !== CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION ||
      row.payment_id !== reservation.paymentId ||
      row.invoice_id !== reservation.invoiceId ||
      row.operator_id !== reservation.operatorId ||
      row.mint_url !== reservation.mintUrl ||
      row.effect_fingerprint !== fingerprint ||
      (effect.kind === "swap" &&
        (row.operator_reference !== null || row.operator_reference_expires_at !== null)) ||
      (effect.kind === "melt" && effect.operatorReferenceExpiresAt <= effect.startedAt) ||
      effect.startedAt < reservation.reservedAt ||
      effect.startedAt < reservation.createdAt ||
      effect.startedAt >= reservation.expiresAt
    ) {
      return failInvalidRecord();
    }
    return Object.freeze({ ...effect, fingerprint });
  } catch (error) {
    if (error instanceof CashuProofReservationLifecycleRepositoryError) {
      throw error;
    }
    return failInvalidRecord();
  }
}

function createPublicEvent(
  draft: EventDraft,
  sequence: number,
  proofStateObservedAt?: UnixTimestamp,
): CashuReservationLifecycleEventV1 {
  const base = {
    eventId: draft.eventId,
    recordedAt: draft.recordedAt,
    sequence,
  };
  if ((draft.state === "consumed") !== (draft.journalEntryId !== undefined)) {
    return failInvalidRecord();
  }
  switch (draft.state) {
    case "dispatch_started":
      if (draft.evidenceKind !== undefined || draft.evidenceAt !== undefined) {
        return failInvalidRecord();
      }
      return Object.freeze({ ...base, state: "dispatch_started" });
    case "pending":
      if (draft.evidenceKind !== "operator_pending" || draft.evidenceAt === undefined) {
        return failInvalidRecord();
      }
      return Object.freeze({
        ...base,
        evidenceAt: draft.evidenceAt,
        evidenceKind: "operator_pending",
        state: "pending",
      });
    case "needs_attention":
      if (
        draft.evidenceAt === undefined ||
        !CASHU_OPERATOR_ATTENTION_REASONS.includes(
          draft.evidenceKind as CashuOperatorAttentionReason,
        )
      ) {
        return failInvalidRecord();
      }
      return Object.freeze({
        ...base,
        evidenceAt: draft.evidenceAt,
        evidenceKind: draft.evidenceKind as CashuOperatorAttentionReason,
        state: "needs_attention",
      });
    case "consumed":
      if (
        draft.evidenceAt === undefined ||
        proofStateObservedAt === undefined ||
        !CASHU_OPERATOR_SUCCESS_EVIDENCE.includes(
          draft.evidenceKind as CashuOperatorSuccessEvidence,
        )
      ) {
        return failInvalidRecord();
      }
      return Object.freeze({
        ...base,
        evidenceAt: draft.evidenceAt,
        evidenceKind: draft.evidenceKind as CashuOperatorSuccessEvidence,
        journalEntryId: draft.journalEntryId as JournalEntryId,
        proofStateObservedAt,
        state: "consumed",
      });
    case "released":
      if (draft.evidenceKind === "pre_dispatch") {
        if (draft.evidenceAt !== undefined || proofStateObservedAt !== undefined) {
          return failInvalidRecord();
        }
        return Object.freeze({ ...base, evidenceKind: "pre_dispatch", state: "released" });
      }
      if (
        draft.evidenceAt === undefined ||
        proofStateObservedAt === undefined ||
        !CASHU_OPERATOR_FAILURE_EVIDENCE.includes(
          draft.evidenceKind as CashuOperatorFailureEvidence,
        )
      ) {
        return failInvalidRecord();
      }
      return Object.freeze({
        ...base,
        evidenceAt: draft.evidenceAt,
        evidenceKind: draft.evidenceKind as CashuOperatorFailureEvidence,
        proofStateObservedAt,
        state: "released",
      });
  }
}

function transitionAllowed(
  current: CashuProofReservationState,
  next: Exclude<CashuProofReservationState, "reserved">,
): boolean {
  if (current === "reserved") {
    return next === "dispatch_started" || next === "released";
  }
  if (["dispatch_started", "pending", "needs_attention"].includes(current)) {
    return ["pending", "needs_attention", "consumed", "released"].includes(next);
  }
  return false;
}

function eventMatchesEffect(
  event: CashuReservationLifecycleEventV1,
  effect: CashuOperatorEffectV1 | undefined,
): boolean {
  if (event.state === "released" && event.evidenceKind === "pre_dispatch") {
    return effect === undefined;
  }
  if (effect === undefined || event.recordedAt < effect.startedAt) {
    return false;
  }
  if ("evidenceAt" in event && event.evidenceAt < effect.startedAt) {
    return false;
  }
  return (
    !("evidenceKind" in event) ||
    (evidenceMatchesEffect(event.evidenceKind, effect.kind) &&
      (!("evidenceAt" in event) ||
        evidenceTimeMatchesEffect(event.evidenceKind, event.evidenceAt, effect)))
  );
}

function evidenceMatchesEffect(
  kind: string | undefined,
  effectKind: CashuOperatorEffectKind,
): boolean {
  if (kind === "operator_pending") {
    return effectKind === "melt";
  }
  if (kind === "swap_succeeded" || kind === "swap_rejected") {
    return effectKind === "swap";
  }
  if (kind === "melt_paid" || kind === "melt_unpaid_after_expiry") {
    return effectKind === "melt";
  }
  return true;
}

function evidenceTimeMatchesEffect(
  kind: string | undefined,
  evidenceAt: UnixTimestamp,
  effect: CashuOperatorEffectV1,
): boolean {
  return !(
    kind === "melt_unpaid_after_expiry" &&
    (effect.kind !== "melt" || evidenceAt < effect.operatorReferenceExpiresAt)
  );
}

function createEffectFingerprint(
  reservation: ReservationScope,
  effect: CashuOperatorEffectV1,
): string {
  return sha256({
    dispatchFingerprint: effect.dispatchFingerprint,
    effectId: effect.effectId,
    invoiceId: reservation.invoiceId,
    kind: effect.kind,
    mintUrl: reservation.mintUrl,
    operatorId: reservation.operatorId,
    operatorReference: effect.kind === "melt" ? effect.operatorReference : null,
    operatorReferenceExpiresAt: effect.kind === "melt" ? effect.operatorReferenceExpiresAt : null,
    paymentId: reservation.paymentId,
    schemaVersion: effect.schemaVersion,
    startedAt: effect.startedAt,
  });
}

function createEventFingerprint(draft: EventDraft, sequence: number): string {
  return sha256({
    effectId: draft.effectId ?? null,
    eventId: draft.eventId,
    evidenceAt: draft.evidenceAt ?? null,
    evidenceKind: draft.evidenceKind ?? null,
    ...(draft.journalEntryId === undefined ? {} : { journalEntryId: draft.journalEntryId }),
    paymentId: draft.paymentId,
    proofStateSnapshotFingerprint: draft.proofStateSnapshotFingerprint ?? null,
    recordedAt: draft.recordedAt,
    schemaVersion: CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
    sequence,
    state: draft.state,
  });
}

function createProofStateFingerprint(
  reservation: ReservationScope,
  snapshot: ReturnType<typeof createCashuProofStateSnapshotV1>,
): string {
  return sha256({
    mintUrl: snapshot.mintUrl,
    observedAt: snapshot.observedAt,
    operatorId: reservation.operatorId,
    paymentId: reservation.paymentId,
    schemaVersion: snapshot.schemaVersion,
    states: snapshot.states,
    unit: reservation.unit,
  });
}

function createAccountingFingerprint(
  reservation: ReservationScope,
  accounting: AcceptedInvoicePaymentV1,
): string {
  const payment = accounting.invoice.payment;
  return sha256({
    acceptedAt: payment.acceptedAt,
    assetAccount: storeAccount(payment.assetAccount),
    effectiveAt: accounting.journalEntry.effectiveAt,
    feeAmount: payment.feeAmount,
    grossAmount: payment.grossAmount,
    invoiceId: accounting.invoice.id,
    journalEntryId: accounting.journalEntry.id,
    merchantId: accounting.invoice.merchantId,
    mintUrl: reservation.mintUrl,
    netAmount: payment.netAmount,
    operatorId: payment.operatorId,
    paymentId: payment.paymentId,
    postings: accounting.journalEntry.postings.map((posting) => ({
      account: storeAccount(posting.account),
      amount: posting.amount,
      side: posting.side,
    })),
    schemaVersion: accounting.journalEntry.schemaVersion,
    settlementMode: payment.settlementMode,
    unit: accounting.journalEntry.unit,
  });
}

function assertAccountingMatchesInput(
  accounting: AcceptedInvoicePaymentV1,
  reservation: ReservationScope,
  input: AcceptCashuInvoicePaymentInput,
): void {
  const payment = accounting.invoice.payment;
  const account = storeAccount(payment.assetAccount);
  const expectedAccount = {
    id: STELLAR_TESTNET_USDC_SETTLEMENT_ASSET_ID,
    kind: "settlement_asset",
  };
  if (
    accounting.invoice.id !== reservation.invoiceId ||
    accounting.invoice.merchantId !== reservation.merchantId ||
    accounting.invoice.paidAt !== input.proofStateObservedAt ||
    accounting.journalEntry.effectiveAt !== input.recordedAt ||
    accounting.journalEntry.id !== input.journalEntryId ||
    payment.paymentId !== reservation.paymentId ||
    payment.operatorId !== reservation.operatorId ||
    payment.feeAmount !== input.feeAmount ||
    account.kind !== expectedAccount.kind ||
    account.id !== expectedAccount.id ||
    payment.settlementMode !== "immediate_conversion"
  ) {
    failAccountingConflict();
  }
}

function postingsMatch(
  rows: readonly PaymentPostingRow[],
  accounting: AcceptedInvoicePaymentV1,
): boolean {
  return (
    rows.length === accounting.journalEntry.postings.length &&
    rows.every((row, position) => {
      const posting = accounting.journalEntry.postings[position];
      if (posting === undefined) {
        return false;
      }
      const account = storeAccount(posting.account);
      return (
        row.journal_entry_id === accounting.journalEntry.id &&
        row.position === position &&
        row.side === posting.side &&
        row.account_kind === account.kind &&
        row.account_id === account.id &&
        parseSafeInteger(row.amount) === posting.amount
      );
    })
  );
}

function mapStoredAssetAccount(
  row: PaymentJournalRow,
): Extract<LedgerAccountV1, { readonly kind: "settlement_asset" }> {
  if (
    row.asset_account_kind === "settlement_asset" &&
    row.asset_account_id === STELLAR_TESTNET_USDC_SETTLEMENT_ASSET_ID
  ) {
    return settlementAssetAccount(STELLAR_TESTNET_USDC_SETTLEMENT_ASSET_ID);
  }
  return failInvalidRecord();
}

function storeAccount(account: LedgerAccountV1): {
  readonly id: string | null;
  readonly kind: string;
} {
  switch (account.kind) {
    case "operator_ecash":
      return { id: account.operatorId, kind: account.kind };
    case "settlement_asset":
      return { id: account.assetId, kind: account.kind };
    case "merchant_payable":
      return { id: account.merchantId, kind: account.kind };
    case "fee_revenue":
      return { id: null, kind: account.kind };
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function meltQuoteAttemptMatchesReservation(
  attempt: StoredCashuStellarMeltQuoteAttempt,
  reservation: ReservationScope,
): boolean {
  return (
    attempt.paymentId === reservation.paymentId &&
    attempt.invoiceId === reservation.invoiceId &&
    attempt.operatorId === reservation.operatorId &&
    attempt.mintUrl === reservation.mintUrl &&
    attempt.request.amount === reservation.amount &&
    attempt.request.unit === reservation.unit &&
    attempt.startedAt >= reservation.createdAt &&
    attempt.startedAt >= reservation.reservedAt &&
    attempt.startedAt < reservation.expiresAt
  );
}

function normalizeUnit(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_UNIT_LENGTH ||
    value !== value.trim() ||
    !UNIT_PATTERN.test(value)
  ) {
    throw new Error("Cashu reservation lifecycle unit is invalid.");
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

function mapValidationError(error: unknown): never {
  if (error instanceof CashuProofReservationLifecycleRepositoryError) {
    throw error;
  }
  return failInvalidInput();
}

function failInvalidInput(): never {
  throw new CashuProofReservationLifecycleRepositoryError(
    "invalid_input",
    "Cashu reservation lifecycle input is invalid.",
  );
}

function failAccountingConflict(): never {
  throw new CashuProofReservationLifecycleRepositoryError(
    "accounting_conflict",
    "Cashu payment accounting identity already has different terms.",
  );
}

function failInvalidRecord(): never {
  throw new CashuProofReservationLifecycleRepositoryError(
    "invalid_record",
    "Stored Cashu reservation lifecycle is invalid.",
  );
}

function failInvalidTransition(): never {
  throw new CashuProofReservationLifecycleRepositoryError(
    "invalid_transition",
    "Cashu reservation lifecycle transition is invalid.",
  );
}

function failEventConflict(): never {
  throw new CashuProofReservationLifecycleRepositoryError(
    "event_conflict",
    "Cashu reservation lifecycle event identifier already has different evidence.",
  );
}

function failEffectConflict(): never {
  throw new CashuProofReservationLifecycleRepositoryError(
    "effect_conflict",
    "Cashu operator effect identity is already bound to different evidence.",
  );
}

function mapStorageError(error: unknown): CashuProofReservationLifecycleRepositoryError {
  if (error instanceof CashuProofReservationLifecycleRepositoryError) {
    return error;
  }
  const databaseError = error as PostgresErrorShape;
  if (databaseError.code === "23505") {
    if (
      typeof databaseError.constraint === "string" &&
      databaseError.constraint.startsWith("merchant_invoice_payment_journals_")
    ) {
      return new CashuProofReservationLifecycleRepositoryError(
        "accounting_conflict",
        "Cashu payment accounting identity is already bound to another payment.",
      );
    }
    if (databaseError.constraint === "cashu_active_invoice_payment_claims_pkey") {
      return new CashuProofReservationLifecycleRepositoryError(
        "invoice_claimed",
        "Another Cashu payment already owns the invoice effect claim.",
      );
    }
    if (
      databaseError.constraint === "cashu_operator_effects_pkey" ||
      databaseError.constraint === "cashu_operator_effects_effect_fingerprint_key" ||
      databaseError.constraint === "cashu_operator_effects_payment_id_key" ||
      databaseError.constraint === "cashu_operator_effects_remote_reference_unique" ||
      databaseError.constraint === "cashu_operator_effects_dispatch_unique"
    ) {
      return new CashuProofReservationLifecycleRepositoryError(
        "effect_conflict",
        "Cashu operator effect identity is already bound to another operation.",
      );
    }
    if (
      databaseError.constraint === "cashu_proof_reservation_events_pkey" ||
      databaseError.constraint === "cashu_proof_reservation_events_event_fingerprint_key"
    ) {
      return new CashuProofReservationLifecycleRepositoryError(
        "event_conflict",
        "Cashu reservation lifecycle event identifier already has different evidence.",
      );
    }
  }
  return new CashuProofReservationLifecycleRepositoryError(
    "storage_unavailable",
    "Cashu reservation lifecycle storage operation failed.",
  );
}
