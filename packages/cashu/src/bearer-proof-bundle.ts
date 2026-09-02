import { type InvoiceId, invoiceId } from "@cashmesh/domain";
import { hashToCurve, type Proof, pointFromHex, pointToHex } from "@cashu/cashu-ts";

import { normalizeCashuMintUrl } from "./mint-url";
import {
  type CashuProofReferenceV1,
  type CashuProofY,
  cashuProofY,
  createCashuProofReferenceV1,
} from "./proof-reference";

export const CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION = 1 as const;
export const MAX_CASHU_BEARER_PROOF_BUNDLE_BYTES = 65_536;

const MAX_PROOF_SECRET_BYTES = 4_096;
const MAX_UNIT_LENGTH = 32;
const SECP_POINT_PATTERN = /^(02|03)[0-9a-f]{64}$/;
const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();
const BUNDLE_CONSTRUCTION_TOKEN = Symbol("CashuBearerProofBundleV1");
const INITIAL_CUSTODY_BUNDLES = new WeakSet<object>();

interface StoredCashuBearerProofV1 {
  readonly amount: number;
  readonly keysetId: string;
  readonly secret: string;
  readonly signature: string;
  readonly y: CashuProofY;
}

interface StoredCashuBearerProofBundleV1 {
  readonly invoiceId: InvoiceId;
  readonly mintUrl: string;
  readonly proofs: readonly StoredCashuBearerProofV1[];
  readonly schemaVersion: typeof CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION;
  readonly unit: string;
}

export interface CreateCashuBearerProofBundleInputV1 {
  readonly invoiceId: InvoiceId;
  readonly mintUrl: string;
  readonly proofReferences: readonly CashuProofReferenceV1[];
  readonly proofs: readonly Proof[];
  readonly unit: string;
}

export type CashuBearerProofBundleErrorCode =
  | "bundle_destroyed"
  | "invalid_bundle"
  | "unsupported_spending_condition";

export class CashuBearerProofBundleError extends Error {
  override readonly name = "CashuBearerProofBundleError";

