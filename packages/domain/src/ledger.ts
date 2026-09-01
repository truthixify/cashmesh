import {
  assertIdentifier,
  assertUnixTimestamp,
  type InvoiceId,
  type JournalEntryId,
  type MerchantId,
  type OperatorId,
  type PaymentId,
  type SettlementAssetId,
  type UnixTimestamp,
} from "./identifiers";
import { type MinorUnitAmount, minorUnits } from "./money";
import { SETTLEMENT_MODES, type SettlementMode } from "./operator-policy";

export const LEDGER_SCHEMA_VERSION = 1 as const;
export const LEDGER_UNIT = "usdc" as const;
export const POSTING_SIDES = ["debit", "credit"] as const;

export type PostingSide = (typeof POSTING_SIDES)[number];

export type LedgerAccountV1 =
  | {
      readonly kind: "operator_ecash";
      readonly operatorId: OperatorId;
    }
  | {
      readonly assetId: SettlementAssetId;
      readonly kind: "settlement_asset";
    }
  | {
      readonly kind: "merchant_payable";
      readonly merchantId: MerchantId;
    }
  | {
      readonly kind: "fee_revenue";
    };

export type OperatorEcashAccountV1 = Extract<LedgerAccountV1, { readonly kind: "operator_ecash" }>;
export type SettlementAssetAccountV1 = Extract<
  LedgerAccountV1,
  { readonly kind: "settlement_asset" }
>;
export type MerchantPayableAccountV1 = Extract<
  LedgerAccountV1,
  { readonly kind: "merchant_payable" }
>;
export type FeeRevenueAccountV1 = Extract<LedgerAccountV1, { readonly kind: "fee_revenue" }>;
export type PaymentAssetAccountV1 = OperatorEcashAccountV1 | SettlementAssetAccountV1;

export interface LedgerPostingV1 {
  readonly account: LedgerAccountV1;
  readonly amount: MinorUnitAmount;
  readonly side: PostingSide;
}

export interface InvoicePaymentReferenceV1 {
  readonly invoiceId: InvoiceId;
  readonly kind: "invoice_payment";
  readonly merchantId: MerchantId;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly settlementMode: SettlementMode;
}

export interface JournalEntryV1 {
  readonly effectiveAt: UnixTimestamp;
  readonly id: JournalEntryId;
  readonly postings: readonly LedgerPostingV1[];
  readonly reference: InvoicePaymentReferenceV1;
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly unit: typeof LEDGER_UNIT;
}

export interface InvoicePaymentJournalInput {
  readonly assetAccount: PaymentAssetAccountV1;
  readonly effectiveAt: UnixTimestamp;
  readonly feeAmount: MinorUnitAmount;
  readonly grossAmount: MinorUnitAmount;
  readonly invoiceId: InvoiceId;
  readonly journalEntryId: JournalEntryId;
  readonly merchantId: MerchantId;
  readonly operatorId: OperatorId;
  readonly paymentId: PaymentId;
  readonly settlementMode: SettlementMode;
}

export type LedgerErrorCode =
  | "account_mode_mismatch"
  | "duplicate_invoice_payment"
  | "duplicate_journal_entry"
  | "duplicate_payment"
  | "fee_not_less_than_gross"
  | "invalid_account"
  | "invalid_posting"
  | "invalid_payment_entry"
  | "invalid_reference"
  | "posting_total_overflow"
  | "unbalanced_entry";

