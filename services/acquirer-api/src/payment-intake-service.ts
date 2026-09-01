import { CashuPaymentPayloadError, inspectCashuPaymentPayloadV1 } from "@cashmesh/cashu";
import { unixTimestamp } from "@cashmesh/domain";

import type { InvoiceRepository } from "./invoice-repository";

export type PaymentIntakeServiceErrorCode =
  | "invalid_payment_payload"
  | "payment_amount_insufficient"
  | "payment_mint_not_accepted"
  | "payment_request_expired"
  | "payment_request_not_found"
  | "payment_unit_not_accepted"
  | "proof_validation_unavailable"
  | "storage_unavailable";

export class PaymentIntakeServiceError extends Error {
  override readonly name = "PaymentIntakeServiceError";

  constructor(
    readonly code: PaymentIntakeServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class PaymentIntakeService {
  private readonly clock: () => number;

  constructor(
    private readonly repository: InvoiceRepository,
    options: { readonly clock?: () => number } = {},
  ) {
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1_000));
  }

  async inspect(rawPayload: string): Promise<never> {
    let envelope: ReturnType<typeof inspectCashuPaymentPayloadV1>;
    try {
      envelope = inspectCashuPaymentPayloadV1(rawPayload);
    } catch (error) {
      if (error instanceof CashuPaymentPayloadError) {
        throw new PaymentIntakeServiceError(
          "invalid_payment_payload",
          "Cashu payment payload is invalid.",
        );
      }
      throw error;
    }

    let issuedInvoice: Awaited<ReturnType<InvoiceRepository["findOpenInvoiceById"]>>;
    try {
      issuedInvoice = await this.repository.findOpenInvoiceById(envelope.invoiceId);
    } catch {
      throw storageUnavailable();
    }
    if (issuedInvoice === undefined) {
      throw new PaymentIntakeServiceError(
        "payment_request_not_found",
        "Cashu payment request was not found.",
      );
    }

    let observedAt: ReturnType<typeof unixTimestamp>;
    try {
      observedAt = unixTimestamp(this.clock());
    } catch {
      throw new PaymentIntakeServiceError(
        "storage_unavailable",
        "Cashu payment intake is unavailable.",
      );
    }
    if (observedAt < issuedInvoice.invoice.createdAt) {
      throw new PaymentIntakeServiceError(
        "storage_unavailable",
        "Cashu payment intake is unavailable.",
      );
    }
    if (observedAt >= issuedInvoice.invoice.expiresAt) {
      throw new PaymentIntakeServiceError(
        "payment_request_expired",
        "Cashu payment request has expired.",
      );
    }
    if (envelope.unit !== issuedInvoice.invoice.unit) {
      throw new PaymentIntakeServiceError(
        "payment_unit_not_accepted",
        "Cashu payment unit does not match the invoice.",
      );
    }
    if (
      !issuedInvoice.cashuPaymentRequest.operators.some(
        (operator) => operator.mintUrl === envelope.mintUrl,
      )
    ) {
      throw new PaymentIntakeServiceError(
        "payment_mint_not_accepted",
        "Cashu payment mint is not accepted for this invoice.",
      );
    }
    if (envelope.grossAmount < issuedInvoice.invoice.amount) {
      throw new PaymentIntakeServiceError(
        "payment_amount_insufficient",
        "Cashu payment gross amount is below the invoice amount.",
      );
    }

    throw new PaymentIntakeServiceError(
      "proof_validation_unavailable",
      "Cashu proof validation is not available.",
    );
  }
}

function storageUnavailable(): PaymentIntakeServiceError {
  return new PaymentIntakeServiceError(
    "storage_unavailable",
    "Cashu payment intake storage is unavailable.",
  );
}
