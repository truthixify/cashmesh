import {
  type MinorUnitAmount,
  minorUnits,
  type UnixTimestamp,
  unixTimestamp,
} from "@cashmesh/domain";

import { normalizeCashuMintUrl } from "./mint-url";

export const CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION = 1 as const;
export const CASHU_STELLAR_METHOD = "stellar" as const;
export const CASHU_STELLAR_UNIT = "usdc" as const;
export const CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE =
  "Test SDF Network ; September 2015" as const;
export const CASHU_STELLAR_TESTNET_USDC_ASSET_CODE = "USDC" as const;
export const CASHU_STELLAR_TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" as const;
export const MIN_CASHU_STELLAR_MELT_AMOUNT = 1;
export const MAX_CASHU_STELLAR_MELT_AMOUNT = 25_000;
export const MAX_CASHU_STELLAR_MELT_QUOTE_TTL_SECONDS = 900;
export const MAX_CASHU_STELLAR_MELT_REQUEST_LENGTH = 4_096;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STELLAR_ADDRESS_PATTERN = /^(?:G[A-Z2-7]{55}|M[A-Z2-7]{68})$/;
const STELLAR_DECIMAL_PATTERN = /^([0-9]+)(?:\.([0-9]{0,7}))?$/;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STELLAR_ACCOUNT_ID_VERSION = 6 << 3;
const STELLAR_MUXED_ACCOUNT_VERSION = 12 << 3;
const STELLAR_ACCOUNT_ID_BYTES = 35;
const STELLAR_MUXED_ACCOUNT_BYTES = 43;
const STELLAR_STROOPS_PER_UNIT = 100_000n;
const STROOPS_PER_WHOLE_USDC = 10_000_000n;
const ALLOWED_SEP7_PARAMETERS = new Set([
  "amount",
  "asset_code",
  "asset_issuer",
  "destination",
  "memo",
  "memo_type",
  "network_passphrase",
]);
const ALLOWED_MEMO_TYPES = new Set(["MEMO_HASH", "MEMO_ID", "MEMO_RETURN", "MEMO_TEXT"]);

declare const cashuStellarMeltQuoteIdBrand: unique symbol;
declare const cashuStellarSettlementDestinationBrand: unique symbol;

export type CashuStellarMeltQuoteId = string & {
  readonly [cashuStellarMeltQuoteIdBrand]: true;
};

export type CashuStellarSettlementDestination = string & {
  readonly [cashuStellarSettlementDestinationBrand]: true;
};

export type CashuStellarMeltQuoteState = "PAID" | "PENDING" | "UNPAID";

export interface CreateCashuStellarMeltQuoteRequestInputV1 {
  readonly amount: number;
  readonly request: string;
}

export interface CashuStellarMeltQuoteRequestV1 {
  readonly amount: MinorUnitAmount;
  readonly method: typeof CASHU_STELLAR_METHOD;
  readonly request: string;
  readonly unit: typeof CASHU_STELLAR_UNIT;
}

export interface CreateCashuStellarMeltQuoteInputV1 {
  readonly amount: number;
  readonly expiry: number;
  readonly feeReserve?: number;
  readonly method: string;
  readonly mintUrl: string;
  readonly observedAt: number;
  readonly quoteId: string;
  readonly request: string;
  readonly schemaVersion?: number;
  readonly state: string;
  readonly unit: string;
}

export interface CashuStellarMeltQuoteV1 {
  readonly amount: MinorUnitAmount;
  readonly expiry: UnixTimestamp;
  readonly feeReserve: MinorUnitAmount;
  readonly method: typeof CASHU_STELLAR_METHOD;
  readonly mintUrl: string;
  readonly observedAt: UnixTimestamp;
  readonly quoteId: CashuStellarMeltQuoteId;
  readonly request: string;
  readonly schemaVersion: typeof CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION;
  readonly state: CashuStellarMeltQuoteState;
  readonly unit: typeof CASHU_STELLAR_UNIT;
}

export type CashuStellarMeltQuoteErrorCode =
  | "amount_out_of_range"
  | "invalid_expiry"
  | "invalid_fee_reserve"
  | "invalid_mint"
  | "invalid_observed_at"
  | "invalid_quote_id"
  | "invalid_request"
  | "invalid_snapshot"
  | "invalid_state";

export class CashuStellarMeltQuoteError extends Error {
  override readonly name = "CashuStellarMeltQuoteError";

