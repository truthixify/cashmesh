import type { CashuProofReferenceV1 } from "@cashmesh/cashu";
import type { InvoiceId, OperatorId, PaymentId, UnixTimestamp } from "@cashmesh/domain";

export const CASHU_PROOF_RESERVATION_SCHEMA_VERSION = 1 as const;

export interface ReserveCashuProofsInput {
  readonly invoiceId: InvoiceId;
  readonly keysetObservedAt: UnixTimestamp;
  readonly mintUrl: string;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly proofReferences: readonly CashuProofReferenceV1[];
  readonly reservedAt: UnixTimestamp;
  readonly unit: string;
}

export interface CashuProofReservationV1 extends ReserveCashuProofsInput {
  readonly grossAmount: number;
  readonly schemaVersion: typeof CASHU_PROOF_RESERVATION_SCHEMA_VERSION;
}

export interface ReserveCashuProofsResult {
  readonly replayed: boolean;
  readonly reservation: CashuProofReservationV1;
}

export interface CashuProofReservationRepository {
  close(): Promise<void>;
  findByPaymentId(paymentId: PaymentId): Promise<CashuProofReservationV1 | undefined>;
  reserve(input: ReserveCashuProofsInput): Promise<ReserveCashuProofsResult>;
}

export type CashuProofReservationRepositoryErrorCode =
  | "invalid_input"
  | "invalid_record"
  | "invoice_not_open"
  | "keyset_evidence_missing"
  | "payment_conflict"
  | "proof_conflict"
  | "reservation_released"
  | "reservation_window_closed"
  | "route_not_accepted"
  | "storage_unavailable";

export class CashuProofReservationRepositoryError extends Error {
  override readonly name = "CashuProofReservationRepositoryError";

  constructor(
    readonly code: CashuProofReservationRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
