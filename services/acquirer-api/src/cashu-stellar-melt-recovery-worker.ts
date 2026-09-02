import { randomUUID } from "node:crypto";

import { type PaymentId, type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";
import {
  type CashuStellarMeltRecoveryCoordinator,
  CashuStellarMeltRecoveryCoordinatorError,
  type CashuStellarMeltRecoveryResultV1,
} from "./cashu-stellar-melt-recovery-coordinator";
import {
  type CashuStellarMeltRecoveryAttentionReason,
  type CashuStellarMeltRecoveryJobRepository,
  CashuStellarMeltRecoveryJobRepositoryError,
  type CashuStellarMeltRecoveryLeaseOutcomeV1,
  type CashuStellarMeltRecoveryLeaseToken,
  type CashuStellarMeltRecoveryLeaseV1,
  type CashuStellarMeltRecoveryRetryReason,
  cashuStellarMeltRecoveryLeaseToken,
} from "./cashu-stellar-melt-recovery-job-repository";

export const DEFAULT_CASHU_STELLAR_MELT_RECOVERY_ATTEMPT_TIMEOUT_MS = 65_000 as const;
export const DEFAULT_CASHU_STELLAR_MELT_RECOVERY_LEASE_SECONDS = 90 as const;
export const DEFAULT_CASHU_STELLAR_MELT_RECOVERY_MAX_ATTEMPTS = 6 as const;
export const DEFAULT_CASHU_STELLAR_MELT_RECOVERY_RETRY_BASE_SECONDS = 30 as const;
export const DEFAULT_CASHU_STELLAR_MELT_RECOVERY_RETRY_MAX_SECONDS = 300 as const;

const MAX_ATTEMPT_TIMEOUT_MS = 120_000;
const MAX_LEASE_SECONDS = 300;
const MAX_RECOVERY_ATTEMPTS = 32;
const MAX_RETRY_SECONDS = 3_600;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CashuStellarMeltRecoveryWorkerDependencies {
  readonly coordinator: Pick<CashuStellarMeltRecoveryCoordinator, "recover">;
  readonly jobRepository: Pick<
    CashuStellarMeltRecoveryJobRepository,
    "claimNext" | "findByPaymentId" | "recordOutcome"
  >;
}

export interface CashuStellarMeltRecoveryWorkerOptions {
  readonly attemptTimeoutMs?: number;
  readonly clock?: () => number;
  readonly leaseDurationSeconds?: number;
  readonly leaseTokenFactory?: () => string;
  readonly maxAttempts?: number;
  readonly retryBaseSeconds?: number;
  readonly retryMaxSeconds?: number;
  readonly workerId: string;
}

export interface RunCashuStellarMeltRecoveryWorkerInput {
  readonly signal?: AbortSignal;
}

export type CashuStellarMeltRecoveryWorkerResultV1 =
  | { readonly state: "idle" }
  | {
      readonly lease: CashuStellarMeltRecoveryLeaseV1;
      readonly paymentId: PaymentId;
      readonly state: "accepted" | "released";
    }
  | {
      readonly lease: CashuStellarMeltRecoveryLeaseV1;
      readonly nextAttemptAt: UnixTimestamp;
      readonly paymentId: PaymentId;
      readonly reason: CashuStellarMeltRecoveryRetryReason;
      readonly state: "retry_scheduled";
    }
  | {
      readonly lease: CashuStellarMeltRecoveryLeaseV1;
      readonly paymentId: PaymentId;
      readonly reason: CashuStellarMeltRecoveryAttentionReason;
      readonly state: "attention_required";
    };

export type CashuStellarMeltRecoveryWorkerErrorCode =
  | "clock_unavailable"
  | "invalid_configuration"
  | "invalid_request"
  | "lease_lost"
  | "request_aborted"
  | "storage_unavailable";

export class CashuStellarMeltRecoveryWorkerError extends Error {
  override readonly name = "CashuStellarMeltRecoveryWorkerError";

  constructor(
    readonly code: CashuStellarMeltRecoveryWorkerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface RecoveryWorkerPolicy {
  readonly attemptTimeoutMs: number;
  readonly leaseDurationSeconds: number;
  readonly maxAttempts: number;
  readonly retryBaseSeconds: number;
  readonly retryMaxSeconds: number;
  readonly workerId: string;
}

export class CashuStellarMeltRecoveryWorker {
  private readonly clock: () => number;
  private readonly coordinator: CashuStellarMeltRecoveryWorkerDependencies["coordinator"];
  private readonly jobRepository: CashuStellarMeltRecoveryWorkerDependencies["jobRepository"];
  private readonly leaseTokenFactory: () => string;
  private readonly policy: RecoveryWorkerPolicy;

  constructor(
    dependencies: CashuStellarMeltRecoveryWorkerDependencies,
    options: CashuStellarMeltRecoveryWorkerOptions,
  ) {
    if (!validDependencies(dependencies)) {
      throw invalidConfiguration();
    }
    this.policy = validatePolicy(options);
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    this.leaseTokenFactory = options.leaseTokenFactory ?? randomUUID;
    this.coordinator = dependencies.coordinator;
    this.jobRepository = dependencies.jobRepository;
  }

  async runOnce(
    input: RunCashuStellarMeltRecoveryWorkerInput = {},
  ): Promise<CashuStellarMeltRecoveryWorkerResultV1> {
    if (!validRunInput(input)) {
      throw invalidRequest();
    }
    if (input.signal?.aborted) {
      throw requestAborted();
    }

    const claimedAt = this.readClock();
    const expiresAt = addSeconds(claimedAt, this.policy.leaseDurationSeconds);
    let leaseToken: CashuStellarMeltRecoveryLeaseToken;
    try {
      leaseToken = cashuStellarMeltRecoveryLeaseToken(this.leaseTokenFactory());
    } catch {
      throw invalidConfiguration();
    }
    let lease: CashuStellarMeltRecoveryLeaseV1 | undefined;
    try {
      lease = await this.jobRepository.claimNext({
        claimedAt,
        expiresAt,
        leaseToken,
        workerId: this.policy.workerId,
      });
    } catch (error) {
      throw mapRepositoryError(error);
    }
    if (lease === undefined) {
      return Object.freeze({ state: "idle" });
    }
    if (lease.attemptNumber > this.policy.maxAttempts) {
      const recordedAt = this.readClock();
      if (recordedAt < lease.claimedAt || recordedAt > lease.expiresAt) {
        throw leaseLost();
      }
      return await this.persistOutcome(lease, attentionOutcome("retry_exhausted", recordedAt));
    }

    const attemptController = new AbortController();
    const timer = setTimeout(() => attemptController.abort(), this.policy.attemptTimeoutMs);
    timer.unref();
    const signal =
      input.signal === undefined
        ? attemptController.signal
        : AbortSignal.any([input.signal, attemptController.signal]);

    let result: CashuStellarMeltRecoveryResultV1 | undefined;
    let failure: unknown;
    try {
      result = await this.coordinator.recover({ paymentId: lease.paymentId, signal });
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }

    const recordedAt = this.readClock();
    if (recordedAt < lease.claimedAt || recordedAt > lease.expiresAt) {
      throw leaseLost();
    }
    const outcome = this.selectOutcome(lease, recordedAt, result, failure);
    return await this.persistOutcome(lease, outcome);
  }

  private selectOutcome(
    lease: CashuStellarMeltRecoveryLeaseV1,
    recordedAt: UnixTimestamp,
    result: CashuStellarMeltRecoveryResultV1 | undefined,
    failure: unknown,
  ): CashuStellarMeltRecoveryLeaseOutcomeV1 {
    if (result !== undefined) {
      if (result.paymentId !== lease.paymentId) {
        return attentionOutcome("evidence_invalid", recordedAt);
      }
      if (result.state === "accepted" || result.state === "released") {
        return Object.freeze({ kind: result.state, recordedAt });
      }
      if (
        result.state === "needs_attention" &&
        result.attentionReason === "operator_response_invalid"
      ) {
        return attentionOutcome("operator_response_invalid", recordedAt);
      }
      const reason = result.state === "pending" ? "nonterminal_evidence" : "operator_state_unknown";
      return this.retryOrExhaust(lease, recordedAt, reason);
    }

    if (failure instanceof CashuStellarMeltRecoveryCoordinatorError) {
      if (failure.code === "request_aborted") {
        return this.retryOrExhaust(lease, recordedAt, "worker_aborted");
      }
      if (failure.code === "storage_unavailable") {
        return this.retryOrExhaust(lease, recordedAt, "storage_unavailable");
      }
      if (
        failure.code === "clock_unavailable" ||
        failure.code === "invalid_configuration" ||
        failure.code === "operator_not_configured"
      ) {
        return attentionOutcome("recovery_configuration_invalid", recordedAt);
      }
      return attentionOutcome("evidence_invalid", recordedAt);
    }
    return this.retryOrExhaust(lease, recordedAt, "storage_unavailable");
  }

  private retryOrExhaust(
    lease: CashuStellarMeltRecoveryLeaseV1,
    recordedAt: UnixTimestamp,
    reason: CashuStellarMeltRecoveryRetryReason,
  ): CashuStellarMeltRecoveryLeaseOutcomeV1 {
    if (lease.attemptNumber >= this.policy.maxAttempts) {
      return attentionOutcome("retry_exhausted", recordedAt);
    }
    const delay = Math.min(
      this.policy.retryBaseSeconds * 2 ** (lease.attemptNumber - 1),
      this.policy.retryMaxSeconds,
    );
    return Object.freeze({
      kind: "retry_scheduled",
      nextAttemptAt: addSeconds(recordedAt, delay),
      reason,
      recordedAt,
    });
  }

  private async persistOutcome(
    lease: CashuStellarMeltRecoveryLeaseV1,
    outcome: CashuStellarMeltRecoveryLeaseOutcomeV1,
  ): Promise<CashuStellarMeltRecoveryWorkerResultV1> {
    try {
      await this.jobRepository.recordOutcome({
        leaseToken: lease.leaseToken,
        paymentId: lease.paymentId,
        ...outcome,
      });
    } catch (error) {
      if (
        error instanceof CashuStellarMeltRecoveryJobRepositoryError &&
        error.code === "lease_lost"
      ) {
        const terminal = await this.loadConcurrentTerminal(lease.paymentId);
        if (terminal !== undefined) {
          return Object.freeze({ lease, paymentId: lease.paymentId, state: terminal });
        }
      }
      throw mapRepositoryError(error);
    }

    if (outcome.kind === "accepted" || outcome.kind === "released") {
      return Object.freeze({ lease, paymentId: lease.paymentId, state: outcome.kind });
    }
    if (outcome.kind === "retry_scheduled") {
      return Object.freeze({
        lease,
        nextAttemptAt: outcome.nextAttemptAt,
        paymentId: lease.paymentId,
        reason: outcome.reason,
        state: "retry_scheduled",
      });
    }
    if (outcome.kind === "attention_required") {
      return Object.freeze({
        lease,
        paymentId: lease.paymentId,
        reason: outcome.reason,
        state: "attention_required",
      });
    }
    throw new CashuStellarMeltRecoveryWorkerError(
      "storage_unavailable",
      "Cashu Stellar melt recovery worker outcome is invalid.",
    );
  }

  private async loadConcurrentTerminal(
    requestedPaymentId: PaymentId,
  ): Promise<"accepted" | "released" | undefined> {
    try {
      const job = await this.jobRepository.findByPaymentId(requestedPaymentId);
      return job?.state === "completed" ? job.terminalState : undefined;
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  private readClock(): UnixTimestamp {
    try {
      return unixTimestamp(this.clock());
    } catch {
      throw clockUnavailable();
    }
  }
}

function validDependencies(value: CashuStellarMeltRecoveryWorkerDependencies): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.coordinator?.recover === "function" &&
    typeof value.jobRepository?.claimNext === "function" &&
    typeof value.jobRepository.findByPaymentId === "function" &&
    typeof value.jobRepository.recordOutcome === "function"
  );
}

function validatePolicy(options: CashuStellarMeltRecoveryWorkerOptions): RecoveryWorkerPolicy {
  const policy = {
    attemptTimeoutMs:
      options?.attemptTimeoutMs ?? DEFAULT_CASHU_STELLAR_MELT_RECOVERY_ATTEMPT_TIMEOUT_MS,
    leaseDurationSeconds:
      options?.leaseDurationSeconds ?? DEFAULT_CASHU_STELLAR_MELT_RECOVERY_LEASE_SECONDS,
    maxAttempts: options?.maxAttempts ?? DEFAULT_CASHU_STELLAR_MELT_RECOVERY_MAX_ATTEMPTS,
    retryBaseSeconds:
      options?.retryBaseSeconds ?? DEFAULT_CASHU_STELLAR_MELT_RECOVERY_RETRY_BASE_SECONDS,
    retryMaxSeconds:
      options?.retryMaxSeconds ?? DEFAULT_CASHU_STELLAR_MELT_RECOVERY_RETRY_MAX_SECONDS,
    workerId: options?.workerId,
  };
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    typeof policy.workerId !== "string" ||
    !WORKER_ID_PATTERN.test(policy.workerId) ||
    !boundedInteger(policy.attemptTimeoutMs, 1, MAX_ATTEMPT_TIMEOUT_MS) ||
    !boundedInteger(policy.leaseDurationSeconds, 1, MAX_LEASE_SECONDS) ||
    policy.leaseDurationSeconds * 1_000 <= policy.attemptTimeoutMs ||
    !boundedInteger(policy.maxAttempts, 1, MAX_RECOVERY_ATTEMPTS) ||
    !boundedInteger(policy.retryBaseSeconds, 1, MAX_RETRY_SECONDS) ||
    !boundedInteger(policy.retryMaxSeconds, policy.retryBaseSeconds, MAX_RETRY_SECONDS) ||
    (options.clock !== undefined && typeof options.clock !== "function") ||
    (options.leaseTokenFactory !== undefined && typeof options.leaseTokenFactory !== "function")
  ) {
    throw invalidConfiguration();
  }
  return Object.freeze(policy as RecoveryWorkerPolicy);
}

function validRunInput(value: RunCashuStellarMeltRecoveryWorkerInput): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value.signal === undefined || value.signal instanceof AbortSignal)
  );
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function addSeconds(timestamp: UnixTimestamp, seconds: number): UnixTimestamp {
  try {
    return unixTimestamp(timestamp + seconds);
  } catch {
    throw clockUnavailable();
  }
}

