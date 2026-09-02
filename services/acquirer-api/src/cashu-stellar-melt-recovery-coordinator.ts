import { createHash } from "node:crypto";

import {
  CASHU_STELLAR_UNIT,
  CashuMintProofStateHttpError,
  type CashuProofReferenceV1,
  CashuProofStateObservationError,
  type CashuProofStateSnapshotV1,
  type CashuProofStateValue,
  type CashuStellarMeltQuoteCheckOptions,
  CashuStellarMeltQuoteClientError,
  type CashuStellarMeltQuoteV1,
  createCashuProofReferenceV1,
  createCashuProofStateSnapshotV1,
  createCashuStellarMeltQuoteV1,
  MAX_NUT18_PAYMENT_PROOFS,
  normalizeCashuMintUrl,
} from "@cashmesh/cashu";
import {
  type AcceptedInvoicePaymentV1,
  invoiceId,
  journalEntryId,
  minorUnits,
  operatorId,
  type PaymentId,
  paymentId,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";

import {
  CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION,
  type CashuOperatorAttentionReason,
  type CashuOperatorEffectV1,
  type CashuProofReservationLifecycleRepository,
  CashuProofReservationLifecycleRepositoryError,
  type CashuProofReservationLifecycleV1,
  cashuReservationLifecycleEventId,
} from "./cashu-proof-reservation-lifecycle-repository";
import {
  CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
  type CashuProofReservationRepository,
  type CashuProofReservationV1,
} from "./cashu-proof-reservation-repository";
import type { CashuProofStateRepository } from "./cashu-proof-state-repository";
import {
  CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION,
  type CashuStellarMeltQuoteAttemptV1,
  type CashuStellarMeltQuoteRepository,
} from "./cashu-stellar-melt-quote-repository";

export const CASHU_STELLAR_MELT_RECOVERY_SCHEMA_VERSION = 1 as const;

const RECOVERY_ID_DOMAIN = "cashmesh.acquirer.stellar-melt-recovery.v1";

export interface CashuStellarMeltQuoteChecker {
  readonly mintUrl: string;
  check(
    quote: CashuStellarMeltQuoteV1,
    options?: CashuStellarMeltQuoteCheckOptions,
  ): Promise<CashuStellarMeltQuoteV1>;
}

export interface CashuProofStateRecoveryObserver {
  readonly mintUrl: string;
  observe(input: {
    readonly proofReferences: readonly CashuProofReferenceV1[];
    readonly signal?: AbortSignal;
  }): Promise<CashuProofStateSnapshotV1>;
}

export interface CashuStellarMeltRecoveryCoordinatorDependencies {
  readonly lifecycleRepository: Pick<
    CashuProofReservationLifecycleRepository,
    | "acceptPayment"
    | "findAcceptedPaymentByPaymentId"
    | "findByPaymentId"
    | "recordPending"
    | "release"
    | "requireAttention"
  >;
  readonly proofStateObservers: readonly CashuProofStateRecoveryObserver[];
  readonly proofStateRepository: Pick<CashuProofStateRepository, "persistObservation">;
  readonly quoteCheckers: readonly CashuStellarMeltQuoteChecker[];
  readonly quoteRepository: Pick<CashuStellarMeltQuoteRepository, "findByPaymentId" | "observe">;
  readonly reservationRepository: Pick<CashuProofReservationRepository, "findByPaymentId">;
}

export interface CashuStellarMeltRecoveryCoordinatorOptions {
  readonly clock?: () => number;
}

export interface RecoverCashuStellarMeltInput {
  readonly paymentId: string;
  readonly signal?: AbortSignal;
}

interface CashuStellarMeltRecoveryResultBaseV1 {
  readonly lifecycle: CashuProofReservationLifecycleV1;
  readonly paymentId: PaymentId;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_RECOVERY_SCHEMA_VERSION;
}

export type CashuStellarMeltRecoveryResultV1 =
  | (CashuStellarMeltRecoveryResultBaseV1 & {
      readonly accounting: AcceptedInvoicePaymentV1;
      readonly replayed: boolean;
      readonly state: "accepted";
    })
  | (CashuStellarMeltRecoveryResultBaseV1 & {
      readonly replayed: boolean;
      readonly state: "released";
    })
  | (CashuStellarMeltRecoveryResultBaseV1 & {
      readonly proofStateObservedAt: UnixTimestamp;
      readonly quoteObservedAt: UnixTimestamp;
      readonly state: "pending";
    })
  | (CashuStellarMeltRecoveryResultBaseV1 & {
      readonly attentionReason: CashuOperatorAttentionReason;
      readonly state: "needs_attention";
    });

export type CashuStellarMeltRecoveryCoordinatorErrorCode =
  | "clock_unavailable"
  | "effect_not_recoverable"
  | "evidence_invalid"
  | "invalid_configuration"
  | "invalid_request"
  | "operator_not_configured"
  | "quote_evidence_missing"
  | "request_aborted"
  | "reservation_not_found"
  | "storage_unavailable";

export class CashuStellarMeltRecoveryCoordinatorError extends Error {
  override readonly name = "CashuStellarMeltRecoveryCoordinatorError";

  constructor(
    readonly code: CashuStellarMeltRecoveryCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface RecoveryContext {
  readonly attempt: Extract<CashuStellarMeltQuoteAttemptV1, { readonly state: "quoted" }>;
  readonly effect: Extract<CashuOperatorEffectV1, { readonly kind: "melt" }>;
  readonly lifecycle: CashuProofReservationLifecycleV1;
  readonly paymentId: PaymentId;
  readonly reservation: CashuProofReservationV1;
}

interface ExpectedRecoveryEvent {
  readonly evidenceAt: UnixTimestamp;
  readonly evidenceKind: CashuOperatorAttentionReason | "operator_pending";
  readonly eventId: ReturnType<typeof cashuReservationLifecycleEventId>;
  readonly state: "needs_attention" | "pending";
}

type ReloadedRecovery =
  | {
      readonly kind: "equivalent_event";
      readonly lifecycle: CashuProofReservationLifecycleV1;
    }
  | {
      readonly kind: "terminal";
      readonly result: CashuStellarMeltRecoveryResultV1;
    };

export class CashuStellarMeltRecoveryCoordinator {
  private readonly clock: () => number;
  private readonly lifecycleRepository: CashuStellarMeltRecoveryCoordinatorDependencies["lifecycleRepository"];
  private readonly proofStateObservers: ReadonlyMap<string, CashuProofStateRecoveryObserver>;
  private readonly proofStateRepository: CashuStellarMeltRecoveryCoordinatorDependencies["proofStateRepository"];
  private readonly quoteCheckers: ReadonlyMap<string, CashuStellarMeltQuoteChecker>;
  private readonly quoteRepository: CashuStellarMeltRecoveryCoordinatorDependencies["quoteRepository"];
  private readonly reservationRepository: CashuStellarMeltRecoveryCoordinatorDependencies["reservationRepository"];

  constructor(
    dependencies: CashuStellarMeltRecoveryCoordinatorDependencies,
    options: CashuStellarMeltRecoveryCoordinatorOptions = {},
  ) {
    if (!validDependencies(dependencies) || !validOptions(options)) {
      throw invalidConfiguration();
    }
    this.quoteCheckers = configuredByMint(dependencies.quoteCheckers);
    this.proofStateObservers = configuredByMint(dependencies.proofStateObservers);
    if (this.quoteCheckers.size === 0 || this.proofStateObservers.size === 0) {
      throw invalidConfiguration();
    }
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    this.lifecycleRepository = dependencies.lifecycleRepository;
    this.proofStateRepository = dependencies.proofStateRepository;
    this.quoteRepository = dependencies.quoteRepository;
    this.reservationRepository = dependencies.reservationRepository;
  }

  async recover(input: RecoverCashuStellarMeltInput): Promise<CashuStellarMeltRecoveryResultV1> {
    const request = validateRecoveryInput(input);
    if (request.signal?.aborted) {
      throw requestAborted();
    }

    const reservation = await this.loadReservation(request.paymentId);
    const lifecycle = await this.loadLifecycle(request.paymentId);
    const terminal = await this.terminalResult(request.paymentId, lifecycle);
    if (terminal !== undefined) {
      return terminal;
    }
    const effect = requireRecoverableEffect(lifecycle);
    const attempt = requireRecoverableAttempt(
      await this.loadQuoteAttempt(request.paymentId),
      reservation,
      effect,
    );
    const context = { attempt, effect, lifecycle, paymentId: request.paymentId, reservation };
    const quoteChecker = this.quoteCheckers.get(reservation.mintUrl);
    const proofStateObserver = this.proofStateObservers.get(reservation.mintUrl);
    if (quoteChecker === undefined || proofStateObserver === undefined) {
      throw new CashuStellarMeltRecoveryCoordinatorError(
        "operator_not_configured",
        "Cashu Stellar melt recovery operator is not configured.",
      );
    }

    let quote: CashuStellarMeltQuoteV1;
    try {
      quote = createCashuStellarMeltQuoteV1(
        await quoteChecker.check(attempt.latestQuote, {
          ...(request.signal !== undefined && { signal: request.signal }),
        }),
      );
      assertObservedQuote(quote, context);
    } catch (error) {
      return await this.handleObservationFailure(context, error, request.signal);
    }

    try {
      const stored = await this.quoteRepository.observe({
        attemptId: attempt.attemptId,
        paymentId: request.paymentId,
        quote,
      });
      const storedAttempt = requireRecoverableAttempt(stored.attempt, reservation, effect);
      if (!sameQuote(storedAttempt.latestQuote, quote)) {
        throw evidenceInvalid();
      }
    } catch {
      const terminal = await this.reloadTerminal(context.paymentId);
      if (terminal !== undefined) {
        return terminal;
      }
      return await this.recordAttention(context, "operator_state_unknown", quote.observedAt);
    }

    let proofState: CashuProofStateSnapshotV1;
    try {
      proofState = validateProofStateSnapshot(
        await proofStateObserver.observe({
          proofReferences: reservation.proofReferences,
          ...(request.signal !== undefined && { signal: request.signal }),
        }),
        reservation,
      );
    } catch (error) {
      return await this.handleObservationFailure(context, error, request.signal, quote.observedAt);
    }

    try {
      const stored = await this.proofStateRepository.persistObservation({
        operatorId: reservation.operatorId,
        paymentId: request.paymentId,
        snapshot: proofState,
        unit: reservation.unit,
      });
      const storedSnapshot = validateProofStateSnapshot(stored.snapshot, reservation);
      if (!sameProofStateSnapshot(storedSnapshot, proofState)) {
        throw evidenceInvalid();
      }
    } catch {
      const terminal = await this.reloadTerminal(context.paymentId);
      if (terminal !== undefined) {
        return terminal;
      }
      return await this.recordAttention(
        context,
        "operator_state_unknown",
        laterTimestamp(quote.observedAt, proofState.observedAt),
      );
    }

    const recordedAt = this.readClock();
    const latestRecordedAt = lifecycle.events.at(-1)?.recordedAt ?? effect.startedAt;
    if (
      quote.observedAt < effect.startedAt ||
      proofState.observedAt < quote.observedAt ||
      recordedAt < latestRecordedAt ||
      recordedAt < proofState.observedAt
    ) {
      throw clockUnavailable();
    }

    const proofStateValue = uniformProofState(proofState);
    if (quote.state === "PAID" && proofStateValue === "SPENT") {
      return await this.acceptPayment(context, quote, proofState, recordedAt);
    }
    if (
      quote.state === "UNPAID" &&
      quote.observedAt >= quote.expiry &&
      proofStateValue === "UNSPENT"
    ) {
      return await this.releaseReservation(context, quote, proofState, recordedAt);
    }
    if (
      (quote.state === "PENDING" &&
        (proofStateValue === "PENDING" || proofStateValue === "UNSPENT")) ||
      (quote.state === "UNPAID" && quote.observedAt < quote.expiry && proofStateValue === "UNSPENT")
    ) {
      return await this.pendingResult(context, quote, proofState, recordedAt);
    }
    return await this.recordAttention(
      context,
      "operator_state_unknown",
      laterTimestamp(quote.observedAt, proofState.observedAt),
      recordedAt,
    );
  }

  private readClock(): UnixTimestamp {
    try {
      return unixTimestamp(this.clock());
    } catch {
      throw clockUnavailable();
    }
  }

  private async loadReservation(requestedPaymentId: PaymentId): Promise<CashuProofReservationV1> {
    try {
      const found = await this.reservationRepository.findByPaymentId(requestedPaymentId);
      if (found === undefined) {
        throw new CashuStellarMeltRecoveryCoordinatorError(
          "reservation_not_found",
          "Cashu Stellar melt recovery reservation was not found.",
        );
      }
      return validateReservation(found, requestedPaymentId);
    } catch (error) {
      if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  private async loadLifecycle(
    requestedPaymentId: PaymentId,
  ): Promise<CashuProofReservationLifecycleV1> {
    try {
      const found = await this.lifecycleRepository.findByPaymentId(requestedPaymentId);
      if (
        found === undefined ||
        found.paymentId !== requestedPaymentId ||
        found.schemaVersion !== CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION
      ) {
        throw evidenceInvalid();
      }
      return found;
    } catch (error) {
      if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  private async loadQuoteAttempt(
    requestedPaymentId: PaymentId,
  ): Promise<CashuStellarMeltQuoteAttemptV1> {
    try {
      const found = await this.quoteRepository.findByPaymentId(requestedPaymentId);
      if (found === undefined) {
        throw new CashuStellarMeltRecoveryCoordinatorError(
          "quote_evidence_missing",
          "Cashu Stellar melt recovery quote evidence was not found.",
        );
      }
      return found;
    } catch (error) {
      if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  private async terminalResult(
    requestedPaymentId: PaymentId,
    lifecycle: CashuProofReservationLifecycleV1,
  ): Promise<CashuStellarMeltRecoveryResultV1 | undefined> {
    if (lifecycle.state === "released") {
      return recoveryResult(requestedPaymentId, lifecycle, "released", true);
    }
    if (lifecycle.state !== "consumed") {
      return undefined;
    }
    try {
      const accounting =
        await this.lifecycleRepository.findAcceptedPaymentByPaymentId(requestedPaymentId);
      if (accounting === undefined) {
        throw evidenceInvalid();
      }
      return recoveryResult(requestedPaymentId, lifecycle, "accepted", true, accounting);
    } catch (error) {
      if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
        throw error;
      }
      throw storageUnavailable();
    }
  }

  private async acceptPayment(
    context: RecoveryContext,
    quote: CashuStellarMeltQuoteV1,
    proofState: CashuProofStateSnapshotV1,
    recordedAt: UnixTimestamp,
  ): Promise<CashuStellarMeltRecoveryResultV1> {
    const ids = terminalIds(context);
    try {
      const accepted = await this.lifecycleRepository.acceptPayment({
        effectId: context.effect.effectId,
        eventId: ids.acceptedEventId,
        evidenceAt: quote.observedAt,
        evidenceKind: "melt_paid",
        feeAmount: minorUnits(0),
        journalEntryId: ids.journalEntryId,
        paymentId: context.paymentId,
        proofStateObservedAt: proofState.observedAt,
        recordedAt,
      });
      return recoveryResult(
        context.paymentId,
        accepted.lifecycle,
        "accepted",
        accepted.replayed,
        accepted.accounting,
      );
    } catch (error) {
      const terminal = await this.reloadTerminal(context.paymentId);
      if (terminal !== undefined) {
        return terminal;
      }
      if (error instanceof CashuProofReservationLifecycleRepositoryError) {
        return await this.recordAttention(
          context,
          "operator_state_unknown",
          proofState.observedAt,
          recordedAt,
        );
      }
      throw storageUnavailable();
    }
  }

  private async releaseReservation(
    context: RecoveryContext,
    quote: CashuStellarMeltQuoteV1,
    proofState: CashuProofStateSnapshotV1,
    recordedAt: UnixTimestamp,
  ): Promise<CashuStellarMeltRecoveryResultV1> {
    const ids = terminalIds(context);
    try {
      const released = await this.lifecycleRepository.release({
        effectId: context.effect.effectId,
        eventId: ids.releasedEventId,
        evidenceAt: quote.observedAt,
        evidenceKind: "melt_unpaid_after_expiry",
        kind: "after_failure",
        paymentId: context.paymentId,
        proofStateObservedAt: proofState.observedAt,
        recordedAt,
      });
      return recoveryResult(context.paymentId, released.lifecycle, "released", released.replayed);
    } catch (error) {
      const terminal = await this.reloadTerminal(context.paymentId);
      if (terminal !== undefined) {
        return terminal;
      }
      if (error instanceof CashuProofReservationLifecycleRepositoryError) {
        return await this.recordAttention(
          context,
          "operator_state_unknown",
          proofState.observedAt,
          recordedAt,
        );
      }
      throw storageUnavailable();
    }
  }

  private async pendingResult(
    context: RecoveryContext,
    quote: CashuStellarMeltQuoteV1,
    proofState: CashuProofStateSnapshotV1,
    recordedAt: UnixTimestamp,
  ): Promise<CashuStellarMeltRecoveryResultV1> {
    let lifecycle = context.lifecycle;
    if (quote.state === "PENDING") {
      const eventId = recoveryEventId(context, "pending", quote.observedAt);
      try {
        const pending = await this.lifecycleRepository.recordPending({
          effectId: context.effect.effectId,
          eventId,
          evidenceAt: quote.observedAt,
          paymentId: context.paymentId,
          recordedAt,
        });
        lifecycle = pending.lifecycle;
      } catch {
        const reloaded = await this.reloadAfterEventWrite(context.paymentId, {
          eventId,
          evidenceAt: quote.observedAt,
          evidenceKind: "operator_pending",
          state: "pending",
        });
        if (reloaded?.kind === "terminal") {
          return reloaded.result;
        }
        if (reloaded?.kind !== "equivalent_event") {
          throw storageUnavailable();
        }
        lifecycle = reloaded.lifecycle;
      }
    }
    return Object.freeze({
      lifecycle,
      paymentId: context.paymentId,
      proofStateObservedAt: proofState.observedAt,
      quoteObservedAt: quote.observedAt,
      schemaVersion: CASHU_STELLAR_MELT_RECOVERY_SCHEMA_VERSION,
      state: "pending",
    });
  }

  private async handleObservationFailure(
    context: RecoveryContext,
    error: unknown,
    signal: AbortSignal | undefined,
    evidenceAt?: UnixTimestamp,
  ): Promise<CashuStellarMeltRecoveryResultV1> {
    if (signal?.aborted || isObservationAbort(error)) {
      throw requestAborted();
    }
    return await this.recordAttention(
      context,
      observationFailureReason(error),
      evidenceAt ?? this.readClock(),
    );
  }

  private async recordAttention(
    context: RecoveryContext,
    reason: CashuOperatorAttentionReason,
    evidenceAt: UnixTimestamp,
    knownRecordedAt?: UnixTimestamp,
  ): Promise<CashuStellarMeltRecoveryResultV1> {
    const recordedAt = knownRecordedAt ?? this.readClock();
    const latestRecordedAt =
      context.lifecycle.events.at(-1)?.recordedAt ?? context.effect.startedAt;
    if (
      evidenceAt < context.effect.startedAt ||
      recordedAt < evidenceAt ||
      recordedAt < latestRecordedAt
    ) {
      throw clockUnavailable();
    }
    const eventId = recoveryEventId(context, `attention:${reason}`, evidenceAt);
    try {
      const attention = await this.lifecycleRepository.requireAttention({
        effectId: context.effect.effectId,
        eventId,
        evidenceAt,
        paymentId: context.paymentId,
        reason,
        recordedAt,
      });
      return Object.freeze({
        attentionReason: reason,
        lifecycle: attention.lifecycle,
        paymentId: context.paymentId,
        schemaVersion: CASHU_STELLAR_MELT_RECOVERY_SCHEMA_VERSION,
        state: "needs_attention",
      });
    } catch {
      const reloaded = await this.reloadAfterEventWrite(context.paymentId, {
        eventId,
        evidenceAt,
        evidenceKind: reason,
        state: "needs_attention",
      });
      if (reloaded?.kind === "terminal") {
        return reloaded.result;
      }
      if (reloaded?.kind === "equivalent_event") {
        return Object.freeze({
          attentionReason: reason,
          lifecycle: reloaded.lifecycle,
          paymentId: context.paymentId,
          schemaVersion: CASHU_STELLAR_MELT_RECOVERY_SCHEMA_VERSION,
          state: "needs_attention",
        });
      }
      throw storageUnavailable();
    }
  }

  private async reloadAfterEventWrite(
    requestedPaymentId: PaymentId,
    expected?: ExpectedRecoveryEvent,
  ): Promise<ReloadedRecovery | undefined> {
    try {
      const lifecycle = await this.lifecycleRepository.findByPaymentId(requestedPaymentId);
      if (
        lifecycle === undefined ||
        lifecycle.paymentId !== requestedPaymentId ||
        lifecycle.schemaVersion !== CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION
      ) {
        return undefined;
      }
      const terminal = await this.terminalResult(requestedPaymentId, lifecycle);
      if (terminal !== undefined) {
        return Object.freeze({ kind: "terminal", result: terminal });
      }
      const event = lifecycle.events.at(-1);
      if (
        expected === undefined ||
        lifecycle.state !== expected.state ||
        event?.eventId !== expected.eventId ||
        event.state !== expected.state ||
        event.evidenceKind !== expected.evidenceKind ||
        event.evidenceAt !== expected.evidenceAt
      ) {
        return undefined;
      }
      return Object.freeze({ kind: "equivalent_event", lifecycle });
    } catch {
      return undefined;
    }
  }

  private async reloadTerminal(
    requestedPaymentId: PaymentId,
  ): Promise<CashuStellarMeltRecoveryResultV1 | undefined> {
    const reloaded = await this.reloadAfterEventWrite(requestedPaymentId);
    return reloaded?.kind === "terminal" ? reloaded.result : undefined;
  }
}

function validDependencies(value: CashuStellarMeltRecoveryCoordinatorDependencies): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(value.quoteCheckers) &&
    Array.isArray(value.proofStateObservers) &&
    value.quoteCheckers.every(
      (checker) =>
        typeof checker === "object" && checker !== null && typeof checker.check === "function",
    ) &&
    value.proofStateObservers.every(
      (observer) =>
        typeof observer === "object" && observer !== null && typeof observer.observe === "function",
    ) &&
    typeof value.lifecycleRepository?.acceptPayment === "function" &&
    typeof value.lifecycleRepository.findAcceptedPaymentByPaymentId === "function" &&
    typeof value.lifecycleRepository.findByPaymentId === "function" &&
    typeof value.lifecycleRepository.recordPending === "function" &&
    typeof value.lifecycleRepository.release === "function" &&
    typeof value.lifecycleRepository.requireAttention === "function" &&
    typeof value.proofStateRepository?.persistObservation === "function" &&
    typeof value.quoteRepository?.findByPaymentId === "function" &&
    typeof value.quoteRepository.observe === "function" &&
    typeof value.reservationRepository?.findByPaymentId === "function"
  );
}

function validOptions(value: CashuStellarMeltRecoveryCoordinatorOptions): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.clock === undefined || typeof value.clock === "function")
  );
}

function configuredByMint<T extends { readonly mintUrl: string }>(
  values: readonly T[],
): Map<string, T> {
  const configured = new Map<string, T>();
  try {
    for (const value of values) {
      const mintUrl = normalizeCashuMintUrl(value.mintUrl);
      if (configured.has(mintUrl)) {
        throw invalidConfiguration();
      }
      configured.set(mintUrl, value);
    }
    return configured;
  } catch (error) {
    if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
      throw error;
    }
    throw invalidConfiguration();
  }
}

function validateRecoveryInput(input: RecoverCashuStellarMeltInput): {
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
    if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
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
      reservation.unit !== CASHU_STELLAR_UNIT ||
      !Array.isArray(reservation.proofReferences) ||
      reservation.proofReferences.length === 0 ||
      reservation.proofReferences.length > MAX_NUT18_PAYMENT_PROOFS
    ) {
      throw evidenceInvalid();
    }
    const proofReferences = reservation.proofReferences.map((proof) =>
      createCashuProofReferenceV1(proof),
    );
    let previousY: string | undefined;
    let total = 0n;
    for (const proof of proofReferences) {
      if (previousY !== undefined && previousY >= proof.y) {
        throw evidenceInvalid();
      }
      previousY = proof.y;
      total += BigInt(proof.amount);
    }
    const normalized = Object.freeze({
      grossAmount: minorUnits(reservation.grossAmount),
      invoiceId: invoiceId(reservation.invoiceId),
      keysetObservedAt: unixTimestamp(reservation.keysetObservedAt),
      mintUrl: normalizeCashuMintUrl(reservation.mintUrl),
      operatorId: operatorId(reservation.operatorId),
      paymentId: paymentId(reservation.paymentId),
      proofReferences: Object.freeze(proofReferences),
      reservedAt: unixTimestamp(reservation.reservedAt),
      schemaVersion: CASHU_PROOF_RESERVATION_SCHEMA_VERSION,
      unit: CASHU_STELLAR_UNIT,
    });
    if (
      normalized.paymentId !== expectedPaymentId ||
      total !== BigInt(normalized.grossAmount) ||
      normalized.keysetObservedAt > normalized.reservedAt
    ) {
      throw evidenceInvalid();
    }
    return normalized;
  } catch (error) {
    if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
      throw error;
    }
    throw evidenceInvalid();
  }
}

