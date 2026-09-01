import { describe, expect, it } from "vitest";

import {
  acceptInvoicePaymentV1,
  assertJournalBatchUnique,
  cancelInvoiceV1,
  createInvoicePaymentJournalV1,
  createInvoiceV1,
  createJournalEntryV1,
  expireInvoiceV1,
  feeRevenueAccount,
  IdentifierError,
  InvoiceError,
  invoiceId,
  journalEntryId,
  LedgerError,
  ledgerAccountKey,
  merchantId,
  merchantPayableAccount,
  minorUnits,
  operatorEcashAccount,
  operatorId,
  paymentId,
  settlementAssetAccount,
  settlementAssetId,
  type UnixTimestamp,
  unixTimestamp,
} from "../src";

const CREATED_AT = unixTimestamp(1_787_000_000);
const EXPIRES_AT = unixTimestamp(1_787_000_300);
const ACCEPTED_AT = unixTimestamp(1_787_000_120);
const EFFECTIVE_AT = unixTimestamp(1_787_000_125);
const MERCHANT_ID = merchantId("merchant-001");
const OPERATOR_A = operatorId("operator-a");
const OPERATOR_B = operatorId("operator-b");
const SETTLEMENT_ASSET = settlementAssetId("stellar-testnet-usdc-circle");

