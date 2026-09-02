import { createSecretKey } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  Aes256GcmCashuProofCustodyCipher,
  type CashuProofCustodyKey,
  type CashuProofCustodyKeyId,
  type CashuProofCustodyKeyProvider,
  cashuProofCustodyKeyId,
  createCashuProofCustodyKey,
} from "../src/cashu-proof-custody-cipher";
import {
  type CashuProofCustodyDataKeyProvider,
  EnvelopeAes256GcmCashuProofCustodyCipher,
} from "../src/cashu-proof-custody-envelope-cipher";
import { FakeCashuProofCustodyDataKeyProvider } from "./fake-cashu-proof-custody-data-key-provider";

const PLAINTEXT = new TextEncoder().encode(
  '{"secret":"test-only-bearer-secret","signature":"test-only-signature"}',
);
const AAD = new TextEncoder().encode('{"paymentId":"payment-001"}');

describe("AES-256-GCM Cashu proof custody cipher", () => {
  it("round-trips authenticated ciphertext without exposing plaintext", async () => {
    const provider = keyProvider([key("custody-key-a", 1)]);
    const cipher = new Aes256GcmCashuProofCustodyCipher({
      keyProvider: provider,
      randomBytes: () => new Uint8Array(12).fill(7),
    });

    const encrypted = await cipher.encrypt(PLAINTEXT, AAD);
    const decrypted = await cipher.decrypt(encrypted, AAD);

    expect(decrypted).toEqual(PLAINTEXT);
    expect(encrypted).toMatchObject({ algorithm: "aes-256-gcm-v1", keyId: "custody-key-a" });
    expect(encrypted.nonce).toEqual(new Uint8Array(12).fill(7));
    expect(encrypted.authenticationTag).toHaveLength(16);
    expect(Buffer.from(encrypted.ciphertext).includes(Buffer.from("test-only-bearer-secret"))).toBe(
      false,
    );
  });

  it.each(["ciphertext", "authenticationTag", "nonce", "aad"] as const)(
    "rejects tampered %s",
    async (field) => {
      const provider = keyProvider([key("custody-key-a", 2)]);
      const cipher = new Aes256GcmCashuProofCustodyCipher({
        keyProvider: provider,
        randomBytes: () => new Uint8Array(12).fill(8),
      });
      const encrypted = await cipher.encrypt(PLAINTEXT, AAD);
      const changed = Uint8Array.from(field === "aad" ? AAD : encrypted[field]);
      changed[0] = (changed[0] ?? 0) ^ 1;

      await expect(
        cipher.decrypt(
          field === "aad" ? encrypted : { ...encrypted, [field]: changed },
          field === "aad" ? changed : AAD,
        ),
      ).rejects.toMatchObject({ code: "integrity_failed" });
    },
  );

  it("binds the key identity even when two IDs resolve to the same key bytes", async () => {
    const first = key("custody-key-a", 3);
    const second = createCashuProofCustodyKey(cashuProofCustodyKeyId("custody-key-b"), first.key);
    const cipher = new Aes256GcmCashuProofCustodyCipher({
      keyProvider: keyProvider([first, second]),
      randomBytes: () => new Uint8Array(12).fill(9),
    });
    const encrypted = await cipher.encrypt(PLAINTEXT, AAD);

    await expect(cipher.decrypt({ ...encrypted, keyId: second.keyId }, AAD)).rejects.toMatchObject({
      code: "integrity_failed",
    });
  });

  it("fails closed for missing keys, invalid keys, and malformed randomness", async () => {
    const goodKey = key("custody-key-a", 4);
    const missing = new Aes256GcmCashuProofCustodyCipher({
      keyProvider: {
        activeKey: async () => goodKey,
        findKey: async () => undefined,
      },
      randomBytes: () => new Uint8Array(12),
    });
    const encrypted = await missing.encrypt(PLAINTEXT, AAD);
    await expect(missing.decrypt(encrypted, AAD)).rejects.toMatchObject({
      code: "key_unavailable",
    });

    const malformedProvider = new Aes256GcmCashuProofCustodyCipher({
      keyProvider: {
        activeKey: async () => goodKey,
        findKey: async () =>
          ({
            key: createSecretKey(new Uint8Array(16)),
            keyId: goodKey.keyId,
          }) as CashuProofCustodyKey,
      },
      randomBytes: () => new Uint8Array(12),
    });
    await expect(malformedProvider.decrypt(encrypted, AAD)).rejects.toMatchObject({
      code: "key_unavailable",
    });

    expect(() =>
      createCashuProofCustodyKey(
        cashuProofCustodyKeyId("short-key"),
        createSecretKey(new Uint8Array(16)),
      ),
    ).toThrow(expect.objectContaining({ code: "invalid_cipher_input" }));

    const badRandomness = new Aes256GcmCashuProofCustodyCipher({
      keyProvider: keyProvider([goodKey]),
      randomBytes: () => new Uint8Array(11),
    });
    await expect(badRandomness.encrypt(PLAINTEXT, AAD)).rejects.toMatchObject({
      code: "invalid_cipher_input",
    });
  });
});