function requireRecoverableEffect(
  lifecycle: CashuProofReservationLifecycleV1,
): Extract<CashuOperatorEffectV1, { readonly kind: "melt" }> {
  const effect = lifecycle.effect;
  if (
    effect === undefined ||
    effect.kind !== "melt" ||
    !["dispatch_started", "pending", "needs_attention"].includes(lifecycle.state)
  ) {
    throw new CashuStellarMeltRecoveryCoordinatorError(
      "effect_not_recoverable",
      "Cashu Stellar melt recovery requires an active melt effect.",
    );
  }
  return effect;
}

function requireRecoverableAttempt(
  attempt: CashuStellarMeltQuoteAttemptV1,
  reservation: CashuProofReservationV1,
  effect: Extract<CashuOperatorEffectV1, { readonly kind: "melt" }>,
): Extract<CashuStellarMeltQuoteAttemptV1, { readonly state: "quoted" }> {
  try {
    if (
      attempt.state !== "quoted" ||
      attempt.schemaVersion !== CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION ||
      attempt.paymentId !== reservation.paymentId ||
      attempt.invoiceId !== reservation.invoiceId ||
      attempt.operatorId !== reservation.operatorId ||
      normalizeCashuMintUrl(attempt.mintUrl) !== reservation.mintUrl ||
      attempt.request.unit !== CASHU_STELLAR_UNIT ||
      attempt.observations.length === 0
    ) {
      throw evidenceInvalid();
    }
    const latestQuote = createCashuStellarMeltQuoteV1(attempt.latestQuote);
    const latestObservation = attempt.observations.at(-1);
    if (
      latestObservation === undefined ||
      !sameQuote(latestQuote, createCashuStellarMeltQuoteV1(latestObservation)) ||
      String(latestQuote.quoteId) !== String(effect.operatorReference) ||
      latestQuote.expiry !== effect.operatorReferenceExpiresAt ||
      latestQuote.mintUrl !== reservation.mintUrl ||
      attempt.startedAt > effect.startedAt ||
      effect.startedAt >= latestQuote.expiry
    ) {
      throw evidenceInvalid();
    }
    return attempt;
  } catch (error) {
    if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
      throw error;
    }
    throw evidenceInvalid();
  }
}