  constructor(
    readonly code: CashuStellarMeltQuoteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function cashuStellarMeltQuoteId(value: string): CashuStellarMeltQuoteId {
  if (typeof value !== "string" || !UUID_V7_PATTERN.test(value)) {
    throw new CashuStellarMeltQuoteError(
      "invalid_quote_id",
      "Cashu Stellar melt quote ID must be a canonical UUIDv7.",
    );
  }
  return value as CashuStellarMeltQuoteId;
}

export function cashuStellarSettlementDestination(
  value: string,
): CashuStellarSettlementDestination {
  if (typeof value !== "string" || !isValidStellarDestination(value)) {
    throw invalidRequest();
  }
  return value as CashuStellarSettlementDestination;
}

export function cashuStellarMeltRequestDestination(
  input: CashuStellarMeltQuoteRequestV1,
): CashuStellarSettlementDestination {
  const request = createCashuStellarMeltQuoteRequestV1(input);
  const url = new URL(request.request);
  return cashuStellarSettlementDestination(
    requiredParameter(new Map(url.searchParams), "destination"),
  );
}

export function createCashuStellarMeltQuoteRequestV1(
  input: CreateCashuStellarMeltQuoteRequestInputV1,
): CashuStellarMeltQuoteRequestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidRequest();
  }

  let amount: MinorUnitAmount;
  try {
    amount = minorUnits(input.amount);
  } catch {
    throw amountOutOfRange();
  }
  if (amount < MIN_CASHU_STELLAR_MELT_AMOUNT || amount > MAX_CASHU_STELLAR_MELT_AMOUNT) {
    throw amountOutOfRange();
  }

  validateSep7PaymentRequest(input.request, amount);
  return Object.freeze({
    amount,
    method: CASHU_STELLAR_METHOD,
    request: input.request,
    unit: CASHU_STELLAR_UNIT,
  });
}

export function createCashuStellarMeltQuoteV1(
  input: CreateCashuStellarMeltQuoteInputV1,
): CashuStellarMeltQuoteV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidSnapshot();
  }
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION
  ) {
    throw invalidSnapshot();
  }
  if (input.method !== CASHU_STELLAR_METHOD || input.unit !== CASHU_STELLAR_UNIT) {
    throw invalidSnapshot();
  }

  const request = createCashuStellarMeltQuoteRequestV1({
    amount: input.amount,
    request: input.request,
  });

  let feeReserve: MinorUnitAmount;
  try {
    feeReserve = minorUnits(input.feeReserve === undefined ? 0 : input.feeReserve);
  } catch {
    throw new CashuStellarMeltQuoteError(
      "invalid_fee_reserve",
      "Cashu Stellar melt quote fee reserve is invalid.",
    );
  }
  if (!Number.isSafeInteger(request.amount + feeReserve)) {
    throw new CashuStellarMeltQuoteError(
      "invalid_fee_reserve",
      "Cashu Stellar melt quote total exceeds safe integer bounds.",
    );
  }

  let mintUrl: string;
  try {
    mintUrl = normalizeCashuMintUrl(input.mintUrl);
  } catch {
    throw new CashuStellarMeltQuoteError(
      "invalid_mint",
      "Cashu Stellar melt quote mint URL is invalid.",
    );
  }

  let observedAt: UnixTimestamp;
  try {
    observedAt = unixTimestamp(input.observedAt);
  } catch {
    throw new CashuStellarMeltQuoteError(
      "invalid_observed_at",
      "Cashu Stellar melt quote observation time is invalid.",
    );
  }

  let expiry: UnixTimestamp;
  try {
    expiry = unixTimestamp(input.expiry);
  } catch {
    throw new CashuStellarMeltQuoteError(
      "invalid_expiry",
      "Cashu Stellar melt quote expiry is invalid.",
    );
  }

  if (input.state !== "UNPAID" && input.state !== "PENDING" && input.state !== "PAID") {
    throw new CashuStellarMeltQuoteError(
      "invalid_state",
      "Cashu Stellar melt quote state is invalid.",
    );
  }

  return Object.freeze({
    amount: request.amount,
    expiry,
    feeReserve,
    method: CASHU_STELLAR_METHOD,
    mintUrl,
    observedAt,
    quoteId: cashuStellarMeltQuoteId(input.quoteId),
    request: request.request,
    schemaVersion: CASHU_STELLAR_MELT_QUOTE_SCHEMA_VERSION,
    state: input.state,
    unit: CASHU_STELLAR_UNIT,
  });
}

