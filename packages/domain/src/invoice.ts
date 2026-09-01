import {
  assertIdentifier,
  assertUnixTimestamp,
  type InvoiceId,
  type JournalEntryId,
  type MerchantId,
  type OperatorId,
  type PaymentId,
  type UnixTimestamp,
} from "./identifiers";
import {
  createInvoicePaymentJournalV1,
  type InvoicePaymentJournalInput,
  type JournalEntryV1,
  type OperatorEcashAccountV1,
  type SettlementAssetAccountV1,
} from "./ledger";
import { type MinorUnitAmount, minorUnits } from "./money";
import type { SettlementMode } from "./operator-policy";

export const INVOICE_SCHEMA_VERSION = 1 as const;
export const INVOICE_UNIT = "usdc" as const;
export const INVOICE_STATES = ["open", "paid", "expired", "cancelled"] as const;

export type InvoiceState = (typeof INVOICE_STATES)[number];

interface InvoiceBaseV1 {
  readonly amount: MinorUnitAmount;
  readonly createdAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly id: InvoiceId;
  readonly merchantId: MerchantId;
  readonly schemaVersion: typeof INVOICE_SCHEMA_VERSION;
  readonly unit: typeof INVOICE_UNIT;
}

export interface OpenInvoiceV1 extends InvoiceBaseV1 {
  readonly state: "open";
}

export interface InvoicePaymentV1 {
  readonly acceptedAt: UnixTimestamp;
  readonly assetAccount: OperatorEcashAccountV1 | SettlementAssetAccountV1;
  readonly feeAmount: MinorUnitAmount;
  readonly grossAmount: MinorUnitAmount;
  readonly journalEntryId: JournalEntryId;
  readonly netAmount: MinorUnitAmount;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly settlementMode: SettlementMode;
}

export interface PaidInvoiceV1 extends InvoiceBaseV1 {
  readonly paidAt: UnixTimestamp;
  readonly payment: InvoicePaymentV1;
  readonly state: "paid";
}

export interface ExpiredInvoiceV1 extends InvoiceBaseV1 {
  readonly expiredAt: UnixTimestamp;
  readonly state: "expired";
}

export interface CancelledInvoiceV1 extends InvoiceBaseV1 {
  readonly cancelledAt: UnixTimestamp;
  readonly state: "cancelled";
}

export type InvoiceV1 = OpenInvoiceV1 | PaidInvoiceV1 | ExpiredInvoiceV1 | CancelledInvoiceV1;

export interface CreateInvoiceInput {
  readonly amount: MinorUnitAmount;
  readonly createdAt: UnixTimestamp;
  readonly expiresAt: UnixTimestamp;
  readonly id: InvoiceId;
  readonly merchantId: MerchantId;
}

export interface AcceptInvoicePaymentInput
  extends Omit<InvoicePaymentJournalInput, "grossAmount" | "invoiceId" | "merchantId"> {
  readonly acceptedAt: UnixTimestamp;
}

export interface AcceptedInvoicePaymentV1 {
  readonly invoice: PaidInvoiceV1;
  readonly journalEntry: JournalEntryV1;
}

export type InvoiceErrorCode =
  | "amount_must_be_positive"
  | "invalid_expiry"
  | "invalid_transition"
  | "payment_after_expiry"
  | "payment_before_creation"
  | "recorded_before_acceptance"
  | "unsupported_schema";

export class InvoiceError extends Error {
  override readonly name = "InvoiceError";

