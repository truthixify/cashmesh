import type { CashuKeysetSnapshotV1 } from "@cashmesh/cashu";
import type { OperatorId, UnixTimestamp } from "@cashmesh/domain";

export interface PersistCashuKeysetObservation {
  readonly operatorId: OperatorId;
  readonly snapshot: CashuKeysetSnapshotV1;
  readonly unit: string;
}

export interface PersistCashuKeysetObservationResult {
  readonly replayed: boolean;
  readonly snapshot: CashuKeysetSnapshotV1;
}

export interface FindFreshCashuKeysetObservation {
  readonly mintUrl: string;
  readonly observedAtOrAfter: UnixTimestamp;
  readonly observedAtOrBefore: UnixTimestamp;
  readonly operatorId: OperatorId;
  readonly unit: string;
}

export interface CashuKeysetRepository {
  close(): Promise<void>;
  findLatestFreshSnapshot(
    input: FindFreshCashuKeysetObservation,
  ): Promise<CashuKeysetSnapshotV1 | undefined>;
  persistObservation(
    input: PersistCashuKeysetObservation,
  ): Promise<PersistCashuKeysetObservationResult>;
}

export type CashuKeysetRepositoryErrorCode =
  | "invalid_input"
  | "invalid_record"
  | "keyset_collision"
  | "observation_conflict"
  | "storage_unavailable";

export class CashuKeysetRepositoryError extends Error {
  override readonly name = "CashuKeysetRepositoryError";

  constructor(
    readonly code: CashuKeysetRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
