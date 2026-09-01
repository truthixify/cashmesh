import type { InvoiceId, MerchantId } from "@cashmesh/domain";

import {
  type CreateOpenInvoiceRecord,
  type CreateOpenInvoiceResult,
  type FindInvoiceCreationRecord,
  type InvoiceRepository,
  InvoiceRepositoryError,
  type IssuedInvoiceV1,
} from "../src/invoice-repository";

interface CreationRecord {
  readonly fingerprint: string;
  readonly issuedInvoice: IssuedInvoiceV1;
}

export class FakeInvoiceRepository implements InvoiceRepository {
  readonly creations = new Map<string, CreationRecord>();
  readonly invoices = new Map<string, IssuedInvoiceV1>();
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
      return Object.freeze({ ...existing.issuedInvoice, replayed: true });
    }
    if (this.invoices.has(input.invoice.id)) {
      throw new InvoiceRepositoryError("invoice_id_conflict", "Invoice identifier exists.");
    }

    const issuedInvoice = Object.freeze({
      cashuPaymentRequest: input.cashuPaymentRequest,
      invoice: input.invoice,
    });
    this.creations.set(
      creationKey,
      Object.freeze({ fingerprint: input.requestFingerprint, issuedInvoice }),
    );
    this.invoices.set(input.invoice.id, issuedInvoice);
    return Object.freeze({ ...issuedInvoice, replayed: false });
  }

  async findInvoiceCreation(
    input: FindInvoiceCreationRecord,
  ): Promise<IssuedInvoiceV1 | undefined> {
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
    return existing.issuedInvoice;
  }

  async findOpenInvoice(
    ownerId: MerchantId,
    requestedInvoiceId: InvoiceId,
  ): Promise<IssuedInvoiceV1 | undefined> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const invoice = this.invoices.get(requestedInvoiceId);
    return invoice?.invoice.merchantId === ownerId ? invoice : undefined;
  }

  async findOpenInvoiceById(requestedInvoiceId: InvoiceId): Promise<IssuedInvoiceV1 | undefined> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.invoices.get(requestedInvoiceId);
  }
}
