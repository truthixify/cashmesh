import {
  type AcceptedInvoicePaymentV1,
  assertIdentifier,
  type JournalEntryId,
  type MinorUnitAmount,
  type PaymentId,
  type UnixTimestamp,
} from "@cashmesh/domain";

declare const effectIdBrand: unique symbol;
declare const effectFingerprintBrand: unique symbol;
declare const lifecycleEventIdBrand: unique symbol;
declare const operatorReferenceBrand: unique symbol;

export const CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION = 1 as const;
export const CASHU_OPERATOR_EFFECT_KINDS = ["swap", "melt"] as const;
export const CASHU_PROOF_RESERVATION_STATES = [
  "reserved",
  "dispatch_started",
  "pending",
  "needs_attention",
  "consumed",
  "released",
] as const;
export const CASHU_OPERATOR_ATTENTION_REASONS = [
  "transport_ambiguous",
  "operator_state_unknown",
  "operator_response_invalid",
] as const;
export const CASHU_OPERATOR_SUCCESS_EVIDENCE = ["swap_succeeded", "melt_paid"] as const;
export const CASHU_OPERATOR_FAILURE_EVIDENCE = [
  "swap_rejected",
  "melt_unpaid_after_expiry",
] as const;

export type CashuOperatorEffectId = string & { readonly [effectIdBrand]: true };
export type CashuOperatorDispatchFingerprint = string & {
  readonly [effectFingerprintBrand]: true;
};
export type CashuReservationLifecycleEventId = string & {
  readonly [lifecycleEventIdBrand]: true;
};
export type CashuOperatorReference = string & { readonly [operatorReferenceBrand]: true };
export type CashuOperatorEffectKind = (typeof CASHU_OPERATOR_EFFECT_KINDS)[number];
export type CashuProofReservationState = (typeof CASHU_PROOF_RESERVATION_STATES)[number];
export type CashuOperatorAttentionReason = (typeof CASHU_OPERATOR_ATTENTION_REASONS)[number];
export type CashuOperatorSuccessEvidence = (typeof CASHU_OPERATOR_SUCCESS_EVIDENCE)[number];
export type CashuOperatorFailureEvidence = (typeof CASHU_OPERATOR_FAILURE_EVIDENCE)[number];

interface CashuOperatorEffectBaseV1 {
  readonly dispatchFingerprint: CashuOperatorDispatchFingerprint;
  readonly effectId: CashuOperatorEffectId;
  readonly schemaVersion: typeof CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION;
  readonly startedAt: UnixTimestamp;
}

export type CashuOperatorEffectV1 = CashuOperatorEffectBaseV1 &
  (
    | {
        readonly kind: "swap";
      }
    | {
        readonly kind: "melt";
        readonly operatorReference: CashuOperatorReference;
        readonly operatorReferenceExpiresAt: UnixTimestamp;
      }
  );

interface CashuReservationLifecycleEventBaseV1 {
  readonly eventId: CashuReservationLifecycleEventId;
  readonly recordedAt: UnixTimestamp;
  readonly sequence: number;
}

export type CashuReservationLifecycleEventV1 =
  | (CashuReservationLifecycleEventBaseV1 & {
      readonly state: "dispatch_started";
    })
  | (CashuReservationLifecycleEventBaseV1 & {
      readonly evidenceAt: UnixTimestamp;
      readonly evidenceKind: "operator_pending";
      readonly state: "pending";
    })
  | (CashuReservationLifecycleEventBaseV1 & {
      readonly evidenceAt: UnixTimestamp;
      readonly evidenceKind: CashuOperatorAttentionReason;
      readonly state: "needs_attention";
    })
  | (CashuReservationLifecycleEventBaseV1 & {
      readonly evidenceAt: UnixTimestamp;
      readonly evidenceKind: CashuOperatorSuccessEvidence;
      readonly journalEntryId: JournalEntryId;
      readonly proofStateObservedAt: UnixTimestamp;
      readonly state: "consumed";
    })
  | (CashuReservationLifecycleEventBaseV1 & {
      readonly evidenceKind: "pre_dispatch";
      readonly state: "released";
    })
  | (CashuReservationLifecycleEventBaseV1 & {
      readonly evidenceAt: UnixTimestamp;
      readonly evidenceKind: CashuOperatorFailureEvidence;
      readonly proofStateObservedAt: UnixTimestamp;
      readonly state: "released";
    });

export interface CashuProofReservationLifecycleV1 {
  readonly effect?: CashuOperatorEffectV1;
  readonly events: readonly CashuReservationLifecycleEventV1[];
  readonly paymentId: PaymentId;
  readonly schemaVersion: typeof CASHU_PROOF_RESERVATION_LIFECYCLE_SCHEMA_VERSION;
  readonly state: CashuProofReservationState;
}

