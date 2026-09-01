import type { IdempotencyKey, InvoiceId, MerchantId, OpenInvoiceV1 } from "@cashmesh/domain";

export interface CreateOpenInvoiceRecord {
  readonly idempotencyKey: IdempotencyKey;
  readonly invoice: OpenInvoiceV1;
  readonly requestFingerprint: string;
}

export interface CreateOpenInvoiceResult {
  readonly invoice: OpenInvoiceV1;
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
  findInvoiceCreation(input: FindInvoiceCreationRecord): Promise<OpenInvoiceV1 | undefined>;
  findOpenInvoice(merchantId: MerchantId, invoiceId: InvoiceId): Promise<OpenInvoiceV1 | undefined>;
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