function attentionOutcome(
  reason: CashuStellarMeltRecoveryAttentionReason,
  recordedAt: UnixTimestamp,
): CashuStellarMeltRecoveryLeaseOutcomeV1 {
  return Object.freeze({ kind: "attention_required", reason, recordedAt });
}

function mapRepositoryError(error: unknown): CashuStellarMeltRecoveryWorkerError {
  if (error instanceof CashuStellarMeltRecoveryJobRepositoryError && error.code === "lease_lost") {
    return leaseLost();
  }
  return new CashuStellarMeltRecoveryWorkerError(
    "storage_unavailable",
    "Cashu Stellar melt recovery worker storage is unavailable.",
  );
}

function invalidConfiguration(): CashuStellarMeltRecoveryWorkerError {
  return new CashuStellarMeltRecoveryWorkerError(
    "invalid_configuration",
    "Cashu Stellar melt recovery worker configuration is invalid.",
  );
}

function invalidRequest(): CashuStellarMeltRecoveryWorkerError {
  return new CashuStellarMeltRecoveryWorkerError(
    "invalid_request",
    "Cashu Stellar melt recovery worker request is invalid.",
  );
}

function requestAborted(): CashuStellarMeltRecoveryWorkerError {
  return new CashuStellarMeltRecoveryWorkerError(
    "request_aborted",
    "Cashu Stellar melt recovery worker was aborted before a lease was claimed.",
  );
}

function clockUnavailable(): CashuStellarMeltRecoveryWorkerError {
  return new CashuStellarMeltRecoveryWorkerError(
    "clock_unavailable",
    "Cashu Stellar melt recovery worker clock is unavailable.",
  );
}

function leaseLost(): CashuStellarMeltRecoveryWorkerError {
  return new CashuStellarMeltRecoveryWorkerError(
    "lease_lost",
    "Cashu Stellar melt recovery lease is no longer current.",
  );
}