describe("merchant invoice accounting", () => {
  it("creates an immutable, versioned open invoice", () => {
    const invoice = openInvoice();

    expect(invoice).toEqual({
      amount: 1_234,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      id: "invoice-001",
      merchantId: MERCHANT_ID,
      schemaVersion: 1,
      state: "open",
      unit: "usdc",
    });
    expect(Object.isFrozen(invoice)).toBe(true);
  });

  it("rejects zero-value invoices and invalid validity windows", () => {
    expect(
      errorFrom(() =>
        createInvoiceV1({
          amount: minorUnits(0),
          createdAt: CREATED_AT,
          expiresAt: EXPIRES_AT,
          id: invoiceId("zero-invoice"),
          merchantId: MERCHANT_ID,
        }),
      ),
    ).toMatchObject({ code: "amount_must_be_positive" });

    expect(
      errorFrom(() =>
        createInvoiceV1({
          amount: minorUnits(100),
          createdAt: CREATED_AT,
          expiresAt: CREATED_AT,
          id: invoiceId("invalid-window"),
          merchantId: MERCHANT_ID,
        }),
      ),
    ).toMatchObject({ code: "invalid_expiry" });
  });

  it("records trusted e-cash as an operator-specific asset with a fee split", () => {
    const accepted = acceptInvoicePaymentV1(openInvoice(), {
      acceptedAt: ACCEPTED_AT,
      assetAccount: operatorEcashAccount(OPERATOR_A),
      effectiveAt: EFFECTIVE_AT,
      feeAmount: minorUnits(34),
      journalEntryId: journalEntryId("journal-001"),
      operatorId: OPERATOR_A,
      paymentId: paymentId("payment-001"),
      settlementMode: "trusted_hold",
    });

    expect(accepted.invoice).toMatchObject({
      paidAt: ACCEPTED_AT,
      payment: {
        acceptedAt: ACCEPTED_AT,
        assetAccount: { kind: "operator_ecash", operatorId: OPERATOR_A },
        feeAmount: 34,
        grossAmount: 1_234,
        journalEntryId: "journal-001",
        netAmount: 1_200,
        operatorId: OPERATOR_A,
        paymentId: "payment-001",
        settlementMode: "trusted_hold",
      },
      state: "paid",
    });
    expect(accepted.journalEntry).toEqual({
      effectiveAt: EFFECTIVE_AT,
      id: "journal-001",
      postings: [
        {
          account: { kind: "operator_ecash", operatorId: OPERATOR_A },
          amount: 1_234,
          side: "debit",
        },
        {
          account: { kind: "merchant_payable", merchantId: MERCHANT_ID },
          amount: 1_200,
          side: "credit",
        },
        { account: { kind: "fee_revenue" }, amount: 34, side: "credit" },
      ],
      reference: {
        invoiceId: "invoice-001",
        kind: "invoice_payment",
        merchantId: MERCHANT_ID,
        operatorId: OPERATOR_A,
        paymentId: "payment-001",
        settlementMode: "trusted_hold",
      },
      schemaVersion: 1,
      unit: "usdc",
    });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.invoice.payment)).toBe(true);
    expect(Object.isFrozen(accepted.invoice.payment.assetAccount)).toBe(true);
    expect(Object.isFrozen(accepted.journalEntry.postings)).toBe(true);
    expect(Object.isFrozen(accepted.journalEntry.postings[0]?.account)).toBe(true);
  });

  it("records immediate conversion in the explicit settlement asset", () => {
    const accepted = acceptInvoicePaymentV1(openInvoice(), {
      acceptedAt: ACCEPTED_AT,
      assetAccount: settlementAssetAccount(SETTLEMENT_ASSET),
      effectiveAt: ACCEPTED_AT,
      feeAmount: minorUnits(0),
      journalEntryId: journalEntryId("journal-converted"),
      operatorId: OPERATOR_A,
      paymentId: paymentId("payment-converted"),
      settlementMode: "immediate_conversion",
    });

    expect(accepted.invoice.payment.assetAccount).toEqual({
      assetId: SETTLEMENT_ASSET,
      kind: "settlement_asset",
    });
    expect(accepted.journalEntry.postings).toEqual([
      {
        account: { assetId: SETTLEMENT_ASSET, kind: "settlement_asset" },
        amount: 1_234,
        side: "debit",
      },
      {
        account: { kind: "merchant_payable", merchantId: MERCHANT_ID },
        amount: 1_234,
        side: "credit",
      },
    ]);
  });

  it("keeps trusted operator assets in distinct ledger accounts", () => {
    expect(ledgerAccountKey(operatorEcashAccount(OPERATOR_A))).toBe("operator_ecash:operator-a");
    expect(ledgerAccountKey(operatorEcashAccount(OPERATOR_B))).toBe("operator_ecash:operator-b");
    expect(operatorEcashAccount(OPERATOR_A)).not.toEqual(operatorEcashAccount(OPERATOR_B));
  });

  it.each([
    {
      account: settlementAssetAccount(SETTLEMENT_ASSET),
      mode: "trusted_hold" as const,
      operator: OPERATOR_A,
    },
    {
      account: operatorEcashAccount(OPERATOR_A),
      mode: "immediate_conversion" as const,
      operator: OPERATOR_A,
    },
    {
      account: operatorEcashAccount(OPERATOR_B),
      mode: "trusted_hold" as const,
      operator: OPERATOR_A,
    },
  ])("rejects an asset account that does not match $mode", ({ account, mode, operator }) => {
    expect(
      errorFrom(() =>
        createInvoicePaymentJournalV1({
          assetAccount: account,
          effectiveAt: EFFECTIVE_AT,
          feeAmount: minorUnits(0),
          grossAmount: minorUnits(100),
          invoiceId: invoiceId("invoice-mode-check"),
          journalEntryId: journalEntryId("journal-mode-check"),
          merchantId: MERCHANT_ID,
          operatorId: operator,
          paymentId: paymentId("payment-mode-check"),
          settlementMode: mode,
        }),
      ),
    ).toMatchObject({ code: "account_mode_mismatch" });
  });

  it("rejects fees that consume the entire payment", () => {
    expect(
      errorFrom(() =>
        createInvoicePaymentJournalV1({
          assetAccount: operatorEcashAccount(OPERATOR_A),
          effectiveAt: EFFECTIVE_AT,
          feeAmount: minorUnits(100),
          grossAmount: minorUnits(100),
          invoiceId: invoiceId("invoice-fee-check"),
          journalEntryId: journalEntryId("journal-fee-check"),
          merchantId: MERCHANT_ID,
          operatorId: OPERATOR_A,
          paymentId: paymentId("payment-fee-check"),
          settlementMode: "trusted_hold",
        }),
      ),
    ).toMatchObject({ code: "fee_not_less_than_gross" });
  });

  it("enforces payment and journal time boundaries", () => {
    expect(
      errorFrom(() =>
        acceptInvoicePaymentV1(
          openInvoice(),
          paymentInput({ acceptedAt: unixTimestamp(CREATED_AT - 1) }),
        ),
      ),
    ).toMatchObject({ code: "payment_before_creation" });
    expect(
      errorFrom(() =>
        acceptInvoicePaymentV1(
          openInvoice(),
          paymentInput({ acceptedAt: unixTimestamp(EXPIRES_AT + 1) }),
        ),
      ),
    ).toMatchObject({ code: "payment_after_expiry" });
    expect(
      errorFrom(() =>
        acceptInvoicePaymentV1(
          openInvoice(),
          paymentInput({ effectiveAt: unixTimestamp(ACCEPTED_AT - 1) }),
        ),
      ),
    ).toMatchObject({ code: "recorded_before_acceptance" });

    const beforeExpiry = acceptInvoicePaymentV1(
      openInvoice(),
      paymentInput({
        acceptedAt: unixTimestamp(EXPIRES_AT - 1),
        effectiveAt: EXPIRES_AT,
      }),
    );
    expect(beforeExpiry.invoice.paidAt).toBe(EXPIRES_AT - 1);
    expect(
      errorFrom(() =>
        acceptInvoicePaymentV1(
          openInvoice(),
          paymentInput({ acceptedAt: EXPIRES_AT, effectiveAt: EXPIRES_AT }),
        ),
      ),
    ).toMatchObject({ code: "payment_after_expiry" });
  });

  it("revalidates branded timestamps at public boundaries", () => {
    const invalidTimestamp = -1 as UnixTimestamp;
    expect(() =>
      createInvoiceV1({
        amount: minorUnits(100),
        createdAt: invalidTimestamp,
        expiresAt: EXPIRES_AT,
        id: invoiceId("invalid-time"),
        merchantId: MERCHANT_ID,
      }),
    ).toThrowError(IdentifierError);
    expect(errorFrom(() => expireInvoiceV1(openInvoice(), invalidTimestamp))).toMatchObject({
      code: "invalid_timestamp",
    });
  });

  it("supports only terminal transitions from an open invoice", () => {
    const cancelled = cancelInvoiceV1(openInvoice(), CREATED_AT);
    const expired = expireInvoiceV1(openInvoice(), EXPIRES_AT);
    const paid = acceptInvoicePaymentV1(openInvoice(), paymentInput()).invoice;

    expect(cancelled).toMatchObject({ cancelledAt: CREATED_AT, state: "cancelled" });
    expect(expired).toMatchObject({ expiredAt: EXPIRES_AT, state: "expired" });
    expect(errorFrom(() => expireInvoiceV1(paid, EXPIRES_AT))).toMatchObject({
      code: "invalid_transition",
    });
    expect(errorFrom(() => cancelInvoiceV1(expired, CREATED_AT))).toMatchObject({
      code: "invalid_transition",
    });
    expect(errorFrom(() => acceptInvoicePaymentV1(cancelled, paymentInput()))).toMatchObject({
      code: "invalid_transition",
    });
  });

  it("projects only declared fields into transitioned records", () => {
    const invoiceWithUnexpectedData = {
      ...openInvoice(),
      customerEmail: "must-not-persist@example.test",
    };
    const accountWithUnexpectedData = {
      ...operatorEcashAccount(OPERATOR_A),
      bearerProof: "must-not-persist",
    };
    const accepted = acceptInvoicePaymentV1(
      invoiceWithUnexpectedData,
      paymentInput({ assetAccount: accountWithUnexpectedData }),
    );

    expect(accepted.invoice).not.toHaveProperty("customerEmail");
    expect(accepted.invoice.payment.assetAccount).not.toHaveProperty("bearerProof");
    expect(accepted.journalEntry.postings[0]?.account).not.toHaveProperty("bearerProof");
  });

  it("revalidates an open invoice before applying a transition", () => {
    const malformedInvoice = {
      ...openInvoice(),
      amount: 0,
    } as unknown as ReturnType<typeof openInvoice>;

    expect(errorFrom(() => acceptInvoicePaymentV1(malformedInvoice, paymentInput()))).toMatchObject(
      {
        code: "amount_must_be_positive",
      },
    );
  });

  it.each([
    { schemaVersion: 2, unit: "usdc" },
    { schemaVersion: 1, unit: "sat" },
  ])("rejects an unsupported stored invoice schema %#", ({ schemaVersion, unit }) => {
    const unsupportedInvoice = {
      ...openInvoice(),
      schemaVersion,
      unit,
    } as unknown as ReturnType<typeof openInvoice>;

    expect(
      errorFrom(() => acceptInvoicePaymentV1(unsupportedInvoice, paymentInput())),
    ).toMatchObject({ code: "unsupported_schema" });
  });

  it("does not allow cancellation at or after invoice expiry", () => {
    expect(errorFrom(() => cancelInvoiceV1(openInvoice(), EXPIRES_AT))).toMatchObject({
      code: "invalid_expiry",
    });
    expect(
      errorFrom(() => cancelInvoiceV1(openInvoice(), unixTimestamp(CREATED_AT - 1))),
    ).toMatchObject({ code: "invalid_expiry" });
  });
});

