import { pointFromHex } from "@cashu/cashu-ts";

const KEYSET_ID_PATTERN = /^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/;
const PROOF_Y_PATTERN = /^(?:02|03)[0-9a-f]{64}$/;

declare const proofYBrand: unique symbol;

export type CashuProofY = string & { readonly [proofYBrand]: true };

export interface CashuProofReferenceInputV1 {
  readonly amount: number;
  readonly keysetId: string;
  readonly y: string;
}

export interface CashuProofReferenceV1 {
  readonly amount: number;
  readonly keysetId: string;
  readonly y: string;
}

export class CashuProofReferenceError extends Error {
  override readonly name = "CashuProofReferenceError";
}

export function createCashuProofReferenceV1(
  input: CashuProofReferenceInputV1,
): CashuProofReferenceV1 {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount <= 0 ||
    typeof input.keysetId !== "string" ||
    !KEYSET_ID_PATTERN.test(input.keysetId) ||
    typeof input.y !== "string"
  ) {
    throw invalidReference();
  }
  const y = cashuProofY(input.y);
  return Object.freeze({ amount: input.amount, keysetId: input.keysetId, y });
}

export function cashuProofY(value: string): CashuProofY {
  if (typeof value !== "string" || !PROOF_Y_PATTERN.test(value)) {
    throw invalidReference();
  }
  try {
    pointFromHex(value);
  } catch {
    throw invalidReference();
  }
  return value as CashuProofY;
}

function invalidReference(): CashuProofReferenceError {
  return new CashuProofReferenceError("Cashu proof reference is invalid.");
}