function assertObservedQuote(quote: CashuStellarMeltQuoteV1, context: RecoveryContext): void {
  if (!sameImmutableQuoteTerms(quote, context.attempt.latestQuote)) {
    throw evidenceInvalid();
  }
  const lastObservedAt = context.attempt.observations.at(-1)?.observedAt;
  if (
    lastObservedAt === undefined ||
    quote.observedAt < lastObservedAt ||
    (quote.observedAt === lastObservedAt && !sameQuote(quote, context.attempt.latestQuote))
  ) {
    throw evidenceInvalid();
  }
}

function validateProofStateSnapshot(
  input: CashuProofStateSnapshotV1,
  reservation: CashuProofReservationV1,
): CashuProofStateSnapshotV1 {
  try {
    const snapshot = createCashuProofStateSnapshotV1(input);
    if (
      snapshot.mintUrl !== reservation.mintUrl ||
      snapshot.states.length !== reservation.proofReferences.length ||
      !snapshot.states.every(
        (state, position) => state.y === reservation.proofReferences[position]?.y,
      )
    ) {
      throw evidenceInvalid();
    }
    return snapshot;
  } catch (error) {
    if (error instanceof CashuStellarMeltRecoveryCoordinatorError) {
      throw error;
    }
    throw evidenceInvalid();
  }
}

