import {
  createCipheriv,
  createDecipheriv,
  type KeyObject,
  randomBytes as secureRandomBytes,
} from "node:crypto";
import { assertIdentifier } from "@cashmesh/domain";

export const CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM = "aes-256-gcm-v1" as const;
export const CASHU_PROOF_CUSTODY_NONCE_BYTES = 12;
export const CASHU_PROOF_CUSTODY_TAG_BYTES = 16;

const MAX_AAD_BYTES = 4_096;
const MAX_CIPHERTEXT_BYTES = 65_536;
const ENCRYPTION_CONTEXT = Buffer.from("cashmesh:cashu-proof-custody:v1\0", "ascii");

declare const custodyKeyIdBrand: unique symbol;

export type CashuProofCustodyKeyId = string & { readonly [custodyKeyIdBrand]: true };

export interface CashuProofCustodyKey {
  readonly key: KeyObject;
  readonly keyId: CashuProofCustodyKeyId;
}

export interface CashuProofCustodyKeyProvider {
  activeKey(): Promise<CashuProofCustodyKey>;
  findKey(keyId: CashuProofCustodyKeyId): Promise<CashuProofCustodyKey | undefined>;
}

export interface EncryptedCashuProofBundleV1 {
  readonly algorithm: typeof CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM;
  readonly authenticationTag: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly keyId: CashuProofCustodyKeyId;
  readonly nonce: Uint8Array;
}

export interface CashuProofCustodyCipher {
  decrypt(record: EncryptedCashuProofBundleV1, aad: Uint8Array): Promise<Uint8Array>;
  encrypt(plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedCashuProofBundleV1>;
}

export type CashuProofCustodyCipherErrorCode =
  | "encryption_failed"
  | "integrity_failed"
  | "invalid_cipher_input"
  | "key_unavailable";

export class CashuProofCustodyCipherError extends Error {
  override readonly name = "CashuProofCustodyCipherError";

