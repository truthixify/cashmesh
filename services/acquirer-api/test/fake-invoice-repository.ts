import type { InvoiceId, MerchantId, OpenInvoiceV1 } from "@cashmesh/domain";

import {
  type CreateOpenInvoiceRecord,
  type CreateOpenInvoiceResult,
  type FindInvoiceCreationRecord,
  type InvoiceRepository,
  InvoiceRepositoryError,
} from "../src/invoice-repository";

interface CreationRecord {
  readonly fingerprint: string;
  readonly invoice: OpenInvoiceV1;
}

export class FakeInvoiceRepository implements InvoiceRepository {
  readonly creations = new Map<string, CreationRecord>();
  readonly invoices = new Map<string, OpenInvoiceV1>();
  closed = false;
  failure?: InvoiceRepositoryError;

  async close(): Promise<void> {
    this.closed = true;
  }

  async createOpenInvoice(input: CreateOpenInvoiceRecord): Promise<CreateOpenInvoiceResult> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const creationKey = `${input.invoice.merchantId}\0${input.idempotencyKey}`;
    const existing = this.creations.get(creationKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== input.requestFingerprint) {
        throw new InvoiceRepositoryError(
          "idempotency_conflict",
          "Idempotency request fingerprint differs.",
        );
      }
      return Object.freeze({ invoice: existing.invoice, replayed: true });
    }
    if (this.invoices.has(input.invoice.id)) {
      throw new InvoiceRepositoryError("invoice_id_conflict", "Invoice identifier exists.");
    }

    this.creations.set(
      creationKey,
      Object.freeze({ fingerprint: input.requestFingerprint, invoice: input.invoice }),
    );
    this.invoices.set(input.invoice.id, input.invoice);
    return Object.freeze({ invoice: input.invoice, replayed: false });
  }

  async findInvoiceCreation(input: FindInvoiceCreationRecord): Promise<OpenInvoiceV1 | undefined> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const creationKey = `${input.merchantId}\0${input.idempotencyKey}`;
    const existing = this.creations.get(creationKey);
    if (existing === undefined) {
      return undefined;
    }
    if (existing.fingerprint !== input.requestFingerprint) {
      throw new InvoiceRepositoryError(
        "idempotency_conflict",
        "Idempotency request fingerprint differs.",
      );
    }
    return existing.invoice;
  }

  async findOpenInvoice(
    ownerId: MerchantId,
    requestedInvoiceId: InvoiceId,
  ): Promise<OpenInvoiceV1 | undefined> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const invoice = this.invoices.get(requestedInvoiceId);
    return invoice?.merchantId === ownerId ? invoice : undefined;
  }
}