function uniformProofState(snapshot: CashuProofStateSnapshotV1): CashuProofStateValue | "MIXED" {
  const first = snapshot.states[0]?.state;
  if (first === undefined || !snapshot.states.every((state) => state.state === first)) {
    return "MIXED";
  }
  return first;
}

function sameProofStateSnapshot(
  left: CashuProofStateSnapshotV1,
  right: CashuProofStateSnapshotV1,
): boolean {
  return (
    left.mintUrl === right.mintUrl &&
    left.observedAt === right.observedAt &&
    left.states.length === right.states.length &&
    left.states.every(
      (state, position) =>
        state.y === right.states[position]?.y && state.state === right.states[position]?.state,
    )
  );
}

function sameQuote(left: CashuStellarMeltQuoteV1, right: CashuStellarMeltQuoteV1): boolean {
  return (
    sameImmutableQuoteTerms(left, right) &&
    left.observedAt === right.observedAt &&
    left.state === right.state
  );
}

function sameImmutableQuoteTerms(
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

function terminalIds(context: RecoveryContext): {
  readonly acceptedEventId: ReturnType<typeof cashuReservationLifecycleEventId>;
  readonly journalEntryId: ReturnType<typeof journalEntryId>;
  readonly releasedEventId: ReturnType<typeof cashuReservationLifecycleEventId>;
} {
  const fingerprint = recoveryFingerprint(context);
  return Object.freeze({
    acceptedEventId: cashuReservationLifecycleEventId(
      `stellar-melt-recovery-accepted:${fingerprint}`,
    ),
    journalEntryId: journalEntryId(`stellar-melt-payment:${fingerprint}`),
    releasedEventId: cashuReservationLifecycleEventId(
      `stellar-melt-recovery-released:${fingerprint}`,
    ),
  });
}

function recoveryEventId(
  context: RecoveryContext,
  kind: string,
  evidenceAt: UnixTimestamp,
): ReturnType<typeof cashuReservationLifecycleEventId> {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        evidenceAt,
        kind,
        recoveryFingerprint: recoveryFingerprint(context),
      }),
    )
    .digest("hex");
  return cashuReservationLifecycleEventId(`stellar-melt-recovery:${fingerprint}`);
}

