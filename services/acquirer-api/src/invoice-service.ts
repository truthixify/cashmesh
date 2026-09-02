import { createHash, randomUUID } from "node:crypto";
import {
  type CashuPaymentRequestIssuer,
  type CashuStellarSettlementDestination,
  cashuStellarSettlementDestination,
} from "@cashmesh/cashu";
import {
  createInvoiceV1,
  idempotencyKey,
  invoiceId,
  merchantId,
  minorUnits,
  type OpenInvoiceV1,
  unixTimestamp,
} from "@cashmesh/domain";

import {
  type CreateOpenInvoiceResult,
  type InvoiceRepository,
  InvoiceRepositoryError,
  type IssuedInvoiceV1,
} from "./invoice-repository";

const INVOICE_ID_ATTEMPTS = 3;

export interface CreateMerchantInvoiceInput {
  readonly amount: number;
  readonly expiresAt: number;
  readonly idempotencyKey: string;
  readonly merchantId: string;
}

export interface FindMerchantInvoiceInput {
  readonly invoiceId: string;
  readonly merchantId: string;
}

export interface InvoiceServiceOptions {
  readonly clock?: () => number;
  readonly invoiceIdFactory?: () => string;
  readonly settlementDestination: string;
}

export type InvoiceServiceErrorCode =
  | "idempotency_conflict"
  | "invalid_invoice"
  | "invalid_request"
  | "payment_request_unavailable"
  | "storage_unavailable";

export class InvoiceServiceError extends Error {
  override readonly name = "InvoiceServiceError";

  constructor(
    readonly code: InvoiceServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class InvoiceService {
  private readonly clock: () => number;
  private readonly invoiceIdFactory: () => string;
  private readonly settlementDestination: CashuStellarSettlementDestination;

  constructor(
    private readonly repository: InvoiceRepository,
    private readonly cashuPaymentRequestIssuer: Pick<CashuPaymentRequestIssuer, "issue">,
    options: InvoiceServiceOptions,
  ) {
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
    this.invoiceIdFactory = options.invoiceIdFactory ?? (() => `inv_${randomUUID()}`);
    this.settlementDestination = cashuStellarSettlementDestination(options.settlementDestination);
  }

  async create(input: CreateMerchantInvoiceInput): Promise<CreateOpenInvoiceResult> {
    let ownerId: ReturnType<typeof merchantId>;
    let requestKey: ReturnType<typeof idempotencyKey>;
    try {
      ownerId = merchantId(input.merchantId);
      requestKey = idempotencyKey(input.idempotencyKey);
    } catch {
      throw new InvoiceServiceError(
        "invalid_request",
        "Merchant identifier or idempotency key is invalid.",
      );
    }

    let amount: ReturnType<typeof minorUnits>;
    let expiresAt: ReturnType<typeof unixTimestamp>;
    try {
      amount = minorUnits(input.amount);
      expiresAt = unixTimestamp(input.expiresAt);
      if (amount === 0) {
        throw new Error("Invoice amount must be positive.");
      }
    } catch {
      throw new InvoiceServiceError("invalid_invoice", "Invoice amount or expiry is invalid.");
    }

    const requestFingerprint = fingerprintRequest({
      amount,
      expiresAt,
      merchantId: ownerId,
      settlementDestination: this.settlementDestination,
    });
    try {
      const existingInvoice = await this.repository.findInvoiceCreation({
        idempotencyKey: requestKey,
        merchantId: ownerId,
        requestFingerprint,
      });
      if (existingInvoice !== undefined) {
        return Object.freeze({ ...existingInvoice, replayed: true });
      }
    } catch (error) {
      throw mapRepositoryError(error);
    }

    let createdAt: ReturnType<typeof unixTimestamp>;
    try {
      createdAt = unixTimestamp(this.clock());
    } catch {
      throw new InvoiceServiceError("storage_unavailable", "Invoice clock is unavailable.");
    }

    for (let attempt = 0; attempt < INVOICE_ID_ATTEMPTS; attempt += 1) {
      let generatedInvoiceId: ReturnType<typeof invoiceId>;
      try {
        generatedInvoiceId = invoiceId(this.invoiceIdFactory());
      } catch {
        throw new InvoiceServiceError(
          "storage_unavailable",
          "Invoice identifier generation failed.",
        );
      }

      let invoice: OpenInvoiceV1;
      try {
        invoice = createInvoiceV1({
          amount,
          createdAt,
          expiresAt,
          id: generatedInvoiceId,
          merchantId: ownerId,
        });
      } catch {
        throw new InvoiceServiceError(
          "invalid_invoice",
          "Invoice expiry must be after the current server time.",
        );
      }

      let cashuPaymentRequest: ReturnType<CashuPaymentRequestIssuer["issue"]>;
      try {
        cashuPaymentRequest = this.cashuPaymentRequestIssuer.issue({
          invoice,
          issuedAt: createdAt,
        });
      } catch {
        throw new InvoiceServiceError(
          "payment_request_unavailable",
          "Cashu payment request could not be issued.",
        );
      }

      try {
        return await this.repository.createOpenInvoice({
          cashuPaymentRequest,
          idempotencyKey: requestKey,
          invoice,
          requestFingerprint,
          settlementDestination: this.settlementDestination,
        });
      } catch (error) {
        if (
          error instanceof InvoiceRepositoryError &&
          error.code === "invoice_id_conflict" &&
          attempt + 1 < INVOICE_ID_ATTEMPTS
        ) {
          continue;
        }
        throw mapRepositoryError(error);
      }
    }

    throw new InvoiceServiceError("storage_unavailable", "Invoice could not be created.");
  }

  async find(input: FindMerchantInvoiceInput): Promise<IssuedInvoiceV1 | undefined> {
    let ownerId: ReturnType<typeof merchantId>;
    let requestedInvoiceId: ReturnType<typeof invoiceId>;
    try {
      ownerId = merchantId(input.merchantId);
      requestedInvoiceId = invoiceId(input.invoiceId);
    } catch {
      throw new InvoiceServiceError("invalid_request", "Invoice lookup identifiers are invalid.");
    }

    try {
      return await this.repository.findOpenInvoice(ownerId, requestedInvoiceId);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }
}

function fingerprintRequest(input: {
  readonly amount: number;
  readonly expiresAt: number;
  readonly merchantId: string;
  readonly settlementDestination: string;
}): string {
  const canonicalRequest = JSON.stringify({
    amount: input.amount,
    expiresAt: input.expiresAt,
    merchantId: input.merchantId,
    settlementDestination: input.settlementDestination,
    schemaVersion: 1,
  });
  return createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
}

function mapRepositoryError(error: unknown): InvoiceServiceError {
  if (error instanceof InvoiceRepositoryError) {
    if (error.code === "idempotency_conflict") {
      return new InvoiceServiceError(
        "idempotency_conflict",
        "Idempotency key was already used for a different invoice request.",
      );
    }
    return new InvoiceServiceError("storage_unavailable", "Invoice storage is unavailable.");
  }
  return new InvoiceServiceError("storage_unavailable", "Invoice storage is unavailable.");
}
