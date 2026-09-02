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