function recoveryFingerprint(context: RecoveryContext): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        domain: RECOVERY_ID_DOMAIN,
        effectId: context.effect.effectId,
        mintUrl: context.reservation.mintUrl,
        paymentId: context.paymentId,
        quoteId: context.attempt.latestQuote.quoteId,
      }),
    )
    .digest("hex");
}

function isObservationAbort(error: unknown): boolean {
  return (
    (error instanceof CashuStellarMeltQuoteClientError && error.code === "request_aborted") ||
    (error instanceof CashuProofStateObservationError && error.code === "observation_aborted") ||
    (error instanceof CashuMintProofStateHttpError && error.code === "request_aborted")
  );
}

function observationFailureReason(error: unknown): CashuOperatorAttentionReason {
  if (
    (error instanceof CashuStellarMeltQuoteClientError &&
      ["invalid_response", "quote_response_mismatch", "response_too_large"].includes(error.code)) ||
    (error instanceof CashuProofStateObservationError &&
      ["invalid_state_response", "state_response_mismatch"].includes(error.code)) ||
    (error instanceof CashuMintProofStateHttpError &&
      ["invalid_response", "response_too_large"].includes(error.code)) ||
    error instanceof CashuStellarMeltRecoveryCoordinatorError
  ) {
    return "operator_response_invalid";
  }
  return "operator_state_unknown";
}

