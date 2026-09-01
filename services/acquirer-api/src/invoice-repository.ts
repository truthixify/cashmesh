import type { CashuPaymentRequestV1 } from "@cashmesh/cashu";
import type { IdempotencyKey, InvoiceId, MerchantId, OpenInvoiceV1 } from "@cashmesh/domain";

export interface IssuedInvoiceV1 {
  readonly cashuPaymentRequest: CashuPaymentRequestV1;
  readonly invoice: OpenInvoiceV1;
}

export interface CreateOpenInvoiceRecord {
  readonly cashuPaymentRequest: CashuPaymentRequestV1;
  readonly idempotencyKey: IdempotencyKey;
  readonly invoice: OpenInvoiceV1;
  readonly requestFingerprint: string;
}

export interface CreateOpenInvoiceResult extends IssuedInvoiceV1 {
  readonly replayed: boolean;
}

export interface FindInvoiceCreationRecord {
  readonly idempotencyKey: IdempotencyKey;
  readonly merchantId: MerchantId;
  readonly requestFingerprint: string;
}

export interface InvoiceRepository {
  close(): Promise<void>;
  createOpenInvoice(input: CreateOpenInvoiceRecord): Promise<CreateOpenInvoiceResult>;
  findInvoiceCreation(input: FindInvoiceCreationRecord): Promise<IssuedInvoiceV1 | undefined>;
  findOpenInvoice(
    merchantId: MerchantId,
    invoiceId: InvoiceId,
  ): Promise<IssuedInvoiceV1 | undefined>;
}

export type InvoiceRepositoryErrorCode =
  | "idempotency_conflict"
  | "invalid_record"
  | "invoice_id_conflict"
  | "storage_unavailable";

export class InvoiceRepositoryError extends Error {
  override readonly name = "InvoiceRepositoryError";

  constructor(
    readonly code: InvoiceRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}
