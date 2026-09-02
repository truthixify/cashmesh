import type { CashuBearerProofBundleV1 } from "@cashmesh/cashu";
import type { PaymentId, UnixTimestamp } from "@cashmesh/domain";

export const CASHU_PROOF_CUSTODY_SCHEMA_VERSION = 1 as const;

export interface CashuProofCustodyMetadataV1 {
  readonly createdAt: UnixTimestamp;
  readonly paymentId: PaymentId;
  readonly proofCount: number;
  readonly schemaVersion: typeof CASHU_PROOF_CUSTODY_SCHEMA_VERSION;
}

export interface StoreCashuProofCustodyInput {
  readonly bearerProofs: CashuBearerProofBundleV1;
  readonly createdAt: UnixTimestamp;
  readonly paymentId: PaymentId;
}

export interface StoreCashuProofCustodyResult {
  readonly metadata: CashuProofCustodyMetadataV1;
  readonly replayed: boolean;
}

export interface CashuProofCustodyRepository {
  close(): Promise<void>;
  findMetadata(paymentId: PaymentId): Promise<CashuProofCustodyMetadataV1 | undefined>;
  store(input: StoreCashuProofCustodyInput): Promise<StoreCashuProofCustodyResult>;
  // A dispatch coordinator must establish durable effect authority before network use.
  withDecryptedBundle<T>(
    paymentId: PaymentId,
    use: (bundle: CashuBearerProofBundleV1) => Promise<T> | T,
  ): Promise<T | undefined>;
}

export type CashuProofCustodyRepositoryErrorCode =
  | "custody_conflict"
  | "invalid_input"
  | "invalid_record"
  | "invalid_reservation_state"
  | "key_unavailable"
  | "nonce_conflict"
  | "reservation_not_found"
  | "storage_unavailable";

export class CashuProofCustodyRepositoryError extends Error {
  override readonly name = "CashuProofCustodyRepositoryError";

  constructor(
    readonly code: CashuProofCustodyRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
