import { createHash } from "node:crypto";

import {
  CASHU_STELLAR_MELT_DISPATCH_SCHEMA_VERSION,
  CASHU_STELLAR_METHOD,
  CASHU_STELLAR_UNIT,
  type CashuKeysetSnapshotV1,
  type CashuStellarMeltDispatchV1,
  type CashuStellarMeltExecutionClient,
  CashuStellarMeltExecutionClientError,
  type CashuStellarMeltExecutionResultV1,
  type CashuStellarMeltQuoteV1,
  createCashuKeysetSnapshotV1,
  createCashuProofReferenceV1,
  createCashuStellarMeltQuoteV1,
  MAX_NUT18_PAYMENT_PROOFS,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import {
  invoiceId,
  minorUnits,
  operatorId,
  type PaymentId,
  paymentId,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";

import type { CashuKeysetRepository } from "./cashu-keyset-repository";
import type { CashuProofCustodyRepository } from "./cashu-proof-custody-repository";
import {
  type CashuOperatorAttentionReason,
  type CashuProofReservationLifecycleRepository,
  type CashuProofReservationLifecycleV1,
  cashuOperatorDispatchFingerprint,
  cashuOperatorEffectId,
  cashuOperatorReference,
  cashuReservationLifecycleEventId,
} from "./cashu-proof-reservation-lifecycle-repository";
import {
  CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
  type CashuProofReservationRepository,
  type CashuProofReservationV1,
} from "./cashu-proof-reservation-repository";
import {
  CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
  type CashuStellarMeltQuoteAttemptV1,
  type CashuStellarMeltQuoteRepository,
} from "./cashu-stellar-melt-quote-repository";

export const CASHU_STELLAR_MELT_COORDINATION_SCHEMA_VERSION = 1 as const;

const COORDINATION_ID_DOMAIN = "cashmesh.acquirer.stellar-melt-coordination.v1";
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export type CashuStellarMeltExecutor = Pick<CashuStellarMeltExecutionClient, "execute" | "mintUrl">;

export interface CashuStellarMeltCoordinatorDependencies {
  readonly custodyRepository: Pick<CashuProofCustodyRepository, "withDecryptedBundle">;
  readonly executors: readonly CashuStellarMeltExecutor[];
  readonly keysetRepository: Pick<CashuKeysetRepository, "findLatestFreshSnapshot">;
  readonly lifecycleRepository: Pick<
    CashuProofReservationLifecycleRepository,
    "findByPaymentId" | "recordPending" | "requireAttention" | "startEffect"
  >;
  readonly quoteRepository: Pick<CashuStellarMeltQuoteRepository, "findByPaymentId" | "observe">;
  readonly reservationRepository: Pick<CashuProofReservationRepository, "findByPaymentId">;
}

export interface CashuStellarMeltCoordinatorOptions {
  readonly clock?: () => number;
}

export interface DispatchCashuStellarMeltInput {
  readonly paymentId: string;
  readonly signal?: AbortSignal;
}

interface CashuStellarMeltCoordinationResultBaseV1 {
  readonly lifecycle: CashuProofReservationLifecycleV1;
  readonly paymentId: PaymentId;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_COORDINATION_SCHEMA_VERSION;
}

export type CashuStellarMeltCoordinationResultV1 =
  | (CashuStellarMeltCoordinationResultBaseV1 & {
      readonly state: "recovery_required";
    })
  | (CashuStellarMeltCoordinationResultBaseV1 & {
      readonly attentionReason: CashuOperatorAttentionReason;
      readonly state: "needs_attention";
    })
  | (CashuStellarMeltCoordinationResultBaseV1 & {
      readonly observedAt: UnixTimestamp;
      readonly state: "operator_unpaid" | "operator_pending" | "operator_paid_observed";
    });

export type CashuStellarMeltCoordinatorErrorCode =
  | "clock_unavailable"
  | "custody_not_found"
  | "evidence_invalid"
  | "invalid_configuration"
  | "invalid_request"
  | "keyset_evidence_missing"
  | "operator_not_configured"
  | "quote_not_dispatchable"
  | "request_aborted"
  | "reservation_not_found"
  | "storage_unavailable";

export class CashuStellarMeltCoordinatorError extends Error {
  override readonly name = "CashuStellarMeltCoordinatorError";

  constructor(
    readonly code: CashuStellarMeltCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface CoordinationIds {
  readonly effectId: ReturnType<typeof cashuOperatorEffectId>;
  readonly pendingEventId: ReturnType<typeof cashuReservationLifecycleEventId>;
  readonly startEventId: ReturnType<typeof cashuReservationLifecycleEventId>;
  attentionEventId(
    reason: CashuOperatorAttentionReason,
  ): ReturnType<typeof cashuReservationLifecycleEventId>;
}

export class CashuStellarMeltCoordinator {
  private readonly clock: () => number;
  private readonly custodyRepository: CashuStellarMeltCoordinatorDependencies["custodyRepository"];
  private readonly executors: ReadonlyMap<string, CashuStellarMeltExecutor>;
  private readonly keysetRepository: CashuStellarMeltCoordinatorDependencies["keysetRepository"];
  private readonly lifecycleRepository: CashuStellarMeltCoordinatorDependencies["lifecycleRepository"];
  private readonly quoteRepository: CashuStellarMeltCoordinatorDependencies["quoteRepository"];
  private readonly reservationRepository: CashuStellarMeltCoordinatorDependencies["reservationRepository"];

  constructor(
    dependencies: CashuStellarMeltCoordinatorDependencies,
    options: CashuStellarMeltCoordinatorOptions = {},
  ) {
    if (!validDependencies(dependencies) || !validOptions(options)) {
      throw invalidConfiguration();
    }
    const executors = new Map<string, CashuStellarMeltExecutor>();
    try {
      for (const executor of dependencies.executors) {
        const mintUrl = normalizeCashuMintUrl(executor.mintUrl);
        if (typeof executor.execute !== "function" || executors.has(mintUrl)) {
          throw invalidConfiguration();
        }
        executors.set(mintUrl, executor);
      }
    } catch {
      throw invalidConfiguration();
    }
    if (executors.size === 0) {
      throw invalidConfiguration();
    }

    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    this.custodyRepository = dependencies.custodyRepository;
    this.executors = executors;
    this.keysetRepository = dependencies.keysetRepository;
    this.lifecycleRepository = dependencies.lifecycleRepository;
    this.quoteRepository = dependencies.quoteRepository;
    this.reservationRepository = dependencies.reservationRepository;
  }

  async dispatch(
    input: DispatchCashuStellarMeltInput,
  ): Promise<CashuStellarMeltCoordinationResultV1> {
    const request = validateDispatchInput(input);
    if (request.signal?.aborted) {
      throw requestAborted();
    }
    const preparedAt = this.readClock();
    const reservation = await this.loadReservation(request.paymentId);
    const existingLifecycle = await this.loadLifecycle(request.paymentId);
    if (existingLifecycle.state !== "reserved" || existingLifecycle.effect !== undefined) {
      return coordinationResult(request.paymentId, existingLifecycle, "recovery_required");
    }

    const attempt = await this.loadQuoteAttempt(request.paymentId);
    const quote = requireDispatchableQuote(attempt, reservation, preparedAt);
    const snapshot = await this.loadExactKeysetSnapshot(reservation);
    const inputFee = deriveInputFee(reservation, snapshot, quote, preparedAt);
    const executor = this.executors.get(reservation.mintUrl);
    if (executor === undefined) {
      throw new CashuStellarMeltCoordinatorError(
        "operator_not_configured",
        "Cashu Stellar melt operator is not configured.",
      );
    }
    const ids = coordinationIds(reservation, quote);

    let freshLifecycle: CashuProofReservationLifecycleV1 | undefined;
    let replayedLifecycle: CashuProofReservationLifecycleV1 | undefined;
    let authorizedDispatch: CashuStellarMeltDispatchV1 | undefined;
    let execution: CashuStellarMeltExecutionResultV1 | undefined;
    try {
      execution = await this.custodyRepository.withDecryptedBundle(
        request.paymentId,
        async (bearerProofs) =>
          executor.execute({
            authorize: async (dispatch) => {
              validateDispatchAuthority(dispatch, quote, reservation.mintUrl);
              const startedAt = this.readClock();
              const currentInputFee = deriveInputFee(reservation, snapshot, quote, startedAt);
              if (currentInputFee !== inputFee) {
                throw evidenceInvalid();
              }
              const started = await this.startEffect({
                dispatch,
                ids,
                paymentId: request.paymentId,
                quote,
                startedAt,
              });
              if (started.replayed) {
                replayedLifecycle = started.lifecycle;
                return false;
              }
              freshLifecycle = started.lifecycle;
              authorizedDispatch = dispatch;
              return true;
            },
            bearerProofs,
            inputFee,
            quote,
            ...(request.signal !== undefined && { signal: request.signal }),
          }),
      );
    } catch (error) {
      if (replayedLifecycle !== undefined) {
        return coordinationResult(request.paymentId, replayedLifecycle, "recovery_required");
      }
      if (freshLifecycle !== undefined) {
        return await this.recordAttention(
          request.paymentId,
          freshLifecycle,
          ids,
          attentionReason(error),
        );
      }
      throw mapPreAuthorizationError(error);
    }

    if (execution === undefined) {
      if (freshLifecycle !== undefined) {
        return await this.recordAttention(
          request.paymentId,
          freshLifecycle,
          ids,
          "operator_state_unknown",
        );
      }
      throw new CashuStellarMeltCoordinatorError(
        "custody_not_found",
        "Cashu Stellar melt bearer custody was not found.",
      );
    }
    if (freshLifecycle === undefined || authorizedDispatch === undefined) {
      throw evidenceInvalid();
    }
    if (!executionMatchesAuthority(execution, authorizedDispatch, quote)) {
      return await this.recordAttention(
        request.paymentId,
        freshLifecycle,
        ids,
        "operator_response_invalid",
      );
    }

    try {
      const recordedAt = this.readClock();
      const effect = freshLifecycle.effect;
      if (
        effect === undefined ||
        effect.kind !== "melt" ||
        execution.quote.observedAt < effect.startedAt ||
        execution.quote.observedAt > recordedAt
      ) {
        throw clockUnavailable();
      }
      await this.quoteRepository.observe({
        attemptId: attempt.attemptId,
        paymentId: request.paymentId,
        quote: execution.quote,
      });
      if (execution.quote.state === "PENDING") {
        const pending = await this.lifecycleRepository.recordPending({
          effectId: effect.effectId,
          eventId: ids.pendingEventId,
          evidenceAt: execution.quote.observedAt,
          paymentId: request.paymentId,
          recordedAt,
        });
        return coordinationResult(
          request.paymentId,
          pending.lifecycle,
          "operator_pending",
          execution.quote.observedAt,
        );
      }
      return coordinationResult(
        request.paymentId,
        freshLifecycle,
        execution.quote.state === "PAID" ? "operator_paid_observed" : "operator_unpaid",
        execution.quote.observedAt,
      );
    } catch {
      return await this.recordAttention(
        request.paymentId,
        freshLifecycle,
        ids,
        "operator_state_unknown",
      );
    }
  }

  private readClock(): UnixTimestamp {
    try {
      return unixTimestamp(this.clock());
    } catch {
      throw clockUnavailable();
    }
  }

  private async loadReservation(requestedPaymentId: PaymentId): Promise<CashuProofReservationV1> {
    let found: CashuProofReservationV1 | undefined;
    try {
      found = await this.reservationRepository.findByPaymentId(requestedPaymentId);
    } catch {
      throw storageUnavailable();
    }
    if (found === undefined) {
      throw new CashuStellarMeltCoordinatorError(
        "reservation_not_found",
        "Cashu Stellar melt reservation was not found.",
      );
    }
    return validateReservation(found, requestedPaymentId);
  }

  private async loadLifecycle(
    requestedPaymentId: PaymentId,
  ): Promise<CashuProofReservationLifecycleV1> {
    let found: CashuProofReservationLifecycleV1 | undefined;
    try {
      found = await this.lifecycleRepository.findByPaymentId(requestedPaymentId);
    } catch {
      throw storageUnavailable();
    }
    if (found === undefined || found.paymentId !== requestedPaymentId) {
      throw evidenceInvalid();
    }
    return found;
  }

  private async loadQuoteAttempt(
    requestedPaymentId: PaymentId,
  ): Promise<CashuStellarMeltQuoteAttemptV1> {
    let found: CashuStellarMeltQuoteAttemptV1 | undefined;
    try {
      found = await this.quoteRepository.findByPaymentId(requestedPaymentId);
    } catch {
      throw storageUnavailable();
    }
    if (found === undefined) {
      throw quoteNotDispatchable();
    }
    return found;
  }

  private async loadExactKeysetSnapshot(
    reservation: CashuProofReservationV1,
  ): Promise<CashuKeysetSnapshotV1> {
    let found: CashuKeysetSnapshotV1 | undefined;
    try {
      found = await this.keysetRepository.findLatestFreshSnapshot({
        mintUrl: reservation.mintUrl,
        observedAtOrAfter: reservation.keysetObservedAt,
        observedAtOrBefore: reservation.keysetObservedAt,
        operatorId: reservation.operatorId,
        unit: reservation.unit,
      });
    } catch {
      throw storageUnavailable();
    }
    if (found === undefined) {
      throw new CashuStellarMeltCoordinatorError(
        "keyset_evidence_missing",
        "Cashu Stellar melt keyset evidence was not found.",
      );
    }
    try {
      return createCashuKeysetSnapshotV1(found);
    } catch {
      throw evidenceInvalid();
    }
  }

  private async startEffect(input: {
    readonly dispatch: CashuStellarMeltDispatchV1;
    readonly ids: CoordinationIds;
    readonly paymentId: PaymentId;
    readonly quote: CashuStellarMeltQuoteV1;
    readonly startedAt: UnixTimestamp;
  }) {
    try {
      return await this.lifecycleRepository.startEffect({
        dispatchFingerprint: cashuOperatorDispatchFingerprint(input.dispatch.dispatchFingerprint),
        effectId: input.ids.effectId,
        eventId: input.ids.startEventId,
        kind: "melt",
        operatorReference: cashuOperatorReference(input.quote.quoteId),
        operatorReferenceExpiresAt: input.quote.expiry,
        paymentId: input.paymentId,
        startedAt: input.startedAt,
      });
    } catch {
      throw storageUnavailable();
    }
  }

  private async recordAttention(
    requestedPaymentId: PaymentId,
    lifecycle: CashuProofReservationLifecycleV1,
    ids: CoordinationIds,
    reason: CashuOperatorAttentionReason,
  ): Promise<CashuStellarMeltCoordinationResultV1> {
    const effect = lifecycle.effect;
    if (effect === undefined || effect.kind !== "melt") {
      throw evidenceInvalid();
    }
    const recordedAt = this.readClock();
    if (recordedAt < effect.startedAt) {
      throw clockUnavailable();
    }
    try {
      const attention = await this.lifecycleRepository.requireAttention({
        effectId: effect.effectId,
        eventId: ids.attentionEventId(reason),
        evidenceAt: recordedAt,
        paymentId: requestedPaymentId,
        reason,
        recordedAt,
      });
      return Object.freeze({
        attentionReason: reason,
        lifecycle: attention.lifecycle,
        paymentId: requestedPaymentId,
        schemaVersion: CASHU_STELLAR_MELT_COORDINATION_SCHEMA_VERSION,
        state: "needs_attention",
      });
    } catch (error) {
      if (error instanceof CashuStellarMeltCoordinatorError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }
}

function validDependencies(
  value: CashuStellarMeltCoordinatorDependencies,
): value is CashuStellarMeltCoordinatorDependencies {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(value.executors) &&
    typeof value.custodyRepository?.withDecryptedBundle === "function" &&
    typeof value.keysetRepository?.findLatestFreshSnapshot === "function" &&
    typeof value.lifecycleRepository?.findByPaymentId === "function" &&
    typeof value.lifecycleRepository.recordPending === "function" &&
    typeof value.lifecycleRepository.requireAttention === "function" &&
    typeof value.lifecycleRepository.startEffect === "function" &&
    typeof value.quoteRepository?.findByPaymentId === "function" &&
    typeof value.quoteRepository.observe === "function" &&
    typeof value.reservationRepository?.findByPaymentId === "function"
  );
}

function validOptions(value: CashuStellarMeltCoordinatorOptions): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.clock === undefined || typeof value.clock === "function")
  );
}

function validateDispatchInput(input: DispatchCashuStellarMeltInput): {
  readonly paymentId: PaymentId;
  readonly signal?: AbortSignal;
} {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      throw invalidRequest();
    }
    return Object.freeze({
      paymentId: paymentId(input.paymentId),
      ...(input.signal !== undefined && { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof CashuStellarMeltCoordinatorError) {
      throw error;
    }
    throw invalidRequest();
  }
}

function validateReservation(
  reservation: CashuProofReservationV1,
  expectedPaymentId: PaymentId,
): CashuProofReservationV1 {
  try {
    if (
      typeof reservation !== "object" ||
      reservation === null ||
      Array.isArray(reservation) ||
      reservation.schemaVersion !== CASHU_PROOF_RESERVATION_SCHEMA_VERSION ||
      !Array.isArray(reservation.proofReferences) ||
      reservation.proofReferences.length === 0 ||
      reservation.proofReferences.length > MAX_NUT18_PAYMENT_PROOFS
    ) {
      throw evidenceInvalid();
    }
    const normalizedPaymentId = paymentId(reservation.paymentId);
    const normalizedInvoiceId = invoiceId(reservation.invoiceId);
    const normalizedOperatorId = operatorId(reservation.operatorId);
    const mintUrl = normalizeCashuMintUrl(reservation.mintUrl);
    const grossAmount = minorUnits(reservation.grossAmount);
    const keysetObservedAt = unixTimestamp(reservation.keysetObservedAt);
    const reservedAt = unixTimestamp(reservation.reservedAt);
    const proofReferences = reservation.proofReferences.map((reference) =>
      createCashuProofReferenceV1(reference),
    );
    const proofYs = new Set<string>();
    let previousY: string | undefined;
    let referenceTotal = 0n;
    for (const proof of proofReferences) {
      if (proofYs.has(proof.y) || (previousY !== undefined && previousY >= proof.y)) {
        throw evidenceInvalid();
      }
      proofYs.add(proof.y);
      previousY = proof.y;
      referenceTotal += BigInt(proof.amount);
    }
    if (
      normalizedPaymentId !== expectedPaymentId ||
      reservation.unit !== CASHU_STELLAR_UNIT ||
      keysetObservedAt > reservedAt ||
      referenceTotal !== BigInt(grossAmount)
    ) {
      throw evidenceInvalid();
    }
    return Object.freeze({
      grossAmount,
      invoiceId: normalizedInvoiceId,
      keysetObservedAt,
      mintUrl,
      operatorId: normalizedOperatorId,
      paymentId: normalizedPaymentId,
      proofReferences: Object.freeze(proofReferences),
      reservedAt,
      schemaVersion: CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
      unit: CASHU_STELLAR_UNIT,
    });
  } catch (error) {
    if (error instanceof CashuStellarMeltCoordinatorError) {
      throw error;
    }
    throw evidenceInvalid();
  }
}

function requireDispatchableQuote(
  attempt: CashuStellarMeltQuoteAttemptV1,
  reservation: CashuProofReservationV1,
  now: UnixTimestamp,
): CashuStellarMeltQuoteV1 {
  try {
    if (
      attempt.state !== "quoted" ||
      attempt.schemaVersion !== CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION ||
      attempt.paymentId !== reservation.paymentId ||
      attempt.invoiceId !== reservation.invoiceId ||
      attempt.operatorId !== reservation.operatorId ||
      normalizeCashuMintUrl(attempt.mintUrl) !== reservation.mintUrl ||
      attempt.request.method !== CASHU_STELLAR_METHOD ||
      attempt.request.unit !== CASHU_STELLAR_UNIT ||
      attempt.observations.length === 0
    ) {
      throw quoteNotDispatchable();
    }
    const quote = createCashuStellarMeltQuoteV1(attempt.latestQuote);
    const latest = attempt.observations.at(-1);
    if (
      latest === undefined ||
      !matchingQuoteSnapshots(quote, latest) ||
      quote.mintUrl !== reservation.mintUrl ||
      quote.amount !== attempt.request.amount ||
      quote.request !== attempt.request.request ||
      quote.state !== "UNPAID" ||
      quote.feeReserve !== 0 ||
      quote.observedAt > now ||
      now >= quote.expiry
    ) {
      throw quoteNotDispatchable();
    }
    return quote;
  } catch (error) {
    if (error instanceof CashuStellarMeltCoordinatorError) {
      throw error;
    }
    throw quoteNotDispatchable();
  }
}

function deriveInputFee(
  reservation: CashuProofReservationV1,
  rawSnapshot: CashuKeysetSnapshotV1,
  quote: CashuStellarMeltQuoteV1,
  evaluatedAt: UnixTimestamp,
): number {
  let snapshot: CashuKeysetSnapshotV1;
  try {
    snapshot = createCashuKeysetSnapshotV1(rawSnapshot);
  } catch {
    throw evidenceInvalid();
  }
  if (
    snapshot.mintUrl !== reservation.mintUrl ||
    snapshot.observedAt !== reservation.keysetObservedAt
  ) {
    throw evidenceInvalid();
  }

  const keysets = new Map(snapshot.keysets.map((keyset) => [keyset.id, keyset]));
  let feePpk = 0n;
  for (const proof of reservation.proofReferences) {
    const keyset = keysets.get(proof.keysetId);
    if (
      keyset === undefined ||
      keyset.unit !== reservation.unit ||
      keyset.keys[String(proof.amount)] === undefined ||
      (keyset.finalExpiry !== undefined && evaluatedAt >= keyset.finalExpiry)
    ) {
      throw evidenceInvalid();
    }
    feePpk += BigInt(keyset.inputFeePpk);
  }
  const inputFee = (feePpk + 999n) / 1_000n;
  if (
    inputFee > MAX_SAFE_INTEGER_BIGINT ||
    BigInt(quote.amount) + inputFee !== BigInt(reservation.grossAmount)
  ) {
    throw evidenceInvalid();
  }
  return Number(inputFee);
}

function validateDispatchAuthority(
  dispatch: CashuStellarMeltDispatchV1,
  quote: CashuStellarMeltQuoteV1,
  mintUrl: string,
): void {
  try {
    if (
      typeof dispatch !== "object" ||
      dispatch === null ||
      Array.isArray(dispatch) ||
      dispatch.schemaVersion !== CASHU_STELLAR_MELT_DISPATCH_SCHEMA_VERSION ||
      dispatch.method !== CASHU_STELLAR_METHOD ||
      normalizeCashuMintUrl(dispatch.mintUrl) !== mintUrl ||
      dispatch.quoteId !== quote.quoteId ||
      dispatch.expiresAt !== quote.expiry
    ) {
      throw evidenceInvalid();
    }
    cashuOperatorDispatchFingerprint(dispatch.dispatchFingerprint);
  } catch (error) {
    if (error instanceof CashuStellarMeltCoordinatorError) {
      throw error;
    }
    throw evidenceInvalid();
  }
}

function executionMatchesAuthority(
  execution: CashuStellarMeltExecutionResultV1,
  dispatch: CashuStellarMeltDispatchV1,
  expectedQuote: CashuStellarMeltQuoteV1,
): boolean {
  try {
    const quote = createCashuStellarMeltQuoteV1(execution.quote);
    return (
      execution.dispatch.dispatchFingerprint === dispatch.dispatchFingerprint &&
      execution.dispatch.quoteId === dispatch.quoteId &&
      execution.dispatch.mintUrl === dispatch.mintUrl &&
      execution.dispatch.expiresAt === dispatch.expiresAt &&
      execution.dispatch.method === dispatch.method &&
      execution.dispatch.schemaVersion === dispatch.schemaVersion &&
      matchingImmutableQuoteTerms(expectedQuote, quote)
    );
  } catch {
    return false;
  }
}

function matchingQuoteSnapshots(
  left: CashuStellarMeltQuoteV1,
  right: CashuStellarMeltQuoteV1,
): boolean {
  try {
    const normalized = createCashuStellarMeltQuoteV1(right);
    return (
      matchingImmutableQuoteTerms(left, normalized) &&
      left.observedAt === normalized.observedAt &&
      left.state === normalized.state
    );
  } catch {
    return false;
  }
}

function matchingImmutableQuoteTerms(
  left: CashuStellarMeltQuoteV1,
  right: CashuStellarMeltQuoteV1,
): boolean {
  return (
    left.amount === right.amount &&
    left.expiry === right.expiry &&
    left.feeReserve === right.feeReserve &&
    left.method === right.method &&
    left.mintUrl === right.mintUrl &&
    left.quoteId === right.quoteId &&
    left.request === right.request &&
    left.unit === right.unit
  );
}

function coordinationIds(
  reservation: CashuProofReservationV1,
  quote: CashuStellarMeltQuoteV1,
): CoordinationIds {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        domain: COORDINATION_ID_DOMAIN,
        mintUrl: reservation.mintUrl,
        paymentId: reservation.paymentId,
        quoteId: quote.quoteId,
      }),
    )
    .digest("hex");
  return Object.freeze({
    attentionEventId: (reason: CashuOperatorAttentionReason) =>
      cashuReservationLifecycleEventId(`stellar-melt-attention:${reason}:${fingerprint}`),
    effectId: cashuOperatorEffectId(`stellar-melt:${fingerprint}`),
    pendingEventId: cashuReservationLifecycleEventId(`stellar-melt-pending:${fingerprint}`),
    startEventId: cashuReservationLifecycleEventId(`stellar-melt-start:${fingerprint}`),
  });
}