describe("balanced journal invariants", () => {
  it("rejects an unbalanced entry", () => {
    expect(
      errorFrom(() =>
        createJournalEntryV1({
          effectiveAt: EFFECTIVE_AT,
          id: journalEntryId("journal-unbalanced"),
          postings: [
            {
              account: operatorEcashAccount(OPERATOR_A),
              amount: minorUnits(100),
              side: "debit",
            },
            {
              account: merchantPayableAccount(MERCHANT_ID),
              amount: minorUnits(99),
              side: "credit",
            },
          ],
          reference: paymentReference("invoice-unbalanced", "payment-unbalanced"),
        }),
      ),
    ).toMatchObject({ code: "unbalanced_entry" });
  });

  it("rejects journal totals beyond safe integer bounds", () => {
    const maximum = minorUnits(Number.MAX_SAFE_INTEGER);
    const one = minorUnits(1);
    expect(
      errorFrom(() =>
        createJournalEntryV1({
          effectiveAt: EFFECTIVE_AT,
          id: journalEntryId("journal-overflow"),
          postings: [
            { account: operatorEcashAccount(OPERATOR_A), amount: maximum, side: "debit" },
            { account: operatorEcashAccount(OPERATOR_A), amount: one, side: "debit" },
            { account: merchantPayableAccount(MERCHANT_ID), amount: maximum, side: "credit" },
            { account: feeRevenueAccount(), amount: one, side: "credit" },
          ],
          reference: paymentReference("invoice-overflow", "payment-overflow"),
        }),
      ),
    ).toMatchObject({ code: "posting_total_overflow" });
  });

  it("rejects a malformed journal reference discriminator", () => {
    expect(
      errorFrom(() =>
        createJournalEntryV1({
          effectiveAt: EFFECTIVE_AT,
          id: journalEntryId("journal-reference"),
          postings: [
            {
              account: operatorEcashAccount(OPERATOR_A),
              amount: minorUnits(100),
              side: "debit",
            },
            {
              account: merchantPayableAccount(MERCHANT_ID),
              amount: minorUnits(100),
              side: "credit",
            },
          ],
          reference: {
            ...paymentReference("invoice-reference", "payment-reference"),
            kind: "refund",
          } as unknown as ReturnType<typeof paymentReference>,
        }),
      ),
    ).toMatchObject({ code: "invalid_reference" });
  });

  it("rejects a balanced invoice journal credited to a different merchant", () => {
    expect(
      errorFrom(() =>
        createJournalEntryV1({
          effectiveAt: EFFECTIVE_AT,
          id: journalEntryId("journal-wrong-merchant"),
          postings: [
            {
              account: operatorEcashAccount(OPERATOR_A),
              amount: minorUnits(100),
              side: "debit",
            },
            {
              account: merchantPayableAccount(merchantId("merchant-other")),
              amount: minorUnits(100),
              side: "credit",
            },
          ],
          reference: paymentReference("invoice-wrong-merchant", "payment-wrong-merchant"),
        }),
      ),
    ).toMatchObject({ code: "invalid_payment_entry" });
  });

  it("detects duplicate journal, invoice-payment, and payment identifiers", () => {
    const first = paymentJournal("first", "invoice-first", "payment-first");

    expect(errorFrom(() => assertJournalBatchUnique([first, first]))).toMatchObject({
      code: "duplicate_journal_entry",
    });
    expect(
      errorFrom(() =>
        assertJournalBatchUnique([
          first,
          paymentJournal("second", "invoice-first", "payment-second"),
        ]),
      ),
    ).toMatchObject({ code: "duplicate_invoice_payment" });
    expect(
      errorFrom(() =>
        assertJournalBatchUnique([
          first,
          paymentJournal("third", "invoice-third", "payment-first"),
        ]),
      ),
    ).toMatchObject({ code: "duplicate_payment" });
  });

  it("exposes stable domain error types", () => {
    expect(InvoiceError.prototype).toBeInstanceOf(Error);
    expect(LedgerError.prototype).toBeInstanceOf(Error);
  });
});

