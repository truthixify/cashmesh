import { pointFromHex } from "@cashu/cashu-ts";

const KEYSET_ID_PATTERN = /^(?:00[0-9a-f]{14}|01[0-9a-f]{64})$/;
const PROOF_Y_PATTERN = /^(?:02|03)[0-9a-f]{64}$/;

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
    typeof input.y !== "string" ||
    !PROOF_Y_PATTERN.test(input.y)
  ) {
    throw invalidReference();
  }
  try {
    pointFromHex(input.y);
  } catch {
    throw invalidReference();
  }
  return Object.freeze({ amount: input.amount, keysetId: input.keysetId, y: input.y });
}

function invalidReference(): CashuProofReferenceError {
  return new CashuProofReferenceError("Cashu proof reference is invalid.");
}