function attentionReason(error: unknown): CashuOperatorAttentionReason {
  if (error instanceof CashuStellarMeltExecutionClientError) {
    if (
      error.code === "invalid_response" ||
      error.code === "quote_response_mismatch" ||
      error.code === "response_too_large"
    ) {
      return "operator_response_invalid";
    }
    if (
      error.code === "network_error" ||
      error.code === "request_aborted" ||
      error.code === "request_timeout" ||
      error.code === "unexpected_status"
    ) {
      return "transport_ambiguous";
    }
  }
  return "operator_state_unknown";
}

function mapPreAuthorizationError(error: unknown): CashuStellarMeltCoordinatorError {
  if (error instanceof CashuStellarMeltCoordinatorError) {
    return error;
  }
  if (error instanceof CashuStellarMeltExecutionClientError) {
    if (error.code === "request_aborted") {
      return requestAborted();
    }
    if (error.code === "quote_expired" || error.code === "unsupported_fee_reserve") {
      return quoteNotDispatchable();
    }
    if (error.code === "invalid_clock") {
      return clockUnavailable();
    }
    return evidenceInvalid();
  }
  return storageUnavailable();
}

function coordinationResult(
  requestedPaymentId: PaymentId,
  lifecycle: CashuProofReservationLifecycleV1,
  state: "operator_paid_observed" | "operator_pending" | "operator_unpaid" | "recovery_required",
  observedAt?: UnixTimestamp,
): CashuStellarMeltCoordinationResultV1 {
  if (state === "recovery_required") {
    return Object.freeze({
      lifecycle,
      paymentId: requestedPaymentId,
      schemaVersion: CASHU_STELLAR_MELT_COORDINATION_SCHEMA_VERSION,
      state,
    });
  }
  if (observedAt === undefined) {
    throw evidenceInvalid();
  }
  return Object.freeze({
    lifecycle,
    observedAt,
    paymentId: requestedPaymentId,
    schemaVersion: CASHU_STELLAR_MELT_COORDINATION_SCHEMA_VERSION,
    state,
  });
}