interface CashuReservationEventInputBase {
  readonly eventId: CashuReservationLifecycleEventId;
  readonly paymentId: PaymentId;
  readonly recordedAt: UnixTimestamp;
}

interface StartCashuOperatorEffectBaseInput {
  readonly dispatchFingerprint: CashuOperatorDispatchFingerprint;
  readonly effectId: CashuOperatorEffectId;
  readonly eventId: CashuReservationLifecycleEventId;
  readonly paymentId: PaymentId;
  readonly startedAt: UnixTimestamp;
}

export type StartCashuOperatorEffectInput = StartCashuOperatorEffectBaseInput &
  (
    | {
        readonly kind: "swap";
      }
    | {
        readonly kind: "melt";
        readonly operatorReference: CashuOperatorReference;
        readonly operatorReferenceExpiresAt: UnixTimestamp;
      }
  );

export interface RecordCashuOperatorPendingInput extends CashuReservationEventInputBase {
  readonly effectId: CashuOperatorEffectId;
  readonly evidenceAt: UnixTimestamp;
}

export interface RequireCashuOperatorAttentionInput extends CashuReservationEventInputBase {
  readonly effectId: CashuOperatorEffectId;
  readonly evidenceAt: UnixTimestamp;
  readonly reason: CashuOperatorAttentionReason;
}

export interface AcceptCashuInvoicePaymentInput extends CashuReservationEventInputBase {
  readonly effectId: CashuOperatorEffectId;
  readonly evidenceAt: UnixTimestamp;
  readonly evidenceKind: "melt_paid";
  readonly feeAmount: MinorUnitAmount;
  readonly journalEntryId: JournalEntryId;
  readonly proofStateObservedAt: UnixTimestamp;
}

export type ReleaseCashuProofReservationInput =
  | (CashuReservationEventInputBase & {
      readonly kind: "pre_dispatch";
    })
  | (CashuReservationEventInputBase & {
      readonly effectId: CashuOperatorEffectId;
      readonly evidenceAt: UnixTimestamp;
      readonly evidenceKind: CashuOperatorFailureEvidence;
      readonly kind: "after_failure";
      readonly proofStateObservedAt: UnixTimestamp;
    });

export interface CashuProofReservationLifecycleResult {
  readonly lifecycle: CashuProofReservationLifecycleV1;
  readonly replayed: boolean;
}

export interface AcceptCashuInvoicePaymentResult extends CashuProofReservationLifecycleResult {
  readonly accounting: AcceptedInvoicePaymentV1;
}

export interface CashuProofReservationLifecycleRepository {
  acceptPayment(input: AcceptCashuInvoicePaymentInput): Promise<AcceptCashuInvoicePaymentResult>;
  close(): Promise<void>;
  findAcceptedPaymentByPaymentId(
    paymentId: PaymentId,
  ): Promise<AcceptedInvoicePaymentV1 | undefined>;
  findByPaymentId(paymentId: PaymentId): Promise<CashuProofReservationLifecycleV1 | undefined>;
  recordPending(
    input: RecordCashuOperatorPendingInput,
  ): Promise<CashuProofReservationLifecycleResult>;
  release(input: ReleaseCashuProofReservationInput): Promise<CashuProofReservationLifecycleResult>;
  requireAttention(
    input: RequireCashuOperatorAttentionInput,
  ): Promise<CashuProofReservationLifecycleResult>;
  startEffect(input: StartCashuOperatorEffectInput): Promise<CashuProofReservationLifecycleResult>;
}

export type CashuProofReservationLifecycleRepositoryErrorCode =
  | "accounting_conflict"
  | "effect_conflict"
  | "event_conflict"
  | "invalid_input"
  | "invalid_record"
  | "invalid_transition"
  | "invoice_claimed"
  | "proof_state_evidence_missing"
  | "quote_evidence_mismatch"
  | "quote_evidence_missing"
  | "reservation_not_found"
  | "storage_unavailable";

export class CashuProofReservationLifecycleRepositoryError extends Error {
  override readonly name = "CashuProofReservationLifecycleRepositoryError";

  constructor(
    readonly code: CashuProofReservationLifecycleRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function cashuOperatorEffectId(value: string): CashuOperatorEffectId {
  assertIdentifier(value, "Cashu operator effect id");
  return value as CashuOperatorEffectId;
}

export function cashuOperatorDispatchFingerprint(value: string): CashuOperatorDispatchFingerprint {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      "Cashu operator dispatch fingerprint must be 64 lowercase hexadecimal characters.",
    );
  }
  return value as CashuOperatorDispatchFingerprint;
}

export function cashuReservationLifecycleEventId(value: string): CashuReservationLifecycleEventId {
  assertIdentifier(value, "Cashu reservation lifecycle event id");
  return value as CashuReservationLifecycleEventId;
}

export function cashuOperatorReference(value: string): CashuOperatorReference {
  assertIdentifier(value, "Cashu operator reference");
  return value as CashuOperatorReference;
}
