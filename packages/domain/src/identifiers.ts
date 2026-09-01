declare const identifierBrand: unique symbol;
declare const timestampBrand: unique symbol;

export type Identifier<Kind extends string> = string & {
  readonly [identifierBrand]: Kind;
};

export type IdempotencyKey = Identifier<"idempotency">;
export type InvoiceId = Identifier<"invoice">;
export type JournalEntryId = Identifier<"journal_entry">;
export type MerchantId = Identifier<"merchant">;
export type OperatorId = Identifier<"operator">;
export type PaymentId = Identifier<"payment">;
export type SettlementAssetId = Identifier<"settlement_asset">;
export type UnixTimestamp = number & { readonly [timestampBrand]: true };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class IdentifierError extends Error {
  override readonly name = "IdentifierError";

  constructor(
    readonly code: "invalid_identifier" | "invalid_timestamp",
    message: string,
  ) {
    super(message);
  }
}

export function invoiceId(value: string): InvoiceId {
  return identifier(value, "invoice");
}

export function idempotencyKey(value: string): IdempotencyKey {
  return identifier(value, "idempotency");
}

export function journalEntryId(value: string): JournalEntryId {
  return identifier(value, "journal_entry");
}

export function merchantId(value: string): MerchantId {
  return identifier(value, "merchant");
}

export function operatorId(value: string): OperatorId {
  return identifier(value, "operator");
}

export function paymentId(value: string): PaymentId {
  return identifier(value, "payment");
}

export function settlementAssetId(value: string): SettlementAssetId {
  return identifier(value, "settlement_asset");
}

export function unixTimestamp(value: number): UnixTimestamp {
  assertUnixTimestamp(value);
  return value as UnixTimestamp;
}

export function assertUnixTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IdentifierError(
      "invalid_timestamp",
      "Unix timestamps must be non-negative safe integers in seconds.",
    );
  }
}

export function assertIdentifier(value: string, field: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new IdentifierError(
      "invalid_identifier",
      `${field} must be 1 to 128 URL-safe identifier characters.`,
    );
  }
}

function identifier<Kind extends string>(value: string, kind: Kind): Identifier<Kind> {
  assertIdentifier(value, `${kind} id`);
  return value as Identifier<Kind>;
}