function openInvoice() {
  return createInvoiceV1({
    amount: minorUnits(1_234),
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    id: invoiceId("invoice-001"),
    merchantId: MERCHANT_ID,
  });
}

function paymentInput(
  overrides: Partial<Parameters<typeof acceptInvoicePaymentV1>[1]> = {},
): Parameters<typeof acceptInvoicePaymentV1>[1] {
  return {
    acceptedAt: ACCEPTED_AT,
    assetAccount: operatorEcashAccount(OPERATOR_A),
    effectiveAt: EFFECTIVE_AT,
    feeAmount: minorUnits(0),
    journalEntryId: journalEntryId("journal-default"),
    operatorId: OPERATOR_A,
    paymentId: paymentId("payment-default"),
    settlementMode: "trusted_hold",
    ...overrides,
  };
}

function paymentReference(invoice: string, payment: string) {
  return {
    invoiceId: invoiceId(invoice),
    kind: "invoice_payment" as const,
    merchantId: MERCHANT_ID,
    operatorId: OPERATOR_A,
    paymentId: paymentId(payment),
    settlementMode: "trusted_hold" as const,
  };
}

function paymentJournal(journal: string, invoice: string, payment: string) {
  return createInvoicePaymentJournalV1({
    assetAccount: operatorEcashAccount(OPERATOR_A),
    effectiveAt: EFFECTIVE_AT,
    feeAmount: minorUnits(0),
    grossAmount: minorUnits(100),
    invoiceId: invoiceId(invoice),
    journalEntryId: journalEntryId(journal),
    merchantId: MERCHANT_ID,
    operatorId: OPERATOR_A,
    paymentId: paymentId(payment),
    settlementMode: "trusted_hold",
  });
}

function errorFrom(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected action to throw.");
}
