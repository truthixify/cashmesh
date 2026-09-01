import { type InvoiceId, invoiceId } from "@cashmesh/domain";
import {
  normalizeMintUrl,
  PaymentRequest,
  type PaymentRequestPayload,
  type Proof,
} from "@cashu/cashu-ts";

export const MAX_NUT18_PAYMENT_PAYLOAD_BYTES = 65_536;
export const MAX_NUT18_PAYMENT_PROOFS = 128;

const MAX_ENDPOINT_LENGTH = 512;
const MAX_MEMO_LENGTH = 512;
const MAX_PROOF_IDENTIFIER_LENGTH = 128;
const MAX_PROOF_SECRET_LENGTH = 4_096;
const MAX_PROOF_SIGNATURE_LENGTH = 192;
const MAX_UNIT_LENGTH = 32;
const MAX_SAFE_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);
const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TEXT_ENCODER = new TextEncoder();

export interface CashuPaymentPayloadEnvelopeV1 {
  readonly grossAmount: number;
  readonly invoiceId: InvoiceId;
  readonly mintUrl: string;
  readonly proofCount: number;
  readonly unit: string;
}

export type CashuPaymentPayloadErrorCode =
  | "amount_limit_exceeded"
  | "invalid_invoice_id"
  | "invalid_mint"
  | "invalid_payload"
  | "invalid_proof"
  | "invalid_unit"
  | "payload_too_large"
  | "proof_limit_exceeded";

export class CashuPaymentPayloadError extends Error {
  override readonly name = "CashuPaymentPayloadError";

  constructor(
    readonly code: CashuPaymentPayloadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function inspectCashuPaymentPayloadV1(rawPayload: string): CashuPaymentPayloadEnvelopeV1 {
  if (typeof rawPayload !== "string" || rawPayload.length === 0) {
    throw new CashuPaymentPayloadError(
      "invalid_payload",
      "Cashu payment payload must be JSON text.",
    );
  }
  if (encodedLength(rawPayload) > MAX_NUT18_PAYMENT_PAYLOAD_BYTES) {
    throw new CashuPaymentPayloadError(
      "payload_too_large",
      "Cashu payment payload exceeds the transport limit.",
    );
  }

  let payload: PaymentRequestPayload;
  try {
    payload = PaymentRequest.decodePayload(rawPayload);
  } catch {
    throw new CashuPaymentPayloadError("invalid_payload", "Cashu payment payload is malformed.");
  }

  const requestedInvoiceId = parseInvoiceId(payload.id);
  const mintUrl = normalizePaymentMint(payload.mint);
  const unit = parseUnit(payload.unit);
  if (payload.memo !== undefined && encodedLength(payload.memo) > MAX_MEMO_LENGTH) {
    throw new CashuPaymentPayloadError("invalid_payload", "Cashu payment memo is too large.");
  }
  if (payload.proofs.length > MAX_NUT18_PAYMENT_PROOFS) {
    throw new CashuPaymentPayloadError(
      "proof_limit_exceeded",
      "Cashu payment payload contains too many proofs.",
    );
  }

  let grossAmount = 0n;
  for (const proof of payload.proofs) {
    validateProofEnvelope(proof);
    const amount = proof.amount.toBigInt();
    if (amount === 0n) {
      throw new CashuPaymentPayloadError(
        "invalid_proof",
        "Cashu proofs must have positive amounts.",
      );
    }
    grossAmount += amount;
    if (grossAmount > MAX_SAFE_AMOUNT) {
      throw new CashuPaymentPayloadError(
        "amount_limit_exceeded",
        "Cashu payment amount exceeds CashMesh integer bounds.",
      );
    }
  }

  return Object.freeze({
    grossAmount: Number(grossAmount),
    invoiceId: requestedInvoiceId,
    mintUrl,
    proofCount: payload.proofs.length,
    unit,
  });
}

function parseInvoiceId(value: string | undefined): InvoiceId {
  try {
    return invoiceId(value ?? "");
  } catch {
    throw new CashuPaymentPayloadError(
      "invalid_invoice_id",
      "Cashu payment payload has an invalid invoice identifier.",
    );
  }
}

function parseUnit(value: string): string {
  if (value.length > MAX_UNIT_LENGTH || value !== value.trim() || !UNIT_PATTERN.test(value)) {
    throw new CashuPaymentPayloadError("invalid_unit", "Cashu payment payload unit is invalid.");
  }
  return value;
}

function normalizePaymentMint(value: string): string {
  if (value.length === 0 || value.length > MAX_ENDPOINT_LENGTH || value !== value.trim()) {
    throw new CashuPaymentPayloadError("invalid_mint", "Cashu payment mint URL is invalid.");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new CashuPaymentPayloadError("invalid_mint", "Cashu payment mint URL is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new CashuPaymentPayloadError("invalid_mint", "Cashu payment mint URL is unsafe.");
  }

  try {
    return normalizeMintUrl(endpoint.toString());
  } catch {
    throw new CashuPaymentPayloadError("invalid_mint", "Cashu payment mint URL is invalid.");
  }
}

function validateProofEnvelope(proof: Proof): void {
  if (
    !isBoundedText(proof.id, MAX_PROOF_IDENTIFIER_LENGTH) ||
    !isBoundedText(proof.secret, MAX_PROOF_SECRET_LENGTH) ||
    !isBoundedText(proof.C, MAX_PROOF_SIGNATURE_LENGTH)
  ) {
    throw new CashuPaymentPayloadError("invalid_proof", "Cashu payment proof fields are invalid.");
  }
}

function isBoundedText(value: string, maximumBytes: number): boolean {
  return value.length > 0 && encodedLength(value) <= maximumBytes;
}

function encodedLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}