function laterTimestamp(left: UnixTimestamp, right: UnixTimestamp): UnixTimestamp {
  return left >= right ? left : right;
}

function recoveryResult(
  requestedPaymentId: PaymentId,
  lifecycle: CashuProofReservationLifecycleV1,
  state: "accepted" | "released",
  replayed: boolean,
  accounting?: AcceptedInvoicePaymentV1,
): CashuStellarMeltRecoveryResultV1 {
  if (state === "accepted") {
    if (accounting === undefined) {
      throw evidenceInvalid();
    }
    return Object.freeze({
      accounting,
      lifecycle,
      paymentId: requestedPaymentId,
      replayed,
      schemaVersion: CASHU_STELLAR_MELT_RECOVERY_SCHEMA_VERSION,
      state,
    });
  }
  return Object.freeze({
    lifecycle,
    paymentId: requestedPaymentId,
    replayed,
    schemaVersion: CASHU_STELLAR_MELT_RECOVERY_SCHEMA_VERSION,
    state,
  });
}

function invalidConfiguration(): CashuStellarMeltRecoveryCoordinatorError {
  return new CashuStellarMeltRecoveryCoordinatorError(
    "invalid_configuration",
    "Cashu Stellar melt recovery configuration is invalid.",
  );
}

function invalidRequest(): CashuStellarMeltRecoveryCoordinatorError {
  return new CashuStellarMeltRecoveryCoordinatorError(
    "invalid_request",
    "Cashu Stellar melt recovery request is invalid.",
  );
}

function requestAborted(): CashuStellarMeltRecoveryCoordinatorError {
  return new CashuStellarMeltRecoveryCoordinatorError(
    "request_aborted",
    "Cashu Stellar melt recovery observation was aborted.",
  );
}

function evidenceInvalid(): CashuStellarMeltRecoveryCoordinatorError {
  return new CashuStellarMeltRecoveryCoordinatorError(
    "evidence_invalid",
    "Cashu Stellar melt recovery evidence is invalid.",
  );
}

function clockUnavailable(): CashuStellarMeltRecoveryCoordinatorError {
  return new CashuStellarMeltRecoveryCoordinatorError(
    "clock_unavailable",
    "Cashu Stellar melt recovery clock is unavailable.",
  );
}

function storageUnavailable(): CashuStellarMeltRecoveryCoordinatorError {
  return new CashuStellarMeltRecoveryCoordinatorError(
    "storage_unavailable",
    "Cashu Stellar melt recovery storage is unavailable.",
  );
}
