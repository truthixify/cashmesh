import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSecretKey,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  CASHU_PROOF_CUSTODY_DATA_KEY_BYTES,
  CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM,
  CASHU_PROOF_CUSTODY_ENVELOPE_ENCRYPTION_ALGORITHM,
  CASHU_PROOF_CUSTODY_MAX_WRAPPED_DATA_KEY_BYTES,
  CASHU_PROOF_CUSTODY_NONCE_BYTES,
  CASHU_PROOF_CUSTODY_TAG_BYTES,
  type CashuProofCustodyCipher,
  CashuProofCustodyCipherError,
  type CashuProofCustodyKeyId,
  cashuProofCustodyKeyId,
  type EncryptedCashuProofBundle,
  type EncryptedCashuProofBundleV2,
} from "./cashu-proof-custody-cipher";

const MAX_AAD_BYTES = 4_096;
const MAX_CIPHERTEXT_BYTES = 65_536;
const ENCRYPTION_CONTEXT = Buffer.from("cashmesh:cashu-proof-custody:envelope:v2\0", "ascii");
const WRAPPING_CONTEXT = Buffer.from("cashmesh:cashu-proof-custody:key-wrap:v2\0", "ascii");
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export interface GeneratedCashuProofCustodyDataKey {
  readonly keyId: CashuProofCustodyKeyId;
  // Ownership transfers to the cipher, which overwrites this buffer after one operation.
  readonly plaintextDataKey: Uint8Array;
  readonly wrappedDataKey: Uint8Array;
}

export interface CashuProofCustodyDataKeyProvider {
  // Implementations must cryptographically authenticate the supplied non-secret context.
  generateDataKey(input: {
    readonly context: Uint8Array;
  }): Promise<GeneratedCashuProofCustodyDataKey>;
  // Ownership of the returned buffer transfers to the cipher and must not be cached or reused.
  unwrapDataKey(input: {
    readonly context: Uint8Array;
    readonly keyId: CashuProofCustodyKeyId;
    readonly wrappedDataKey: Uint8Array;
  }): Promise<Uint8Array>;
}

export interface EnvelopeAes256GcmCashuProofCustodyCipherOptions {
  readonly dataKeyProvider: CashuProofCustodyDataKeyProvider;
  readonly legacyCipher?: CashuProofCustodyCipher;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export class EnvelopeAes256GcmCashuProofCustodyCipher implements CashuProofCustodyCipher {
  readonly #dataKeyProvider: CashuProofCustodyDataKeyProvider;
  readonly #legacyCipher: CashuProofCustodyCipher | undefined;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(options: EnvelopeAes256GcmCashuProofCustodyCipherOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options) ||
      typeof options.dataKeyProvider?.generateDataKey !== "function" ||
      typeof options.dataKeyProvider.unwrapDataKey !== "function" ||
      (options.legacyCipher !== undefined &&
        (typeof options.legacyCipher.encrypt !== "function" ||
          typeof options.legacyCipher.decrypt !== "function")) ||
      (options.randomBytes !== undefined && typeof options.randomBytes !== "function")
    ) {
      throw invalidCipherInput();
    }
    this.#dataKeyProvider = options.dataKeyProvider;
    this.#legacyCipher = options.legacyCipher;
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  async encrypt(plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedCashuProofBundleV2> {
    validateBytes(plaintext, 1, MAX_CIPHERTEXT_BYTES);
    validateBytes(aad, 1, MAX_AAD_BYTES);
    const wrappingContext = createWrappingContext(aad);
    let plaintextDataKey: Uint8Array | undefined;
    try {
      let generated: GeneratedCashuProofCustodyDataKey;
      try {
        generated = await this.#dataKeyProvider.generateDataKey({
          context: Uint8Array.from(wrappingContext),
        });
      } catch {
        throw keyUnavailable();
      }
      if (generated?.plaintextDataKey instanceof Uint8Array) {
        plaintextDataKey = generated.plaintextDataKey;
      }
      const validated = validateGeneratedDataKey(generated);
      plaintextDataKey = validated.plaintextDataKey;
      const wrappedDataKey = Uint8Array.from(validated.wrappedDataKey);
      const dataKeyFingerprint = createDataKeyFingerprint(plaintextDataKey);
      const nonce = Uint8Array.from(this.#randomBytes(CASHU_PROOF_CUSTODY_NONCE_BYTES));
      if (nonce.byteLength !== CASHU_PROOF_CUSTODY_NONCE_BYTES) {
        throw invalidCipherInput();
      }
      const cipher = createCipheriv("aes-256-gcm", createSecretKey(plaintextDataKey), nonce, {
        authTagLength: CASHU_PROOF_CUSTODY_TAG_BYTES,
      });
      cipher.setAAD(createBoundAad(validated.keyId, dataKeyFingerprint, wrappedDataKey, aad));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Object.freeze({
        algorithm: CASHU_PROOF_CUSTODY_ENVELOPE_ENCRYPTION_ALGORITHM,
        authenticationTag: Uint8Array.from(cipher.getAuthTag()),
        ciphertext: Uint8Array.from(ciphertext),
        dataKeyFingerprint,
        keyId: validated.keyId,
        nonce,
        wrappedDataKey,
      });
    } catch (error) {
      if (error instanceof CashuProofCustodyCipherError) {
        throw error;
      }
      throw new CashuProofCustodyCipherError(
        "encryption_failed",
        "Cashu bearer proof encryption failed.",
      );
    } finally {
      plaintextDataKey?.fill(0);
      wrappingContext.fill(0);
    }
  }

