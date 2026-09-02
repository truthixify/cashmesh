import type { PaymentId, UnixTimestamp } from "@cashmesh/domain";
import type { CashuOperatorEffectId } from "./cashu-proof-reservation-lifecycle-repository";

export const CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION = 1 as const;
export const CASHU_STELLAR_MELT_RECOVERY_INITIAL_DELAY_SECONDS = 60 as const;

const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

declare const cashuStellarMeltRecoveryLeaseTokenBrand: unique symbol;

export type CashuStellarMeltRecoveryLeaseToken = string & {
  readonly [cashuStellarMeltRecoveryLeaseTokenBrand]: true;
};

export const CASHU_STELLAR_MELT_RECOVERY_RETRY_REASONS = Object.freeze([
  "nonterminal_evidence",
  "operator_state_unknown",
  "storage_unavailable",
  "worker_aborted",
] as const);

export type CashuStellarMeltRecoveryRetryReason =
  (typeof CASHU_STELLAR_MELT_RECOVERY_RETRY_REASONS)[number];

export const CASHU_STELLAR_MELT_RECOVERY_ATTENTION_REASONS = Object.freeze([
  "evidence_invalid",
  "operator_response_invalid",
  "recovery_configuration_invalid",
  "retry_exhausted",
] as const);

export type CashuStellarMeltRecoveryAttentionReason =
  (typeof CASHU_STELLAR_MELT_RECOVERY_ATTENTION_REASONS)[number];

export interface CashuStellarMeltRecoveryLeaseV1 {
  readonly attemptNumber: number;
  readonly claimedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly leaseToken: CashuStellarMeltRecoveryLeaseToken;
  readonly paymentId: PaymentId;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION;
  readonly workerId: string;
}

export type CashuStellarMeltRecoveryLeaseOutcomeV1 =
  | {
      readonly kind: "accepted" | "released";
      readonly recordedAt: UnixTimestamp;
    }
  | {
      readonly kind: "retry_scheduled";
      readonly nextAttemptAt: UnixTimestamp;
      readonly reason: CashuStellarMeltRecoveryRetryReason;
      readonly recordedAt: UnixTimestamp;
    }
  | {
      readonly kind: "attention_required";
      readonly reason: CashuStellarMeltRecoveryAttentionReason;
      readonly recordedAt: UnixTimestamp;
    };

export interface CashuStellarMeltRecoveryAttemptV1 {
  readonly lease: CashuStellarMeltRecoveryLeaseV1;
  readonly outcome?: CashuStellarMeltRecoveryLeaseOutcomeV1;
}

interface CashuStellarMeltRecoveryJobBaseV1 {
  readonly attempts: readonly CashuStellarMeltRecoveryAttemptV1[];
  readonly effectId: CashuOperatorEffectId;
  readonly initialAttemptAt: UnixTimestamp;
  readonly paymentId: PaymentId;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_RECOVERY_JOB_SCHEMA_VERSION;
}

export type CashuStellarMeltRecoveryJobV1 =
  | (CashuStellarMeltRecoveryJobBaseV1 & {
      readonly nextAttemptAt: UnixTimestamp;
      readonly state: "scheduled";
    })
  | (CashuStellarMeltRecoveryJobBaseV1 & {
      readonly lease: CashuStellarMeltRecoveryLeaseV1;
      readonly state: "leased";
    })
  | (CashuStellarMeltRecoveryJobBaseV1 & {
      readonly outcome: Extract<
        CashuStellarMeltRecoveryLeaseOutcomeV1,
        { readonly kind: "attention_required" }
      >;
      readonly state: "attention_required";
    })
  | (CashuStellarMeltRecoveryJobBaseV1 & {
      readonly completedAt: UnixTimestamp;
      readonly terminalState: "accepted" | "released";
      readonly state: "completed";
    });

export interface ClaimCashuStellarMeltRecoveryJobInput {
  readonly claimedAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly leaseToken: CashuStellarMeltRecoveryLeaseToken;
  readonly workerId: string;
}

interface RecordCashuStellarMeltRecoveryOutcomeBase {
  readonly leaseToken: CashuStellarMeltRecoveryLeaseToken;
  readonly paymentId: PaymentId;
  readonly recordedAt: UnixTimestamp;
}

export type RecordCashuStellarMeltRecoveryOutcomeInput =
  | (RecordCashuStellarMeltRecoveryOutcomeBase & {
      readonly kind: "accepted" | "released";
    })
  | (RecordCashuStellarMeltRecoveryOutcomeBase & {
      readonly kind: "retry_scheduled";
      readonly nextAttemptAt: UnixTimestamp;
      readonly reason: CashuStellarMeltRecoveryRetryReason;
    })
  | (RecordCashuStellarMeltRecoveryOutcomeBase & {
      readonly kind: "attention_required";
      readonly reason: CashuStellarMeltRecoveryAttentionReason;
    });

export interface RecordCashuStellarMeltRecoveryOutcomeResult {
  readonly job: CashuStellarMeltRecoveryJobV1;
  readonly replayed: boolean;
}

export interface CashuStellarMeltRecoveryJobRepository {
  claimNext(
    input: ClaimCashuStellarMeltRecoveryJobInput,
  ): Promise<CashuStellarMeltRecoveryLeaseV1 | undefined>;
  close(): Promise<void>;
  findByPaymentId(paymentId: PaymentId): Promise<CashuStellarMeltRecoveryJobV1 | undefined>;
  recordOutcome(
    input: RecordCashuStellarMeltRecoveryOutcomeInput,
  ): Promise<RecordCashuStellarMeltRecoveryOutcomeResult>;
}

export type CashuStellarMeltRecoveryJobRepositoryErrorCode =
  | "invalid_input"
  | "invalid_record"
  | "lease_conflict"
  | "lease_lost"
  | "storage_unavailable";

export class CashuStellarMeltRecoveryJobRepositoryError extends Error {
  override readonly name = "CashuStellarMeltRecoveryJobRepositoryError";

  constructor(
    readonly code: CashuStellarMeltRecoveryJobRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function cashuStellarMeltRecoveryLeaseToken(
  value: string,
): CashuStellarMeltRecoveryLeaseToken {
  if (typeof value !== "string" || !INTERNAL_ID_PATTERN.test(value)) {
    throw new TypeError("Cashu Stellar melt recovery lease token is invalid.");
  }
  return value as CashuStellarMeltRecoveryLeaseToken;
}