  constructor(
    readonly code: CashuBearerProofBundleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class CashuBearerProofBundleV1 {
  readonly #initiallyValidated: boolean;
  #plaintext: Uint8Array;
  readonly #proofReferences: readonly CashuProofReferenceV1[];

  constructor(
    constructionToken: typeof BUNDLE_CONSTRUCTION_TOKEN,
    readonly invoiceId: InvoiceId,
    readonly mintUrl: string,
    readonly proofCount: number,
    readonly unit: string,
    proofReferences: readonly CashuProofReferenceV1[],
    plaintext: Uint8Array,
    initiallyValidated: boolean,
  ) {
    if (constructionToken !== BUNDLE_CONSTRUCTION_TOKEN) {
      throw new CashuBearerProofBundleError(
        "invalid_bundle",
        "Cashu bearer proof bundle is invalid.",
      );
    }
    this.#initiallyValidated = initiallyValidated;
    this.#plaintext = plaintext;
    this.#proofReferences = proofReferences;
    if (initiallyValidated) {
      INITIAL_CUSTODY_BUNDLES.add(this);
    }
    Object.freeze(this);
  }

  destroy(): void {
    INITIAL_CUSTODY_BUNDLES.delete(this);
    this.#plaintext.fill(0);
    this.#plaintext = new Uint8Array();
  }

  serializeForEncryption(): Uint8Array {
    if (this.#plaintext.byteLength === 0) {
      throw new CashuBearerProofBundleError(
        "bundle_destroyed",
        "Cashu bearer proof bundle has already been destroyed.",
      );
    }
    return Uint8Array.from(this.#plaintext);
  }

  proofReferencesForBinding(): readonly CashuProofReferenceV1[] {
    return this.#proofReferences;
  }

  isValidatedForInitialCustody(): boolean {
    return this.#initiallyValidated && INITIAL_CUSTODY_BUNDLES.has(this);
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      invoiceId: this.invoiceId,
      mintUrl: this.mintUrl,
      proofCount: this.proofCount,
      redacted: true,
      schemaVersion: CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION,
      unit: this.unit,
    });
  }

  toString(): string {
    return "CashuBearerProofBundleV1 [REDACTED]";
  }
}

export function isCashuBearerProofBundleValidatedForInitialCustodyV1(
  value: unknown,
): value is CashuBearerProofBundleV1 {
  return typeof value === "object" && value !== null && INITIAL_CUSTODY_BUNDLES.has(value);
}

export function createCashuBearerProofBundleV1(
  input: CreateCashuBearerProofBundleInputV1,
): CashuBearerProofBundleV1 {
  try {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      !Array.isArray(input.proofs) ||
      !Array.isArray(input.proofReferences) ||
      input.proofs.length === 0 ||
      input.proofs.length !== input.proofReferences.length
    ) {
      return failInvalidBundle();
    }
    const requestedInvoiceId = invoiceId(input.invoiceId);
    const mintUrl = normalizeCashuMintUrl(input.mintUrl);
    const unit = normalizeUnit(input.unit);
    const references = new Map<CashuProofY, CashuProofReferenceV1>();
    for (const reference of input.proofReferences) {
      const normalized = createCashuProofReferenceV1(reference);
      const y = cashuProofY(normalized.y);
      if (references.has(y)) {
        return failInvalidBundle();
      }
      references.set(y, normalized);
    }

    const proofs = input.proofs.map((proof) => {
      if (proof.witness !== undefined || isWellKnownSecret(proof.secret)) {
        throw new CashuBearerProofBundleError(
          "unsupported_spending_condition",
          "Cashu bearer proof custody does not support spending conditions.",
        );
      }
      const secret = normalizeSecret(proof.secret);
      const y = proofYFromSecret(secret);
      const reference = references.get(y);
      const amount = Number(proof.amount.toBigInt());
      if (
        reference === undefined ||
        reference.amount !== amount ||
        reference.keysetId !== proof.id
      ) {
        return failInvalidBundle();
      }
      references.delete(y);
      return Object.freeze({
        amount,
        keysetId: reference.keysetId,
        secret,
        signature: normalizeSignature(proof.C),
        y,
      });
    });
    if (references.size !== 0) {
      return failInvalidBundle();
    }
    proofs.sort(compareProofs);
    return bundleFromStored(
      {
        invoiceId: requestedInvoiceId,
        mintUrl,
        proofs,
        schemaVersion: CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION,
        unit,
      },
      true,
    );
  } catch (error) {
    if (error instanceof CashuBearerProofBundleError) {
      throw error;
    }
    return failInvalidBundle();
  }
}

export function restoreCashuBearerProofBundleV1(plaintext: Uint8Array): CashuBearerProofBundleV1 {
  try {
    if (
      !(plaintext instanceof Uint8Array) ||
      plaintext.byteLength === 0 ||
      plaintext.byteLength > MAX_CASHU_BEARER_PROOF_BUNDLE_BYTES
    ) {
      return failInvalidBundle();
    }
    const parsed = JSON.parse(TEXT_DECODER.decode(plaintext)) as unknown;
    requireExactObject(parsed, ["invoiceId", "mintUrl", "proofs", "schemaVersion", "unit"]);
    if (
      parsed.schemaVersion !== CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION ||
      !Array.isArray(parsed.proofs) ||
      parsed.proofs.length === 0 ||
      parsed.proofs.length > 128
    ) {
      return failInvalidBundle();
    }
    const requestedInvoiceId = invoiceId(parsed.invoiceId as string);
    const mintUrl = normalizeCashuMintUrl(parsed.mintUrl);
    const unit = normalizeUnit(parsed.unit);
    const seenYs = new Set<CashuProofY>();
    const proofs = parsed.proofs.map((proof) => {
      requireExactObject(proof, ["amount", "keysetId", "secret", "signature", "y"]);
      if (
        typeof proof.amount !== "number" ||
        typeof proof.keysetId !== "string" ||
        typeof proof.signature !== "string" ||
        typeof proof.y !== "string"
      ) {
        return failInvalidBundle();
      }
      const secret = normalizeSecret(proof.secret);
      if (isWellKnownSecret(secret)) {
        throw new CashuBearerProofBundleError(
          "unsupported_spending_condition",
          "Cashu bearer proof custody does not support spending conditions.",
        );
      }
      const reference = createCashuProofReferenceV1({
        amount: proof.amount,
        keysetId: proof.keysetId,
        y: proof.y,
      });
      const y = cashuProofY(reference.y);
      if (proofYFromSecret(secret) !== y || seenYs.has(y)) {
        return failInvalidBundle();
      }
      seenYs.add(y);
      return Object.freeze({
        amount: reference.amount,
        keysetId: reference.keysetId,
        secret,
        signature: normalizeSignature(proof.signature),
        y,
      });
    });
    if (
      proofs.some(
        (proof, position) => position > 0 && compareProofs(proofs[position - 1], proof) >= 0,
      )
    ) {
      return failInvalidBundle();
    }
    const bundle = {
      invoiceId: requestedInvoiceId,
      mintUrl,
      proofs,
      schemaVersion: CASHU_BEARER_PROOF_BUNDLE_SCHEMA_VERSION,
      unit,
    } as const;
    const canonical = encodeStoredBundle(bundle);
    if (!bytesEqual(canonical, plaintext)) {
      return failInvalidBundle();
    }
    return constructBundle(bundle, canonical, false);
  } catch (error) {
    if (error instanceof CashuBearerProofBundleError) {
      throw error;
    }
    return failInvalidBundle();
  }
}