  async decrypt(record: EncryptedCashuProofBundle, aad: Uint8Array): Promise<Uint8Array> {
    if (record?.algorithm === CASHU_PROOF_CUSTODY_ENCRYPTION_ALGORITHM) {
      if (this.#legacyCipher === undefined) {
        throw keyUnavailable();
      }
      return await this.#legacyCipher.decrypt(record, aad);
    }
    validateEncryptedRecord(record);
    validateBytes(aad, 1, MAX_AAD_BYTES);
    const wrappingContext = createWrappingContext(aad);
    let plaintextDataKey: Uint8Array | undefined;
    try {
      try {
        plaintextDataKey = await this.#dataKeyProvider.unwrapDataKey({
          context: Uint8Array.from(wrappingContext),
          keyId: record.keyId,
          wrappedDataKey: Uint8Array.from(record.wrappedDataKey),
        });
      } catch {
        throw keyUnavailable();
      }
      if (
        !(plaintextDataKey instanceof Uint8Array) ||
        plaintextDataKey.byteLength !== CASHU_PROOF_CUSTODY_DATA_KEY_BYTES
      ) {
        throw keyUnavailable();
      }
      if (!matchesDataKeyFingerprint(plaintextDataKey, record.dataKeyFingerprint)) {
        throw integrityFailed();
      }
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          createSecretKey(plaintextDataKey),
          record.nonce,
          { authTagLength: CASHU_PROOF_CUSTODY_TAG_BYTES },
        );
        decipher.setAAD(
          createBoundAad(record.keyId, record.dataKeyFingerprint, record.wrappedDataKey, aad),
        );
        decipher.setAuthTag(record.authenticationTag);
        return decryptAuthenticated(decipher, record.ciphertext);
      } catch {
        throw integrityFailed();
      }
    } finally {
      plaintextDataKey?.fill(0);
      wrappingContext.fill(0);
    }
  }
}

function validateGeneratedDataKey(
  value: GeneratedCashuProofCustodyDataKey,
): GeneratedCashuProofCustodyDataKey {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      typeof value.keyId !== "string"
    ) {
      throw keyUnavailable();
    }
    const keyId = cashuProofCustodyKeyId(value.keyId);
    validateBytes(
      value.plaintextDataKey,
      CASHU_PROOF_CUSTODY_DATA_KEY_BYTES,
      CASHU_PROOF_CUSTODY_DATA_KEY_BYTES,
    );
    validateBytes(value.wrappedDataKey, 1, CASHU_PROOF_CUSTODY_MAX_WRAPPED_DATA_KEY_BYTES);
    if (containsBytes(value.wrappedDataKey, value.plaintextDataKey)) {
      throw keyUnavailable();
    }
    return {
      keyId,
      plaintextDataKey: value.plaintextDataKey,
      wrappedDataKey: value.wrappedDataKey,
    };
  } catch {
    throw keyUnavailable();
  }
}

function validateEncryptedRecord(
  value: EncryptedCashuProofBundle,
): asserts value is EncryptedCashuProofBundleV2 {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      value.algorithm !== CASHU_PROOF_CUSTODY_ENVELOPE_ENCRYPTION_ALGORITHM ||
      typeof value.keyId !== "string" ||
      typeof value.dataKeyFingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(value.dataKeyFingerprint)
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
    validateBytes(value.wrappedDataKey, 1, CASHU_PROOF_CUSTODY_MAX_WRAPPED_DATA_KEY_BYTES);
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

function containsBytes(container: Uint8Array, candidate: Uint8Array): boolean {
  if (candidate.byteLength > container.byteLength) {
    return false;
  }
  for (let offset = 0; offset <= container.byteLength - candidate.byteLength; offset += 1) {
    let matches = true;
    for (let position = 0; position < candidate.byteLength; position += 1) {
      if (container[offset + position] !== candidate[position]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

function decryptAuthenticated(
  decipher: ReturnType<typeof createDecipheriv>,
  ciphertext: Uint8Array,
): Uint8Array {
  let updated: Buffer | undefined;
  let finalized: Buffer | undefined;
  try {
    updated = decipher.update(ciphertext);
    finalized = decipher.final();
    const plaintext = Buffer.concat([updated, finalized]);
    return new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  } finally {
    updated?.fill(0);
    finalized?.fill(0);
  }
}

function createWrappingContext(aad: Uint8Array): Buffer {
  return createHash("sha256").update(WRAPPING_CONTEXT).update(aad).digest();
}

function createBoundAad(
  keyId: CashuProofCustodyKeyId,
  dataKeyFingerprint: string,
  wrappedDataKey: Uint8Array,
  aad: Uint8Array,
): Buffer {
  const wrappedDataKeyDigest = createHash("sha256").update(wrappedDataKey).digest();
  return Buffer.concat([
    ENCRYPTION_CONTEXT,
    Buffer.from(keyId, "ascii"),
    Buffer.of(0),
    Buffer.from(dataKeyFingerprint, "ascii"),
    Buffer.of(0),
    wrappedDataKeyDigest,
    aad,
  ]);
}

function createDataKeyFingerprint(dataKey: Uint8Array): string {
  return createHash("sha256").update(dataKey).digest("hex");
}

function matchesDataKeyFingerprint(dataKey: Uint8Array, expected: string): boolean {
  const actual = createHash("sha256").update(dataKey).digest();
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
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

function integrityFailed(): CashuProofCustodyCipherError {
  return new CashuProofCustodyCipherError(
    "integrity_failed",
    "Cashu bearer proof ciphertext failed authentication.",
  );
}
