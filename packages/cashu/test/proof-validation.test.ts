import { inspect } from "node:util";
import {
  Amount,
  blindMessage,
  constructUnblindedSignature,
  createBlindSignature,
  createDLEQProof,
  createNewMintKeys,
  deriveKeysetId,
  PaymentRequest,
  type Proof,
  pointFromBytes,
  pointToHex,
  serializeMintKeys,
} from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";

import {
  CashuBearerProofBundleError,
  type CashuKeysetSnapshotEntryInputV1,
  CashuKeysetSnapshotError,
  CashuProofReferenceError,
  CashuProofValidationError,
  createCashuKeysetSnapshotV1,
  createCashuProofReferenceV1,
  isCashuBearerProofBundleValidatedForInitialCustodyV1,
  restoreCashuBearerProofBundleV1,
  validateCashuPaymentProofsForCustodyV1,
  validateCashuPaymentProofsV1,
} from "../src";

const INVOICE_ID = "invoice-proof-validation-001";
const MINT_URL = "https://mint.cashmesh.example";
const NOW = 1_788_100_000;

describe("createCashuProofReferenceV1", () => {
  it("accepts only a canonical non-bearer NUT-07 proof reference", () => {
    const reference = createCashuProofReferenceV1({
      amount: 8,
      keysetId: "000f715baf5d4c2e",
      y: "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05",
    });

    expect(reference).toEqual({
      amount: 8,
      keysetId: "000f715baf5d4c2e",
      y: "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05",
    });
    expect(Object.isFrozen(reference)).toBe(true);
    expect(JSON.stringify(reference)).not.toMatch(/secret|signature|dleq|witness/i);
  });

  it.each([
    { amount: 0, keysetId: "000f715baf5d4c2e", name: "zero amount", y: `02${"11".repeat(32)}` },
    { amount: 1, keysetId: "bad-keyset", name: "invalid keyset", y: `02${"11".repeat(32)}` },
    {
      amount: 1,
      keysetId: "000f715baf5d4c2e",
      name: "invalid curve point",
      y: `02${"ff".repeat(32)}`,
    },
  ])("rejects $name", ({ amount, keysetId, y }) => {
    expect(() => createCashuProofReferenceV1({ amount, keysetId, y })).toThrow(
      CashuProofReferenceError,
    );
  });
});