function invalidConfiguration(): CashuStellarMeltCoordinatorError {
  return new CashuStellarMeltCoordinatorError(
    "invalid_configuration",
    "Cashu Stellar melt coordinator configuration is invalid.",
  );
}

function invalidRequest(): CashuStellarMeltCoordinatorError {
  return new CashuStellarMeltCoordinatorError(
    "invalid_request",
    "Cashu Stellar melt dispatch request is invalid.",
  );
}

function requestAborted(): CashuStellarMeltCoordinatorError {
  return new CashuStellarMeltCoordinatorError(
    "request_aborted",
    "Cashu Stellar melt dispatch was aborted.",
  );
}

function quoteNotDispatchable(): CashuStellarMeltCoordinatorError {
  return new CashuStellarMeltCoordinatorError(
    "quote_not_dispatchable",
    "Cashu Stellar melt quote is not dispatchable.",
  );
}

function evidenceInvalid(): CashuStellarMeltCoordinatorError {
  return new CashuStellarMeltCoordinatorError(
    "evidence_invalid",
    "Cashu Stellar melt evidence is invalid.",
  );
}

function clockUnavailable(): CashuStellarMeltCoordinatorError {
  return new CashuStellarMeltCoordinatorError(
    "clock_unavailable",
    "Cashu Stellar melt coordinator clock is unavailable.",
  );
}

function storageUnavailable(): CashuStellarMeltCoordinatorError {
  return new CashuStellarMeltCoordinatorError(
    "storage_unavailable",
    "Cashu Stellar melt coordination storage is unavailable.",
  );
}
