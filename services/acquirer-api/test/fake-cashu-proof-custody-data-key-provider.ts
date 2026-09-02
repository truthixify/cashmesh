import { createCipheriv, createDecipheriv, type KeyObject } from "node:crypto";

import type {
  CashuProofCustodyKey,
  CashuProofCustodyKeyId,
} from "../src/cashu-proof-custody-cipher";
import type { CashuProofCustodyDataKeyProvider } from "../src/cashu-proof-custody-envelope-cipher";

export class FakeCashuProofCustodyDataKeyProvider implements CashuProofCustodyDataKeyProvider {
  readonly contexts: Uint8Array[] = [];
  readonly generatedPlaintextKeys: Uint8Array[] = [];
  readonly unwrappedPlaintextKeys: Uint8Array[] = [];
  readonly #active: CashuProofCustodyKey;
  readonly #byId: Map<CashuProofCustodyKeyId, CashuProofCustodyKey>;
  readonly #dataKeyFills: readonly number[];
  #generation = 0;

  constructor(keys: readonly CashuProofCustodyKey[], dataKeyFills: readonly number[]) {
    const active = keys[0];
    if (active === undefined || dataKeyFills.length === 0) {
      throw new Error("A test wrapping key and data-key fill are required.");
    }
    this.#active = active;
    this.#byId = new Map(keys.map((value) => [value.keyId, value]));
    this.#dataKeyFills = dataKeyFills;
  }

  async generateDataKey(input: { readonly context: Uint8Array }) {
    this.contexts.push(Uint8Array.from(input.context));
    const fill = this.#dataKeyFills[this.#generation] ?? this.#dataKeyFills.at(-1);
    if (fill === undefined) {
      throw new Error("A data-key fill is required.");
    }
    this.#generation += 1;
    const plaintextDataKey = new Uint8Array(32).fill(fill);
    const wrappedDataKey = wrapDataKey(
      this.#active.key,
      plaintextDataKey,
      input.context,
      this.#generation,
    );
    this.generatedPlaintextKeys.push(plaintextDataKey);
    return {
      keyId: this.#active.keyId,
      plaintextDataKey,
      wrappedDataKey,
    };
  }

  async unwrapDataKey(input: {
    readonly context: Uint8Array;
    readonly keyId: CashuProofCustodyKeyId;
    readonly wrappedDataKey: Uint8Array;
  }) {
    this.contexts.push(Uint8Array.from(input.context));
    const wrappingKey = this.#byId.get(input.keyId);
    if (wrappingKey === undefined) {
      throw new Error("Test wrapping key is unavailable.");
    }
    const plaintextDataKey = unwrapDataKey(wrappingKey.key, input.wrappedDataKey, input.context);
    this.unwrappedPlaintextKeys.push(plaintextDataKey);
    return plaintextDataKey;
  }
}

function wrapDataKey(
  wrappingKey: KeyObject,
  dataKey: Uint8Array,
  context: Uint8Array,
  generation: number,
): Uint8Array {
  const nonce = new Uint8Array(12).fill(generation);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce, { authTagLength: 16 });
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return Uint8Array.from(Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]));
}

function unwrapDataKey(
  wrappingKey: KeyObject,
  wrappedDataKey: Uint8Array,
  context: Uint8Array,
): Uint8Array {
  if (wrappedDataKey.byteLength !== 60) {
    throw new Error("Test wrapped data key is malformed.");
  }
  const nonce = wrappedDataKey.subarray(0, 12);
  const tag = wrappedDataKey.subarray(12, 28);
  const ciphertext = wrappedDataKey.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, nonce, { authTagLength: 16 });
  decipher.setAAD(context);
  decipher.setAuthTag(tag);
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