describe("createCashuKeysetSnapshotV1", () => {
  it("canonicalizes and deeply freezes a verified mint keyset snapshot", () => {
    const second = testKeyset(8, 750, { active: false });
    const first = testKeyset(7, 125);
    const snapshot = createCashuKeysetSnapshotV1({
      keysets: [
        { ...second.entry, keys: uppercaseValues(second.entry.keys) },
        { ...first.entry, keys: uppercaseValues(first.entry.keys) },
      ],
      mintUrl: `${MINT_URL}/`,
      observedAt: NOW - 10,
    });

    expect(snapshot).toMatchObject({
      mintUrl: MINT_URL,
      observedAt: NOW - 10,
      schemaVersion: 1,
    });
    expect(snapshot.keysets.map((keyset) => keyset.id)).toEqual(
      [first.entry.id, second.entry.id].sort(),
    );
    expect(Object.values(snapshot.keysets[0]?.keys ?? {})).toEqual(
      Object.values(snapshot.keysets[0]?.keys ?? {}).map((key) => key.toLowerCase()),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.keysets)).toBe(true);
    expect(Object.isFrozen(snapshot.keysets[0])).toBe(true);
    expect(Object.isFrozen(snapshot.keysets[0]?.keys)).toBe(true);
  });

  it("rejects empty, duplicate, tampered, and unsupported keysets", () => {
    const fixture = testKeyset(7, 125);
    const firstKey = Object.keys(fixture.entry.keys)[0];
    if (firstKey === undefined) {
      throw new Error("Expected deterministic keyset fixture keys.");
    }

    expect(
      snapshotError(() =>
        createCashuKeysetSnapshotV1({ keysets: [], mintUrl: MINT_URL, observedAt: NOW }),
      ),
    ).toMatchObject({ code: "empty_keyset_set" });
    expect(
      snapshotError(() =>
        createCashuKeysetSnapshotV1({
          keysets: [fixture.entry],
          mintUrl: MINT_URL,
          observedAt: NOW,
          schemaVersion: 2,
        }),
      ),
    ).toMatchObject({ code: "invalid_snapshot" });
    expect(
      snapshotError(() =>
        createCashuKeysetSnapshotV1({
          keysets: [fixture.entry, fixture.entry],
          mintUrl: MINT_URL,
          observedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "duplicate_keyset" });
    expect(
      snapshotError(() =>
        createCashuKeysetSnapshotV1({
          keysets: [
            {
              ...fixture.entry,
              keys: { ...fixture.entry.keys, [firstKey]: `03${"11".repeat(32)}` },
            },
          ],
          mintUrl: MINT_URL,
          observedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "invalid_keyset" });
    expect(
      snapshotError(() =>
        createCashuKeysetSnapshotV1({
          keysets: [{ ...fixture.entry, keys: { ["1".repeat(100_000)]: "x" } }],
          mintUrl: MINT_URL,
          observedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "invalid_keyset" });
    expect(
      snapshotError(() =>
        createCashuKeysetSnapshotV1({
          keysets: [{ ...fixture.entry, id: `02${fixture.entry.id.slice(2)}` }],
          mintUrl: MINT_URL,
          observedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "unsupported_keyset_version" });
    expect(
      snapshotError(() =>
        createCashuKeysetSnapshotV1({
          keysets: [{ ...fixture.entry, id: "abcdefghijkl" }],
          mintUrl: MINT_URL,
          observedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "unsupported_keyset_version" });
  });

  it("exposes a stable snapshot error type", () => {
    expect(CashuKeysetSnapshotError.prototype).toBeInstanceOf(Error);
  });
});

describe("validateCashuPaymentProofsV1", () => {
  it("rejects malformed validation input with a stable error type", () => {
    expect(
      validationError(() =>
        validateCashuPaymentProofsV1(
          null as unknown as Parameters<typeof validateCashuPaymentProofsV1>[0],
        ),
      ),
    ).toMatchObject({ code: "invalid_validation_input" });
    expect(CashuProofValidationError.prototype).toBeInstanceOf(Error);
  });

  it("accepts the official NUT-12 proof vector against a verified keyset", () => {
    const publicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const keys = { "1": publicKey };
    const keysetId = deriveKeysetId(keys, { versionByte: 0 });
    const proof: Proof = {
      C: "024369d2d22a80ecf78f3937da9d5f30c1b9f74f0c32684d583cca0fa6a61cdcfc",
      amount: Amount.one(),
      dleq: {
        e: "b31e58ac6527f34975ffab13e70a48b6d2b0d35abc4b03f0151f09ee1a9763d4",
        r: "a6d13fcd7a18442e6076f5e1e7c887ad5de40a019824bdfa9fe740d302e8d861",
        s: "8fbae004c59e754d71df67e392b6ae4e29293113ddc2ec86592a0431d16306d8",
      },
      id: keysetId,
      secret: "daf4dd00a2b68a0858a80450f52c8a7d2ccf87d375e43e216e0c571f089f63e9",
    };
    const snapshot = snapshotFrom([
      { active: false, id: keysetId, inputFeePpk: 0, keys, unit: "usdc" },
    ]);

    expect(
      validateCashuPaymentProofsV1({
        keysetSnapshot: snapshot,
        rawPayload: paymentPayload([proof]),
        validatedAt: NOW,
      }),
    ).toMatchObject({ grossAmount: 1, inputFee: 0, netAmount: 1 });
  });

  it("validates mixed inactive and active keysets and computes exact NUT-02 fees", () => {
    const first = testKeyset(7, 125);
    const second = testKeyset(8, 750, { active: false });
    const snapshot = snapshotFrom([second.entry, first.entry]);
    const proofs = [
      createProof(first, 8, "test-only-proof-a", 101n),
      createProof(first, 4, "test-only-proof-b", 102n),
      createProof(second, 16, "test-only-proof-c", 103n),
    ];

    const result = validateCashuPaymentProofsV1({
      keysetSnapshot: snapshot,
      rawPayload: paymentPayload(proofs),
      validatedAt: NOW,
    });

    expect(result).toEqual({
      grossAmount: 28,
      inputFee: 1,
      invoiceId: INVOICE_ID,
      keysetIds: [first.entry.id, second.entry.id].sort(),
      keysetSnapshotObservedAt: NOW - 10,
      mintUrl: MINT_URL,
      netAmount: 27,
      proofCount: 3,
      proofReferences: [
        {
          amount: 8,
          keysetId: first.entry.id,
          y: "0239bcd9b5df9a0fcc2aae3b352954b7cfd020d2b01842a4dee62edac0f8b8cd05",
        },
        {
          amount: 4,
          keysetId: first.entry.id,
          y: "02ab1c4a13001bbc881cf2d568048d414008ac94e0bde1cb05e96076553b1edcd5",
        },
        {
          amount: 16,
          keysetId: second.entry.id,
          y: "02b79a5775181e7973cab6c33eea75d943d9974acefd4d2a267f0f76ef567915ff",
        },
      ],
      unit: "usdc",
      validatedAt: NOW,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.keysetIds)).toBe(true);
    expect(Object.isFrozen(result.proofReferences)).toBe(true);
    expect(Object.isFrozen(result.proofReferences[0])).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-only-proof");
    expect(JSON.stringify(result)).not.toContain(proofs[0]?.C ?? "missing-signature");
    expect(JSON.stringify(result)).not.toContain(proofs[0]?.dleq?.r ?? "missing-dleq");
  });

  it("rounds the aggregate input fee up once using integer arithmetic", () => {
    const fixture = testKeyset(7, 100);
    const result = validateCashuPaymentProofsV1({
      keysetSnapshot: snapshotFrom([fixture.entry]),
      rawPayload: paymentPayload([
        createProof(fixture, 1, "test-only-fee-a", 201n),
        createProof(fixture, 2, "test-only-fee-b", 202n),
        createProof(fixture, 4, "test-only-fee-c", 203n),
      ]),
      validatedAt: NOW,
    });

    expect(result).toMatchObject({ grossAmount: 7, inputFee: 1, netAmount: 6 });
  });

  it("creates an explicitly serializable bearer bundle while redacting ordinary output", () => {
    const fixture = testKeyset(7, 0);
    const proofs = [
      createProof(fixture, 8, "test-only-custody-a", 251n),
      createProof(fixture, 4, "test-only-custody-b", 252n),
    ];
    const result = validateCashuPaymentProofsForCustodyV1({
      keysetSnapshot: snapshotFrom([fixture.entry]),
      rawPayload: paymentPayload(proofs),
      validatedAt: NOW,
    });

    expect(result.validation).toMatchObject({ grossAmount: 12, netAmount: 12, proofCount: 2 });
    expect(JSON.stringify(result)).not.toMatch(/test-only-custody|"signature"|"dleq"|"witness"/i);
    expect(inspect(result.bearerProofs)).not.toMatch(/test-only-custody|signature|dleq|witness/i);
    expect(String(result.bearerProofs)).toBe("CashuBearerProofBundleV1 [REDACTED]");

    const plaintext = result.bearerProofs.serializeForEncryption();
    const stored = JSON.parse(new TextDecoder().decode(plaintext)) as {
      readonly proofs: readonly Record<string, unknown>[];
    };
    expect(stored.proofs.map((proof) => Object.keys(proof).sort())).toEqual([
      ["amount", "keysetId", "secret", "signature", "y"],
      ["amount", "keysetId", "secret", "signature", "y"],
    ]);
    expect(JSON.stringify(stored)).toContain("test-only-custody-a");
    expect(JSON.stringify(stored)).not.toMatch(/dleq|witness/i);

    const restored = restoreCashuBearerProofBundleV1(plaintext);
    expect(result.bearerProofs.isValidatedForInitialCustody()).toBe(true);
    expect(isCashuBearerProofBundleValidatedForInitialCustodyV1(result.bearerProofs)).toBe(true);
    expect(restored.isValidatedForInitialCustody()).toBe(false);
    expect(isCashuBearerProofBundleValidatedForInitialCustodyV1(restored)).toBe(false);
    const forged = Object.assign(Object.create(Object.getPrototypeOf(result.bearerProofs)), {
      isValidatedForInitialCustody: () => true,
    });
    expect(isCashuBearerProofBundleValidatedForInitialCustodyV1(forged)).toBe(false);
    expect(restored.serializeForEncryption()).toEqual(plaintext);
    result.bearerProofs.destroy();
    expect(isCashuBearerProofBundleValidatedForInitialCustodyV1(result.bearerProofs)).toBe(false);
    expect(() => result.bearerProofs.serializeForEncryption()).toThrow(CashuBearerProofBundleError);
  });

  it("rejects spending conditions and non-canonical restored plaintext", () => {
    const fixture = testKeyset(7, 0);
    const ordinary = createProof(fixture, 8, "test-only-custody", 261n);
    const structured = createProof(fixture, 8, '["P2PK",{"data":"test-only-unsupported"}]', 262n);

    expect(
      validationError(() =>
        validateCashuPaymentProofsForCustodyV1({
          keysetSnapshot: snapshotFrom([fixture.entry]),
          rawPayload: paymentPayload([{ ...ordinary, witness: '{"signatures":[]}' }]),
          validatedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "unsupported_spending_condition" });
    expect(
      validationError(() =>
        validateCashuPaymentProofsForCustodyV1({
          keysetSnapshot: snapshotFrom([fixture.entry]),
          rawPayload: paymentPayload([structured]),
          validatedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "unsupported_spending_condition" });

    const valid = validateCashuPaymentProofsForCustodyV1({
      keysetSnapshot: snapshotFrom([fixture.entry]),
      rawPayload: paymentPayload([ordinary]),
      validatedAt: NOW,
    }).bearerProofs.serializeForEncryption();
    const nonCanonical = new TextEncoder().encode(` ${new TextDecoder().decode(valid)}`);
    expect(validationError(() => restoreCashuBearerProofBundleV1(nonCanonical))).toMatchObject({
      code: "invalid_bundle",
    });
  });

  it("requires DLEQ and rejects a tampered signature", () => {
    const fixture = testKeyset(7, 0);
    const validProof = createProof(fixture, 8, "test-only-integrity", 301n);
    const { dleq: _dleq, ...withoutDleq } = validProof;

    expect(
      validationError(() =>
        validateCashuPaymentProofsV1({
          keysetSnapshot: snapshotFrom([fixture.entry]),
          rawPayload: paymentPayload([withoutDleq]),
          validatedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "proof_integrity_failed" });
    expect(
      validationError(() =>
        validateCashuPaymentProofsV1({
          keysetSnapshot: snapshotFrom([fixture.entry]),
          rawPayload: paymentPayload([{ ...validProof, C: `03${"22".repeat(32)}` }]),
          validatedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "proof_integrity_failed" });
    expect(
      validationError(() =>
        validateCashuPaymentProofsV1({
          keysetSnapshot: snapshotFrom([fixture.entry]),
          rawPayload: paymentPayload([{ ...validProof, amount: Amount.from(3) }]),
          validatedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "proof_integrity_failed" });
  });

  it("rejects duplicate bearer proofs before their amount can be counted twice", () => {
    const fixture = testKeyset(7, 0);
    const proof = createProof(fixture, 8, "test-only-duplicate", 401n);

    expect(
      validationError(() =>
        validateCashuPaymentProofsV1({
          keysetSnapshot: snapshotFrom([fixture.entry]),
          rawPayload: paymentPayload([proof, proof]),
          validatedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "duplicate_proof" });
  });

  it.each([
    {
      code: "mint_mismatch",
      name: "a different mint snapshot",
      setup: () => {
        const fixture = testKeyset(7, 0);
        return {
          payload: paymentPayload([createProof(fixture, 8, "test-only-mint", 501n)], {
            mintUrl: "https://another-mint.example",
          }),
          snapshot: snapshotFrom([fixture.entry]),
          validatedAt: NOW,
        };
      },
    },
    {
      code: "keyset_not_found",
      name: "an unknown keyset",
      setup: () => {
        const known = testKeyset(7, 0);
        const unknown = testKeyset(8, 0);
        return {
          payload: paymentPayload([createProof(unknown, 8, "test-only-unknown", 502n)]),
          snapshot: snapshotFrom([known.entry]),
          validatedAt: NOW,
        };
      },
    },
    {
      code: "keyset_unit_mismatch",
      name: "a different keyset unit",
      setup: () => {
        const fixture = testKeyset(7, 0, { unit: "sat" });
        return {
          payload: paymentPayload([createProof(fixture, 8, "test-only-unit", 503n)]),
          snapshot: snapshotFrom([fixture.entry]),
          validatedAt: NOW,
        };
      },
    },
    {
      code: "keyset_expired",
      name: "an expired keyset",
      setup: () => {
        const fixture = testKeyset(7, 0, { finalExpiry: NOW });
        return {
          payload: paymentPayload([createProof(fixture, 8, "test-only-expired", 504n)]),
          snapshot: snapshotFrom([fixture.entry]),
          validatedAt: NOW,
        };
      },
    },
    {
      code: "snapshot_from_future",
      name: "a future observation",
      setup: () => {
        const fixture = testKeyset(7, 0);
        return {
          payload: paymentPayload([createProof(fixture, 8, "test-only-future", 505n)]),
          snapshot: createCashuKeysetSnapshotV1({
            keysets: [fixture.entry],
            mintUrl: MINT_URL,
            observedAt: NOW + 1,
          }),
          validatedAt: NOW,
        };
      },
    },
  ])("rejects $name", ({ code, setup }) => {
    const input = setup();

    expect(
      validationError(() =>
        validateCashuPaymentProofsV1({
          keysetSnapshot: input.snapshot,
          rawPayload: input.payload,
          validatedAt: input.validatedAt,
        }),
      ),
    ).toMatchObject({ code });
  });

  it("rejects a proof set whose aggregate input fee exceeds its value", () => {
    const fixture = testKeyset(7, 2_000);

    expect(
      validationError(() =>
        validateCashuPaymentProofsV1({
          keysetSnapshot: snapshotFrom([fixture.entry]),
          rawPayload: paymentPayload([createProof(fixture, 1, "test-only-dust", 601n)]),
          validatedAt: NOW,
        }),
      ),
    ).toMatchObject({ code: "input_fee_exceeds_amount" });
  });
});

interface TestKeyset {
  readonly entry: CashuKeysetSnapshotEntryInputV1;
  readonly pair: ReturnType<typeof createNewMintKeys>;
}

function testKeyset(
  seedByte: number,
  inputFeePpk: number,
  options: {
    readonly active?: boolean;
    readonly finalExpiry?: number;
    readonly unit?: string;
  } = {},
): TestKeyset {
  const pair = createNewMintKeys(8, new Uint8Array(32).fill(seedByte), {
    ...(options.finalExpiry !== undefined && { expiry: options.finalExpiry }),
    input_fee_ppk: inputFeePpk,
    unit: options.unit ?? "usdc",
    versionByte: 1,
  });
  return {
    entry: {
      active: options.active ?? true,
      ...(options.finalExpiry !== undefined && { finalExpiry: options.finalExpiry }),
      id: pair.keysetId,
      inputFeePpk,
      keys: serializeMintKeys(pair.pubKeys),
      unit: options.unit ?? "usdc",
    },
    pair,
  };
}

function createProof(
  fixture: TestKeyset,
  amount: number,
  secret: string,
  blindingFactor: bigint,
): Proof {
  const denomination = String(amount);
  const privateKey = fixture.pair.privKeys[denomination];
  const publicKey = fixture.pair.pubKeys[denomination];
  if (privateKey === undefined || publicKey === undefined) {
    throw new Error("Test proof denomination is not in the deterministic keyset.");
  }

  const secretBytes = new TextEncoder().encode(secret);
  const blinded = blindMessage(secretBytes, blindingFactor);
  const blindSignature = createBlindSignature(blinded.B_, privateKey, fixture.pair.keysetId);
  const dleq = createDLEQProof(blinded.B_, privateKey);
  const unblinded = constructUnblindedSignature(
    blindSignature,
    blinded.r,
    secretBytes,
    pointFromBytes(publicKey),
  );

  return {
    C: pointToHex({ kind: "secp", pt: unblinded.C }),
    amount: Amount.from(amount),
    dleq: {
      e: bytesToHex(dleq.e),
      r: blinded.r.toString(16).padStart(64, "0"),
      s: bytesToHex(dleq.s),
    },
    id: fixture.pair.keysetId,
    secret,
  };
}

function snapshotFrom(keysets: readonly CashuKeysetSnapshotEntryInputV1[]) {
  return createCashuKeysetSnapshotV1({
    keysets,
    mintUrl: MINT_URL,
    observedAt: NOW - 10,
  });
}

function paymentPayload(
  proofs: readonly Proof[],
  options: { readonly mintUrl?: string } = {},
): string {
  return new PaymentRequest({ id: INVOICE_ID, unit: "usdc" }).encodePayload(
    options.mintUrl ?? MINT_URL,
    [...proofs],
  );
}

function uppercaseValues(
  value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value).map(([amount, key]) => [amount, key.toUpperCase()]),
  );
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function snapshotError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected snapshot action to throw.");
}

function validationError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected validation action to throw.");
}