  constructor(
    readonly code: CashuProofCustodyCipherErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Aes256GcmCashuProofCustodyCipherOptions {
  readonly keyProvider: CashuProofCustodyKeyProvider;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export class Aes256GcmCashuProofCustodyCipher implements CashuProofCustodyCipher {
  readonly #keyProvider: CashuProofCustodyKeyProvider;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(options: Aes256GcmCashuProofCustodyCipherOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options) ||
      typeof options.keyProvider?.activeKey !== "function" ||
      typeof options.keyProvider.findKey !== "function" ||
      (options.randomBytes !== undefined && typeof options.randomBytes !== "function")
    ) {
      throw invalidCipherInput();
    }
    this.#keyProvider = options.keyProvider;
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  async encrypt(plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedCashuProofBundleV1> {
    validateBytes(plaintext, 1, MAX_CIPHERTEXT_BYTES);
    validateBytes(aad, 1, MAX_AAD_BYTES);
    let key: CashuProofCustodyKey;
    try {
      key = validateKey(await this.#keyProvider.activeKey());
    } catch (error) {
      if (error instanceof CashuProofCustodyCipherError) {
        throw error;
      }
      throw keyUnavailable();
    }
    try {
      const nonce = Uint8Array.from(this.#randomBytes(CASHU_PROOF_CUSTODY_NONCE_BYTES));
      if (nonce.byteLength !== CASHU_PROOF_CUSTODY_NONCE_BYTES) {
        throw invalidCipherInput();
      }
      const cipher = createCipheriv("aes-256-gcm", key.key, nonce, {
        authTagLength: CASHU_PROOF_CUSTODY_TAG_BYTES,
      });
      cipher.setAAD(createBoundAad(key.keyId, aad));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authenticationTag = cipher.getAuthTag();
      return Object.freeze({
        algorithm: CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM,
        authenticationTag: Uint8Array.from(authenticationTag),
        ciphertext: Uint8Array.from(ciphertext),
        keyId: key.keyId,
        nonce,
      });
    } catch (error) {
      if (error instanceof CashuProofCustodyCipherError) {
        throw error;
      }
      throw new CashuProofCustodyCipherError(
        "encryption_failed",
        "Cashu bearer proof encryption failed.",
      );
    }
  }

  async decrypt(record: EncryptedCashuProofBundleV1, aad: Uint8Array): Promise<Uint8Array> {
    validateEncryptedRecord(record);
    validateBytes(aad, 1, MAX_AAD_BYTES);
    let key: CashuProofCustodyKey | undefined;
    try {
      key = await this.#keyProvider.findKey(record.keyId);
    } catch {
      throw keyUnavailable();
    }
    if (key === undefined) {
      throw keyUnavailable();
    }
    let validatedKey: CashuProofCustodyKey;
    try {
      validatedKey = validateKey(key);
    } catch {
      throw keyUnavailable();
    }
    if (validatedKey.keyId !== record.keyId) {
      throw keyUnavailable();
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", validatedKey.key, record.nonce, {
        authTagLength: CASHU_PROOF_CUSTODY_TAG_BYTES,
      });
      decipher.setAAD(createBoundAad(record.keyId, aad));
      decipher.setAuthTag(record.authenticationTag);
      return Uint8Array.from(Buffer.concat([decipher.update(record.ciphertext), decipher.final()]));
    } catch {
      throw new CashuProofCustodyCipherError(
        "integrity_failed",
        "Cashu bearer proof ciphertext failed authentication.",
      );
    }
  }
}

export function cashuProofCustodyKeyId(value: string): CashuProofCustodyKeyId {
  assertIdentifier(value, "Cashu proof custody key id");
  return value as CashuProofCustodyKeyId;
}

export function createCashuProofCustodyKey(
  keyId: CashuProofCustodyKeyId,
  key: KeyObject,
): CashuProofCustodyKey {
  return validateKey({ key, keyId });
}

function validateKey(value: CashuProofCustodyKey): CashuProofCustodyKey {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !(value.key instanceof Object) ||
      value.key.type !== "secret" ||
      value.key.symmetricKeySize !== 32 ||
      typeof value.keyId !== "string"
    ) {
      throw invalidCipherInput();
    }
    const keyId = cashuProofCustodyKeyId(value.keyId);
    return Object.freeze({ key: value.key, keyId });
  } catch (error) {
    if (error instanceof CashuProofCustodyCipherError) {
      throw error;
    }
    throw invalidCipherInput();
  }
}

function validateEncryptedRecord(
  value: EncryptedCashuProofBundleV1,
): asserts value is EncryptedCashuProofBundleV1 {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      value.algorithm !== CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM ||
      typeof value.keyId !== "string"
    ) {
      throw invalidCipherInput();
    }
    cashuProofCustodyKeyId(value.keyId);
    validateBytes(value.nonce, CASHU_PROOF_CUSTODY_NONCE_BYTES, CASHU_PROOF_CUSTODY_NONCE_BYTES);
    validateBytes(
      value.authenticationTag,
      CASHU_PROOF_CUSTODY_TAG_BYTES,
      CASHU_PROOF_CUSTODY_TAG_BYTES,
    );
    validateBytes(value.ciphertext, 1, MAX_CIPHERTEXT_BYTES);
  } catch (error) {
    if (error instanceof CashuProofCustodyCipherError) {
      throw error;
    }
    throw invalidCipherInput();
  }
}

function validateBytes(value: Uint8Array, minimum: number, maximum: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw invalidCipherInput();
  }
}

function createBoundAad(keyId: CashuProofCustodyKeyId, aad: Uint8Array): Buffer {
  return Buffer.concat([ENCRYPTION_CONTEXT, Buffer.from(keyId, "ascii"), Buffer.of(0), aad]);
}

function invalidCipherInput(): CashuProofCustodyCipherError {
  return new CashuProofCustodyCipherError(
    "invalid_cipher_input",
    "Cashu bearer proof cipher input is invalid.",
  );
}

function keyUnavailable(): CashuProofCustodyCipherError {
  return new CashuProofCustodyCipherError(
    "key_unavailable",
    "Cashu bearer proof encryption key is unavailable.",
  );
}
