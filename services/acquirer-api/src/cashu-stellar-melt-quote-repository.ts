import type { CashuStellarMeltQuoteRequestV1, CashuStellarMeltQuoteV1 } from "@cashmesh/cashu";
import {
  assertIdentifier,
  type InvoiceId,
  type OperatorId,
  type PaymentId,
  type UnixTimestamp,
} from "@cashmesh/domain";

declare const cashuStellarMeltQuoteAttemptIdBrand: unique symbol;

export const CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION = 1 as const;
export const CASHU_STELLAR_MELT_QUOTE_AMBIGUITY_REASONS = ["transport_ambiguous"] as const;

export type CashuStellarMeltQuoteAttemptId = string & {
  readonly [cashuStellarMeltQuoteAttemptIdBrand]: true;
};
export type CashuStellarMeltQuoteAmbiguityReason =
  (typeof CASHU_STELLAR_MELT_QUOTE_AMBIGUITY_REASONS)[number];

interface CashuStellarMeltQuoteAttemptBaseV1 {
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly invoiceId: InvoiceId;
  readonly mintUrl: string;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly request: CashuStellarMeltQuoteRequestV1;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_QUOTE_ATTEMPT_SCHEMA_VERSION;
  readonly startedAt: UnixTimestamp;
}

export type CashuStellarMeltQuoteAttemptV1 =
  | (CashuStellarMeltQuoteAttemptBaseV1 & {
      readonly observations: readonly [];
      readonly state: "creating";
    })
  | (CashuStellarMeltQuoteAttemptBaseV1 & {
      readonly ambiguityReason: CashuStellarMeltQuoteAmbiguityReason;
      readonly ambiguousAt: UnixTimestamp;
      readonly observations: readonly [];
      readonly state: "ambiguous";
    })
  | (CashuStellarMeltQuoteAttemptBaseV1 & {
      readonly latestQuote: CashuStellarMeltQuoteV1;
      readonly observations: readonly CashuStellarMeltQuoteV1[];
      readonly state: "quoted";
    });

export interface BeginCashuStellarMeltQuoteAttemptInput {
  readonly amount: number;
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly paymentId: PaymentId;
  readonly request: string;
  readonly startedAt: UnixTimestamp;
}

export interface RecordAmbiguousCashuStellarMeltQuoteAttemptInput {
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly paymentId: PaymentId;
  readonly reason: CashuStellarMeltQuoteAmbiguityReason;
  readonly recordedAt: UnixTimestamp;
}

export interface RecordCashuStellarMeltQuoteInput {
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly paymentId: PaymentId;
  readonly quote: CashuStellarMeltQuoteV1;
}

export interface ObserveCashuStellarMeltQuoteInput {
  readonly attemptId: CashuStellarMeltQuoteAttemptId;
  readonly paymentId: PaymentId;
  readonly quote: CashuStellarMeltQuoteV1;
}

export interface CashuStellarMeltQuoteAttemptResult {
  readonly attempt: CashuStellarMeltQuoteAttemptV1;
  readonly replayed: boolean;
}

export interface CashuStellarMeltQuoteRepository {
  begin(input: BeginCashuStellarMeltQuoteAttemptInput): Promise<CashuStellarMeltQuoteAttemptResult>;
  close(): Promise<void>;
  findByPaymentId(paymentId: PaymentId): Promise<CashuStellarMeltQuoteAttemptV1 | undefined>;
  observe(input: ObserveCashuStellarMeltQuoteInput): Promise<CashuStellarMeltQuoteAttemptResult>;
  recordAmbiguous(
    input: RecordAmbiguousCashuStellarMeltQuoteAttemptInput,
  ): Promise<CashuStellarMeltQuoteAttemptResult>;
  recordQuote(input: RecordCashuStellarMeltQuoteInput): Promise<CashuStellarMeltQuoteAttemptResult>;
}

export type CashuStellarMeltQuoteRepositoryErrorCode =
  | "attempt_conflict"
  | "attempt_not_found"
  | "custody_not_found"
  | "invalid_input"
  | "invalid_record"
  | "invalid_transition"
  | "invoice_window_closed"
  | "observation_conflict"
  | "quote_conflict"
  | "reservation_not_active"
  | "reservation_not_found"
  | "storage_unavailable"
  | "terms_mismatch";

export class CashuStellarMeltQuoteRepositoryError extends Error {
  override readonly name = "CashuStellarMeltQuoteRepositoryError";

  constructor(
    readonly code: CashuStellarMeltQuoteRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function cashuStellarMeltQuoteAttemptId(value: string): CashuStellarMeltQuoteAttemptId {
  assertIdentifier(value, "Cashu Stellar melt quote attempt id");
  return value as CashuStellarMeltQuoteAttemptId;
}
