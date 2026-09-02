import type { CashuProofStateSnapshotV1 } from "@cashmesh/cashu";
import type { OperatorId, PaymentId, UnixTimestamp } from "@cashmesh/domain";

export interface PersistCashuProofStateObservation {
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly snapshot: CashuProofStateSnapshotV1;
  readonly unit: string;
}

export interface PersistCashuProofStateObservationResult {
  readonly replayed: boolean;
  readonly snapshot: CashuProofStateSnapshotV1;
}

export interface FindFreshCashuProofStateObservation {
  readonly mintUrl: string;
  readonly observedAtOrAfter: UnixTimestamp;
  readonly observedAtOrBefore: UnixTimestamp;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly unit: string;
}

export interface CashuProofStateRepository {
  close(): Promise<void>;
  findLatestFreshSnapshot(
    input: FindFreshCashuProofStateObservation,
  ): Promise<CashuProofStateSnapshotV1 | undefined>;
  persistObservation(
    input: PersistCashuProofStateObservation,
  ): Promise<PersistCashuProofStateObservationResult>;
}

export type CashuProofStateRepositoryErrorCode =
  | "invalid_input"
  | "invalid_record"
  | "observation_before_reservation"
  | "observation_conflict"
  | "proof_set_mismatch"
  | "reservation_not_found"
  | "reservation_scope_mismatch"
  | "reservation_terminal"
  | "spent_state_regression"
  | "storage_unavailable";

export class CashuProofStateRepositoryError extends Error {
  override readonly name = "CashuProofStateRepositoryError";

  constructor(
    readonly code: CashuProofStateRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