describe("envelope AES-256-GCM Cashu proof custody cipher", () => {
  it("round-trips one wrapped data key and wipes provider plaintext buffers", async () => {
    const provider = new FakeCashuProofCustodyDataKeyProvider([key("wrapping-key-a", 10)], [21]);
    const cipher = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: provider,
      randomBytes: () => new Uint8Array(12).fill(11),
    });

    const encrypted = await cipher.encrypt(PLAINTEXT, AAD);
    expect(provider.generatedPlaintextKeys[0]).toEqual(new Uint8Array(32));
    expect(encrypted).toMatchObject({
      algorithm: "aes-256-gcm-envelope-v2",
      keyId: "wrapping-key-a",
    });
    expect(encrypted.dataKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(encrypted.wrappedDataKey).toHaveLength(60);
    expect(Buffer.from(encrypted.wrappedDataKey).includes(Buffer.from("test-only"))).toBe(false);

    const decrypted = await cipher.decrypt(encrypted, AAD);
    expect(decrypted).toEqual(PLAINTEXT);
    expect(provider.unwrappedPlaintextKeys[0]).toEqual(new Uint8Array(32));
    expect(provider.contexts.every((context) => context.byteLength === 32)).toBe(true);
  });

  it("uses a distinct data key for every encryption even when nonces repeat", async () => {
    const provider = new FakeCashuProofCustodyDataKeyProvider(
      [key("wrapping-key-a", 11)],
      [22, 23],
    );
    const cipher = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: provider,
      randomBytes: () => new Uint8Array(12).fill(12),
    });

    const first = await cipher.encrypt(PLAINTEXT, AAD);
    const second = await cipher.encrypt(PLAINTEXT, AAD);

    expect(first.nonce).toEqual(second.nonce);
    expect(first.dataKeyFingerprint).not.toBe(second.dataKeyFingerprint);
    expect(first.wrappedDataKey).not.toEqual(second.wrappedDataKey);
  });

  it.each([
    "ciphertext",
    "authenticationTag",
    "nonce",
    "dataKeyFingerprint",
    "wrappedDataKey",
    "aad",
  ] as const)("fails closed for tampered %s", async (field) => {
    const provider = new FakeCashuProofCustodyDataKeyProvider([key("wrapping-key-a", 12)], [24]);
    const cipher = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: provider,
      randomBytes: () => new Uint8Array(12).fill(13),
    });
    const encrypted = await cipher.encrypt(PLAINTEXT, AAD);
    const changed = Uint8Array.from(
      field === "aad"
        ? AAD
        : field === "dataKeyFingerprint"
          ? Buffer.from(encrypted.dataKeyFingerprint, "hex")
          : encrypted[field],
    );
    changed[0] = (changed[0] ?? 0) ^ 1;
    const changedRecord =
      field === "aad"
        ? encrypted
        : field === "dataKeyFingerprint"
          ? { ...encrypted, dataKeyFingerprint: Buffer.from(changed).toString("hex") }
          : { ...encrypted, [field]: changed };

    await expect(
      cipher.decrypt(changedRecord, field === "aad" ? changed : AAD),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(integrity_failed|key_unavailable)$/),
    });
  });

  it("authenticates wrapping metadata even when a provider returns the requested data key", async () => {
    const dataKey = new Uint8Array(32).fill(30);
    const provider: CashuProofCustodyDataKeyProvider = {
      generateDataKey: async () => ({
        keyId: cashuProofCustodyKeyId("wrapping-key-a"),
        plaintextDataKey: Uint8Array.from(dataKey),
        wrappedDataKey: new Uint8Array([1, 2, 3]),
      }),
      unwrapDataKey: async () => Uint8Array.from(dataKey),
    };
    const cipher = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: provider,
      randomBytes: () => new Uint8Array(12).fill(20),
    });
    const encrypted = await cipher.encrypt(PLAINTEXT, AAD);

    await expect(
      cipher.decrypt(
        {
          ...encrypted,
          keyId: cashuProofCustodyKeyId("wrapping-key-b"),
        },
        AAD,
      ),
    ).rejects.toMatchObject({ code: "integrity_failed" });
    await expect(
      cipher.decrypt({ ...encrypted, wrappedDataKey: new Uint8Array([1, 2, 4]) }, AAD),
    ).rejects.toMatchObject({ code: "integrity_failed" });
  });

  it("reads legacy v1 records only through an explicitly supplied historical cipher", async () => {
    const legacy = new Aes256GcmCashuProofCustodyCipher({
      keyProvider: keyProvider([key("legacy-key", 13)]),
      randomBytes: () => new Uint8Array(12).fill(14),
    });
    const legacyRecord = await legacy.encrypt(PLAINTEXT, AAD);
    const provider = new FakeCashuProofCustodyDataKeyProvider([key("wrapping-key-a", 14)], [25]);
    const versioned = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: provider,
      legacyCipher: legacy,
      randomBytes: () => new Uint8Array(12).fill(15),
    });

    await expect(versioned.decrypt(legacyRecord, AAD)).resolves.toEqual(PLAINTEXT);
    await expect(versioned.encrypt(PLAINTEXT, AAD)).resolves.toMatchObject({
      algorithm: "aes-256-gcm-envelope-v2",
    });

    const envelopeOnly = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: provider,
    });
    await expect(envelopeOnly.decrypt(legacyRecord, AAD)).rejects.toMatchObject({
      code: "key_unavailable",
    });
  });

  it("keeps historical wrapping keys readable after active-key rotation", async () => {
    const oldKey = key("wrapping-key-old", 15);
    const newKey = key("wrapping-key-new", 16);
    const writer = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: new FakeCashuProofCustodyDataKeyProvider([oldKey], [26]),
      randomBytes: () => new Uint8Array(12).fill(16),
    });
    const record = await writer.encrypt(PLAINTEXT, AAD);
    const reader = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: new FakeCashuProofCustodyDataKeyProvider([newKey, oldKey], [27]),
    });

    await expect(reader.decrypt(record, AAD)).resolves.toEqual(PLAINTEXT);
  });

  it("rejects malformed provider keys and randomness without retaining key bytes", async () => {
    const malformedKey = new Uint8Array(16).fill(28);
    const malformedProvider: CashuProofCustodyDataKeyProvider = {
      generateDataKey: async () => ({
        keyId: cashuProofCustodyKeyId("wrapping-key-a"),
        plaintextDataKey: malformedKey,
        wrappedDataKey: new Uint8Array([1]),
      }),
      unwrapDataKey: async () => new Uint8Array(16),
    };
    const malformed = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: malformedProvider,
    });
    await expect(malformed.encrypt(PLAINTEXT, AAD)).rejects.toMatchObject({
      code: "key_unavailable",
    });
    expect(malformedKey).toEqual(new Uint8Array(16));

    const exposedKey = new Uint8Array(32).fill(29);
    const exposingProvider: CashuProofCustodyDataKeyProvider = {
      generateDataKey: async () => ({
        keyId: cashuProofCustodyKeyId("wrapping-key-a"),
        plaintextDataKey: exposedKey,
        wrappedDataKey: Uint8Array.from(exposedKey),
      }),
      unwrapDataKey: async () => new Uint8Array(32),
    };
    const exposed = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: exposingProvider,
    });
    await expect(exposed.encrypt(PLAINTEXT, AAD)).rejects.toMatchObject({
      code: "key_unavailable",
    });
    expect(exposedKey).toEqual(new Uint8Array(32));

    const provider = new FakeCashuProofCustodyDataKeyProvider([key("wrapping-key-a", 17)], [29]);
    const badRandomness = new EnvelopeAes256GcmCashuProofCustodyCipher({
      dataKeyProvider: provider,
      randomBytes: () => new Uint8Array(11),
    });
    await expect(badRandomness.encrypt(PLAINTEXT, AAD)).rejects.toMatchObject({
      code: "invalid_cipher_input",
    });
    expect(provider.generatedPlaintextKeys[0]).toEqual(new Uint8Array(32));
  });
});

function key(keyId: string, fill: number): CashuProofCustodyKey {
  return createCashuProofCustodyKey(
    cashuProofCustodyKeyId(keyId),
    createSecretKey(new Uint8Array(32).fill(fill)),
  );
}

function keyProvider(keys: readonly CashuProofCustodyKey[]): CashuProofCustodyKeyProvider {
  const byId = new Map<CashuProofCustodyKeyId, CashuProofCustodyKey>(
    keys.map((value) => [value.keyId, value]),
  );
  const active = keys[0];
  if (active === undefined) {
    throw new Error("A test custody key is required.");
  }
  return {
    activeKey: async () => active,
    findKey: async (keyId) => byId.get(keyId),
  };
}