function bundleFromStored(
  bundle: StoredCashuBearerProofBundleV1,
  initiallyValidated: boolean,
): CashuBearerProofBundleV1 {
  const plaintext = encodeStoredBundle(bundle);
  if (plaintext.byteLength > MAX_CASHU_BEARER_PROOF_BUNDLE_BYTES) {
    return failInvalidBundle();
  }
  return constructBundle(bundle, plaintext, initiallyValidated);
}

function constructBundle(
  bundle: StoredCashuBearerProofBundleV1,
  plaintext: Uint8Array,
  initiallyValidated: boolean,
): CashuBearerProofBundleV1 {
  return new CashuBearerProofBundleV1(
    BUNDLE_CONSTRUCTION_TOKEN,
    bundle.invoiceId,
    bundle.mintUrl,
    bundle.proofs.length,
    bundle.unit,
    Object.freeze(
      bundle.proofs.map((proof) =>
        createCashuProofReferenceV1({
          amount: proof.amount,
          keysetId: proof.keysetId,
          y: proof.y,
        }),
      ),
    ),
    plaintext,
    initiallyValidated,
  );
}

function encodeStoredBundle(bundle: StoredCashuBearerProofBundleV1): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(bundle));
}

function proofYFromSecret(secret: string): CashuProofY {
  return cashuProofY(pointToHex({ kind: "secp", pt: hashToCurve(TEXT_ENCODER.encode(secret)) }));
}

function normalizeSignature(value: string): string {
  const canonical = value.toLowerCase();
  if (!SECP_POINT_PATTERN.test(canonical)) {
    return failInvalidBundle();
  }
  pointFromHex(canonical);
  return canonical;
}

function normalizeSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    TEXT_ENCODER.encode(value).byteLength > MAX_PROOF_SECRET_BYTES
  ) {
    return failInvalidBundle();
  }
  return value;
}

function normalizeUnit(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_UNIT_LENGTH ||
    value !== value.trim() ||
    !UNIT_PATTERN.test(value)
  ) {
    return failInvalidBundle();
  }
  return value;
}

function isWellKnownSecret(secret: unknown): boolean {
  if (typeof secret !== "string") {
    return false;
  }
  try {
    const value = JSON.parse(secret) as unknown;
    return (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "object" &&
      value[1] !== null &&
      !Array.isArray(value[1])
    );
  } catch {
    return false;
  }
}

function compareProofs(
  left: StoredCashuBearerProofV1 | undefined,
  right: StoredCashuBearerProofV1,
): number {
  if (left === undefined) {
    return -1;
  }
  return left.y < right.y ? -1 : left.y > right.y ? 1 : 0;
}

function requireExactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  ) {
    return failInvalidBundle();
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function failInvalidBundle(): never {
  throw new CashuBearerProofBundleError("invalid_bundle", "Cashu bearer proof bundle is invalid.");
}
