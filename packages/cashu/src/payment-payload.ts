import { type InvoiceId, invoiceId, type UnixTimestamp, unixTimestamp } from "@cashmesh/domain";
import {
  hashToCurve,
  PaymentRequest,
  type PaymentRequestPayload,
  type Proof,
  pointToHex,
  verifyProofsForReceive,
} from "@cashu/cashu-ts";

import { type CashuKeysetSnapshotV1, createCashuKeysetSnapshotV1 } from "./keyset-snapshot";
import { normalizeCashuMintUrl } from "./mint-url";
import { type CashuProofReferenceV1, createCashuProofReferenceV1 } from "./proof-reference";

export const MAX_NUT18_PAYMENT_PAYLOAD_BYTES = 65_536;
export const MAX_NUT18_PAYMENT_PROOFS = 128;

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

export interface ValidateCashuPaymentProofsInputV1 {
  readonly keysetSnapshot: CashuKeysetSnapshotV1;
  readonly rawPayload: string;
  readonly validatedAt: number;
}

export interface ValidatedCashuPaymentProofsV1 extends CashuPaymentPayloadEnvelopeV1 {
  readonly inputFee: number;
  readonly keysetIds: readonly string[];
  readonly keysetSnapshotObservedAt: UnixTimestamp;
  readonly netAmount: number;
  readonly proofReferences: readonly CashuProofReferenceV1[];
  readonly validatedAt: UnixTimestamp;
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

export type CashuProofValidationErrorCode =
  | "duplicate_proof"
  | "input_fee_exceeds_amount"
  | "invalid_validation_input"
  | "invalid_validation_time"
  | "keyset_expired"
  | "keyset_not_found"
  | "keyset_unit_mismatch"
  | "mint_mismatch"
  | "proof_integrity_failed"
  | "snapshot_from_future";

export class CashuProofValidationError extends Error {
  override readonly name = "CashuProofValidationError";

  constructor(
    readonly code: CashuProofValidationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function inspectCashuPaymentPayloadV1(rawPayload: string): CashuPaymentPayloadEnvelopeV1 {
  return decodePaymentPayload(rawPayload).envelope;
}

export function validateCashuPaymentProofsV1(
  input: ValidateCashuPaymentProofsInputV1,
): ValidatedCashuPaymentProofsV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CashuProofValidationError(
      "invalid_validation_input",
      "Cashu proof validation input is invalid.",
    );
  }
  const { envelope, payload } = decodePaymentPayload(input.rawPayload);
  const keysetSnapshot = createCashuKeysetSnapshotV1(input.keysetSnapshot);

  let validatedAt: UnixTimestamp;
  try {
    validatedAt = unixTimestamp(input.validatedAt);
  } catch {
    throw new CashuProofValidationError(
      "invalid_validation_time",
      "Cashu proof validation time is invalid.",
    );
  }
  if (keysetSnapshot.observedAt > validatedAt) {
    throw new CashuProofValidationError(
      "snapshot_from_future",
      "Cashu keyset snapshot was observed after the validation time.",
    );
  }
  if (keysetSnapshot.mintUrl !== envelope.mintUrl) {
    throw new CashuProofValidationError(
      "mint_mismatch",
      "Cashu keyset snapshot does not match the payment mint.",
    );
  }

  const keysetsById = new Map(keysetSnapshot.keysets.map((keyset) => [keyset.id, keyset]));
  const verificationKeysets = new Map(
    keysetSnapshot.keysets.map((keyset) => [
      keyset.id,
      { id: keyset.id, keys: { ...keyset.keys } },
    ]),
  );
  const proofSecrets = new Set<string>();
  const usedKeysetIds = new Set<string>();
  let inputFeePpk = 0n;

  for (const proof of payload.proofs) {
    if (proofSecrets.has(proof.secret)) {
      throw new CashuProofValidationError(
        "duplicate_proof",
        "Cashu payment contains a duplicate proof.",
      );
    }
    proofSecrets.add(proof.secret);

    const keyset = keysetsById.get(proof.id);
    if (keyset === undefined) {
      throw new CashuProofValidationError(
        "keyset_not_found",
        "Cashu payment references an unknown keyset.",
      );
    }
    if (keyset.unit !== envelope.unit) {
      throw new CashuProofValidationError(
        "keyset_unit_mismatch",
        "Cashu payment proof keyset uses a different unit.",
      );
    }
    if (keyset.finalExpiry !== undefined && validatedAt >= keyset.finalExpiry) {
      throw new CashuProofValidationError(
        "keyset_expired",
        "Cashu payment proof keyset has expired.",
      );
    }
    usedKeysetIds.add(keyset.id);
    inputFeePpk += BigInt(keyset.inputFeePpk);
  }

  let proofReferences: CashuProofReferenceV1[];
  try {
    verifyProofsForReceive(
      payload.proofs,
      (keysetId) => {
        const keyset = verificationKeysets.get(keysetId);
        if (keyset === undefined) {
          throw new CashuProofValidationError(
            "keyset_not_found",
            "Cashu payment references an unknown keyset.",
          );
        }
        return keyset;
      },
      { requireDleq: true },
    );
    const proofYs = new Set<string>();
    proofReferences = payload.proofs.map((proof) => {
      const y = pointToHex({
        kind: "secp",
        pt: hashToCurve(TEXT_ENCODER.encode(proof.secret)),
      });
      if (proofYs.has(y)) {
        throw new CashuProofValidationError(
          "duplicate_proof",
          "Cashu payment contains a duplicate proof.",
        );
      }
      proofYs.add(y);
      return createCashuProofReferenceV1({
        amount: Number(proof.amount.toBigInt()),
        keysetId: proof.id,
        y,
      });
    });
    proofReferences.sort((left, right) => (left.y < right.y ? -1 : left.y > right.y ? 1 : 0));
  } catch (error) {
    if (error instanceof CashuProofValidationError) {
      throw error;
    }
    throw new CashuProofValidationError(
      "proof_integrity_failed",
      "Cashu payment proof integrity validation failed.",
    );
  }

  const inputFee = (inputFeePpk + 999n) / 1_000n;
  const grossAmount = BigInt(envelope.grossAmount);
  if (inputFee > grossAmount) {
    throw new CashuProofValidationError(
      "input_fee_exceeds_amount",
      "Cashu payment input fee exceeds its gross amount.",
    );
  }

  return Object.freeze({
    ...envelope,
    inputFee: Number(inputFee),
    keysetIds: Object.freeze([...usedKeysetIds].sort()),
    keysetSnapshotObservedAt: keysetSnapshot.observedAt,
    netAmount: Number(grossAmount - inputFee),
    proofReferences: Object.freeze(proofReferences),
    validatedAt,
  });
}

function decodePaymentPayload(rawPayload: string): {
  readonly envelope: CashuPaymentPayloadEnvelopeV1;
  readonly payload: PaymentRequestPayload;
} {
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

  const envelope = Object.freeze({
    grossAmount: Number(grossAmount),
    invoiceId: requestedInvoiceId,
    mintUrl,
    proofCount: payload.proofs.length,
    unit,
  });
  return { envelope, payload };
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
  try {
    return normalizeCashuMintUrl(value);
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