export class LedgerError extends Error {
  override readonly name = "LedgerError";

  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function operatorEcashAccount(operatorId: OperatorId): OperatorEcashAccountV1 {
  assertIdentifier(operatorId, "operator id");
  return Object.freeze({ kind: "operator_ecash", operatorId });
}

export function settlementAssetAccount(assetId: SettlementAssetId): SettlementAssetAccountV1 {
  assertIdentifier(assetId, "settlement asset id");
  return Object.freeze({ assetId, kind: "settlement_asset" });
}

export function merchantPayableAccount(merchantId: MerchantId): MerchantPayableAccountV1 {
  assertIdentifier(merchantId, "merchant id");
  return Object.freeze({ kind: "merchant_payable", merchantId });
}

export function feeRevenueAccount(): FeeRevenueAccountV1 {
  return Object.freeze({ kind: "fee_revenue" });
}

export function ledgerAccountKey(account: LedgerAccountV1): string {
  validateAccount(account);
  switch (account.kind) {
    case "operator_ecash":
      return `operator_ecash:${account.operatorId}`;
    case "settlement_asset":
      return `settlement_asset:${account.assetId}`;
    case "merchant_payable":
      return `merchant_payable:${account.merchantId}`;
    case "fee_revenue":
      return "fee_revenue:usdc";
  }
}

export function createJournalEntryV1(input: {
  readonly effectiveAt: UnixTimestamp;
  readonly id: JournalEntryId;
  readonly postings: readonly LedgerPostingV1[];
  readonly reference: InvoicePaymentReferenceV1;
}): JournalEntryV1 {
  assertIdentifier(input.id, "journal entry id");
  validateReference(input.reference);
  assertUnixTimestamp(input.effectiveAt);
  if (input.postings.length < 2) {
    throw new LedgerError("invalid_posting", "A journal entry requires at least two postings.");
  }

  let debits = 0n;
  let credits = 0n;
  const postings = input.postings.map((posting) => {
    validateAccount(posting.account);
    const amount = minorUnits(posting.amount);
    if (amount === 0 || !POSTING_SIDES.includes(posting.side)) {
      throw new LedgerError(
        "invalid_posting",
        "Posting amounts must be positive with a valid side.",
      );
    }
    if (posting.side === "debit") {
      debits += BigInt(amount);
    } else {
      credits += BigInt(amount);
    }
    return Object.freeze({
      account: cloneAccount(posting.account),
      amount,
      side: posting.side,
    });
  });

  if (debits > BigInt(Number.MAX_SAFE_INTEGER) || credits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LedgerError("posting_total_overflow", "Journal totals exceed safe integer bounds.");
  }
  if (debits !== credits) {
    throw new LedgerError("unbalanced_entry", "Journal debits and credits must balance exactly.");
  }
  validateInvoicePaymentPostings(postings, input.reference);

  return Object.freeze({
    effectiveAt: input.effectiveAt,
    id: input.id,
    postings: Object.freeze(postings),
    reference: Object.freeze({
      invoiceId: input.reference.invoiceId,
      kind: "invoice_payment",
      merchantId: input.reference.merchantId,
      operatorId: input.reference.operatorId,
      paymentId: input.reference.paymentId,
      settlementMode: input.reference.settlementMode,
    }),
    schemaVersion: LEDGER_SCHEMA_VERSION,
    unit: LEDGER_UNIT,
  });
}

export function createInvoicePaymentJournalV1(input: InvoicePaymentJournalInput): JournalEntryV1 {
  validateSettlementMode(input.settlementMode);
  validatePaymentAsset(input.assetAccount, input.operatorId, input.settlementMode);
  const grossAmount = minorUnits(input.grossAmount);
  const feeAmount = minorUnits(input.feeAmount);
  if (grossAmount === 0 || feeAmount >= grossAmount) {
    throw new LedgerError(
      "fee_not_less_than_gross",
      "Gross amount must be positive and fee must be less than gross.",
    );
  }
  const netAmount = minorUnits(grossAmount - feeAmount);
  const postings: LedgerPostingV1[] = [
    { account: input.assetAccount, amount: grossAmount, side: "debit" },
    {
      account: merchantPayableAccount(input.merchantId),
      amount: netAmount,
      side: "credit",
    },
  ];
  if (feeAmount > 0) {
    postings.push({ account: feeRevenueAccount(), amount: feeAmount, side: "credit" });
  }

  return createJournalEntryV1({
    effectiveAt: input.effectiveAt,
    id: input.journalEntryId,
    postings,
    reference: {
      invoiceId: input.invoiceId,
      kind: "invoice_payment",
      merchantId: input.merchantId,
      operatorId: input.operatorId,
      paymentId: input.paymentId,
      settlementMode: input.settlementMode,
    },
  });
}

export function assertJournalBatchUnique(entries: readonly JournalEntryV1[]): void {
  const entryIds = new Set<string>();
  const invoiceIds = new Set<string>();
  const paymentIds = new Set<string>();
  for (const entry of entries) {
    if (entryIds.has(entry.id)) {
      throw new LedgerError("duplicate_journal_entry", `Journal entry ${entry.id} is duplicated.`);
    }
    if (invoiceIds.has(entry.reference.invoiceId)) {
      throw new LedgerError(
        "duplicate_invoice_payment",
        `Invoice ${entry.reference.invoiceId} has more than one payment journal.`,
      );
    }
    if (paymentIds.has(entry.reference.paymentId)) {
      throw new LedgerError(
        "duplicate_payment",
        `Payment ${entry.reference.paymentId} appears in more than one journal.`,
      );
    }
    entryIds.add(entry.id);
    invoiceIds.add(entry.reference.invoiceId);
    paymentIds.add(entry.reference.paymentId);
  }
}

function validatePaymentAsset(
  account: InvoicePaymentJournalInput["assetAccount"],
  operatorId: OperatorId,
  mode: SettlementMode,
): void {
  validateAccount(account);
  const matchesTrustedHold = account.kind === "operator_ecash" && account.operatorId === operatorId;
  const matchesConversion = account.kind === "settlement_asset";
  if (
    (mode === "trusted_hold" && !matchesTrustedHold) ||
    (mode === "immediate_conversion" && !matchesConversion)
  ) {
    throw new LedgerError(
      "account_mode_mismatch",
      "Payment asset account does not match the recorded settlement mode.",
    );
  }
}

function validateSettlementMode(mode: SettlementMode): void {
  if (!SETTLEMENT_MODES.includes(mode)) {
    throw new LedgerError("invalid_posting", "Settlement mode is invalid.");
  }
}

function validateReference(reference: InvoicePaymentReferenceV1): void {
  if (reference.kind !== "invoice_payment") {
    throw new LedgerError("invalid_reference", "Journal reference kind is invalid.");
  }
  assertIdentifier(reference.invoiceId, "invoice id");
  assertIdentifier(reference.merchantId, "merchant id");
  assertIdentifier(reference.operatorId, "operator id");
  assertIdentifier(reference.paymentId, "payment id");
  validateSettlementMode(reference.settlementMode);
}

function validateInvoicePaymentPostings(
  postings: readonly LedgerPostingV1[],
  reference: InvoicePaymentReferenceV1,
): void {
  const assetDebits = postings.filter(
    (posting): posting is LedgerPostingV1 & { readonly account: PaymentAssetAccountV1 } =>
      posting.side === "debit" &&
      (posting.account.kind === "operator_ecash" || posting.account.kind === "settlement_asset"),
  );
  const merchantCredits = postings.filter(
    (posting) =>
      posting.side === "credit" &&
      posting.account.kind === "merchant_payable" &&
      posting.account.merchantId === reference.merchantId,
  );
  const feeCredits = postings.filter(
    (posting) => posting.side === "credit" && posting.account.kind === "fee_revenue",
  );

  if (
    assetDebits.length !== 1 ||
    merchantCredits.length !== 1 ||
    feeCredits.length > 1 ||
    postings.length !== assetDebits.length + merchantCredits.length + feeCredits.length
  ) {
    throw new LedgerError(
      "invalid_payment_entry",
      "Invoice payment journals require one asset debit, one matching merchant credit, and an optional fee credit.",
    );
  }
  const assetDebit = assetDebits[0];
  if (assetDebit === undefined) {
    throw new LedgerError("invalid_payment_entry", "Invoice payment asset debit is missing.");
  }
  validatePaymentAsset(assetDebit.account, reference.operatorId, reference.settlementMode);
}

function validateAccount(account: LedgerAccountV1): void {
  switch (account.kind) {
    case "operator_ecash":
      assertIdentifier(account.operatorId, "operator id");
      return;
    case "settlement_asset":
      assertIdentifier(account.assetId, "settlement asset id");
      return;
    case "merchant_payable":
      assertIdentifier(account.merchantId, "merchant id");
      return;
    case "fee_revenue":
      return;
    default:
      throw new LedgerError("invalid_account", "Ledger account kind is invalid.");
  }
}

function cloneAccount(account: LedgerAccountV1): LedgerAccountV1 {
  switch (account.kind) {
    case "operator_ecash":
      return Object.freeze({ kind: "operator_ecash", operatorId: account.operatorId });
    case "settlement_asset":
      return Object.freeze({ assetId: account.assetId, kind: "settlement_asset" });
    case "merchant_payable":
      return Object.freeze({ kind: "merchant_payable", merchantId: account.merchantId });
    case "fee_revenue":
      return Object.freeze({ kind: "fee_revenue" });
  }
}