function validateSep7PaymentRequest(value: string, amount: MinorUnitAmount): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CASHU_STELLAR_MELT_REQUEST_LENGTH ||
    containsRawControlOrWhitespace(value)
  ) {
    throw invalidRequest();
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidRequest();
  }
  if (
    url.protocol !== "web+stellar:" ||
    url.pathname !== "pay" ||
    url.host !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw invalidRequest();
  }

  const parameters = new Map<string, string>();
  for (const [key, parameterValue] of url.searchParams) {
    if (!ALLOWED_SEP7_PARAMETERS.has(key) || parameters.has(key)) {
      throw invalidRequest();
    }
    parameters.set(key, parameterValue);
  }

  const destination = requiredParameter(parameters, "destination");
  const requestAmount = requiredParameter(parameters, "amount");
  const assetCode = requiredParameter(parameters, "asset_code");
  const assetIssuer = requiredParameter(parameters, "asset_issuer");
  const networkPassphrase = requiredParameter(parameters, "network_passphrase");
  if (
    !isValidStellarDestination(destination) ||
    assetCode !== CASHU_STELLAR_TESTNET_USDC_ASSET_CODE ||
    assetIssuer !== CASHU_STELLAR_TESTNET_USDC_ISSUER ||
    networkPassphrase !== CASHU_STELLAR_TESTNET_NETWORK_PASSPHRASE ||
    !stellarAmountMatches(requestAmount, amount)
  ) {
    throw invalidRequest();
  }

  const hasMemo = parameters.has("memo");
  const hasMemoType = parameters.has("memo_type");
  if (hasMemo !== hasMemoType) {
    throw invalidRequest();
  }
  if (hasMemoType && !ALLOWED_MEMO_TYPES.has(parameters.get("memo_type") ?? "")) {
    throw invalidRequest();
  }
}

function isValidStellarDestination(value: string): boolean {
  if (!STELLAR_ADDRESS_PATTERN.test(value)) {
    return false;
  }
  const decoded = decodeBase32(value);
  if (decoded === undefined) {
    return false;
  }
  const isMuxed = value.startsWith("M");
  const expectedLength = isMuxed ? STELLAR_MUXED_ACCOUNT_BYTES : STELLAR_ACCOUNT_ID_BYTES;
  const expectedVersion = isMuxed ? STELLAR_MUXED_ACCOUNT_VERSION : STELLAR_ACCOUNT_ID_VERSION;
  if (decoded.length !== expectedLength || decoded[0] !== expectedVersion) {
    return false;
  }

  const payload = decoded.subarray(0, decoded.length - 2);
  const checksum = crc16Xmodem(payload);
  return (
    decoded[decoded.length - 2] === (checksum & 0xff) &&
    decoded[decoded.length - 1] === checksum >> 8
  );
}

function decodeBase32(value: string): Uint8Array | undefined {
  const output: number[] = [];
  let buffer = 0;
  let bufferedBits = 0;
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) {
      return undefined;
    }
    buffer = (buffer << 5) | digit;
    bufferedBits += 5;
    if (bufferedBits >= 8) {
      bufferedBits -= 8;
      output.push((buffer >> bufferedBits) & 0xff);
      buffer &= (1 << bufferedBits) - 1;
    }
  }
  if (buffer !== 0) {
    return undefined;
  }
  return Uint8Array.from(output);
}

function crc16Xmodem(value: Uint8Array): number {
  let checksum = 0;
  for (const byte of value) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 0x8000 ? ((checksum << 1) ^ 0x1021) & 0xffff : (checksum << 1) & 0xffff;
    }
  }
  return checksum;
}

function containsRawControlOrWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x20 || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function requiredParameter(parameters: ReadonlyMap<string, string>, name: string): string {
  const value = parameters.get(name);
  if (value === undefined || value === "") {
    throw invalidRequest();
  }
  return value;
}

function stellarAmountMatches(value: string, amount: MinorUnitAmount): boolean {
  const match = STELLAR_DECIMAL_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const whole = match[1];
  const fraction = match[2] ?? "";
  if (whole === undefined) {
    return false;
  }
  try {
    const stroops = BigInt(whole) * STROOPS_PER_WHOLE_USDC + BigInt(fraction.padEnd(7, "0") || "0");
    return stroops === BigInt(amount) * STELLAR_STROOPS_PER_UNIT;
  } catch {
    return false;
  }
}

function amountOutOfRange(): CashuStellarMeltQuoteError {
  return new CashuStellarMeltQuoteError(
    "amount_out_of_range",
    `Cashu Stellar melt amount must be ${MIN_CASHU_STELLAR_MELT_AMOUNT} through ${MAX_CASHU_STELLAR_MELT_AMOUNT} USDC minor units.`,
  );
}

function invalidRequest(): CashuStellarMeltQuoteError {
  return new CashuStellarMeltQuoteError(
    "invalid_request",
    "Cashu Stellar melt request must match the bounded testnet USDC SEP-0007 profile.",
  );
}

function invalidSnapshot(): CashuStellarMeltQuoteError {
  return new CashuStellarMeltQuoteError(
    "invalid_snapshot",
    "Cashu Stellar melt quote input is invalid.",
  );
}