  constructor(
    readonly code: InvoiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function createInvoiceV1(input: CreateInvoiceInput): OpenInvoiceV1 {
  const amount = validateInvoiceBase(input);
  return Object.freeze({
    amount,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    id: input.id,
    merchantId: input.merchantId,
    schemaVersion: INVOICE_SCHEMA_VERSION,
    state: "open",
    unit: INVOICE_UNIT,
  });
}

export function acceptInvoicePaymentV1(
  invoice: InvoiceV1,
  input: AcceptInvoicePaymentInput,
): AcceptedInvoicePaymentV1 {
  requireOpen(invoice, "accept payment");
  assertUnixTimestamp(input.acceptedAt);
  assertUnixTimestamp(input.effectiveAt);
  if (input.acceptedAt < invoice.createdAt) {
    throw new InvoiceError(
      "payment_before_creation",
      "Payment cannot be accepted before invoice creation.",
    );
  }
  if (input.acceptedAt >= invoice.expiresAt) {
    throw new InvoiceError(
      "payment_after_expiry",
      "Payment cannot be accepted at or after expiry.",
    );
  }
  if (input.effectiveAt < input.acceptedAt) {
    throw new InvoiceError(
      "recorded_before_acceptance",
      "Journal time cannot precede payment acceptance.",
    );
  }

  const journalEntry = createInvoicePaymentJournalV1({
    ...input,
    grossAmount: invoice.amount,
    invoiceId: invoice.id,
    merchantId: invoice.merchantId,
  });
  const feeAmount = minorUnits(input.feeAmount);
  const netAmount = minorUnits(invoice.amount - feeAmount);
  const payment: InvoicePaymentV1 = Object.freeze({
    acceptedAt: input.acceptedAt,
    assetAccount: clonePaymentAsset(input.assetAccount),
    feeAmount,
    grossAmount: invoice.amount,
    journalEntryId: input.journalEntryId,
    netAmount,
    operatorId: input.operatorId,
    paymentId: input.paymentId,
    settlementMode: input.settlementMode,
  });
  const paidInvoice: PaidInvoiceV1 = Object.freeze({
    ...copyInvoiceBase(invoice),
    paidAt: input.acceptedAt,
    payment,
    state: "paid" as const,
  });
  return Object.freeze({ invoice: paidInvoice, journalEntry });
}

export function expireInvoiceV1(invoice: InvoiceV1, expiredAt: UnixTimestamp): ExpiredInvoiceV1 {
  requireOpen(invoice, "expire");
  assertUnixTimestamp(expiredAt);
  if (expiredAt < invoice.expiresAt) {
    throw new InvoiceError("invalid_expiry", "Invoice cannot expire before its expiry time.");
  }
  return Object.freeze({ ...copyInvoiceBase(invoice), expiredAt, state: "expired" });
}

export function cancelInvoiceV1(
  invoice: InvoiceV1,
  cancelledAt: UnixTimestamp,
): CancelledInvoiceV1 {
  requireOpen(invoice, "cancel");
  assertUnixTimestamp(cancelledAt);
  if (cancelledAt < invoice.createdAt || cancelledAt >= invoice.expiresAt) {
    throw new InvoiceError(
      "invalid_expiry",
      "Cancellation must occur during the open invoice window.",
    );
  }
  return Object.freeze({ ...copyInvoiceBase(invoice), cancelledAt, state: "cancelled" });
}

function requireOpen(invoice: InvoiceV1, action: string): asserts invoice is OpenInvoiceV1 {
  if (invoice.schemaVersion !== INVOICE_SCHEMA_VERSION || invoice.unit !== INVOICE_UNIT) {
    throw new InvoiceError(
      "unsupported_schema",
      "Invoice schema version or accounting unit is unsupported.",
    );
  }
  if (invoice.state !== "open") {
    throw new InvoiceError(
      "invalid_transition",
      `Cannot ${action} while invoice is ${invoice.state}.`,
    );
  }
  validateInvoiceBase(invoice);
}

function validateInvoiceBase(input: CreateInvoiceInput): MinorUnitAmount {
  assertIdentifier(input.id, "invoice id");
  assertIdentifier(input.merchantId, "merchant id");
  assertUnixTimestamp(input.createdAt);
  assertUnixTimestamp(input.expiresAt);
  const amount = minorUnits(input.amount);
  if (amount === 0) {
    throw new InvoiceError("amount_must_be_positive", "Invoice amount must be positive.");
  }
  if (input.expiresAt <= input.createdAt) {
    throw new InvoiceError("invalid_expiry", "Invoice expiry must be after creation.");
  }
  return amount;
}

function copyInvoiceBase(invoice: InvoiceBaseV1): InvoiceBaseV1 {
  return {
    amount: invoice.amount,
    createdAt: invoice.createdAt,
    expiresAt: invoice.expiresAt,
    id: invoice.id,
    merchantId: invoice.merchantId,
    schemaVersion: INVOICE_SCHEMA_VERSION,
    unit: INVOICE_UNIT,
  };
}

function clonePaymentAsset(
  account: InvoicePaymentJournalInput["assetAccount"],
): InvoicePaymentV1["assetAccount"] {
  if (account.kind === "operator_ecash") {
    return Object.freeze({ kind: "operator_ecash", operatorId: account.operatorId });
  }
  return Object.freeze({ assetId: account.assetId, kind: "settlement_asset" });
}
